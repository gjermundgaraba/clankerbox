/** The whole host layer, as `clankerbox host` runs it, over the fake runtime. */
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Client } from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Effect, Layer, Schema } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import type { HostConfig } from "../src/config.ts";
import { hostLayer } from "../src/index.ts";
import { open } from "../src/store.ts";
import { fakeRuntime } from "./fake-runtime.ts";
import { removeScratch, scratch } from "./scratch.ts";

const owned: Array<string> = [];

const servers: Array<Server> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
        }),
    ),
  );
  await removeScratch(owned);
});

/** A port that was free on loopback a moment ago; with `hold`, still held by a listener. */
const loopbackPort = async (hold = false) => {
  const server = createServer();

  await new Promise<void>((resolve) => {
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });

  const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
    server.address(),
    { onExcessProperty: "ignore" },
  );

  if (hold) {
    servers.push(server);
  } else {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }

  return port;
};

const config = (dir: string, port: number): HostConfig => ({
  id: "linux",
  runtime: "smolvm",
  listen: { address: "127.0.0.1", port },
  stateDir: join(dir, "state"),
  bases: new Map([["ubuntu", "ubuntu@sha256:f144"]]),
  smolvm: { prefix: "/opt/smolvm/1.22.2", publishAddress: "127.0.0.1", ramBudgetMib: 4096 },
});

/** Runs `use` while the host runs on `host`, then stops the host. */
const whileServing = <A, E>(host: HostConfig, dir: string, use: Effect.Effect<A, E>) =>
  Layer.build(hostLayer(host, fakeRuntime({ dir }).layer)).pipe(
    Effect.andThen(use),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  );

const withClient = <A, E>(port: number, use: (client: Client.Interface) => Effect.Effect<A, E>) =>
  Effect.flatMap(Client.Client, use).pipe(
    Effect.provide(Client.layer([{ id: "linux", url: `http://127.0.0.1:${port}` }])),
  );

test("the host fails the actions its last process left running before it serves", async () => {
  const dir = await scratch(owned);
  const port = await loopbackPort();
  const host = config(dir, port);

  await Effect.flatMap(open(host.stateDir, "linux"), (store) =>
    store.insert({
      name: "dev",
      instance: "0123456789abcdef0123456789abcdef",
      native: undefined,
      createdAt: DateTime.makeUnsafe("2026-10-04T12:00:00Z"),
      base: "ubuntu",
      profile: undefined,
      cpu: 1,
      ramMib: 1024,
      diskGib: 10,
      port: undefined,
      hostKey: undefined,
      action: { name: "create", status: "running" },
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);

  const machine = await whileServing(
    host,
    dir,
    withClient(port, (client) => client.machine("linux_dev")),
  );

  expect(machine.action).toEqual({
    name: "create",
    status: "failed",
    error: { tag: "Internal", message: "host restarted during create" },
  });
});

test("a second host on the same state dir refuses to start", async () => {
  const dir = await scratch(owned);
  const first = config(dir, await loopbackPort());
  const second = config(dir, await loopbackPort());
  const secondFake = fakeRuntime({ dir: await scratch(owned) });

  const error = await whileServing(
    first,
    dir,
    Effect.flip(Layer.build(hostLayer(second, secondFake.layer))).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  expect(error._tag).toBe("Precondition");
  expect(error.message).toContain("another host process holds state dir");
});

test("a host whose address is taken says where it couldn't listen", async () => {
  const dir = await scratch(owned);
  const port = await loopbackPort(true);

  const error = await Layer.build(hostLayer(config(dir, port), fakeRuntime({ dir }).layer)).pipe(
    Effect.flip,
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  );

  expect(error._tag).toBe("Internal");
  expect(error.message).toContain(`couldn't listen on 127.0.0.1:${port}`);
});
