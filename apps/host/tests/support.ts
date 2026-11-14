import { once } from "node:events";
import { createServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import type { Server } from "node:net";
import path from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import {
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Logger,
  Predicate,
  Scope,
} from "effect";
import { HttpClient, HttpServer } from "effect/http";
import { expect } from "vite-plus/test";

import { BuildStore } from "../src/builds.ts";
import { hostLayer, listening } from "../src/composition/host.ts";
import type { PortRange } from "../src/machine-ports.ts";
import { Operations } from "../src/operations.ts";
import type { Interface as OperationsInterface } from "../src/operations.ts";
import type { BuildsSettings } from "../src/platform/s3.ts";
import type { TailnetSettings } from "../src/platform/tailscale.ts";
import type {
  Admission,
  Runtime,
  Interface as RuntimeInterface,
} from "../src/runtime.ts";
import type { HostSettings } from "../src/settings.ts";
import type { Tailnet } from "../src/tailnet.ts";
import { fakeRuntime } from "./fake-runtime.ts";
import type {
  FakeOptions,
  FakeRuntime,
  FakeRuntimeName,
} from "./fake-runtime.ts";
import { suitePorts } from "./port-slot.ts";

export { suitePorts } from "./port-slot.ts";

export { hostKeySetup, presets, writeTailscaleStubs } from "./fake-runtime.ts";

export type { FakeRuntimeName } from "./fake-runtime.ts";

export const image = "registry.example/ubuntu@sha256:00";

export const quiet = Duration.hours(1);

export const hostConfig = (
  stateDir: string,
  machinePorts: PortRange = suitePorts.shared,
  id = "smolvm"
): HostSettings => ({
  id,
  listen: { address: "127.0.0.1", port: 0 },
  bases: new Map([["ubuntu", image]]),
  stateDir,
  machinePorts,
});

export const loopbackServer = (port = 0) =>
  NodeHttpServer.layer(
    createServer,
    listening({ listen: { address: "127.0.0.1", port } })
  );

export interface HostOptions {
  readonly id?: string;
  readonly port?: number;
  readonly bases?: ReadonlyMap<string, string>;
  readonly logger?: Logger.Logger<unknown, unknown>;
  readonly ports?: PortRange;
  readonly tailnet?: Layer.Layer<Tailnet>;
  readonly tailnetSettings?: TailnetSettings;
  readonly builds?: Layer.Layer<BuildStore>;
  readonly buildsSettings?: BuildsSettings;
  readonly http?: Layer.Layer<HttpClient.HttpClient>;
}

export interface ServedHost {
  readonly id: string;
  readonly dir: string;
  readonly stateDir: string;
  readonly url: string;
  readonly operations: OperationsInterface;
  readonly dispose: Effect.Effect<void>;
}

export interface TestHost extends ServedHost {
  readonly fake: FakeRuntime;
}

export const noHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() =>
    Effect.die("a test host made an HTTP request it was given no client for")
  )
);

/**
 * A host over the runtime `runtime` makes of its settings, on loopback. It ends with the scope, or
 * at `dispose`.
 */
export const startHostOver = <E>(
  dir: string,
  runtime: (
    settings: HostSettings
  ) => Layer.Layer<
    Runtime,
    E,
    NodeServices.NodeServices | HttpClient.HttpClient
  >,
  options?: HostOptions
) =>
  Effect.gen(function* () {
    const id = options?.id ?? "smolvm";
    const stateDir = path.join(dir, "state");
    const scope = yield* Scope.make();

    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

    const settings: HostSettings = {
      ...hostConfig(stateDir, options?.ports, id),
      ...(options?.bases === undefined ? {} : { bases: options.bases }),
    };

    const context = yield* Layer.buildWithScope(
      hostLayer(
        {
          ...settings,
          tailnet: options?.tailnetSettings,
          builds: options?.buildsSettings,
        },
        runtime(settings),
        loopbackServer(options?.port)
      ).pipe(
        Layer.provide(options?.tailnet ?? Layer.empty),
        Layer.provide(options?.builds ?? Layer.empty),
        Layer.provide(options?.http ?? noHttp),
        Layer.provideMerge(
          Logger.layer(options?.logger === undefined ? [] : [options.logger])
        ),
        Layer.provide(NodeServices.layer)
      ),
      scope
    );

    const host: ServedHost = {
      id,
      dir,
      stateDir,
      url: HttpServer.formatAddress(
        Context.get(context, HttpServer.HttpServer).address
      ),
      operations: Context.get(context, Operations),
      dispose: Scope.close(scope, Exit.void),
    };

    return host;
  });

