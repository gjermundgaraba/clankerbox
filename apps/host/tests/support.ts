import { createServer } from "node:http";
import path from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { requirements } from "@gjermundgaraba/clankerbox-sdk";
import type { Kind } from "@gjermundgaraba/clankerbox-sdk";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Context, Duration, Effect, Exit, Layer, Logger, Scope } from "effect";
import { HttpClient, HttpServer } from "effect/http";
import { expect } from "vite-plus/test";

import { hostLayer } from "../src/composition/host.ts";
import type { PortRange } from "../src/machine-ports.ts";
import { Operations } from "../src/operations.ts";
import type { Interface as OperationsInterface } from "../src/operations.ts";
import type { TailnetSettings } from "../src/platform/tailscale.ts";
import type { HostSettings } from "../src/settings.ts";
import type { Tailnet } from "../src/tailnet.ts";
import { fakeRuntime } from "./fake-runtime.ts";
import type { FakeOptions, FakeRuntime } from "./fake-runtime.ts";

export { loginSetup, writeTailscaleStubs } from "./fake-runtime.ts";

export const image = requirements.bases.linux.ubuntu;

const sharedPorts: PortRange = { first: 21_000, last: 21_099 };

export const quiet = Duration.hours(1);

export const hostConfig = (
  stateDir: string,
  machinePorts = sharedPorts,
  kind: Kind = "linux",
  id: string = kind
): HostSettings => ({
  id,
  kind,
  listen: { address: "127.0.0.1", port: 0 },
  bases: new Map([["ubuntu", image]]),
  stateDir,
  machinePorts,
});

export const loopbackServer = (port = 0) =>
  NodeHttpServer.layer(createServer, { host: "127.0.0.1", port });

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
    readonly kind?: Kind;
    readonly bases?: ReadonlyMap<string, string>;
    readonly logger?: Logger.Logger<unknown, unknown>;
    readonly runtime?: Omit<FakeOptions, "dir" | "kind">;
    readonly ports?: PortRange;
    readonly tailnet?: Layer.Layer<Tailnet>;
    readonly tailnetSettings?: TailnetSettings;
    readonly http?: Layer.Layer<HttpClient.HttpClient>;
  }
) =>
  Effect.gen(function* () {
    const fake =
      options?.fake ??
      fakeRuntime({ dir, kind: options?.kind, ...options?.runtime });

    const stateDir = path.join(dir, "state");
    const scope = yield* Scope.make();

    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

    const context = yield* Layer.buildWithScope(
      hostLayer(
        {
          ...hostConfig(stateDir, options?.ports, options?.kind, options?.id),
          ...(options?.bases === undefined ? {} : { bases: options.bases }),
          tailnet: options?.tailnetSettings,
        },
        fake.layer,
        loopbackServer(options?.port)
      ).pipe(
        Layer.provide(options?.tailnet ?? Layer.empty),
        Layer.provide(options?.http ?? noHttp),
        Layer.provideMerge(
          Logger.layer(options?.logger === undefined ? [] : [options.logger])
        ),
        Layer.provide(NodeServices.layer)
      ),
      scope
    );

    const host: TestHost = {
      id: options?.id ?? options?.kind ?? "linux",
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
