import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Capacity } from "@gjermundgaraba/clankerbox-sdk";
import { write, scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { operatorKey } from "@gjermundgaraba/clankerbox-sdk/testing/keys";
import type { StubHost } from "@gjermundgaraba/clankerbox-sdk/testing/stub-host";
import { Effect } from "effect";
import { afterEach, expect } from "vite-plus/test";

import {
  cleanup,
  cli,
  hostIn,
  sizes,
  writeConfig,
  writeProfiles,
} from "./support.ts";
import type { CliOptions } from "./support.ts";

const stubs: StubHost[] = [];

const host = hostIn(stubs);

layer(NodeServices.layer)((it) => {
  afterEach(async () => {
    await cleanup(stubs);
  });

  it.effect(
    "prebuild captures a profile's setup, a create of the profile restores it, and other sizes or --fresh run the setup",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const profiles = yield* writeProfiles(dir);
        const config = yield* writeConfig(dir, ["linux"], "profiles");
        const linux = host({ id: "linux", bases: ["ubuntu"] });
        const endpoints: CliOptions["endpoints"] = [["linux", linux]];

        yield* write(
          path.join(profiles, "dev.json"),
          JSON.stringify({
            base: "ubuntu",
            cpu: 2,
            ramMib: 4096,
            diskGib: 20,
            setup: { path: "dev-recipe" },
          })
        );

        const built = yield* cli(
          ["prebuild", "--profile", "dev", "--config", config],
          {
            endpoints,
          }
        );

        expect(built.code).toBe(0);
        expect(built.stdout).toMatch(/^linux_prebuilt-[0-9a-f]{12}$/u);
        expect(built.stderr).toBe("");

        const again = yield* cli(
          ["prebuild", "--profile", "dev", "--config", config],
          {
            endpoints,
          }
        );

        expect(again.code).toBe(0);
        expect(again.stdout).toBe(built.stdout);
        expect(again.stderr).toBe("");
        expect(linux.prebuilds.map(({ id }) => id)).toStrictEqual([
          built.stdout,
          built.stdout,
        ]);
        expect(linux.creates).toStrictEqual([]);

        const listed = yield* cli(["checkpoint", "list", "--config", config], {
          endpoints,
        });

        expect(listed.stdout).toMatch(/PROFILE/u);
        expect(listed.stdout).toMatch(
          new RegExp(
            `${built.stdout}\\s+disk\\s+linux_prebuilding-\\S+\\s+ubuntu\\s+dev\\s`,
            "u"
          )
        );

        const restored = yield* cli(
          ["create", "box", "--profile", "dev", "--config", config],
          {
            endpoints,
          }
        );

        expect(restored.code).toBe(0);
        expect(restored.stdout).toBe("linux_box");
        expect(restored.stderr).toMatch(
          new RegExp(
            `^clankerbox: restored from the prebuild ${built.stdout}, made \\d+[smhd] ago$`,
            "u"
          )
        );
        expect(linux.creates).toStrictEqual([]);

        for (const flags of [["--ram", "8G"], ["--fresh"]]) {
          const before = linux.creates.length;

          const fresh = yield* cli(
            [
              "create",
              `box${before}`,
              "--profile",
              "dev",
              ...flags,
              "--config",
              config,
            ],
            { endpoints }
          );

          expect(fresh.code).toBe(0);
          expect(fresh.stderr).toBe("");
          expect(linux.creates).toHaveLength(before + 1);
        }
      })
  );

  it.effect(
    "prebuild sends the host its spec and its setup's script, and prints the host's error",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir, ["linux"]);
        const script = path.join(dir, "setup.sh");

        yield* write(script, "#!/bin/sh\ntrue\n");

        const linux = host({ id: "linux", bases: ["ubuntu"] });

        const failing = host({
          id: "linux",
          bases: ["ubuntu"],
          prebuild: () =>
            Effect.fail(new Capacity({ message: "no room for the builder" })),
        });

        const built = yield* cli(
          ["prebuild", ...sizes, "--setup", script, "--config", config],
          {
            endpoints: [["linux", linux]],
          }
        );

        const refused = yield* cli(
          ["prebuild", ...sizes, "--setup", script, "--config", config],
          {
            endpoints: [["linux", failing]],
          }
        );

        expect(built.code).toBe(0);
        expect(linux.prebuilds).toStrictEqual([
          {
            id: built.stdout,
            base: "ubuntu",
            cpu: 2,
            ramMib: 4096,
            diskGib: 20,
            setup: {
              script: "#!/bin/sh\ntrue\n",
              authorizedKeys: `${operatorKey}\n`,
            },
          },
        ]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("Capacity: no room for the builder");
      })
  );

  it.effect("prebuild names itself in a refusal of its spec", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir, ["linux"]);
      const linux = host({ id: "linux", bases: ["ubuntu"] });

      const { code, stderr } = yield* cli(
        ["prebuild", "--base", "ubuntu", "--config", config],
        {
          endpoints: [["linux", linux]],
        }
      );

      expect(code).toBe(1);
      expect(stderr).toBe(
        "clankerbox: Invalid: prebuild: --cpu: missing; --ram: missing; --disk: missing"
      );
      expect(linux.calls).toStrictEqual([]);
    })
  );

  it.effect("prebuild needs a setup", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir, ["linux"]);
      const linux = host({ id: "linux", bases: ["ubuntu"] });

      const { code, stderr } = yield* cli(
        ["prebuild", ...sizes, "--config", config],
        {
          endpoints: [["linux", linux]],
        }
      );

      expect(code).toBe(1);
      expect(stderr).toBe(
        "clankerbox: Invalid: prebuild needs a setup: pass --setup, or a profile that has one"
      );
      expect(linux.calls).toStrictEqual([]);
    })
  );
});
