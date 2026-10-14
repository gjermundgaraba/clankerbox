import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { DateTime, Effect, Layer } from "effect";
import { FetchHttpClient, type HttpClient, HttpRouter, HttpServer } from "effect/http";
import {
  actionsByName,
  type Checkpoint,
  type Client,
  Conflict,
  type CreateRequest,
  type Host,
  Http,
  type Machine,
  NotFound,
  type Reading,
  type Runtime,
  version,
  versionHeader,
} from "../src/index.ts";

/** What the contract lets action `N` fail with. */
type Declared<N extends Client.HostAction> = (typeof actionsByName)[N]["error"][number]["Type"];

export interface StubHostOptions {
  readonly id: string;
  readonly bases: ReadonlyArray<string>;
  readonly runtime?: Runtime;
  /** Default: 1.27.3. */
  readonly runtimeVersion?: string;
  /** Default: running. */
  readonly captureFrom?: Host["captureFrom"];
  readonly create?: (request: CreateRequest) => Effect.Effect<Machine, Declared<"createMachine">>;
  readonly deleteMachine?: (id: string) => Effect.Effect<void, Declared<"deleteMachine">>;
  /** Runs before each create's default handler, such as to hold two creates at once. */
  readonly beforeCreate?: (request: CreateRequest) => Effect.Effect<void>;
  readonly machines?: ReadonlyArray<Machine>;
  readonly checkpoints?: ReadonlyArray<Checkpoint>;
  /** Default: none. */
  readonly capacity?: ReadonlyArray<Reading>;
}

export const machine = (id: string, fields?: Partial<Machine>): Machine => ({
  id,
  runtime: "smolvm",
  createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
  base: "ubuntu",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  state: "running",
  made: true,
  action: { name: "createMachine", status: "done" },
  ...fields,
});

/** A ready checkpoint of the machine `machine` makes by default, unless `fields` say otherwise. */
export const checkpoint = (id: string, fields?: Partial<Checkpoint>): Checkpoint => ({
  id,
  createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
  machine: id,
  kind: "disk",
  base: "ubuntu",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  action: { name: "captureCheckpoint", status: "done" },
  ...fields,
});

export const stubHost = (options: StubHostOptions) => {
  const runtime = options.runtime ?? "smolvm";
  const machines = new Map<string, Machine>();
  const checkpoints = new Map<string, Checkpoint>();
  const creates: Array<CreateRequest> = [];
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

  const findCheckpoint = (id: string) => {
    const found = checkpoints.get(id);

    return found === undefined
      ? Effect.fail(new NotFound({ message: `no checkpoint ${id}` }))
      : Effect.succeed(found);
  };

  const taken = (held: ReadonlyMap<string, unknown>, id: string) =>
    held.has(id)
      ? Effect.fail(new Conflict({ message: `${id} exists`, kind: "exists" }))
      : Effect.void;

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
      ? Effect.andThen(
          options.beforeCreate?.(request) ?? Effect.void,
          add(
            labelled(
              machine(request.id, {
                runtime,
                base: request.base,
                cpu: request.cpu,
                ramMib: request.ramMib,
                diskGib: request.diskGib,
              }),
              request.profile,
            ),
          ),
        )
      : options.create(request);

  const restore = (checkpoint: string, name: string) =>
    Effect.flatMap(findCheckpoint(checkpoint), (found) =>
      add(
        labelled(
          machine(`${options.id}_${name}`, {
            runtime,
            base: found.base,
            cpu: found.cpu,
            ramMib: found.ramMib,
            diskGib: found.diskGib,
            action: { name: "restoreMachine", status: "done" },
          }),
          found.profile,
        ),
      ),
    );

  const app = Action.implement(Http.actions, {
    listMachines: () => Effect.as(record("machine.list"), [...machines.values()]),
    getMachine: ({ id }) => Effect.andThen(record("machine.get"), find(id)),
    createMachine: (request) =>
      Effect.andThen(
        Effect.sync(() => creates.push(request)),
        Effect.andThen(record("machine.create"), create(request)),
      ),
    startMachine: ({ id }) => Effect.andThen(record("machine.start"), find(id)),
    stopMachine: ({ id }) =>
      Effect.andThen(
        record("machine.stop"),
        Effect.map(find(id), (found): Machine => ({ ...found, state: "stopped" })),
      ),
    deleteMachine: ({ id }) =>
      Effect.andThen(
        record("machine.delete"),
        options.deleteMachine === undefined
          ? Effect.andThen(
              find(id),
              Effect.sync(() => machines.delete(id)),
            )
          : options.deleteMachine(id),
      ),
    forkMachine: ({ machine: source, name }) =>
      Effect.andThen(
        record("machine.fork"),
        Effect.flatMap(find(source), (found) => add({ ...found, id: `${options.id}_${name}` })),
      ),
    restoreMachine: ({ checkpoint, name }) =>
      Effect.andThen(record("machine.restore"), restore(checkpoint, name)),
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
                  action: { name: "captureCheckpoint", status: "done" },
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
    getHost: () =>
      Effect.as(record("host.get"), {
        id: options.id,
        runtime,
        version,
        runtimeVersion: options.runtimeVersion ?? "1.27.3",
        captureFrom: options.captureFrom ?? "running",
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
    /** Labelled such as `machine.start`. */
    calls,
    versions,
    /** Replaces the machine of its ID, as a failed create or a moved endpoint does. */
    hold: (held: Machine) => {
      machines.set(held.id, held);
    },
    held: () => [...machines.keys()],
    /** To serve on a real HTTP server. */
    routes,
    handler: (request: Request) => {
      versions.push(request.headers.get(versionHeader));

      return web.handler(request);
    },
    dispose: () => web.dispose(),
  };
};

export type StubHost = ReturnType<typeof stubHost>;

/**
 * Never answers; `aborted` counts the requests the client gave up on, and `reached` settles once
 * a request has arrived, after the client started its timer.
 */
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

/**
 * Sends each request to the stub named by its URL's origin, through the real router. A `down`
 * origin, or one no stub serves, fails like a refused connection.
 */
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
