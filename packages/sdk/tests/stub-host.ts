import { setTimeout as sleep } from "node:timers/promises";

import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { DateTime, Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import type { HttpClient } from "effect/http";

import {
  Conflict,
  Http,
  NotFound,
  version,
  versionHeader,
} from "../src/index.ts";
import type {
  Checkpoint,
  CreateRequest,
  Declared,
  Executed,
  ExecRequest,
  Machine,
  PrebuildRequest,
  Kind,
  Reading,
  Sizing,
} from "../src/index.ts";

export interface StubHostOptions {
  readonly id: string;
  readonly bases: readonly string[];
  readonly kind?: Kind;
  /** Default: 0.0.0-test. */
  readonly runtimeVersion?: string;
  /** Default: running. */
  readonly create?: (
    request: CreateRequest
  ) => Effect.Effect<Machine, Declared<"createMachine">>;
  /** Replaces the default prebuild, which captures a builder of its own over any checkpoint of its ID. */
  readonly prebuild?: (
    request: PrebuildRequest
  ) => Effect.Effect<Checkpoint, Declared<"prebuildCheckpoint">>;
  readonly machines?: readonly Machine[];
  readonly checkpoints?: readonly Checkpoint[];
  /** What every restore fails with. Default: none. */
  readonly restoreFails?: Declared<"restoreMachine">;
  /** Default: none. */
  readonly capacity?: readonly Reading[];
  /** Default: exit 0 with no output, in a machine the stub holds. */
  readonly exec?: (
    request: ExecRequest
  ) => Effect.Effect<Executed, Declared<"execMachine">>;
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

export const checkpoint = (
  id: string,
  fields?: Partial<Checkpoint>
): Checkpoint => ({
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

const taken = (held: ReadonlyMap<string, unknown>, id: string) =>
  held.has(id)
    ? Effect.fail(new Conflict({ message: `${id} exists` }))
    : Effect.void;

const labelled = <A extends Machine | Checkpoint>(
  made: A,
  profile: string | undefined
): A => (profile === undefined ? made : { ...made, profile });

const sized = (found: Machine | Checkpoint, sizes: Sizing) => ({
  cpu: sizes.cpu ?? found.cpu,
  ramMib: sizes.ramMib ?? found.ramMib,
  diskGib: sizes.diskGib ?? found.diskGib,
});

export const stubHost = (options: StubHostOptions) => {
  const kind = options.kind ?? "linux";
  const machines = new Map<string, Machine>();
  const checkpoints = new Map<string, Checkpoint>();
  const creates: CreateRequest[] = [];
  const prebuilds: PrebuildRequest[] = [];
  const execs: ExecRequest[] = [];
  const calls: string[] = [];
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

  const settled = (
    found: Machine,
    state: Machine["state"],
    desired: Machine["desired"]
  ) => {
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

  const add = (made: Machine) =>
    Effect.andThen(
      taken(machines, made.id),
      Effect.sync(() => {
        machines.set(made.id, made);

        return made;
      })
    );

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
            request.profile
          )
        )
      : options.create(request);

  const restore = (source: string, name: string, sizes: Sizing = {}) =>
    Effect.flatMap(findCheckpoint(source), (found) =>
      add(
        labelled(
          machine(`${options.id}_${name}`, {
            kind,
            base: found.base,
            ...sized(found, sizes),
          }),
          found.profile
        )
      )
    );

  const prebuild = (
    request: PrebuildRequest
  ): Effect.Effect<Checkpoint, Declared<"prebuildCheckpoint">> => {
    if (options.prebuild !== undefined) {
      return options.prebuild(request);
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
        request.profile
      );

      checkpoints.set(made.id, made);

      return made;
    });
  };

  const app = Action.implement(Http.actions, {
    listMachines: () =>
      Effect.as(record("machine.list"), [...machines.values()]),
    getMachine: ({ id }) => Effect.andThen(record("machine.get"), find(id)),
    createMachine: (request) =>
      Effect.andThen(
        Effect.sync(() => creates.push(request)),
        Effect.andThen(record("machine.create"), create(request))
      ),
    execMachine: (request) =>
      Effect.andThen(
        Effect.sync(() => execs.push(request)),
        Effect.andThen(
          record("machine.exec"),
          options.exec === undefined
            ? Effect.as(find(request.id), {
                exitCode: 0,
                output: "",
                truncated: false,
              })
            : options.exec(request)
        )
      ),
    startMachine: ({ id }) =>
      Effect.andThen(
        record("machine.start"),
        Effect.map(find(id), (found) => settled(found, "running", "running"))
      ),
    stopMachine: ({ id }) =>
      Effect.andThen(
        record("machine.stop"),
        Effect.map(find(id), (found) => settled(found, "stopped", "stopped"))
      ),
    pauseMachine: ({ id }) =>
      Effect.andThen(
        record("machine.pause"),
        Effect.map(find(id), (found) =>
          settled(
            found,
            found.state === "stopped" ? "stopped" : "paused",
            "paused"
          )
        )
      ),
    resizeMachine: ({ id, ...sizes }) =>
      Effect.andThen(
        record("machine.resize"),
        Effect.map(find(id), (found) => {
          const now: Machine = { ...found, ...sized(found, sizes) };

          machines.set(now.id, now);

          return now;
        })
      ),
    deleteMachine: ({ id }) =>
      Effect.andThen(
        record("machine.delete"),
        Effect.andThen(
          find(id),
          Effect.sync(() => machines.delete(id))
        )
      ),
    forkMachine: ({ machine: source, name, ...sizes }) =>
      Effect.andThen(
        record("machine.fork"),
        Effect.flatMap(find(source), (found) =>
          add({ ...found, id: `${options.id}_${name}`, ...sized(found, sizes) })
        )
      ),
    restoreMachine: ({ checkpoint: source, name, ...sizes }) =>
      Effect.andThen(
        record("machine.restore"),
        options.restoreFails === undefined
          ? restore(source, name, sizes)
          : Effect.fail(options.restoreFails)
      ),
    listCheckpoints: () =>
      Effect.as(record("checkpoint.list"), [...checkpoints.values()]),
    getCheckpoint: ({ id }) =>
      Effect.andThen(record("checkpoint.get"), findCheckpoint(id)),
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
                found.profile
              );

              checkpoints.set(made.id, made);

              return made;
            })
          )
        )
      ),
    deleteCheckpoint: ({ id }) =>
      Effect.andThen(
        record("checkpoint.delete"),
        Effect.andThen(
          findCheckpoint(id),
          Effect.sync(() => checkpoints.delete(id))
        )
      ),
    prebuildCheckpoint: (request) =>
      Effect.andThen(
        Effect.sync(() => prebuilds.push(request)),
        Effect.andThen(record("checkpoint.prebuild"), prebuild(request))
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
        (options.capacity ?? []).map((limit) => ({
          host: options.id,
          ...limit,
        }))
      ),
  });

  const routes = ActionHttp.layer(Http, [app]);

  const web = HttpRouter.toWebHandler(
    routes.pipe(Layer.provide(HttpServer.layerServices)),
    {
      disableLogger: true,
    }
  );

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
    handler: async (request: Request) => {
      versions.push(request.headers.get(versionHeader));

      return await web.handler(request);
    },
    dispose: async () => {
      await web.dispose();
    },
  };
};

