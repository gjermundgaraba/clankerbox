import { createServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import type { Server } from "node:net";
import path from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Context, Duration, Effect, Exit, Layer, Logger, Scope } from "effect";
import { HttpClient, HttpServer } from "effect/http";
import { expect } from "vite-plus/test";

import { BuildStore } from "../src/builds.ts";
import { hostLayer } from "../src/composition/host.ts";
import type { PortRange } from "../src/machine-ports.ts";
import { Operations } from "../src/operations.ts";
import type { Interface as OperationsInterface } from "../src/operations.ts";
import type { BuildsSettings } from "../src/platform/s3.ts";
import type { TailnetSettings } from "../src/platform/tailscale.ts";
import type {
  Admission,
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

export {
  fakedTraits as runtimeTraits,
  hostKeySetup,
  writeTailscaleStubs,
} from "./fake-runtime.ts";

export type { FakeRuntimeName } from "./fake-runtime.ts";

export const image = "registry.example/ubuntu@sha256:00";

const sharedPorts: PortRange = { first: 21_000, last: 21_099 };

export const quiet = Duration.hours(1);

export const hostConfig = (
  stateDir: string,
  machinePorts = sharedPorts,
  id = "smolvm"
): HostSettings => ({
  id,
  listen: { address: "127.0.0.1", port: 0 },
  bases: new Map([["ubuntu", image]]),
  stateDir,
  machinePorts,
});

/**
 * A test host's server, which ends as a kill does: it cuts the requests still open, as a control
 * plane's wait on a step, instead of answering them before it closes.
 */
export const loopbackServer = (port = 0) =>
  NodeHttpServer.layer(createServer, {
    host: "127.0.0.1",
    port,
    disablePreemptiveShutdown: true,
  });

export interface TestHost {
  readonly id: string;
  readonly dir: string;
  readonly fake: FakeRuntime;
  readonly stateDir: string;
  readonly url: string;
  readonly operations: OperationsInterface;
  readonly dispose: Effect.Effect<void>;
}

export const noHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() =>
    Effect.die("a test host made an HTTP request it was given no client for")
  )
);

export const startHost = (
  dir: string,
  options?: {
    readonly fake?: FakeRuntime;
    readonly id?: string;
    readonly port?: number;
    readonly as?: FakeRuntimeName;
    readonly bases?: ReadonlyMap<string, string>;
    readonly logger?: Logger.Logger<unknown, unknown>;
    readonly runtime?: Omit<FakeOptions, "dir" | "as">;
    readonly ports?: PortRange;
    readonly tailnet?: Layer.Layer<Tailnet>;
    readonly tailnetSettings?: TailnetSettings;
    readonly builds?: Layer.Layer<BuildStore>;
    readonly buildsSettings?: BuildsSettings;
    readonly http?: Layer.Layer<HttpClient.HttpClient>;
  }
) =>
  Effect.gen(function* () {
    const fake =
      options?.fake ??
      fakeRuntime({ dir, as: options?.as, ...options?.runtime });

    const stateDir = path.join(dir, "state");
    const scope = yield* Scope.make();

    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

    const context = yield* Layer.buildWithScope(
      hostLayer(
        {
          ...hostConfig(stateDir, options?.ports, options?.id ?? options?.as),
          ...(options?.bases === undefined ? {} : { bases: options.bases }),
          tailnet: options?.tailnetSettings,
          builds: options?.buildsSettings,
        },
        fake.layer,
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

    const host: TestHost = {
      id: options?.id ?? options?.as ?? "smolvm",
      dir,
      fake,
      stateDir,
      url: HttpServer.formatAddress(
        Context.get(context, HttpServer.HttpServer).address
      ),
      operations: Context.get(context, Operations),
      dispose: Scope.close(scope, Exit.void),
    };

    return host;
  });

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
