import { createServer } from "node:http";
import { join } from "node:path";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { CreateRequest } from "@gjermundgaraba/clankerbox-sdk";
import { Context, Effect, Exit, Layer, Logger, Scope } from "effect";
import { HttpServer } from "effect/http";
import * as Checkpoints from "../src/checkpoints.ts";
import { hostLayer } from "../src/composition/host.ts";
import * as Machines from "../src/machines.ts";
import type { PortRange } from "../src/machine-ports.ts";
import type { HostSettings } from "../src/settings.ts";
import * as Store from "../src/store.ts";
import { type FakeOptions, type FakeRuntime, fakeRuntime } from "./fake-runtime.ts";

export const image =
  "mirror.gcr.io/library/ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7";

const sharedPorts: PortRange = { first: 21_000, last: 21_099 };

export const hostConfig = (stateDir: string, machinePorts = sharedPorts): HostSettings => ({
  id: "linux",
  runtime: "smolvm",
  listen: { address: "127.0.0.1", port: 0 },
  bases: new Map([["ubuntu", image]]),
  stateDir,
  machinePorts,
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

export const startHost = (
  dir: string,
  options?: {
    readonly fake?: FakeRuntime;
    readonly runtime?: Omit<FakeOptions, "dir">;
    readonly ports?: PortRange;
  },
) =>
  Effect.gen(function* () {
    const fake = options?.fake ?? fakeRuntime({ dir, ...options?.runtime });
    const stateDir = join(dir, "state");
    const scope = yield* Scope.make();

    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

    const context = yield* Layer.buildWithScope(
      hostLayer(hostConfig(stateDir, options?.ports), fake.layer, loopbackServer()).pipe(
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
