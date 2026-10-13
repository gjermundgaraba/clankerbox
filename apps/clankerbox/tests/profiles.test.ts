import * as NodeServices from "@effect/platform-node/NodeServices";
import { join } from "node:path";
import { layer } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, expect } from "vite-plus/test";
import { type StubHost, write, scratch } from "@gjermundgaraba/clankerbox-sdk/testing";
import { cleanup, cli, decodeJsonError, writeConfig, writeProfiles } from "./support.ts";

const stubs: Array<StubHost> = [];

afterEach(() => cleanup(stubs));

layer(NodeServices.layer)((it) => {
  it.effect("profiles lists the profiles directory's profiles by name, without asking a host", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;

      yield* writeProfiles(dir);

      const config = yield* writeConfig(dir, ["linux"], "profiles");
      const { code, stdout } = yield* cli(["profiles", "--config", config]);
      const rows = stdout.split("\n").map((line) => line.split(/\s+/u));

      expect(code).toBe(0);
      expect(rows).toEqual([
        ["NAME", "BASE", "CPU", "RAM", "DISK", "SETUP", "TIMEOUT", "HOST"],
        ["dev", "ubuntu-dev", "2", "4G", "20G", "dev-recipe", "15m", "hetzner"],
        ["small", "ubuntu", "1", "1G", "10G", "-", "-", "-"],
      ]);
    }),
  );

  it.effect(
    "profiles --json carries each profile's name and fields, with its setup path resolved",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const profiles = yield* writeProfiles(dir);
        const config = yield* writeConfig(dir, ["linux"], "profiles");

        const { code, stdout } = yield* cli(["profiles", "--json", "--config", config]);

        expect(code).toBe(0);
        expect(JSON.parse(stdout)).toEqual({
          profiles: [
            {
              name: "dev",
              base: "ubuntu-dev",
              cpu: 2,
              ramMib: 4096,
              diskGib: 20,
              setup: { path: join(profiles, "dev-recipe"), timeoutSeconds: 900 },
              host: "hetzner",
            },
            { name: "small", base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10 },
          ],
        });
      }),
  );

  it.effect(
    "profiles fails without a profiles directory, or on a profile that doesn't decode",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const bare = yield* writeConfig(dir, ["linux"]);

        const unset = yield* cli(["profiles", "--json", "--config", bare]);

        expect(unset.code).toBe(1);
        expect(decodeJsonError(unset.stdout).error).toMatchObject({
          tag: "Invalid",
          message: expect.stringContaining("no profiles directory"),
        });

        const missing = yield* cli([
          "profiles",
          "--json",
          "--config",
          yield* writeConfig(dir, ["linux"], "absent"),
        ]);

        expect(missing.code).toBe(1);
        expect(decodeJsonError(missing.stdout).error.tag).toBe("Invalid");

        const profiles = yield* writeProfiles(dir);

        yield* write(join(profiles, "broken.json"), JSON.stringify({ base: "ubuntu" }));

        const broken = yield* cli([
          "profiles",
          "--json",
          "--config",
          yield* writeConfig(dir, ["linux"], "profiles"),
        ]);

        expect(broken.code).toBe(1);
        expect(decodeJsonError(broken.stdout).error.tag).toBe("Invalid");
        expect(decodeJsonError(broken.stdout).error.message).toBe(
          `profile ${join(profiles, "broken.json")}: cpu: missing; ramMib: missing; diskGib: missing`,
        );
      }),
  );
});