export const startHost = (
  dir: string,
  options?: HostOptions & {
    readonly fake?: FakeRuntime;
    readonly as?: FakeRuntimeName;
    readonly runtime?: Omit<FakeOptions, "dir" | "as">;
  }
) => {
  const fake =
    options?.fake ?? fakeRuntime({ dir, as: options?.as, ...options?.runtime });

  return Effect.map(
    startHostOver(dir, () => fake.layer, {
      ...options,
      id: options?.id ?? options?.as ?? "smolvm",
    }),
    (host): TestHost => ({ ...host, fake })
  );
};

export const hostOn =
  (ports: PortRange) =>
  (options?: Parameters<typeof startHost>[1] & { readonly dir?: string }) =>
    Effect.gen(function* () {
      return yield* startHost(options?.dir ?? (yield* scratch), {
        ports,
        ...options,
      });
    });

/** A build store in memory, which every host given it shares, and what was downloaded from it. */
export const memoryBuildStore = () => {
  const objects = new Map<string, Uint8Array>();
  const downloaded: string[] = [];

  const store = BuildStore.of({
    list: (prefix) =>
      Effect.sync(() =>
        [...objects.keys()].filter((key) => key.startsWith(prefix)).toSorted()
      ),
    get: (key) =>
      Effect.suspend(() => {
        const found = objects.get(key);

        downloaded.push(key);

        return found === undefined
          ? Effect.fail(
              new Internal({ message: `the build store has no ${key}` })
            )
          : Effect.succeed(found);
      }),
    put: (key, body) =>
      Effect.sync(() => {
        objects.set(key, body);
      }),
    remove: (keys) =>
      Effect.sync(() => {
        for (const key of keys) {
          objects.delete(key);
        }
      }),
  });

  return {
    layer: Layer.succeed(BuildStore, store),
    store,
    objects,
    downloaded,
  };
};

export const admitOn = (runtime: RuntimeInterface): Admission["admit"] =>
  runtime.admission?.admit ?? (() => Effect.die("the runtime admits"));

export const accepts = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resume(Effect.succeed(true));
    });

    socket.once("error", () => {
      resume(Effect.succeed(false));
    });
  });

/** A loopback port the OS found free, for a test that listens on it. */
export const freePort = Effect.callback<number>((resume) => {
  const server = createTcpServer();

  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    const found = server.address();

    server.close(() => {
      resume(
        found === null || Predicate.isString(found)
          ? Effect.die(`a free port was answered as ${String(found)}`)
          : Effect.succeed(found.port)
      );
    });
  });
});

/** Whether another program could bind the loopback port now: it lets go of it at once. */
export const strangerBinds = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const server = createTcpServer();

    server.once("error", () => {
      resume(Effect.succeed(false));
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => {
        resume(Effect.succeed(true));
      });
    });
  });

/** What a loopback port echoes of the payload, once the client has sent it all. */
export const roundTrip = (port: number, payload: string) =>
  Effect.promise(async () => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];

    await once(socket, "connect");
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    const ended = once(socket, "end");

    socket.end(payload);
    await ended;
    socket.destroy();

    return Buffer.concat(chunks).toString();
  });

export const holding = (port: number) =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createTcpServer();

      server.listen({ host: "127.0.0.1", port }, () => {
        resume(Effect.succeed(server));
      });
    }),
    (server) =>
      Effect.callback<undefined>((resume) => {
        server.close(() => {
          resume(Effect.undefined);
        });
      })
  );

export const pause = Effect.sleep(Duration.millis(50));

export const eventually = <A, E>(
  read: Effect.Effect<A, E>,
  done: (value: A) => boolean
) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 100; tries += 1) {
      const value = yield* read;

      if (done(value)) {
        return value;
      }

      yield* pause;
    }

    const last = yield* read;

    expect(done(last), `never got there: ${JSON.stringify(last)}`).toBe(true);

    return last;
  });

/** The checkpoint files a runtime keeps, which a test's runtime must. */
export const filesOf = (runtime: RuntimeInterface) =>
  runtime.files === undefined
    ? Effect.die(`the ${runtime.traits.runtime} runtime keeps no files`)
    : Effect.succeed(runtime.files);
