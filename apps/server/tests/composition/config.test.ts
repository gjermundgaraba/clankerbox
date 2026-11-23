import path from "node:path";
import { inspect } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { mintToken } from "@gjermundgaraba/clankerbox-sdk/node";
import { scratch, write } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { operatorKey } from "@gjermundgaraba/clankerbox-sdk/testing/keys";
import { Effect, Redacted } from "effect";
import type { Schema } from "effect";
import { expect } from "vite-plus/test";

import { loadConfig } from "../../src/composition/config.ts";
import { defaultFailedRowsLast, defaultRecheck } from "../../src/settings.ts";

const config = {
  listen: { address: "100.64.0.10", port: 8585 },
  stateDir: "state",
  authorizedKeys: "id.pub",
  hosts: [
    { id: "linux", url: "http://100.64.0.10:8484" },
    { id: "mac", url: "http://100.64.0.20:8484", draining: true },
  ],
};

const load = (contents: Schema.Json, keys = `${operatorKey}\n`) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const file = path.join(dir, "server.json");

    yield* write(path.join(dir, "id.pub"), keys);
    yield* write(file, JSON.stringify(contents));

    return { file, loaded: loadConfig(file) };
  });

const guarded = (dir: string) =>
  Effect.gen(function* () {
    const laptop = mintToken("laptop");

    yield* write(path.join(dir, "callers"), `${laptop.line}\n`);
    yield* write(path.join(dir, "cert.pem"), "a certificate");
    yield* write(path.join(dir, "key.pem"), "a key");

    return { laptop };
  });

