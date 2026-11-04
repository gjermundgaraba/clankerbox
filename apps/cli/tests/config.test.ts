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
  sizes,
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
          JSON.stringify({ server: serverUrl, profile: "profiles" })
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
    "a config path under ~/ needs HOME only where a command uses it, and says so naming the file",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = path.join(dir, "config.json");
        const script = path.join(dir, "setup.sh");

        const unset = (given: string) =>
          `clankerbox: Invalid: client config ${config}: ${given} starts with ~/, and HOME is unset`;

        yield* write(script, "#!/bin/sh\n");
        yield* write(
          config,
          JSON.stringify({
            server: serverUrl,
            profiles: "~/profiles",
          })
        );

        const run = (args: readonly string[]) =>
          cli([...args, "--config", config], { server: server() });

        const hosts = yield* run(["hosts"]);
        const profiles = yield* run(["profiles"]);

        const create = yield* run([
          "create",
          "box",
          ...sizes,
          "--setup",
          script,
        ]);

        expect([hosts.code, create.code]).toStrictEqual([0, 0]);
        expect(profiles.stderr).toBe(unset("~/profiles"));
      })
  );

  it.effect(
    "a config from 0.35 that still names authorizedKeys is refused, saying they moved to the server config",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const old = path.join(dir, "config.json");

        yield* write(
          old,
          JSON.stringify({
            server: serverUrl,
            authorizedKeys: "~/.ssh/id_ed25519.pub",
          })
        );

        expect(yield* hostsStderr(old)).toBe(
          `clankerbox: Invalid: client config ${old}: authorizedKeys: moved to the server config: delete it here, and put its keys in the file the server config's authorizedKeys names (README, Upgrading from 0.35)`
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
            profiles: 7,
          })
        );
        yield* write(empty, JSON.stringify({}));

        expect(yield* hostsStderr(wrong)).toBe(
          `clankerbox: Invalid: client config ${wrong}: hosts: not a known field; server: missing; profiles: Expected string`
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
