/** A host in process: the host layer `clankerbox host` runs, over the fake runtime. */
import { createServer } from "node:http";
import { join } from "node:path";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { CreateRequest } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Layer, Logger, ManagedRuntime } from "effect";
import { HttpServer } from "effect/http";
import * as Checkpoints from "../src/checkpoints.ts";
import { type HostLayerConfig, hostLayer } from "../src/index.ts";
import * as Machines from "../src/machines.ts";
import type { PortRange } from "../src/ports.ts";
import * as Store from "../src/store.ts";
import { type FakeOptions, type FakeRuntime, fakeRuntime } from "./fake-runtime.ts";
import { removeScratch } from "./scratch.ts";

export const image =
  "mirror.gcr.io/library/ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7";

/**
 * The machines' ports of a test host whose file names none. A file that asserts ports passes a
 * range of its own, so files running at once never probe each other's ports.
 */
const sharedPorts: PortRange = { first: 21_000, last: 21_099 };

/** Host `linux` on the smolvm runtime, which the fake runtime stands in for. */
export const hostConfig = (stateDir: string, machinePorts = sharedPorts): HostLayerConfig => ({
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

/** Ends the hosts, then removes the scratch directories they ran in. */
export const cleanup = async (owned: Array<string>, hosts: Array<TestHost>) => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  await removeScratch(owned);
};

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
  ) => Promise<A>;
  readonly machines: Machines.Interface;
  readonly checkpoints: Checkpoints.Interface;
  readonly store: Store.Interface;
  /** Ends the host: its fibers are interrupted and the state dir's lock released. */
  readonly dispose: () => Promise<void>;
}

/**
 * Runs host `linux` as `clankerbox host` does, over `fake`, or a new fake in `dir`, with its
 * state dir in `dir`, served on a loopback port, giving machines `ports`. Failed actions log no
 * warnings here: the tests read their errors.
 */
export const startHost = async (
  dir: string,
  options?: {
    readonly fake?: FakeRuntime;
    readonly runtime?: Omit<FakeOptions, "dir">;
    readonly ports?: PortRange;
  },
): Promise<TestHost> => {
  const fake = options?.fake ?? fakeRuntime({ dir, ...options?.runtime });
  const stateDir = join(dir, "state");

  const runtime = ManagedRuntime.make(
    hostLayer(hostConfig(stateDir, options?.ports), () => fake.layer, loopbackServer()).pipe(
      Layer.provideMerge(Logger.layer([])),
      Layer.provide(NodeServices.layer),
    ),
  );

  const run = <A, E>(
    effect: Effect.Effect<A, E, Machines.Machines | Checkpoints.Checkpoints | Store.Store>,
  ) => runtime.runPromise(effect);

  return {
    dir,
    fake,
    stateDir,
    url: HttpServer.formatAddress(
      (await runtime.runPromise(Effect.service(HttpServer.HttpServer))).address,
    ),
    run,
    machines: await run(Effect.service(Machines.Machines)),
    checkpoints: await run(Effect.service(Checkpoints.Checkpoints)),
    store: await run(Effect.service(Store.Store)),
    dispose: () => runtime.dispose(),
  };
};
