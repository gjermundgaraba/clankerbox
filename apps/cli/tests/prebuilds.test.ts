import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { NotOffered, ScriptFailed } from "@gjermundgaraba/clankerbox-sdk";
import { write, scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { operatorKey } from "@gjermundgaraba/clankerbox-sdk/testing/keys";
import type {
  MachineStep,
  StubServer,
} from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import { Effect } from "effect";
import { afterEach, expect } from "vite-plus/test";

import {
  cleanup,
  cli,
  decodeJsonError,
  serverIn,
  sizes,
  writeConfig,
  writeProfiles,
} from "./support.ts";

const stubs: StubServer[] = [];

const server = serverIn(stubs);

const restored: MachineStep = {
  phase: "settled",
  state: "running",
  prebuild: "prebuilt-0",
};

layer(NodeServices.layer)((it) => {
  afterEach(async () => {
    await cleanup(stubs);
  });

  it.effect(
    "prebuild waits for the build and prints its ID, and the checkpoint it leaves lists under the profile",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const profiles = yield* writeProfiles(dir);
        const config = yield* writeConfig(dir, "profiles");
        const stub = server();

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
          { server: stub }
        );

        expect(built).toMatchObject({
          code: 0,
          stdout: "prebuilt-0",
          stderr: "",
        });
        expect(stub.creates).toStrictEqual([]);

        const listed = yield* cli(["checkpoint", "list", "--config", config], {
          server: stub,
        });

        expect(listed.stdout).toMatch(/PROFILE/u);
        expect(listed.stdout).toMatch(
          /prebuilt-0\s+ready\s+disk\s+prebuilt-0\s+ubuntu\s+dev\s/u
        );
      })
  );

  it.effect(
    "a create the control plane restored from a prebuild says which on stderr, and --fresh asks it not to",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        yield* writeProfiles(dir);

        const config = yield* writeConfig(dir, "profiles");
        const stub = server({ bases: ["ubuntu-dev"] });

        stub.script("box", [restored]);
        stub.script("quiet", [restored]);

        const text = yield* cli(
          ["create", "box", "--profile", "dev", "--config", config],
          { server: stub }
        );

        const json = yield* cli(
          ["create", "quiet", "--profile", "dev", "--json", "--config", config],
          { server: stub }
        );

        const fresh = yield* cli(
          ["create", "slow", "--profile", "dev", "--fresh", "--config", config],
          { server: stub }
        );

        expect(text).toMatchObject({
          code: 0,
          stdout: "box",
          stderr: "clankerbox: restored from the prebuild prebuilt-0",
        });
        expect(json.stderr).toBe("");
        expect(JSON.parse(json.stdout)).toMatchObject({
          id: "quiet",
          prebuild: "prebuilt-0",
        });
        expect(fresh).toMatchObject({ code: 0, stdout: "slow", stderr: "" });
        expect(stub.creates.map(({ fresh: asked }) => asked)).toStrictEqual([
          undefined,
          undefined,
          true,
        ]);
      })
  );

  it.effect(
    "prebuild sends its spec and its setup's script, and prints the error of a refusal or of a build that fails",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir);
        const script = path.join(dir, "setup.sh");

        yield* write(script, "#!/bin/sh\ntrue\n");

        const stub = server();
        const args = ["prebuild", ...sizes, "--setup", script];

        const refusing = server({
          prebuild: ({ base }) =>
            Effect.fail(new NotOffered({ message: "no host offers it", base })),
        });

        const built = yield* cli([...args, "--config", config], {
          server: stub,
        });

        const refused = yield* cli([...args, "--config", config], {
          server: refusing,
        });

        stub.scriptBuild("prebuilt-1", [
          {
            phase: "failed",
            error: new ScriptFailed({
              message: "setup exited 7",
              script: "setup",
            }),
          },
        ]);

        const failed = yield* cli([...args, "--json", "--config", config], {
          server: stub,
        });

        expect(built.code).toBe(0);
        expect(stub.prebuilds[0]).toStrictEqual({
          base: "ubuntu",
          cpu: 2,
          ramMib: 4096,
          diskGib: 20,
          setup: {
            script: "#!/bin/sh\ntrue\n",
            authorizedKeys: `${operatorKey}\n`,
          },
        });
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("NotOffered: no host offers it");
        expect(failed.code).toBe(1);
        expect(decodeJsonError(failed.stdout).error).toMatchObject({
          tag: "ScriptFailed",
          message: "setup exited 7",
          action: "prebuildCheckpoint",
          id: "prebuilt-1",
        });
      })
  );

  it.effect(
    "prebuild get reads a build prebuild --no-wait left going, and how it failed, or says it is gone",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir);
        const script = path.join(dir, "setup.sh");

        yield* write(script, "#!/bin/sh\ntrue\n");

        const stub = server();

        const started = yield* cli(
          [
            "prebuild",
            ...sizes,
            "--setup",
            script,
            "--no-wait",
            "--config",
            config,
          ],
          { server: stub }
        );

        stub.scriptBuild("prebuilt-0", [
          "building",
          {
            phase: "failed",
            error: new ScriptFailed({
              message: "setup exited 7",
              script: "setup",
            }),
          },
        ]);

        const building = yield* cli(
          ["prebuild", "get", "prebuilt-0", "--config", config],
          { server: stub }
        );

        const failed = yield* cli(
          ["prebuild", "get", "prebuilt-0", "--json", "--config", config],
          { server: stub }
        );

        const unknown = yield* cli(
          ["prebuild", "get", "prebuilt-9", "--json", "--config", config],
          { server: stub }
        );

        expect(started).toMatchObject({ code: 0, stdout: "prebuilt-0" });
        expect(building.code).toBe(0);
        expect(building.stdout).toMatch(/PHASE\s+building/u);
        expect(failed.code).toBe(0);
        expect(JSON.parse(failed.stdout)).toMatchObject({
          id: "prebuilt-0",
          phase: "failed",
          error: { _tag: "ScriptFailed", message: "setup exited 7" },
        });
        expect(unknown.code).toBe(1);
        expect(decodeJsonError(unknown.stdout).error).toMatchObject({
          tag: "NotFound",
          action: "getPrebuild",
          id: "prebuilt-9",
        });
        expect(stub.calls).toStrictEqual([
          "checkpoint.prebuild",
          "prebuild.get",
          "prebuild.get",
          "prebuild.get",
        ]);
      })
  );

  it.effect("prebuild names itself in a refusal of its spec", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir);
      const stub = server();

      const { code, stderr } = yield* cli(
        ["prebuild", "--base", "ubuntu", "--config", config],
        { server: stub }
      );

      expect(code).toBe(1);
      expect(stderr).toBe(
        "clankerbox: Invalid: prebuild: --cpu: missing; --ram: missing; --disk: missing"
      );
      expect(stub.calls).toStrictEqual([]);
    })
  );

  it.effect("prebuild needs a setup", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir);
      const stub = server();

      const { code, stderr } = yield* cli(
        ["prebuild", ...sizes, "--config", config],
        { server: stub }
      );

      expect(code).toBe(1);
      expect(stderr).toBe(
        "clankerbox: Invalid: prebuild needs a setup: pass --setup, or a profile that has one"
      );
      expect(stub.calls).toStrictEqual([]);
    })
  );
});
