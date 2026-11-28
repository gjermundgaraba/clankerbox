import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { mintToken } from "@gjermundgaraba/clankerbox-sdk/node";
import { scratch, write } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect } from "effect";
import type { Schema } from "effect";
import { expect } from "vite-plus/test";

import { Box } from "../../src/box.ts";
import { loadConfig } from "../../src/composition/config.ts";
import { publishAddress } from "../../src/settings.ts";
import type { ReservedPorts } from "../../src/settings.ts";

const image = "registry.example/ubuntu@sha256:00";
const macImage = "registry.example/macos@sha256:00";

const config = {
  id: "smolvm",
  listen: { address: "100.64.0.10", port: 8484 },
  stateDir: "state",
  bases: { ubuntu: image },
  runtime: { smolvm: { prefix: "/opt/smolvm" } },
};

const linuxDefault: ReservedPorts = {
  first: 32_768,
  last: 60_999,
  owner: "Linux's default ephemeral ports",
};

const onBox = (ephemeralPorts: ReservedPorts) =>
  Effect.provideService(Box, {
    uid: 0,
    ended: () => Effect.succeed(true),
    ephemeralPorts,
    aclHolder: () => Effect.undefined,
  });

const load = (contents: Schema.Json, ephemeral = linuxDefault) =>
  Effect.gen(function* () {
    const file = path.join(yield* scratch, "host.json");

    yield* write(file, JSON.stringify(contents));

    return { file, loaded: onBox(ephemeral)(loadConfig(file)) };
  });

const tls = { cert: "cert.pem", key: "key.pem" };

const guarded = (dir: string) =>
  Effect.gen(function* () {
    const plane = mintToken("host", "cp");

    yield* write(path.join(dir, "callers"), `${plane.line}\n`);
    yield* write(path.join(dir, "cert.pem"), "a certificate");
    yield* write(path.join(dir, "key.pem"), "a key");

    return { plane };
  });

