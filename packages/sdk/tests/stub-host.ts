/**
 * A stub host served in memory through the real effect-actions routes, and a transport that
 * sends each request to the stub named by its URL's origin.
 */
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { DateTime, Effect, Layer } from "effect";
import { FetchHttpClient, type HttpClient, HttpRouter, HttpServer } from "effect/http";
import {
  type Checkpoint,
  Conflict,
  type CreateRequest,
  type HostError,
  Http,
  type Limit,
  type Machine,
  NotFound,
  type Runtime,
  version,
  versionHeader,
} from "../src/index.ts";

export interface StubHostOptions {
  readonly id: string;
  readonly bases: ReadonlyArray<string>;
  readonly runtime?: Runtime;
  /** The runtime's version the host reports. Default: 1.27.3. */
  readonly runtimeVersion?: string;
  /** Replaces the create handler, for example to refuse with `Capacity` or to run long. */
  readonly create?: (request: CreateRequest) => Effect.Effect<Machine, HostError>;
  /** Replaces the machine delete handler, for example to fail it. */
  readonly deleteMachine?: (id: string) => Effect.Effect<void, HostError>;
  /** Runs before each create's default handler, for example to hold two creates at once. */
  readonly beforeCreate?: (request: CreateRequest) => Effect.Effect<void>;
  /** Machines the host already holds. */
  readonly machines?: ReadonlyArray<Machine>;
  /** Checkpoints the host already holds. */
  readonly checkpoints?: ReadonlyArray<Checkpoint>;
  /** The limits the host reports, each under its own ID. Default: none. */
  readonly capacity?: ReadonlyArray<Omit<Limit, "host">>;
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
  action: { name: "create", status: "done" },
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

  /** The host takes a name once per resource type, as a real host's claim does. */
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

  /** A machine or checkpoint with the label its source carries, if it carries one. */
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
            action: { name: "restore", status: "done" },
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
                  action: { name: "capture", status: "done" },
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
    /** Every create request the host received, in order. */
    creates,
    /** Every action the host ran, labelled such as `machine.start`. */
    calls,
    /** The version header of every request the host received, in order. */
    versions,
    /**
     * Holds `machine`, replacing one of its ID: as a create that failed after its row was inserted
     * leaves one, or as a start that moved its endpoint does.
     */
    hold: (held: Machine) => {
      machines.set(held.id, held);
    },
    /** The IDs of the machines the host holds now. */
    held: () => [...machines.keys()],
    /** The host's routes, to serve on a real HTTP server. */
    routes,
    handler: (request: Request) => {
      versions.push(request.headers.get(versionHeader));

      return web.handler(request);
    },
    dispose: () => web.dispose(),
  };
};

export type StubHost = ReturnType<typeof stubHost>;

/** A host that never answers; `aborted` counts the requests the client gave up on. */
export class Silent {
  aborted = 0;
}

/**
 * How a host behaves on the network: served, down, never answering, answering 100 ms late,
 * or losing every reply after running it.
 */
export type Endpoint =
  | StubHost
  | "down"
  | Silent
  | { readonly slow: StubHost }
  | { readonly lost: StubHost };

const requestUrl = (input: string | URL | Request): URL =>
  new URL(input instanceof Request ? input.url : input);

/** A request that never gets an answer, until the client gives up on it. */
const unanswered = (silent: Silent, signal: AbortSignal | null | undefined) =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      silent.aborted += 1;
      reject(new Error("aborted"));
    });
  });

/**
 * An HTTP client whose requests go to the stub named by their URL's origin, through the
 * stub's real router. A `down` origin, or one no stub serves, fails like a refused connection.
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
