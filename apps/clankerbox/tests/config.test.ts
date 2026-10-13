import * as NodeServices from "@effect/platform-node/NodeServices";
import { join } from "node:path";
import { layer } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, expect } from "vite-plus/test";
import { mkdir, type StubHost, write, scratch } from "@gjermundgaraba/clankerbox-sdk/testing";
import { cleanup, cli, decodeJsonError, hostIn, writeConfig } from "./support.ts";

const stubs: Array<StubHost> = [];

afterEach(() => cleanup(stubs));

const host = hostIn(stubs);

layer(NodeServices.layer)((it) => {
  it.effect(
    "the config is read from $XDG_CONFIG_HOME/clankerbox/config.json without --config",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;

        yield* mkdir(join(dir, "clankerbox"));
        yield* writeConfig(join(dir, "clankerbox"), ["linux"]);

        const { code, stdout } = yield* cli(["hosts"], {
          endpoints: [["linux", host({ id: "linux", bases: ["ubuntu"] })]],
          env: { XDG_CONFIG_HOME: dir },
        });

        expect(code).toBe(0);
        expect(stdout).toContain("ubuntu");
      }),
  );

  it.effect(
    "without XDG_CONFIG_HOME the config is read from ~/.config/clankerbox/config.json",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;

        yield* mkdir(join(dir, ".config", "clankerbox"));
        yield* writeConfig(join(dir, ".config", "clankerbox"), ["linux"]);

        const { code } = yield* cli(["hosts"], {
          endpoints: [["linux", host({ id: "linux", bases: ["ubuntu"] })]],
          env: { HOME: dir },
        });

        expect(code).toBe(0);
      }),
  );

  it.effect(
    "a config with an unknown key is Invalid naming the file, and one listing a host twice Invalid",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const typo = join(dir, "typo.json");
        const twice = join(dir, "twice.json");

        yield* write(
          typo,
          JSON.stringify({ hosts: [{ id: "linux", url: "http://linux.test" }], host: [] }),
        );
        yield* write(
          twice,
          JSON.stringify({
            hosts: [
              { id: "linux", url: "http://linux.test" },
              { id: "linux", url: "http://other.test" },
            ],
          }),
        );

        const typoed = yield* cli(["hosts", "--json", "--config", typo]);
        const listedTwice = yield* cli(["hosts", "--json", "--config", twice]);

        expect([typoed.code, listedTwice.code]).toEqual([1, 1]);
        expect(decodeJsonError(typoed.stdout).error).toMatchObject({ tag: "Invalid", file: typo });
        expect(decodeJsonError(listedTwice.stdout).error.tag).toBe("Invalid");
      }),
  );

  it.effect(
    "a config's mistakes are all named, each by its JSON path, and an empty host list by what it lacks",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const wrong = join(dir, "wrong.json");
        const empty = join(dir, "empty.json");

        yield* write(wrong, JSON.stringify({ hosts: [{ id: "Linux" }], host: [] }));
        yield* write(empty, JSON.stringify({ hosts: [] }));

        const run = (config: string) =>
          Effect.map(cli(["hosts", "--config", config]), ({ stderr }) => stderr);

        expect(yield* run(wrong)).toBe(
          `clankerbox: Invalid: client config ${wrong}: host: not a known field; hosts[0].id: a host ID is 1 to 32 lowercase letters, digits and '-', starting with a letter; hosts[0].url: missing`,
        );
        expect(yield* run(empty)).toBe(
          "clankerbox: Invalid: the host list is empty: a client needs a host",
        );
        expect(yield* run(join(dir, "absent.json"))).toBe(
          `clankerbox: Invalid: couldn't read client config ${join(dir, "absent.json")}: no such file or directory`,
        );
      }),
  );
});