layer(NodeServices.layer)((it) => {
  it.effect(
    "a server config resolves its state dir and authorized keys against its own directory, and a host drains only when it says so",
    () =>
      Effect.gen(function* () {
        const { file, loaded } = yield* load(config);

        expect(yield* loaded).toStrictEqual({
          listen: { address: "100.64.0.10", port: 8585 },
          stateDir: path.join(file, "..", "state"),
          hosts: [
            {
              id: "linux",
              url: "http://100.64.0.10:8484",
              draining: false,
            },
            { id: "mac", url: "http://100.64.0.20:8484", draining: true },
          ],
          recheck: defaultRecheck,
          failedRowsLast: defaultFailedRowsLast,
          authorizedKeys: `${operatorKey}\n`,
          hookTimeoutSeconds: 120,
        });
      })
  );

  const clientSecret = "tskey-client-k1-that-never-prints";

  const tailnet = {
    oauthClient: { id: "k1", secret: clientSecret },
    tags: ["tag:clankerbox-machine"],
  };

  it.effect(
    "a server config's tailnet holds its OAuth client, whose secret nothing that prints the config shows",
    () =>
      Effect.gen(function* () {
        const { loaded } = yield* load({ ...config, tailnet });
        const server = yield* loaded;

        expect(server.tailnet?.tags).toStrictEqual(["tag:clankerbox-machine"]);
        expect(server.tailnet?.oauthClient.id).toBe("k1");
        expect(
          server.tailnet === undefined
            ? undefined
            : Redacted.value(server.tailnet.oauthClient.secret)
        ).toBe(clientSecret);

        for (const printed of [
          JSON.stringify(server),
          inspect(server, { depth: 10 }),
        ]) {
          expect(printed).not.toContain(clientSecret);
        }
      })
  );

  it.effect(
    "a tailnet needs a client and at least one tag, and a refused one doesn't print its secret",
    () =>
      Effect.gen(function* () {
        const refused: Schema.Json[] = [
          { ...config, tailnet: { ...tailnet, tags: [] } },
          { ...config, tailnet: { ...tailnet, tags: ["clankerbox-machine"] } },
          { ...config, tailnet: { ...tailnet, tags: ["tag:1st"] } },
          { ...config, tailnet: { ...tailnet, tags: ["tag:-machine"] } },
          {
            ...config,
            tailnet: { ...tailnet, tags: ["tag:clankerbox_machine"] },
          },
          {
            ...config,
            tailnet: { ...tailnet, oauthClient: { id: "k1", secret: "" } },
          },
          { ...config, tailnet: { tags: tailnet.tags } },
          { ...config, tailnet: { ...tailnet, authKey: clientSecret } },
          { ...config, tailnet: { ...tailnet, buildTags: [] } },
          {
            ...config,
            tailnet: { ...tailnet, buildTags: ["clankerbox-build"] },
          },
        ];

        for (const contents of refused) {
          const { loaded } = yield* load(contents);
          const error = yield* Effect.flip(loaded);

          expect(error._tag).toBe("Invalid");
          expect(error.message).not.toContain(clientSecret);
        }
      })
  );

  it.effect(
    "a tailnet's buildTags are tags for a template's builder, and a tag takes what Tailscale's own check takes, capitals included",
    () =>
      Effect.gen(function* () {
        const tags = ["tag:Dev", "tag:a", "tag:clankerbox-machine-2"];

        const { loaded } = yield* load({
          ...config,
          tailnet: { ...tailnet, tags, buildTags: ["tag:clankerbox-build"] },
        });

        const server = yield* loaded;

        expect([server.tailnet?.tags, server.tailnet?.buildTags]).toStrictEqual(
          [tags, ["tag:clankerbox-build"]]
        );
      })
  );

  it.effect("a server config's hookTimeout is in seconds", () =>
    Effect.gen(function* () {
      const { loaded } = yield* load({ ...config, hookTimeout: 45 });

      expect((yield* loaded).hookTimeoutSeconds).toBe(45);
    })
  );

  it.effect(
    "a server config whose authorizedKeys holds a private key is refused",
    () =>
      Effect.gen(function* () {
        const secret = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ";

        const { file, loaded } = yield* load(
          config,
          `-----BEGIN OPENSSH PRIVATE KEY-----\n${secret}\n-----END OPENSSH PRIVATE KEY-----\n`
        );

        const error = yield* Effect.flip(loaded);
        const keys = path.join(file, "..", "id.pub");

        expect([error._tag, error.file]).toStrictEqual(["Invalid", keys]);
        expect(error.message).toContain(
          `authorized keys ${keys}: each line that isn't blank is a public key`
        );
        expect(error.message).not.toContain(secret);
      })
  );

  it.effect("an absolute state dir stays as it is", () =>
    Effect.gen(function* () {
      const { loaded } = yield* load({
        ...config,
        stateDir: "/var/clankerbox",
      });

      expect((yield* loaded).stateDir).toBe("/var/clankerbox");
    })
  );

  it.effect("a host listed twice is Invalid, naming it", () =>
    Effect.gen(function* () {
      const { file, loaded } = yield* load({
        ...config,
        hosts: [
          { id: "linux", url: "http://a:8484" },
          { id: "linux", url: "http://b:8484" },
        ],
      });

      const error = yield* Effect.flip(loaded);

      expect([error._tag, error.file]).toStrictEqual(["Invalid", file]);
      expect(error.message).toContain("host linux is listed twice");
    })
  );

  it.effect(
    "a config that isn't one is Invalid and names its file: bad JSON, a wrong field, an unknown one",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const unparsed = path.join(dir, "broken.json");

        yield* write(unparsed, "{");

        const contents: readonly Schema.Json[] = [
          { ...config, listen: { ...config.listen, port: 0 } },
          { ...config, listen: { ...config.listen, address: "0.0.0.0" } },
          { ...config, listen: { ...config.listen, port: 65_536 } },
          { ...config, hosts: [{ id: "not a host id", url: "http://a:8484" }] },
          { ...config, hosts: [{ id: "linux" }] },
          { listen: config.listen, hosts: config.hosts },
          {
            listen: config.listen,
            stateDir: config.stateDir,
            hosts: config.hosts,
          },
          { ...config, authorizedKeys: "missing.pub" },
          { ...config, recheck: 30 },
          { ...config, hookTimeout: 0 },
          { ...config, hookTimeout: 1.5 },
          { ...config, hookTimeout: "2m" },
          { ...config, hosts: [{ ...config.hosts[0], kind: "linux" }] },
        ];

        const errors = [
          yield* Effect.flip(loadConfig(unparsed)),
          ...(yield* Effect.forEach(contents, (each) =>
            Effect.flatMap(load(each), ({ loaded }) => Effect.flip(loaded))
          )),
        ];

        expect(errors.map(({ _tag }) => _tag)).toStrictEqual(
          errors.map(() => "Invalid")
        );
        expect(errors.map(({ file }) => file === undefined)).not.toContain(
          true
        );
      })
  );

  it.effect(
    "a listen address that is neither tailnet nor loopback is refused unless the config names both callers and tls, saying which it lacks",
    () =>
      Effect.gen(function* () {
        const tls = { cert: "cert.pem", key: "key.pem" };

        for (const address of ["203.0.113.7", "0.0.0.0", "::", "10.0.0.5"]) {
          const listen = { ...config.listen, address };

          for (const [extra, lacks, has] of [
            [{}, "callers and tls", undefined],
            [{ callers: "callers" }, "needs tls set", "callers"],
            [{ tls }, "needs callers set", "tls set"],
          ] as const) {
            const { file, loaded } = yield* load({
              ...config,
              listen,
              ...extra,
            });

            yield* guarded(path.dirname(file));

            const error = yield* Effect.flip(loaded);

            expect([error._tag, error.file], address).toStrictEqual([
              "Invalid",
              file,
            ]);
            expect(error.message, address).toContain(
              `listen.address ${address} is not a tailnet address`
            );
            expect(error.message, address).toContain(lacks);

            if (has !== undefined) {
              expect(error.message, address).not.toContain(has);
            }
          }
        }
      })
  );

  it.effect(
    "a config with callers and tls listens anywhere and reads each",
    () =>
      Effect.gen(function* () {
        const { file, loaded } = yield* load({
          ...config,
          listen: { ...config.listen, address: "203.0.113.7" },
          callers: "callers",
          tls: { cert: "cert.pem", key: "key.pem" },
        });

        const { laptop } = yield* guarded(path.dirname(file));
        const read = yield* loaded;

        expect(read.listen.address).toBe("203.0.113.7");
        expect(read.callers?.map(({ name }) => name)).toStrictEqual(["laptop"]);
        expect(Buffer.from(read.callers?.[0]?.hash ?? []).toString("hex")).toBe(
          laptop.line.split(" ")[1]
        );
        expect(read.tls).toStrictEqual({ cert: "a certificate", key: "a key" });
      })
  );

  it.effect("a config that can't be read is Invalid and names its file", () =>
    Effect.gen(function* () {
      const file = path.join(yield* scratch, "missing.json");
      const error = yield* Effect.flip(loadConfig(file));

      expect([error._tag, error.file]).toStrictEqual(["Invalid", file]);
      expect(error.message).toContain("couldn't read server config");
    })
  );
});