export type StubHost = ReturnType<typeof stubHost>;

export class Silent {
  aborted = 0;
  readonly #reached = Promise.withResolvers<undefined>();
  readonly reached = Effect.promise(async () => {
    await this.#reached.promise;
  });

  arrive() {
    this.#reached.resolve(undefined);
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

const unanswered = async (
  silent: Silent,
  signal: AbortSignal | null | undefined
) => {
  const { promise, reject } = Promise.withResolvers<Response>();

  signal?.addEventListener("abort", () => {
    silent.aborted += 1;
    reject(new Error("aborted"));
  });

  return await promise;
};

export const transport = (
  endpoints: ReadonlyMap<string, Endpoint>
): Layer.Layer<HttpClient.HttpClient> => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const endpoint = endpoints.get(requestUrl(input).origin);

    if (endpoint === undefined || endpoint === "down") {
      throw new TypeError("fetch failed", {
        cause: new Error("connect ECONNREFUSED"),
      });
    }

    if (endpoint instanceof Silent) {
      endpoint.arrive();

      return await unanswered(endpoint, init?.signal);
    }

    if ("slow" in endpoint) {
      await sleep(100);

      return await endpoint.slow.handler(new Request(input, init));
    }

    if ("lost" in endpoint) {
      await endpoint.lost.handler(new Request(input, init));

      throw new TypeError("fetch failed", {
        cause: new Error("other side closed"),
      });
    }

    return await endpoint.handler(new Request(input, init));
  };

  return FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
  );
};
