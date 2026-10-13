import { totalmem } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { inspect } from "node:util";
import { Effect, Redacted, type Schema } from "effect";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { loadConfig } from "../src/config.ts";
import { scratch, write } from "@gjermundgaraba/clankerbox-sdk/testing";

const image =
  "mirror.gcr.io/library/ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7";

const config = {
  id: "linux",
  runtime: "smolvm",
  listen: { address: "100.95.240.37", port: 8484 },
  stateDir: "state",
  bases: { ubuntu: image },
  smolvm: { prefix: "/opt/smolvm/1.27.3", publishAddress: "100.95.240.37" },
};

const load = (contents: Schema.Json) =>
  Effect.gen(function* () {
    const file = join(yield* scratch, "host.json");

    yield* write(file, JSON.stringify(contents));

    return { file, loaded: loadConfig(file) };
  });

layer(NodeServices.layer)((it) => {
  it.effect(
    "a host config resolves its state dir against its own directory and defaults the RAM budget and machine ports",
    () =>
      Effect.gen(function* () {
        const { file, loaded } = yield* load(config);
        const host = yield* loaded;

        expect(host).toEqual({
          id: "linux",
          runtime: "smolvm",
          listen: { address: "100.95.240.37", port: 8484 },
          stateDir: join(file, "..", "state"),
          bases: new Map([["ubuntu", image]]),
          machinePorts: { first: 10_000, last: 19_999 },
          smolvm: {
            prefix: "/opt/smolvm/1.27.3",
            publishAddress: "100.95.240.37",
            ramBudgetMib: Math.floor(totalmem() / 1024 / 1024) - 2048,
          },
        });
      }),
  );

  it.effect("the publish address defaults to the listen address, and a set one is kept", () =>
    Effect.gen(function* () {
      const defaulted = yield* load({ ...config, smolvm: { prefix: config.smolvm.prefix } });

      const set = yield* load({
        ...config,
        smolvm: { ...config.smolvm, publishAddress: "100.100.1.2" },
      });

      expect(yield* defaulted.loaded).toMatchObject({
        smolvm: { publishAddress: "100.95.240.37" },
      });
      expect(yield* set.loaded).toMatchObject({
        smolvm: { publishAddress: "100.100.1.2" },
      });
    }),
  );

  it.effect("a set RAM budget is kept, even above physical RAM", () =>
    Effect.gen(function* () {
      const { loaded } = yield* load({
        ...config,
        smolvm: { ...config.smolvm, ramBudgetMib: 1_000_000 },
      });

      expect(yield* loaded).toMatchObject({
        smolvm: { ramBudgetMib: 1_000_000 },
      });
    }),
  );

  const tart = {
    id: "mac",
    runtime: "tart",
    listen: { address: "100.122.69.11", port: 8484 },
    stateDir: "state",
    bases: { tahoe: "ghcr.io/cirruslabs/macos-tahoe-base@sha256:87f3" },
    tart: { binary: "/opt/tart/2.40.1/tart.app/Contents/MacOS/tart" },
  };

  it.effect(
    "a Tart host config names its tart binary, and its publish address defaults to the listen address",
    () =>
      Effect.gen(function* () {
        const { file, loaded } = yield* load(tart);

        expect(yield* loaded).toEqual({
          id: "mac",
          runtime: "tart",
          listen: { address: "100.122.69.11", port: 8484 },
          stateDir: join(file, "..", "state"),
          bases: new Map([["tahoe", "ghcr.io/cirruslabs/macos-tahoe-base@sha256:87f3"]]),
          machinePorts: { first: 10_000, last: 19_999 },
          tart: {
            binary: "/opt/tart/2.40.1/tart.app/Contents/MacOS/tart",
            publishAddress: "100.122.69.11",
          },
        });

        const published = yield* load({
          ...tart,
          tart: { ...tart.tart, publishAddress: "127.0.0.1" },
        });

        expect(yield* published.loaded).toMatchObject({
          tart: { publishAddress: "127.0.0.1" },
        });
      }),
  );

  it.effect("a Tart host config takes only Tart's settings, on a tailnet or loopback address", () =>
    Effect.gen(function* () {
      for (const contents of [
        { ...tart, smolvm: config.smolvm },
        { ...tart, tart: { ...tart.tart, ramBudgetMib: 4096 } },
        { ...tart, tart: { ...tart.tart, publishAddress: "0.0.0.0" } },
        { ...tart, tart: {} },
      ]) {
        const { loaded } = yield* load(contents);

        expect((yield* Effect.flip(loaded))._tag).toBe("InvalidFile");
      }
    }),
  );

  const apiKey = "boat_test-key-that-never-prints";

  const boat = {
    id: "boat",
    runtime: "boat",
    listen: { address: "100.95.240.37", port: 8486 },
    stateDir: "state",
    bases: { "boat-ubuntu": "boat" },
    boat: { apiKey },
  };

  it.effect(
    "a boat host config holds its API key, which nothing that prints the config shows",
    () =>
      Effect.gen(function* () {
        const { file, loaded } = yield* load(boat);
        const host = yield* loaded;

        expect(host).toMatchObject({
          id: "boat",
          runtime: "boat",
          stateDir: join(file, "..", "state"),
          bases: new Map([["boat-ubuntu", "boat"]]),
        });
        expect(host.runtime === "boat" ? Redacted.value(host.boat.apiKey) : undefined).toBe(apiKey);

        for (const printed of [JSON.stringify(host), inspect(host, { depth: 10 })]) {
          expect(printed).not.toContain(apiKey);
        }
      }),
  );

  it.effect(
    "a boat host config takes only boat's settings, and a refused one doesn't print its key",
    () =>
      Effect.gen(function* () {
        const refused: Array<Schema.Json> = [
          { ...boat, boat: {} },
          { ...boat, boat: { apiKey: "" } },
          { ...boat, boat: { apiKey, baseUrl: "http://boat.test" } },
          { ...boat, boat: { apiKey, publishAddress: "127.0.0.1" } },
          { ...boat, tart: tart.tart },
          { ...boat, listen: { address: "0.0.0.0", port: 8486 } },
        ];

        for (const contents of refused) {
          const { loaded } = yield* load(contents);
          const error = yield* Effect.flip(loaded);

          expect(error._tag).toBe("InvalidFile");
          expect(error.message).not.toContain(apiKey);
        }
      }),
  );

  it.effect("a host listens and publishes only on a tailnet or loopback address", () =>
    Effect.gen(function* () {
      for (const address of ["127.0.0.1", "127.0.0.2", "::1", "100.64.0.1", "fd7a:115c:a1e0::5"]) {
        const { loaded } = yield* load({ ...config, listen: { address, port: 8484 } });

        expect(yield* loaded, address).toMatchObject({
          listen: { address },
        });
      }

      for (const address of [
        "0.0.0.0",
        "::",
        "37.27.63.112",
        "192.168.1.2",
        "linux.tailnet",
        "100.128.0.1",
      ]) {
        const listening = yield* load({ ...config, listen: { address, port: 8484 } });

        const publishing = yield* load({
          ...config,
          smolvm: { ...config.smolvm, publishAddress: address },
        });

        for (const { loaded } of [listening, publishing]) {
          const error = yield* Effect.flip(loaded);

          expect(error._tag, address).toBe("InvalidFile");
          expect(error.message, address).toContain("tailnet address");
        }
      }
    }),
  );

  it.effect("a host's API port lies outside the machines' range, 10000-19999", () =>
    Effect.gen(function* () {
      for (const port of [9999, 20_000, 65_535]) {
        const { loaded } = yield* load({ ...config, listen: { ...config.listen, port } });

        expect(yield* loaded, String(port)).toMatchObject({
          listen: { port },
        });
      }

      for (const port of [10_000, 14_000, 19_999]) {
        const smolvm = yield* load({ ...config, listen: { ...config.listen, port } });
        const onBoat = yield* load({ ...boat, listen: { ...boat.listen, port } });

        for (const { loaded } of [smolvm, onBoat]) {
          const error = yield* Effect.flip(loaded);

          expect(error._tag, String(port)).toBe("InvalidFile");
          expect(error.message, String(port)).toContain("outside 10000-19999");
        }
      }
    }),
  );

  it.effect(
    "machinePorts moves the machines' range, which the API's port must still lie outside",
    () =>
      Effect.gen(function* () {
        const machinePorts = { first: 5000, last: 5099 };

        const moved = yield* load({
          ...config,
          listen: { ...config.listen, port: 15_000 },
          machinePorts,
        });

        const inside = yield* load({
          ...config,
          listen: { ...config.listen, port: 5050 },
          machinePorts,
        });

        const backwards = yield* load({ ...config, machinePorts: { first: 5099, last: 5000 } });

        expect(yield* moved.loaded).toMatchObject({
          listen: { port: 15_000 },
          machinePorts,
        });
        expect((yield* Effect.flip(inside.loaded)).message).toContain("outside 5000-5099");
        expect((yield* Effect.flip(backwards.loaded))._tag).toBe("InvalidFile");
      }),
  );

  it.effect(
    "machinePorts stays out of smolvm's fork ports and the Linux and macOS ephemeral ports",
    () =>
      Effect.gen(function* () {
        for (const [first, last] of [
          [9000, 19_999],
          [32_000, 32_767],
        ] as const) {
          const { loaded } = yield* load({ ...config, machinePorts: { first, last } });

          expect(yield* loaded, `${first}-${last}`).toMatchObject({
            machinePorts: { first, last },
          });
        }

        for (const [first, last, reserved] of [
          [19_999, 20_000, "20000-31999, smolvm's fork ports"],
          [31_999, 32_000, "20000-31999, smolvm's fork ports"],
          [32_767, 32_768, "32768-60999, Linux's ephemeral ports"],
          [61_000, 61_000, "49152-65535, macOS's ephemeral ports"],
          [65_535, 65_535, "49152-65535, macOS's ephemeral ports"],
          [1, 65_535, "20000-31999, smolvm's fork ports"],
        ] as const) {
          const { loaded } = yield* load({ ...config, machinePorts: { first, last } });
          const error = yield* Effect.flip(loaded);

          expect(error._tag, `${first}-${last}`).toBe("InvalidFile");
          expect(error.message, `${first}-${last}`).toContain(`must stay out of ${reserved}`);
        }
      }),
  );

  it.effect("an unknown key, another runtime or a bad host ID is InvalidFile", () =>
    Effect.gen(function* () {
      for (const contents of [
        { ...config, labels: [] },
        { ...config, runtime: "tart" },
        { ...config, id: "Linux" },
        { ...config, smolvm: { ...config.smolvm, ramBudgetMib: 0 } },
      ]) {
        const { loaded } = yield* load(contents);

        expect((yield* Effect.flip(loaded))._tag).toBe("InvalidFile");
      }
    }),
  );

  it.effect("a missing config file is InvalidFile, naming it", () =>
    Effect.gen(function* () {
      const missing = join(yield* scratch, "nope.json");

      const error = yield* Effect.flip(loadConfig(missing)).pipe(
        Effect.provide(NodeServices.layer),
      );

      expect(error._tag).toBe("InvalidFile");
      expect(error.file).toBe(missing);
      expect(error.message).toContain(missing);
    }),
  );
});
