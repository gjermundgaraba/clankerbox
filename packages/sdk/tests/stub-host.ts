import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { DateTime, Effect, Layer } from "effect";
import { FetchHttpClient, type HttpClient, HttpRouter, HttpServer } from "effect/http";
import {
  type Checkpoint,
  Conflict,
  type CreateRequest,
  type Declared,
  type Executed,
  type ExecRequest,
  Http,
  type Machine,
  NotFound,
  type PrebuildRequest,
  type Prebuilt,
  type Kind,
  type Reading,
  type Sizing,
  version,
  versionHeader,
} from "../src/index.ts";

export interface StubHostOptions {
  readonly id: string;
  readonly bases: ReadonlyArray<string>;
  readonly kind?: Kind;
  /** Default: 0.0.0-test. */
  readonly runtimeVersion?: string;
  /** Default: running. */
  readonly create?: (request: CreateRequest) => Effect.Effect<Machine, Declared<"createMachine">>;
  /** Replaces the default prebuild, which captures a builder of its own unless it has the checkpoint. */
  readonly prebuild?: (
    request: PrebuildRequest,
  ) => Effect.Effect<Prebuilt, Declared<"prebuildCheckpoint">>;
  readonly machines?: ReadonlyArray<Machine>;
  readonly checkpoints?: ReadonlyArray<Checkpoint>;
  /** What every restore fails with. Default: none. */
  readonly restoreFails?: Declared<"restoreMachine">;
  /** Default: none. */
  readonly capacity?: ReadonlyArray<Reading>;
  /** Default: exit 0 with no output, in a machine the stub holds. */
  readonly exec?: (request: ExecRequest) => Effect.Effect<Executed, Declared<"execMachine">>;
}

export const machine = (id: string, fields?: Partial<Machine>): Machine => ({
  id,
  kind: "linux",
  createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
  base: "ubuntu",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  state: "running",
  desired: "running",
  phase: "settled",
  ...fields,
});

export const checkpoint = (id: string, fields?: Partial<Checkpoint>): Checkpoint => ({
  id,
  createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
  machine: id,
  kind: "disk",
  base: "ubuntu",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  ...fields,
});

