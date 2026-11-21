import { once } from "node:events";
import { connect, createServer as createTcpServer } from "node:net";
import type { Server } from "node:net";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import {
  read as readFile,
  scratch,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import {
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  Predicate,
  Schedule,
  Scope,
} from "effect";
import { HttpClient, HttpServer } from "effect/http";
import { expect } from "vite-plus/test";

import { hostLayer, hostServer } from "../src/composition/host.ts";
import { Operations } from "../src/operations.ts";
import type { Interface as OperationsInterface } from "../src/operations.ts";
import type { Store } from "../src/platform/bucket/builds.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  Admission,
  Interface as RuntimeInterface,
} from "../src/runtime.ts";
import type { PortRange, HostSettings } from "../src/settings.ts";
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
  hostServer({ listen: { address: "127.0.0.1", port } });

export interface HostOptions {
  readonly id?: string;
  readonly port?: number;
  readonly bases?: ReadonlyMap<string, string>;
  readonly logger?: Logger.Logger<unknown, unknown>;
  readonly ports?: PortRange;
  readonly tailnet?: boolean;
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
          tailnet: options?.tailnet,
        },
        runtime(settings),
        loopbackServer(options?.port)
      ).pipe(
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
    readonly runtime?: Omit<FakeOptions, "dir" | "as" | "builds">;
    readonly builds?: Store;
  }
) => {
  const fake =
    options?.fake ??
    fakeRuntime({
      dir,
      as: options?.as,
      builds: options?.builds,
      ...options?.runtime,
    });

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

export const memoryBuildStore = () => {
  const objects = new Map<string, Uint8Array>();
  const downloaded: string[] = [];

  const store: Store = {
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
  };

  return {
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

export const connection = (url: string) =>
  Effect.promise(async () => {
    const socket = connect(Number(new URL(url).port), "127.0.0.1");
    const chunks: Buffer[] = [];

    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on("error", () => {
      socket.destroy();
    });

    await once(socket, "connect");

    return {
      socket,
      read: () => Buffer.concat(chunks).toString(),
      closedWithin: (wait: Duration.Duration) =>
        Effect.sync(() => socket.closed).pipe(
          Effect.repeat({
            until: (closed) => closed,
            schedule: Schedule.spaced(Duration.millis(10)),
          }),
          Effect.timeoutOption(wait),
          Effect.map(Option.isSome)
        ),
    };
  });

export const emptyAnswer = (read: string) => {
  const end = read.indexOf("\r\n\r\n");
  const head = read.slice(0, end).toLowerCase();
  const body = read.slice(end + 4);

  const whole =
    end !== -1 &&
    ((body === "" && head.includes("\r\ncontent-length: 0")) ||
      (body === "0\r\n\r\n" &&
        head.includes("\r\ntransfer-encoding: chunked")));

  return whole ? read.slice(0, read.indexOf("\r\n")) : `not whole: ${read}`;
};

export const waitFor = (file: string, text: string) =>
  Effect.orElseSucceed(readFile(file), () => "").pipe(
    Effect.repeat({
      until: (contents) => contents.includes(text),
      schedule: Schedule.spaced(Duration.millis(10)),
    })
  );

const dev = {
  name: "dev",
  instance: "0f3a9c1e",
  cpu: 1,
  ramMib: 512,
  diskGib: 10,
};

export const madeOn = (as: FakeRuntimeName) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const fake = fakeRuntime({ dir, as });
    const runtime = Context.get(yield* Layer.build(fake.layer), Runtime);

    const { handle } = yield* runtime.make(dev, { _tag: "image", image }, 2222);

    return {
      runtime,
      fake,
      bin: path.join(dir, "bin"),
      machine: { ...dev, handle },
    };
  });

export const based = madeOn("smolvm");
