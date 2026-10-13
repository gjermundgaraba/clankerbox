import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Client } from "@gjermundgaraba/clankerbox-sdk";
import * as NodeClient from "@gjermundgaraba/clankerbox-sdk/node";
import { DateTime, Effect, Layer, Logger } from "effect";
import { HttpServer } from "effect/http";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { hostLayer } from "../../src/composition/host.ts";
import { open } from "../../src/platform/sqlite.ts";
import type { HostSettings } from "../../src/settings.ts";
import { type FakeRuntime, fakeRuntime } from "../fake-runtime.ts";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing";
import { hostConfig, loopbackServer } from "../support.ts";

const config = (dir: string, fields?: Partial<HostSettings>): HostSettings => ({
  ...hostConfig(join(dir, "state")),
  ...fields,
});

const hostOn = (host: HostSettings, fake: FakeRuntime) =>
  hostLayer(host, () => fake.layer, loopbackServer(host.listen.port));

const whileServing = <A, E, R>(
  host: HostSettings,
  dir: string,
  use: (url: string) => Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(Effect.service(HttpServer.HttpServer), (server) =>
    use(HttpServer.formatAddress(server.address)),
  ).pipe(Effect.provide(hostOn(host, fakeRuntime({ dir }))), Effect.provide(Logger.layer([])));

const refused = (host: HostSettings, fake: FakeRuntime) =>
  Effect.flip(Layer.build(hostOn(host, fake))).pipe(
    Effect.scoped,
    Effect.provide(Logger.layer([])),
  );

const withClient = <A, E>(url: string, use: (client: Client.Interface) => Effect.Effect<A, E>) =>
  Effect.flatMap(Client.Client, use).pipe(Effect.provide(NodeClient.layer([{ id: "linux", url }])));

layer(NodeServices.layer)((it) => {
  it.effect("the host fails the actions its last process left running before it serves", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const host = config(dir);

      yield* Effect.flatMap(open(host), (store) =>
        store.insert("create", {
          kind: "machine",
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
      ).pipe(Effect.scoped);

      const machine = yield* whileServing(host, dir, (url) =>
        withClient(url, (client) => client.machine("linux_dev")),
      );

      expect(machine.action).toEqual({
        name: "create",
        status: "failed",
        error: { tag: "Internal", message: "host restarted during create" },
      });
    }),
  );

  it.effect(
    "a second host on the same state dir refuses to start, before it builds its runtime",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const secondFake = fakeRuntime({ dir: yield* scratch });

        const error = yield* whileServing(config(dir), dir, () => refused(config(dir), secondFake));

        expect(error._tag).toBe("Precondition");
        expect(error.message).toContain("another host process holds state dir");
        expect(secondFake.stubs()).toBeUndefined();
      }),
  );

  it.effect(
    "a host renamed, or moved to another runtime, refuses its state dir before it builds its runtime",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;

        const fake = fakeRuntime({ dir: yield* scratch });

        yield* whileServing(config(dir), dir, () => Effect.void);

        const renamed = yield* refused(config(dir, { id: "mac" }), fake);
        const moved = yield* refused(config(dir, { runtime: "tart" }), fake);

        expect(renamed._tag).toBe("Precondition");
        expect(renamed.message).toContain(
          "holds host linux on smolvm, and this config names host mac",
        );
        expect(moved.message).toContain("this config names host linux on tart");
        expect(fake.stubs()).toBeUndefined();
      }),
  );

  it.effect("a host whose address is taken says where it couldn't listen", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;

      const other = yield* scratch;

      const [port, failure] = yield* whileServing(config(dir), dir, (url) => {
        const port = Number(new URL(url).port);
        const taken = config(other, { listen: { address: "127.0.0.1", port } });

        return Effect.map(
          refused(taken, fakeRuntime({ dir: other })),
          (error) => [port, error] as const,
        );
      });

      expect(failure._tag).toBe("Internal");
      expect(failure.message).toContain(`couldn't listen on 127.0.0.1:${port}`);
    }),
  );
});