export const stubHost = (options: StubHostOptions) => {
  const kind = options.kind ?? "linux";
  const machines = new Map<string, Machine>();
  const checkpoints = new Map<string, Checkpoint>();
  const creates: Array<CreateRequest> = [];
  const prebuilds: Array<PrebuildRequest> = [];
  const execs: Array<ExecRequest> = [];
  const calls: Array<string> = [];
  const versions: Array<string | null> = [];

  for (const held of options.machines ?? []) {
    machines.set(held.id, held);
  }

  for (const held of options.checkpoints ?? []) {
    checkpoints.set(held.id, held);
  }

  const record = (call: string) => Effect.sync(() => calls.push(call));

  const find = (id: string) => {
    const found = machines.get(id);

    return found === undefined
      ? Effect.fail(new NotFound({ message: `no machine ${id}` }))
      : Effect.succeed(found);
  };

  const settled = (found: Machine, state: Machine["state"], desired: Machine["desired"]) => {
    const now: Machine = { ...found, state, desired };

    machines.set(now.id, now);

    return now;
  };

  const findCheckpoint = (id: string) => {
    const found = checkpoints.get(id);

    return found === undefined
      ? Effect.fail(new NotFound({ message: `no checkpoint ${id}` }))
      : Effect.succeed(found);
  };

  const taken = (held: ReadonlyMap<string, unknown>, id: string) =>
    held.has(id) ? Effect.fail(new Conflict({ message: `${id} exists` })) : Effect.void;

  const add = (made: Machine) =>
    Effect.andThen(
      taken(machines, made.id),
      Effect.sync(() => {
        machines.set(made.id, made);

        return made;
      }),
    );

  const labelled = <A extends Machine | Checkpoint>(made: A, profile: string | undefined): A =>
    profile === undefined ? made : { ...made, profile };

  const create = (request: CreateRequest) =>
    options.create === undefined
      ? add(
          labelled(
            machine(request.id, {
              kind,
              base: request.base,
              cpu: request.cpu,
              ramMib: request.ramMib,
              diskGib: request.diskGib,
            }),
            request.profile,
          ),
        )
      : options.create(request);

  const sized = <A extends Machine | Checkpoint>(found: A, sizes: Sizing) => ({
    cpu: sizes.cpu ?? found.cpu,
    ramMib: sizes.ramMib ?? found.ramMib,
    diskGib: sizes.diskGib ?? found.diskGib,
  });

  const restore = (checkpoint: string, name: string, sizes: Sizing = {}) =>
    Effect.flatMap(findCheckpoint(checkpoint), (found) =>
      add(
        labelled(
          machine(`${options.id}_${name}`, { kind, base: found.base, ...sized(found, sizes) }),
          found.profile,
        ),
      ),
    );

  const prebuild = (
    request: PrebuildRequest,
  ): Effect.Effect<Prebuilt, Declared<"prebuildCheckpoint">> => {
    if (options.prebuild !== undefined) {
      return options.prebuild(request);
    }

    const found = checkpoints.get(request.id);

    if (found !== undefined) {
      return Effect.succeed({ checkpoint: found, built: false });
    }

    return Effect.sync(() => {
      const made = labelled<Checkpoint>(
        checkpoint(request.id, {
          machine: `${options.id}_prebuilding-0000000000000000`,
          base: request.base,
          cpu: request.cpu,
          ramMib: request.ramMib,
          diskGib: request.diskGib,
        }),
        request.profile,
      );

      checkpoints.set(made.id, made);

      return { checkpoint: made, built: true };
    });
  };

  const app = Action.implement(Http.actions, {
    listMachines: () => Effect.as(record("machine.list"), [...machines.values()]),
    getMachine: ({ id }) => Effect.andThen(record("machine.get"), find(id)),
    createMachine: (request) =>
      Effect.andThen(
        Effect.sync(() => creates.push(request)),
        Effect.andThen(record("machine.create"), create(request)),
      ),
    execMachine: (request) =>
      Effect.andThen(
        Effect.sync(() => execs.push(request)),
        Effect.andThen(
          record("machine.exec"),
          options.exec === undefined
            ? Effect.as(find(request.id), { exitCode: 0, output: "", truncated: false })
            : options.exec(request),
        ),
      ),
    startMachine: ({ id }) =>
      Effect.andThen(
        record("machine.start"),
        Effect.map(find(id), (found) => settled(found, "running", "running")),
      ),
    stopMachine: ({ id }) =>
      Effect.andThen(
        record("machine.stop"),
        Effect.map(find(id), (found) => settled(found, "stopped", "stopped")),
      ),
    pauseMachine: ({ id }) =>
      Effect.andThen(
        record("machine.pause"),
        Effect.map(find(id), (found) =>
          settled(found, found.state === "stopped" ? "stopped" : "paused", "paused"),
        ),
      ),
    resizeMachine: ({ id, ...sizes }) =>
      Effect.andThen(
        record("machine.resize"),
        Effect.map(find(id), (found) => {
          const now: Machine = { ...found, ...sized(found, sizes) };

          machines.set(now.id, now);

          return now;
        }),
      ),
    deleteMachine: ({ id }) =>
      Effect.andThen(
        record("machine.delete"),
        Effect.andThen(
          find(id),
          Effect.sync(() => machines.delete(id)),
        ),
      ),
    forkMachine: ({ machine: source, name, ...sizes }) =>
      Effect.andThen(
        record("machine.fork"),
        Effect.flatMap(find(source), (found) =>
          add({ ...found, id: `${options.id}_${name}`, ...sized(found, sizes) }),
        ),
      ),
    restoreMachine: ({ checkpoint, name, ...sizes }) =>
      Effect.andThen(
        record("machine.restore"),
        options.restoreFails === undefined
          ? restore(checkpoint, name, sizes)
          : Effect.fail(options.restoreFails),
      ),
    listCheckpoints: () => Effect.as(record("checkpoint.list"), [...checkpoints.values()]),
    getCheckpoint: ({ id }) => Effect.andThen(record("checkpoint.get"), findCheckpoint(id)),
    captureCheckpoint: ({ machine: source, name }) =>
      Effect.andThen(
        record("checkpoint.capture"),
        Effect.flatMap(find(source), (found) =>
          Effect.andThen(
            taken(checkpoints, `${options.id}_${name}`),
            Effect.sync(() => {
              const made = labelled<Checkpoint>(
                {
                  id: `${options.id}_${name}`,
                  createdAt: found.createdAt,
                  machine: found.id,
                  kind: "disk",
                  base: found.base,
                  cpu: found.cpu,
                  ramMib: found.ramMib,
                  diskGib: found.diskGib,
                },
                found.profile,
              );

              checkpoints.set(made.id, made);

              return made;
            }),
          ),
        ),
      ),
    deleteCheckpoint: ({ id }) =>
      Effect.andThen(
        record("checkpoint.delete"),
        Effect.andThen(
          findCheckpoint(id),
          Effect.sync(() => checkpoints.delete(id)),
        ),
      ),
    prebuildCheckpoint: (request) =>
      Effect.andThen(
        Effect.sync(() => prebuilds.push(request)),
        Effect.andThen(record("checkpoint.prebuild"), prebuild(request)),
      ),
    getHost: () =>
      Effect.as(record("host.get"), {
        id: options.id,
        kind,
        version,
        runtimeVersion: options.runtimeVersion ?? "0.0.0-test",
        bases: options.bases,
      }),
    getCapacity: () =>
      Effect.as(
        record("host.capacity"),
        (options.capacity ?? []).map((limit) => ({ host: options.id, ...limit })),
      ),
  });

  const routes = ActionHttp.layer(Http, [app]);

  const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });

  return {
    id: options.id,
    creates,
    prebuilds,
    execs,
    calls,
    versions,
    hold: (held: Machine) => {
      machines.set(held.id, held);
    },
    held: () => [...machines.keys()],
    heldCheckpoints: () => [...checkpoints.keys()],
    routes,
    handler: (request: Request) => {
      versions.push(request.headers.get(versionHeader));

      return web.handler(request);
    },
    dispose: () => web.dispose(),
  };
};

