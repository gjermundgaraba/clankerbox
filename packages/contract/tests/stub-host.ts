/**
 * A stub host served in memory through the real effect-actions routes, and a transport that
 * sends each request to the stub named by its URL's origin.
 */
import { DateTime, Effect, Layer } from "effect";
import { FetchHttpClient, type HttpClient, HttpRouter, HttpServer } from "effect/http";
import {
  type Checkpoint,
  CheckpointGroup,
  type CreateRequest,
  type HostError,
  HostGroup,
  Http,
  type Machine,
  MachineGroup,
  NotFound,
  type Runtime,
  version,
} from "../src/index.ts";

export interface StubHostOptions {
  readonly id: string;
  readonly bases: ReadonlyArray<string>;
  readonly runtime?: Runtime;
  /** The clankerbox version the host reports, the SDK's by default. */
  readonly version?: string;
  /** Replaces the create handler, for example to refuse with `Capacity` or to run long. */
  readonly create?: (request: CreateRequest) => Effect.Effect<Machine, HostError>;
  /** Machines the host already holds. */
  readonly machines?: ReadonlyArray<Machine>;
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
  action: { name: "create", status: "done" },
  ...fields,
});

export const stubHost = (options: StubHostOptions) => {
  const runtime = options.runtime ?? "smolvm";
  const machines = new Map<string, Machine>();
  const checkpoints = new Map<string, Checkpoint>();
  const creates: Array<CreateRequest> = [];
  const calls: Array<string> = [];

  for (const held of options.machines ?? []) {
    machines.set(held.id, held);
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

  const add = (made: Machine) =>
    Effect.sync(() => {
      machines.set(made.id, made);

      return made;
    });

  const create = (request: CreateRequest) =>
    options.create === undefined
      ? add(
          machine(request.id, {
            runtime,
            base: request.base,
            cpu: request.cpu,
            ramMib: request.ramMib,
            diskGib: request.diskGib,
          }),
        )
      : options.create(request);

  const machineApp = MachineGroup.implement({
    list: () => Effect.as(record("machine.list"), [...machines.values()]),
    get: ({ id }) => Effect.andThen(record("machine.get"), find(id)),
    create: (request) =>
      Effect.andThen(
        Effect.sync(() => creates.push(request)),
        Effect.andThen(record("machine.create"), create(request)),
      ),
    start: ({ id }) => Effect.andThen(record("machine.start"), find(id)),
    stop: ({ id }) =>
      Effect.andThen(
        record("machine.stop"),
        Effect.map(find(id), (found): Machine => ({ ...found, state: "stopped" })),
      ),
    delete: ({ id }) =>
      Effect.andThen(
        record("machine.delete"),
        Effect.andThen(
          find(id),
          Effect.sync(() => machines.delete(id)),
        ),
      ),
    fork: ({ machine: source, name }) =>
      Effect.andThen(
        record("machine.fork"),
        Effect.flatMap(find(source), (found) => add({ ...found, id: `${options.id}_${name}` })),
      ),
    restore: ({ checkpoint, name }) =>
      Effect.andThen(
        record("machine.restore"),
        Effect.flatMap(findCheckpoint(checkpoint), (found) =>
          add(
            machine(`${options.id}_${name}`, {
              runtime,
              base: found.base,
              cpu: found.cpu,
              ramMib: found.ramMib,
              diskGib: found.diskGib,
              action: { name: "restore", status: "done" },
            }),
          ),
        ),
      ),
  });

  const checkpointApp = CheckpointGroup.implement({
    list: () => Effect.as(record("checkpoint.list"), [...checkpoints.values()]),
    get: ({ id }) => Effect.andThen(record("checkpoint.get"), findCheckpoint(id)),
    capture: ({ machine: source, name }) =>
      Effect.andThen(
        record("checkpoint.capture"),
        Effect.flatMap(find(source), (found) =>
          Effect.sync(() => {
            const made: Checkpoint = {
              id: `${options.id}_${name}`,
              createdAt: found.createdAt,
              machine: found.id,
              kind: "disk",
              base: found.base,
              cpu: found.cpu,
              ramMib: found.ramMib,
              diskGib: found.diskGib,
              action: { name: "capture", status: "done" },
            };

            checkpoints.set(made.id, made);

            return made;
          }),
        ),
      ),
    delete: ({ id }) =>
      Effect.andThen(
        record("checkpoint.delete"),
        Effect.andThen(
          findCheckpoint(id),
          Effect.sync(() => checkpoints.delete(id)),
        ),
      ),
  });

  const hostApp = HostGroup.implement({
    get: () =>
      Effect.as(record("host.get"), {
        id: options.id,
        runtime,
        version: options.version ?? version,
        runtimeVersion: "1.22.2",
        bases: options.bases,
      }),
  });

  const routes = Http.layer([machineApp, checkpointApp, hostApp]);

  const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });

  return {
    id: options.id,
    /** Every create request the host received, in order. */
    creates,
    /** Every action the host ran, as `<group>.<action>`. */
    calls,
    /** The host's routes, to serve on a real HTTP server. */
    routes,
    handler: (request: Request) => web.handler(request),
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
