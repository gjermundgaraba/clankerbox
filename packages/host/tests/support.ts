import { createServer } from "node:http";
import { join } from "node:path";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { CreateRequest, Machine } from "@gjermundgaraba/clankerbox-sdk";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing";
import { Context, Duration, Effect, Exit, Layer, Logger, Scope } from "effect";
import { HttpClient, HttpServer } from "effect/http";
import { expect } from "vite-plus/test";
import * as Checkpoints from "../src/checkpoints.ts";
import { hostLayer } from "../src/composition/host.ts";
import * as Machines from "../src/machines.ts";
import type { PortRange } from "../src/machine-ports.ts";
import type { TailnetSettings } from "../src/platform/tailscale.ts";
import type { Tailnet } from "../src/tailnet.ts";
import type { HostSettings } from "../src/settings.ts";
import * as Store from "../src/store.ts";
import { type FakeOptions, type FakeRuntime, fakeRuntime } from "./fake-runtime.ts";

export const image =
  "mirror.gcr.io/library/ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7";

const sharedPorts: PortRange = { first: 21_000, last: 21_099 };

export const quiet = Duration.hours(1);

export const hostConfig = (
  stateDir: string,
  machinePorts = sharedPorts,
  recheck = quiet,
): HostSettings => ({
  id: "linux",
  runtime: "smolvm",
  listen: { address: "127.0.0.1", port: 0 },
  bases: new Map([["ubuntu", image]]),
  stateDir,
  machinePorts,
  recheck,
});

export const request = (name: string, fields?: Partial<CreateRequest>): CreateRequest => ({
  id: `linux_${name}`,
  base: "ubuntu",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  ...fields,
});

export const loopbackServer = (port = 0) =>
  NodeHttpServer.layer(createServer, { host: "127.0.0.1", port });

export interface TestHost {
  readonly dir: string;
  readonly fake: FakeRuntime;
  readonly stateDir: string;
  readonly url: string;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, Machines.Machines | Checkpoints.Checkpoints | Store.Store>,
  ) => Effect.Effect<A, E>;
  readonly machines: Machines.Interface;
  readonly checkpoints: Checkpoints.Interface;
  readonly store: Store.Interface;
  /** Ends the host early; the test's scope ends it otherwise. */
  readonly dispose: Effect.Effect<void>;
}

export const noHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("a test host made an HTTP request it was given no client for")),
);

export const startHost = (
  dir: string,
  options?: {
    readonly fake?: FakeRuntime;
    readonly runtime?: Omit<FakeOptions, "dir">;
    readonly ports?: PortRange;
    readonly recheck?: Duration.Duration;
    readonly tailnet?: Layer.Layer<Tailnet>;
    /** The config's tailnet, which the host's own Tailscale adapter reaches through `http`. */
    readonly tailnetSettings?: TailnetSettings;
    readonly http?: Layer.Layer<HttpClient.HttpClient>;
  },
) =>
  Effect.gen(function* () {
    const fake = options?.fake ?? fakeRuntime({ dir, ...options?.runtime });
    const stateDir = join(dir, "state");
    const scope = yield* Scope.make();

    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

    const context = yield* Layer.buildWithScope(
      hostLayer(
        {
          ...hostConfig(stateDir, options?.ports, options?.recheck),
          tailnet: options?.tailnetSettings,
        },
        fake.layer,
        loopbackServer(),
      ).pipe(
        Layer.provide(options?.tailnet ?? Layer.empty),
        Layer.provide(options?.http ?? noHttp),
        Layer.provideMerge(Logger.layer([])),
        Layer.provide(NodeServices.layer),
      ),
      scope,
    );

    const host: TestHost = {
      dir,
      fake,
      stateDir,
      url: HttpServer.formatAddress(Context.get(context, HttpServer.HttpServer).address),
      run: (effect) => Effect.provide(effect, context),
      machines: Context.get(context, Machines.Machines),
      checkpoints: Context.get(context, Checkpoints.Checkpoints),
      store: Context.get(context, Store.Store),
      dispose: Scope.close(scope, Exit.void),
    };

    return host;
  });

export const hostOn =
  (ports: PortRange) => (options?: Parameters<typeof startHost>[1] & { readonly dir?: string }) =>
    Effect.gen(function* () {
      return yield* startHost(options?.dir ?? (yield* scratch), { ports, ...options });
    });

export const failure = <A, E>(host: TestHost, effect: Effect.Effect<A, E>) =>
  host.run(Effect.flip(effect));

export const pause = Effect.sleep(Duration.millis(50));

export const eventually = <A, E>(read: Effect.Effect<A, E>, done: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 100; tries++) {
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

export const at = ({ state, desired, phase }: Machine) => [state, desired, phase];
