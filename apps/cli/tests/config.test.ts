import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import {
  mkdir,
  write,
  scratch,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import type { StubServer } from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import { Effect } from "effect";
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
    "a config from 0.35 that still names authorizedKeys or profiles is refused, saying where each went",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const keys = path.join(dir, "keys.json");
        const profiles = path.join(dir, "profiles.json");

        yield* write(
          keys,
          JSON.stringify({
            server: serverUrl,
            authorizedKeys: "~/.ssh/id_ed25519.pub",
          })
        );
        yield* write(
          profiles,
          JSON.stringify({ server: serverUrl, profiles: "profiles" })
        );

        expect(yield* hostsStderr(keys)).toBe(
          `clankerbox: Invalid: client config ${keys}: authorizedKeys: moved to the server config: delete it here, and put its keys in the file the server config's authorizedKeys names (README, Upgrading from 0.35)`
        );
        expect(yield* hostsStderr(profiles)).toBe(
          `clankerbox: Invalid: client config ${profiles}: profiles: profiles are gone: delete it here, and build each profile's setup as a template on the server, with clankerbox template build (README, Upgrading from 0.35)`
        );
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
});
