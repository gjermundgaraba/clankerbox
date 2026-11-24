import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { hashToken, mintToken } from "@gjermundgaraba/clankerbox-sdk/node";
import {
  mkdir,
  write,
  scratch,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { transport } from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import type { StubServer } from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import { Effect, Redacted } from "effect";
import { afterEach, expect } from "vite-plus/test";

import {
  cleanup,
  cli,
  decodeJsonError,
  serverIn,
  serverUrl,
  writeConfig,
} from "./support.ts";

const stubs: StubServer[] = [];

const server = serverIn(stubs);

const secureUrl = "https://cbx.test";

const hostsStderr = (config: string) =>
  Effect.map(cli(["hosts", "--config", config]), ({ stderr }) => stderr);

layer(NodeServices.layer)((it) => {
  afterEach(async () => {
    await cleanup(stubs);
  });

  it.effect(
    "the config is read from $XDG_CONFIG_HOME/clankerbox/config.json without --config",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;

        yield* mkdir(path.join(dir, "clankerbox"));
        yield* writeConfig(path.join(dir, "clankerbox"));

        const { code, stdout } = yield* cli(["hosts"], {
          server: server(),
          env: { XDG_CONFIG_HOME: dir },
        });

        expect(code).toBe(0);
        expect(stdout).toContain("ubuntu");
      })
  );

  it.effect(
    "without XDG_CONFIG_HOME the config is read from ~/.config/clankerbox/config.json",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;

        yield* mkdir(path.join(dir, ".config", "clankerbox"));
        yield* writeConfig(path.join(dir, ".config", "clankerbox"));

        const { code } = yield* cli(["hosts"], {
          server: server(),
          env: { HOME: dir },
        });

        expect(code).toBe(0);
      })
  );

  it.effect(
    "a config with an unknown key, or a server that isn't a URL, is Invalid naming the file",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const typo = path.join(dir, "typo.json");
        const unparsable = path.join(dir, "unparsable.json");

        yield* write(
          typo,
          JSON.stringify({ server: serverUrl, sever: serverUrl })
        );
        yield* write(unparsable, JSON.stringify({ server: "not a url" }));

        const typoed = yield* cli(["hosts", "--json", "--config", typo]);

        const notUrl = yield* cli(["hosts", "--json", "--config", unparsable]);

        expect([typoed.code, notUrl.code]).toStrictEqual([1, 1]);
        expect(decodeJsonError(typoed.stdout).error).toMatchObject({
          tag: "Invalid",
          file: typo,
        });
        expect(decodeJsonError(notUrl.stdout).error).toMatchObject({
          tag: "Invalid",
          file: unparsable,
        });
      })
  );

  it.effect(
    "a config's mistakes are all named, each by its JSON path, the old list of hosts among them",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const wrong = path.join(dir, "wrong.json");
        const empty = path.join(dir, "empty.json");

        yield* write(
          wrong,
          JSON.stringify({
            hosts: [{ id: "linux", url: serverUrl }],
          })
        );
        yield* write(empty, JSON.stringify({}));

        expect(yield* hostsStderr(wrong)).toBe(
          `clankerbox: Invalid: client config ${wrong}: hosts: not a known field; server: missing`
        );
        expect(yield* hostsStderr(empty)).toBe(
          `clankerbox: Invalid: client config ${empty}: server: missing`
        );
        expect(yield* hostsStderr(path.join(dir, "absent.json"))).toBe(
          `clankerbox: Invalid: couldn't read client config ${path.join(dir, "absent.json")}: no such file or directory`
        );
      })
  );
  it.effect(
    "a config's token, a file beside it, is sent as a bearer token on every call, and a file holding no token, a hash, a host's token or a token without its prefix is Invalid saying which",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = path.join(dir, "config.json");
        const { token } = mintToken("caller", "laptop");
        const stub = server();

        yield* write(
          path.join(dir, "laptop.token"),
          `${Redacted.value(token)}\n`
        );
        yield* write(
          config,
          JSON.stringify({ server: secureUrl, token: "laptop.token" })
        );

        const { code } = yield* cli(["hosts", "--config", config], {
          http: transport(new Map([[secureUrl, stub]])),
        });

        expect(code).toBe(0);
        expect(stub.authorizations).not.toStrictEqual([]);
        expect(new Set(stub.authorizations)).toStrictEqual(
          new Set([`Bearer ${Redacted.value(token)}`])
        );

        const needs =
          "where it needs a caller's token, cbx_ and 64 lowercase hex digits as `clankerbox-server token add` prints";

        for (const [file, text, holds] of [
          ["raw.token", "laptop\n", "no token"],
          [
            "hash.token",
            `${Buffer.from(hashToken(Redacted.value(token))).toString("hex")}\n`,
            "a SHA-256, which a callers file or store keeps, not the token",
          ],
          [
            "host.token",
            `${Redacted.value(mintToken("host", "cp").token)}\n`,
            "a host's token",
          ],
          [
            "bare.token",
            `${Redacted.value(token).slice("cbx_".length)}\n`,
            "a SHA-256, which a callers file or store keeps, not the token",
          ],
        ] as const) {
          yield* write(path.join(dir, file), text);
          yield* write(
            config,
            JSON.stringify({ server: secureUrl, token: file })
          );

          expect(yield* hostsStderr(config)).toBe(
            `clankerbox: Invalid: token ${path.join(dir, file)} holds ${holds}, ${needs}`
          );
        }
      })
  );
});
