/** A host in process: the host layer `clankerbox host` runs, over the fake runtime. */
import { createServer } from "node:http";
import { join } from "node:path";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { CreateRequest } from "@gjermundgaraba/clankerbox-sdk";
import { Context, Effect, Exit, Layer, Logger, Scope } from "effect";
import { HttpServer } from "effect/http";
import * as Checkpoints from "../src/checkpoints.ts";
import { hostLayer } from "../src/host.ts";
import * as Machines from "../src/machines.ts";
import type { PortRange } from "../src/machine-ports.ts";
import type { HostSettings } from "../src/settings.ts";
import * as Store from "../src/store.ts";
import { type FakeOptions, type FakeRuntime, fakeRuntime } from "./fake-runtime.ts";

export const image =
  "mirror.gcr.io/library/ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7";

/**
 * The machines' ports of a test host whose file names none. A file that asserts ports passes a
 * range of its own, so files running at once never probe each other's ports.
 */
const sharedPorts: PortRange = { first: 21_000, last: 21_099 };

/** Host `linux` on the smolvm runtime, which the fake runtime stands in for. */
export const hostConfig = (stateDir: string, machinePorts = sharedPorts): HostSettings => ({
  id: "linux",
  runtime: "smolvm",
  listen: { address: "127.0.0.1", port: 0 },
  bases: new Map([["ubuntu", image]]),
  stateDir,
  machinePorts,
});

/** A create request for the machine named `name` on host `linux`. */
export const request = (name: string, fields?: Partial<CreateRequest>): CreateRequest => ({
  id: `linux_${name}`,
  base: "ubuntu",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  ...fields,
});

/** An HTTP server on a port of loopback the OS picks, unless `port` names one. */
export const loopbackServer = (port = 0) =>
  NodeHttpServer.layer(createServer, { host: "127.0.0.1", port });

export interface TestHost {
  /** The scratch directory the host's state dir and the fake's guest roots are in. */
  readonly dir: string;
  readonly fake: FakeRuntime;
  readonly stateDir: string;
  /** Where the host's API answers, on loopback. */
  readonly url: string;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, Machines.Machines | Checkpoints.Checkpoints | Store.Store>,
  ) => Effect.Effect<A, E>;
  readonly machines: Machines.Interface;
  readonly checkpoints: Checkpoints.Interface;
  readonly store: Store.Interface;
  /**
   * Ends the host before its test does: its fibers are interrupted and the state dir's lock
   * released. The test's end does it otherwise.
   */
  readonly dispose: Effect.Effect<void>;
}

/**
 * Runs host `linux` as `clankerbox host` does, over `fake`, or a new fake in `dir`, with its
 * state dir in `dir`, served on a loopback port, giving machines `ports`, until the test ends.
 * Failed actions log no warnings here: the tests read their errors.
 */
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
      hostLayer(hostConfig(stateDir, options?.ports), () => fake.layer, loopbackServer()).pipe(
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