layer(NodeServices.layer)((it) => {
  it.effect(
    "a host config resolves its state dir against its own directory and defaults the machine ports",
    () =>
      Effect.gen(function* () {
        const { file, loaded } = yield* load(config);
        const host = yield* loaded;

        expect(host).toStrictEqual({
          id: "smolvm",
          listen: { address: "100.64.0.10", port: 8484 },
          stateDir: path.join(file, "..", "state"),
          bases: new Map([["ubuntu", image]]),
          machinePorts: { first: 10_000, last: 19_999 },
          runtime: { name: "smolvm", settings: { prefix: "/opt/smolvm" } },
        });
      })
  );

  it.effect("a set RAM budget is kept, even above physical RAM", () =>
    Effect.gen(function* () {
      const { loaded } = yield* load({
        ...config,
        runtime: { smolvm: { prefix: "/opt/smolvm", ramBudgetMib: 1_000_000 } },
      });

      expect(yield* loaded).toMatchObject({
        runtime: { settings: { ramBudgetMib: 1_000_000 } },
      });
    })
  );

  const mac = {
    id: "tart",
    listen: { address: "100.64.0.20", port: 8484 },
    stateDir: "state",
    bases: { macos: macImage },
    runtime: {
      tart: { binary: "/opt/tart/2.41.1/tart.app/Contents/MacOS/tart" },
    },
  };

  it.effect("a tart host config names its tart binary", () =>
    Effect.gen(function* () {
      const { file, loaded } = yield* load(mac);

      expect(yield* loaded).toStrictEqual({
        id: "tart",
        listen: { address: "100.64.0.20", port: 8484 },
        stateDir: path.join(file, "..", "state"),
        bases: new Map([["macos", macImage]]),
        machinePorts: { first: 10_000, last: 19_999 },
        runtime: {
          name: "tart",
          settings: { binary: "/opt/tart/2.41.1/tart.app/Contents/MacOS/tart" },
        },
      });
    })
  );

  it.effect(
    "a host config names exactly one runtime the host drives, with that runtime's settings alone",
    () =>
      Effect.gen(function* () {
        for (const runtime of [
          {},
          { ...mac.runtime, ...config.runtime },
          { tart: { ...mac.runtime.tart, ramBudgetMib: 4096 } },
          { tart: {} },
          { smolvm: mac.runtime.tart },
          { linux: config.runtime.smolvm },
        ]) {
          const { loaded } = yield* load({ ...mac, runtime });
          const error = yield* Effect.flip(loaded);

          expect(error._tag, JSON.stringify(runtime)).toBe("Invalid");
          expect(error.message).toContain("runtime");
        }
      })
  );

  it.effect(
    "a host config that still names its kind is Invalid, and says what replaced it",
    () =>
      Effect.gen(function* () {
        for (const [kind, block] of [
          ["linux", { prefix: "/opt/smolvm" }],
          ["mac", { binary: "/opt/tart/2.41.1/tart.app/Contents/MacOS/tart" }],
        ] as const) {
          const { id, listen, stateDir, bases } = config;

          const { file, loaded } = yield* load({
            id,
            listen,
            stateDir,
            bases,
            kind,
            [kind]: block,
          });

          const error = yield* Effect.flip(loaded);

          expect(error).toMatchObject({ _tag: "Invalid", file });
          expect(error.message).toContain(
            '"kind" and its block are now "runtime"'
          );
          expect(error.message).toContain("smolvm, tart");
        }
      })
  );

  it.effect(
    "a host config's tailnet says only that it takes machines that request one",
    () =>
      Effect.gen(function* () {
        const { loaded } = yield* load({ ...config, tailnet: true });

        expect((yield* loaded).tailnet).toBe(true);

        const { loaded: owning } = yield* load({
          ...config,
          tailnet: {
            oauthClient: { id: "k1", secret: "tskey-client-k1" },
            tags: ["tag:clankerbox-machine"],
          },
        });

        expect((yield* Effect.flip(owning))._tag).toBe("Invalid");
      })
  );

  it.effect(
    "machine SSH ports are published on publish.address when the config sets one, any IP, and on listen.address otherwise",
    () =>
      Effect.gen(function* () {
        const apart = yield* (yield* load({
          ...config,
          publish: { address: "203.0.113.7" },
        })).loaded;

        const together = yield* (yield* load(config)).loaded;

        const named = yield* Effect.flip(
          (yield* load({ ...config, publish: { address: "linux.example" } }))
            .loaded
        );

        expect(publishAddress(apart)).toBe("203.0.113.7");
        expect(apart.listen.address).toBe("100.64.0.10");
        expect(publishAddress(together)).toBe("100.64.0.10");
        expect(named.message).toContain("an IP address");
      })
  );

  it.effect(
    "without callers and tls a host listens only on a tailnet or loopback address, and names what an other address lacks",
    () =>
      Effect.gen(function* () {
        for (const address of [
          "127.0.0.1",
          "127.0.0.2",
          "::1",
          "100.64.0.1",
          "fd7a:115c:a1e0::5",
        ]) {
          const { loaded } = yield* load({
            ...config,
            listen: { address, port: 8484 },
          });

          expect(yield* loaded, address).toMatchObject({
            listen: { address },
          });
        }

        for (const [address, extra, says] of [
          ["0.0.0.0", {}, "needs callers and tls set"],
          ["::", {}, "needs callers and tls set"],
          ["37.27.63.112", {}, "needs callers and tls set"],
          ["192.168.1.2", {}, "needs callers and tls set"],
          ["100.128.0.1", {}, "needs callers and tls set"],
          ["37.27.63.112", { callers: "callers" }, "needs tls set"],
          ["37.27.63.112", { tls }, "needs callers set"],
          ["linux.tailnet", {}, "an IP address"],
        ] as const) {
          const { file, loaded } = yield* load({
            ...config,
            ...extra,
            listen: { address, port: 8484 },
          });

          yield* guarded(path.dirname(file));

          const error = yield* Effect.flip(loaded);

          expect([error._tag, error.file], address).toStrictEqual([
            "Invalid",
            file,
          ]);
          expect(error.message, address).toContain(says);
        }
      })
  );

  it.effect(
    "a host that would publish machines' SSH on every address, as a wildcard listen.address without publish.address would, is refused, saying to set publish.address",
    () =>
      Effect.gen(function* () {
        for (const [listen, publish, says] of [
          ["0.0.0.0", undefined, "set publish.address"],
          ["::", undefined, "set publish.address"],
          ["0:0::0", undefined, "set publish.address"],
          [
            "37.27.63.112",
            "0.0.0.0",
            "publish.address 0.0.0.0 is every address",
          ],
          ["37.27.63.112", "::", "publish.address :: is every address"],
        ] as const) {
          const { file, loaded } = yield* load({
            ...config,
            listen: { address: listen, port: 8484 },
            ...(publish === undefined ? {} : { publish: { address: publish } }),
            callers: "callers",
            tls,
          });

          yield* guarded(path.dirname(file));

          const error = yield* Effect.flip(loaded);

          expect(error._tag, listen).toBe("Invalid");
          expect(error.message, listen).toContain(says);
        }

        const { file, loaded } = yield* load({
          ...config,
          listen: { address: "0.0.0.0", port: 8484 },
          publish: { address: "37.27.63.112" },
          callers: "callers",
          tls,
        });

        yield* guarded(path.dirname(file));

        expect(publishAddress(yield* loaded)).toBe("37.27.63.112");
      })
  );

  it.effect(
    "with callers and tls a host listens on any address, and reads both",
    () =>
      Effect.gen(function* () {
        const { file, loaded } = yield* load({
          ...config,
          listen: { address: "37.27.63.112", port: 8484 },
          callers: "callers",
          tls,
        });

        const { plane } = yield* guarded(path.dirname(file));
        const host = yield* loaded;

        expect(host.listen.address).toBe("37.27.63.112");
        expect(host.callers?.map(({ name }) => name)).toStrictEqual(["cp"]);
        expect(Buffer.from(host.callers?.[0]?.hash ?? []).toString("hex")).toBe(
          plane.line.split(" ")[1]
        );
        expect(host.tls).toStrictEqual({ cert: "a certificate", key: "a key" });
      })
  );

  it.effect(
    "a host's API port lies outside the machines' range, 10000-19999",
    () =>
      Effect.gen(function* () {
        for (const port of [9999, 20_000, 65_535]) {
          const { loaded } = yield* load({
            ...config,
            listen: { ...config.listen, port },
          });

          expect(yield* loaded, String(port)).toMatchObject({
            listen: { port },
          });
        }

        for (const port of [10_000, 14_000, 19_999]) {
          const linux = yield* load({
            ...config,
            listen: { ...config.listen, port },
          });

          const onMac = yield* load({
            ...mac,
            listen: { ...mac.listen, port },
          });

          for (const { loaded } of [linux, onMac]) {
            const error = yield* Effect.flip(loaded);

            expect(error._tag, String(port)).toBe("Invalid");
            expect(error.message, String(port)).toContain(
              "outside 10000-19999"
            );
          }
        }
      })
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

        const backwards = yield* load({
          ...config,
          machinePorts: { first: 5099, last: 5000 },
        });

        expect(yield* moved.loaded).toMatchObject({
          listen: { port: 15_000 },
          machinePorts,
        });
        expect((yield* Effect.flip(inside.loaded)).message).toContain(
          "outside 5000-5099"
        );
        expect((yield* Effect.flip(backwards.loaded))._tag).toBe("Invalid");
      })
  );

  it.effect(
    "machinePorts stays out of the ephemeral ports its box tells of, and nothing else, on every host",
    () =>
      Effect.gen(function* () {
        const tart = { tart: { binary: "/opt/homebrew/bin/tart" } };

        const macBox = {
          first: 49_152,
          last: 65_535,
          owner: "macOS's ephemeral ports",
        };

        const tuned = {
          first: 15_000,
          last: 15_999,
          owner: "this box's ephemeral ports, its ip_local_port_range",
        };

        for (const [runtime, box, first, last] of [
          [config.runtime, linuxDefault, 9000, 19_999],
          [config.runtime, linuxDefault, 32_000, 32_767],
          [config.runtime, linuxDefault, 61_000, 65_535],
          [config.runtime, macBox, 32_000, 49_151],
          [tart, macBox, 20_000, 31_999],
          [config.runtime, linuxDefault, 20_000, 31_999],
          [config.runtime, linuxDefault, 19_999, 32_767],
          [config.runtime, tuned, 40_000, 49_999],
          [config.runtime, tuned, 10_000, 14_999],
        ] as const) {
          const { loaded } = yield* load(
            { ...config, runtime, machinePorts: { first, last } },
            box
          );

          expect(yield* loaded, `${box.owner} ${first}-${last}`).toMatchObject({
            machinePorts: { first, last },
          });
        }

        for (const [runtime, box, first, last, reserved] of [
          [
            config.runtime,
            linuxDefault,
            32_767,
            32_768,
            "32768-60999, Linux's default ephemeral ports",
          ],
          [
            config.runtime,
            linuxDefault,
            60_999,
            61_000,
            "32768-60999, Linux's default ephemeral ports",
          ],
          [
            config.runtime,
            linuxDefault,
            1,
            65_535,
            "32768-60999, Linux's default ephemeral ports",
          ],
          [
            config.runtime,
            tuned,
            10_000,
            19_999,
            "15000-15999, this box's ephemeral ports, its ip_local_port_range",
          ],
          [
            tart,
            macBox,
            49_151,
            49_152,
            "49152-65535, macOS's ephemeral ports",
          ],
          [
            tart,
            macBox,
            65_535,
            65_535,
            "49152-65535, macOS's ephemeral ports",
          ],
        ] as const) {
          const { loaded } = yield* load(
            { ...config, runtime, machinePorts: { first, last } },
            box
          );

          const error = yield* Effect.flip(loaded);

          expect(error._tag, `${box.owner} ${first}-${last}`).toBe("Invalid");
          expect(error.message, `${box.owner} ${first}-${last}`).toContain(
            `must stay out of ${reserved}`
          );
        }
      })
  );

  it.effect("an unknown key, a kind or a bad host ID is Invalid", () =>
    Effect.gen(function* () {
      for (const contents of [
        { ...config, labels: [] },
        { ...config, kind: "mac" },
        { ...config, id: "Smolvm" },
        { ...config, runtime: { smolvm: { prefix: "/opt", ramBudgetMib: 0 } } },
      ]) {
        const { loaded } = yield* load(contents);

        expect((yield* Effect.flip(loaded))._tag).toBe("Invalid");
      }
    })
  );

  it.effect(
    "a base name holding a /, which marks an image reference, is Invalid",
    () =>
      Effect.gen(function* () {
        const { loaded } = yield* load({
          ...config,
          bases: { "team/orb": image },
        });

        const error = yield* Effect.flip(loaded);

        expect(error._tag).toBe("Invalid");
        expect(error.message).toContain(
          "a base name holds no /, which marks an image reference: team/orb"
        );
      })
  );

  it.effect(
    "a builds setting under smolvm or Tart is kept, and one whose endpoint holds credentials is Invalid",
    () =>
      Effect.gen(function* () {
        const credentials = {
          bucket: "builds",
          region: "us-east-1",
          accessKeyId: "id",
          secretAccessKey: "secret",
        };

        const builds = { ...credentials, endpoint: "http://127.0.0.1:8333" };

        for (const host of [
          {
            ...config,
            runtime: { smolvm: { ...config.runtime.smolvm, builds } },
          },
          { ...mac, runtime: { tart: { ...mac.runtime.tart, builds } } },
        ]) {
          const { loaded } = yield* load(host);

          expect(yield* loaded).toMatchObject({
            runtime: { settings: { builds: { endpoint: builds.endpoint } } },
          });
        }

        const { loaded } = yield* load({
          ...config,
          runtime: {
            smolvm: {
              ...config.runtime.smolvm,
              builds: {
                ...credentials,
                endpoint: "http://id:secret@127.0.0.1:8333",
              },
            },
          },
        });

        const error = yield* Effect.flip(loaded);

        expect(error._tag).toBe("Invalid");
        expect(error.message).toContain(
          "an http(s) URL with no path and no credentials"
        );
      })
  );

  it.effect("a missing config file is Invalid, naming it", () =>
    Effect.gen(function* () {
      const missing = path.join(yield* scratch, "nope.json");

      const error = yield* Effect.flip(
        onBox(linuxDefault)(loadConfig(missing))
      ).pipe(Effect.provide(NodeServices.layer));

      expect(error._tag).toBe("Invalid");
      expect(error.file).toBe(missing);
      expect(error.message).toContain(missing);
    })
  );
});
