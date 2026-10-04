/** A host core in process: the real store and actions over the fake runtime. */
import { createServer } from "node:http";
import { join } from "node:path";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { CreateRequest } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Layer, Logger, ManagedRuntime } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import * as Machines from "../src/machines.ts";
import { routes } from "../src/server.ts";
import * as Store from "../src/store.ts";
import { type FakeOptions, type FakeRuntime, fakeRuntime } from "./fake-runtime.ts";
import { removeScratch } from "./scratch.ts";

export const image =
  "ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7";

export const hostConfig = (stateDir: string) => ({
  id: "linux",
  bases: new Map([["ubuntu", image]]),
  stateDir,
});

export const request = (name: string, fields?: Partial<CreateRequest>): CreateRequest => ({
  name,
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

/**
 * The store and the actions over `fake`, on the state dir `stateDir`. Failed actions log no
 * warnings here: the tests read their errors.
 */
export const coreLayer = (stateDir: string, fake: FakeRuntime) =>
  Machines.layer(hostConfig(stateDir)).pipe(
    Layer.provideMerge(
      Layer.merge(Layer.effect(Store.Store, Store.open(stateDir, "linux")), fake.layer),
    ),
    Layer.provideMerge(Logger.layer([])),
    Layer.provide(NodeServices.layer),
  );

export interface TestHost {
  /** The scratch directory the host's state dir and the fake's guest roots are in. */
  readonly dir: string;
  readonly fake: FakeRuntime;
  readonly stateDir: string;
  readonly run: <A, E>(effect: Effect.Effect<A, E, Machines.Machines | Store.Store>) => Promise<A>;
  readonly machines: Machines.Interface;
  readonly store: Store.Interface;
  /** Ends the host: its fibers are interrupted and the state dir's lock released. */
  readonly dispose: () => Promise<void>;
}

/** Starts a host core on `stateDir`, with `fake` as its runtime, or a new fake in `dir`. */
export const startHost = async (
  dir: string,
  options?: { readonly fake?: FakeRuntime; readonly runtime?: Omit<FakeOptions, "dir"> },
): Promise<TestHost> => {
  const fake = options?.fake ?? fakeRuntime({ dir, ...options?.runtime });
  const stateDir = join(dir, "state");
  const runtime = ManagedRuntime.make(coreLayer(stateDir, fake));

  const run = <A, E>(effect: Effect.Effect<A, E, Machines.Machines | Store.Store>) =>
    runtime.runPromise(effect);

  return {
    dir,
    fake,
    stateDir,
    run,
    machines: await run(Effect.service(Machines.Machines)),
    store: await run(Effect.service(Store.Store)),
    dispose: () => runtime.dispose(),
  };
};

export interface ServedHost {
  /** Where the host's API answers, on loopback. */
  readonly url: string;
  readonly fake: FakeRuntime;
  /** The host's machine rows. */
  readonly rows: () => Promise<ReadonlyArray<Store.MachineRecord>>;
  readonly dispose: () => Promise<void>;
}

/** Serves host `linux` over a fake runtime in `dir`, on a loopback port. */
export const serveHost = async (dir: string): Promise<ServedHost> => {
  const fake = fakeRuntime({ dir });
  const stateDir = join(dir, "state");

  const runtime = ManagedRuntime.make(
    HttpRouter.serve(routes(hostConfig(stateDir)), { disableLogger: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      Layer.provideMerge(coreLayer(stateDir, fake)),
    ),
  );

  const server = await runtime.runPromise(Effect.service(HttpServer.HttpServer));

  return {
    url: HttpServer.formatAddress(server.address),
    fake,
    rows: () =>
      runtime.runPromise(Effect.flatMap(Effect.service(Store.Store), (store) => store.list)),
    dispose: () => runtime.dispose(),
  };
};