export type StubHost = ReturnType<typeof stubHost>;

export class Silent {
  aborted = 0;
  readonly #reached = Promise.withResolvers<void>();
  readonly reached = Effect.promise(() => this.#reached.promise);

  arrive() {
    this.#reached.resolve();
  }
}

/** `slow` answers 100 ms late, and `lost` loses every reply after running it. */
export type Endpoint =
  | StubHost
  | "down"
  | Silent
  | { readonly slow: StubHost }
  | { readonly lost: StubHost };

const requestUrl = (input: string | URL | Request): URL =>
  new URL(input instanceof Request ? input.url : input);

const unanswered = (silent: Silent, signal: AbortSignal | null | undefined) =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      silent.aborted += 1;
      reject(new Error("aborted"));
    });
  });

export const transport = (
  endpoints: ReadonlyMap<string, Endpoint>,
): Layer.Layer<HttpClient.HttpClient> => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const endpoint = endpoints.get(requestUrl(input).origin);

    if (endpoint === undefined || endpoint === "down") {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    }

    if (endpoint instanceof Silent) {
      endpoint.arrive();

      return unanswered(endpoint, init?.signal);
    }

    if ("slow" in endpoint) {
      await new Promise((resolve) => setTimeout(resolve, 100));

      return endpoint.slow.handler(new Request(input, init));
    }

    if ("lost" in endpoint) {
      await endpoint.lost.handler(new Request(input, init));

      throw new TypeError("fetch failed", { cause: new Error("other side closed") });
    }

    return endpoint.handler(new Request(input, init));
  };

  return FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)));
};
