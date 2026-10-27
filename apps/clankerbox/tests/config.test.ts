import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import {
  mkdir,
  write,
  scratch,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import type { StubHost } from "@gjermundgaraba/clankerbox-sdk/testing/stub-host";
import { Effect } from "effect";
import { afterEach, expect } from "vite-plus/test";

import {
  cleanup,
  cli,
  decodeJsonError,
  hostIn,
  sizes,
  url,
  writeConfig,
} from "./support.ts";

const stubs: StubHost[] = [];

const host = hostIn(stubs);

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
        yield* writeConfig(path.join(dir, "clankerbox"), ["linux"]);

        const { code, stdout } = yield* cli(["hosts"], {
          endpoints: [["linux", host({ id: "linux", bases: ["ubuntu"] })]],
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
        yield* writeConfig(path.join(dir, ".config", "clankerbox"), ["linux"]);

        const { code } = yield* cli(["hosts"], {
          endpoints: [["linux", host({ id: "linux", bases: ["ubuntu"] })]],
          env: { HOME: dir },
        });

        expect(code).toBe(0);
      })
  );

  it.effect(
    "a config with an unknown key, or listing a host twice, is Invalid naming the file",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const typo = path.join(dir, "typo.json");
        const twice = path.join(dir, "twice.json");

        yield* write(
          typo,
          JSON.stringify({
            hosts: [{ id: "linux", url: "http://linux.test" }],
            host: [],
          })
        );
        yield* write(
          twice,
          JSON.stringify({
            hosts: [
              { id: "linux", url: "http://linux.test" },
              { id: "linux", url: "http://other.test" },
            ],
          })
        );

        const typoed = yield* cli(["hosts", "--json", "--config", typo]);
        const listedTwice = yield* cli(["hosts", "--json", "--config", twice]);

        expect([typoed.code, listedTwice.code]).toStrictEqual([1, 1]);
        expect(decodeJsonError(typoed.stdout).error).toMatchObject({
          tag: "Invalid",
          file: typo,
        });
        expect(decodeJsonError(listedTwice.stdout).error).toMatchObject({
          tag: "Invalid",
          file: twice,
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
            hosts: [{ id: "linux", url: url("linux") }],
            profiles: "~/profiles",
            authorizedKeys: "~/.ssh/id_ed25519.pub",
          })
        );

        const run = (args: readonly string[]) =>
          cli([...args, "--config", config], {
            endpoints: [["linux", host({ id: "linux", bases: ["ubuntu"] })]],
          });

        const hosts = yield* run(["hosts"]);
        const profiles = yield* run(["profiles"]);

        const create = yield* run([
          "create",
          "box",
          ...sizes,
          "--setup",
          script,
        ]);

        expect(hosts.code).toBe(0);
        expect(profiles.stderr).toBe(unset("~/profiles"));
        expect(create.stderr).toBe(unset("~/.ssh/id_ed25519.pub"));
      })
  );

  it.effect(
    "a config's mistakes are all named, each by its JSON path, and an empty host list by what it lacks",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const wrong = path.join(dir, "wrong.json");
        const empty = path.join(dir, "empty.json");

        yield* write(
          wrong,
          JSON.stringify({ hosts: [{ id: "Linux" }], host: [] })
        );
        yield* write(empty, JSON.stringify({ hosts: [] }));

        expect(yield* hostsStderr(wrong)).toBe(
          `clankerbox: Invalid: client config ${wrong}: host: not a known field; hosts[0].id: a host ID is 1 to 32 lowercase letters, digits and '-', starting with a letter; hosts[0].url: missing`
        );
        expect(yield* hostsStderr(empty)).toBe(
          "clankerbox: Invalid: the host list is empty: a client needs a host"
        );
        expect(yield* hostsStderr(path.join(dir, "absent.json"))).toBe(
          `clankerbox: Invalid: couldn't read client config ${path.join(dir, "absent.json")}: no such file or directory`
        );
      })
  );
});
