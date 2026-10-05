/** The whole host layer, as `clankerbox host` runs it, over the fake runtime. */
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Client } from "@gjermundgaraba/clankerbox-sdk";
import * as NodeClient from "@gjermundgaraba/clankerbox-sdk/node";
import { DateTime, Effect, Layer, Logger } from "effect";
import { HttpServer } from "effect/http";
import { afterEach, expect, test } from "vite-plus/test";
import { type HostLayerConfig, hostLayer } from "../src/index.ts";
import { open } from "../src/store.ts";
import { type FakeRuntime, fakeRuntime } from "./fake-runtime.ts";
import { removeScratch, scratch } from "./scratch.ts";
import { hostConfig, loopbackServer } from "./support.ts";

const owned: Array<string> = [];

afterEach(() => removeScratch(owned));

const config = (dir: string, fields?: Partial<HostLayerConfig>): HostLayerConfig => ({
  ...hostConfig(join(dir, "state")),
  ...fields,
});

/** The host on `host`, over `fake`, served on `host.listen.port` of loopback. */
const hostOn = (host: HostLayerConfig, fake: FakeRuntime) =>
  hostLayer(host, () => fake.layer, loopbackServer(host.listen.port));

/** Runs `use` with the URL the host on `host` answers on, then stops the host. */
const whileServing = <A, E>(
  host: HostLayerConfig,
  dir: string,
  use: (url: string) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(Effect.service(HttpServer.HttpServer), (server) =>
    use(HttpServer.formatAddress(server.address)),
  ).pipe(
    Effect.provide(hostOn(host, fakeRuntime({ dir }))),
    Effect.provide(Logger.layer([])),
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  );

/** The failure of the host on `host`, over `fake`, to start. */
const refused = (host: HostLayerConfig, fake: FakeRuntime) =>
  Effect.flip(Layer.build(hostOn(host, fake))).pipe(
    Effect.scoped,
    Effect.provide(Logger.layer([])),
    Effect.provide(NodeServices.layer),
  );

const withClient = <A, E>(url: string, use: (client: Client.Interface) => Effect.Effect<A, E>) =>
  Effect.flatMap(Client.Client, use).pipe(Effect.provide(NodeClient.layer([{ id: "linux", url }])));

test("the host fails the actions its last process left running before it serves", async () => {
  const dir = await scratch(owned);
  const host = config(dir);

  await Effect.flatMap(open(host), (store) =>
    store.insert("create", {
      table: "machines",
      record: {
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
      },
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);

  const machine = await whileServing(host, dir, (url) =>
    withClient(url, (client) => client.machine("linux_dev")),
  );

  expect(machine.action).toEqual({
    name: "create",
    status: "failed",
    error: { tag: "Internal", message: "host restarted during create" },
  });
});

test("a second host on the same state dir refuses to start, before it builds its runtime", async () => {
  const dir = await scratch(owned);
  const secondFake = fakeRuntime({ dir: await scratch(owned) });

  const error = await whileServing(config(dir), dir, () => refused(config(dir), secondFake));

  expect(error._tag).toBe("Precondition");
  expect(error.message).toContain("another host process holds state dir");
  expect(secondFake.stubs()).toBeUndefined();
});

test("a host renamed, or moved to another runtime, refuses its state dir before it builds its runtime", async () => {
  const dir = await scratch(owned);

  const fake = fakeRuntime({ dir: await scratch(owned) });

  await whileServing(config(dir), dir, () => Effect.void);

  const renamed = await Effect.runPromise(refused(config(dir, { id: "mac" }), fake));
  const moved = await Effect.runPromise(refused(config(dir, { runtime: "tart" }), fake));

  expect(renamed._tag).toBe("Precondition");
  expect(renamed.message).toContain("holds host linux on smolvm, and this config names host mac");
  expect(moved.message).toContain("this config names host linux on tart");
  expect(fake.stubs()).toBeUndefined();
});

test("a host whose address is taken says where it couldn't listen", async () => {
  const dir = await scratch(owned);

  const other = await scratch(owned);

  const [port, failure] = await whileServing(config(dir), dir, (url) => {
    const port = Number(new URL(url).port);
    const taken = config(other, { listen: { address: "127.0.0.1", port } });

    return Effect.map(
      refused(taken, fakeRuntime({ dir: other })),
      (error) => [port, error] as const,
    );
  });

  expect(failure._tag).toBe("Internal");
  expect(failure.message).toContain(`couldn't listen on 127.0.0.1:${port}`);
});
