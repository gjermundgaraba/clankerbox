import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { write, scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect } from "effect";
import { expect } from "vite-plus/test";

import { cli, decodeJsonError, writeConfig, writeProfiles } from "./support.ts";

layer(NodeServices.layer)((it) => {
  it.effect(
    "profiles lists the profiles directory's profiles by name, without asking the control plane",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;

        yield* writeProfiles(dir);

        const config = yield* writeConfig(dir, "profiles");
        const { code, stdout } = yield* cli(["profiles", "--config", config]);
        const rows = stdout.split("\n").map((line) => line.split(/\s+/u));

        expect(code).toBe(0);
        expect(rows).toStrictEqual([
          ["NAME", "BASE", "CPU", "RAM", "DISK", "SETUP", "TIMEOUT"],
          ["dev", "ubuntu-dev", "2", "4G", "20G", "dev-recipe", "15m"],
          ["small", "ubuntu", "1", "1G", "10G", "-", "-"],
        ]);
      })
  );

  it.effect(
    "profiles --json carries each profile's name and fields, with its setup path resolved",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const profiles = yield* writeProfiles(dir);
        const config = yield* writeConfig(dir, "profiles");

        const { code, stdout } = yield* cli([
          "profiles",
          "--json",
          "--config",
          config,
        ]);

        expect(code).toBe(0);
        expect(JSON.parse(stdout)).toStrictEqual({
          profiles: [
            {
              name: "dev",
              base: "ubuntu-dev",
              cpu: 2,
              ramMib: 4096,
              diskGib: 20,
              setup: {
                path: path.join(profiles, "dev-recipe"),
                timeoutSeconds: 900,
              },
            },
            {
              name: "small",
              base: "ubuntu",
              cpu: 1,
              ramMib: 1024,
              diskGib: 10,
            },
          ],
        });
      })
  );

  it.effect(
    "profiles fails without a profiles directory, or on a profile that doesn't decode, one that still names a host among them",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const bare = yield* writeConfig(dir);

        const unset = yield* cli(["profiles", "--json", "--config", bare]);

        expect(unset.code).toBe(1);

        const { error: unsetError } = decodeJsonError(unset.stdout);

        expect(unsetError.tag).toBe("Invalid");
        expect(unsetError.message).toContain("no profiles directory");

        const missing = yield* cli([
          "profiles",
          "--json",
          "--config",
          yield* writeConfig(dir, "absent"),
        ]);

        expect(missing.code).toBe(1);
        expect(decodeJsonError(missing.stdout).error.tag).toBe("Invalid");

        const profiles = yield* writeProfiles(dir);

        yield* write(
          path.join(profiles, "broken.json"),
          JSON.stringify({ base: "ubuntu" })
        );

        const broken = yield* cli([
          "profiles",
          "--json",
          "--config",
          yield* writeConfig(dir, "profiles"),
        ]);

        expect(broken.code).toBe(1);
        expect(decodeJsonError(broken.stdout).error.tag).toBe("Invalid");
        expect(decodeJsonError(broken.stdout).error.message).toBe(
          `profile ${path.join(profiles, "broken.json")}: cpu: missing; ramMib: missing; diskGib: missing`
        );

        yield* write(
          path.join(profiles, "broken.json"),
          JSON.stringify({
            base: "ubuntu",
            cpu: 1,
            ramMib: 1024,
            diskGib: 10,
            host: "hetzner",
          })
        );

        const hosted = yield* cli([
          "profiles",
          "--json",
          "--config",
          yield* writeConfig(dir, "profiles"),
        ]);

        expect(hosted.code).toBe(1);
        expect(decodeJsonError(hosted.stdout).error.message).toBe(
          `profile ${path.join(profiles, "broken.json")}: host: not a known field`
        );
      })
  );
});
