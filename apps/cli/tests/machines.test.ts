import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, layer } from "@effect/vitest";
import { ScriptFailed } from "@gjermundgaraba/clankerbox-sdk";
import {
  mkdir,
  write,
  scratch,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { operatorKey } from "@gjermundgaraba/clankerbox-sdk/testing/keys";
import {
  checkpoint,
  machine,
} from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import type { StubServer } from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import { DateTime, Effect, Schema } from "effect";
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

describe("machines", () => {
  afterEach(async () => {
    await cleanup(stubs);
  });

  layer(NodeServices.layer)((it) => {
    it.effect("machines shows each machine's age", () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir);

        const createdAt = DateTime.subtract(yield* DateTime.now, {
          days: 3,
          hours: 2,
        });

        const { code, stdout, stderr } = yield* cli(
          ["machines", "--config", config],
          { server: server({ machines: [machine("dev", { createdAt })] }) }
        );

        const row = stdout.split("\n").find((line) => line.startsWith("dev"));

        expect(code).toBe(0);
        expect(stdout.split("\n")[0]).toContain("AGE");
        expect(row?.split(/\s+/u)).toContain("3d");
        expect(stderr).toBe("");
      })
    );

    const held = machine("dev", {
      ssh: { user: "admin", host: "100.64.0.7", port: 10_022 },
      hostKey: "ssh-ed25519 AAAAexample",
      tailnet: { state: "joined", name: "dev.example.ts.net" },
    });

    const failing = machine("other", {
      phase: "failed",
      error: new ScriptFailed({
        message: "preparation exited 3",
        script: "preparation",
      }),
      tailnet: {
        state: "failed",
        error: "tailscaled is NeedsMachineAuth, not signed in",
      },
    });

    it.effect(
      "machines shows sizes with their units, marks a failed machine, and leaves the SSH login to get",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);

          const undone = machine("broken", {
            state: "missing",
            phase: "failed",
            error: new ScriptFailed({
              message: "setup exited 7",
              script: "setup",
            }),
          });

          const { stdout } = yield* cli(["machines", "--config", config], {
            server: server({ machines: [held, failing, undone] }),
          });

          const rows = stdout.split("\n");

          expect(rows).toHaveLength(4);
          expect(rows[0]?.split(/\s+/u)).toStrictEqual([
            "ID",
            "STATE",
            "BASE",
            "PROFILE",
            "CPU",
            "RAM",
            "DISK",
            "AGE",
            "ERROR",
          ]);
          expect(rows[1]?.split(/\s+/u).slice(4, 7)).toStrictEqual([
            "1",
            "1G",
            "10G",
          ]);
          expect(rows[2]).toContain("running (failed)");
          expect(rows[2]).toContain("ScriptFailed");
          expect(rows[3]).toContain("missing, wants running (failed)");
          expect(rows[3]).toContain("ScriptFailed");
        })
    );

    it.effect(
      "get reads one machine a field a line, with what it was asked to be, its last error, its host key and its tailnet",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);
          const unnamed = machine("plain", { tailnet: { state: "joined" } });
          const stub = server({ machines: [held, failing, unnamed] });

          const fields = (id: string) =>
            Effect.map(
              cli(["get", id, "--config", config], { server: stub }),
              ({ stdout }) =>
                stdout.split("\n").map((line) => line.split(/\s{2,}/u))
            );

          const json = yield* cli(
            ["get", "dev", "--json", "--config", config],
            { server: stub }
          );

          const gone = yield* cli(
            ["get", "gone", "--json", "--config", config],
            { server: stub }
          );

          expect(yield* fields("dev")).toStrictEqual(
            expect.arrayContaining([
              ["ID", "dev"],
              ["STATE", "running"],
              ["RAM", "1G"],
              ["DISK", "10G"],
              ["DESIRED", "running"],
              ["PHASE", "settled"],
              ["SSH", "admin@100.64.0.7:10022"],
              ["ERROR", "-"],
              ["HOST_KEY", "ssh-ed25519 AAAAexample"],
              ["TAILNET", "dev.example.ts.net"],
            ])
          );
          expect(yield* fields("other")).toStrictEqual(
            expect.arrayContaining([
              ["STATE", "running (failed)"],
              ["PHASE", "failed"],
              ["SSH", "-"],
              ["ERROR", "ScriptFailed: preparation exited 3"],
              ["HOST_KEY", "-"],
              [
                "TAILNET",
                "failed: tailscaled is NeedsMachineAuth, not signed in",
              ],
            ])
          );
          expect(yield* fields("plain")).toStrictEqual(
            expect.arrayContaining([
              ["TAILNET", "joined, with no MagicDNS name"],
            ])
          );
          expect(JSON.parse(json.stdout)).toMatchObject({
            id: "dev",
            ssh: held.ssh,
            hostKey: held.hostKey,
            tailnet: held.tailnet,
          });
          expect([
            gone.code,
            decodeJsonError(gone.stdout).error.tag,
          ]).toStrictEqual([1, "NotFound"]);
        })
    );

    it.effect("machines --json carries the machines, and nothing else", () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir);

        const { code, stdout } = yield* cli(
          ["machines", "--json", "--config", config],
          { server: server({ machines: [machine("dev")] }) }
        );

        const document = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              machines: Schema.Array(
                Schema.Struct({ id: Schema.String, createdAt: Schema.String })
              ),
            })
          )
        )(stdout, { onExcessProperty: "ignore" });

        expect(code).toBe(0);
        expect(JSON.parse(stdout)).toStrictEqual({
          machines: [expect.objectContaining({ id: "dev" })],
        });
        expect(document.machines.map(({ id }) => id)).toStrictEqual(["dev"]);
        expect(document.machines[0]?.createdAt).toBe(
          "2026-10-01T00:00:00.000Z"
        );
      })
    );

    it.effect(
      "create NAME sends the name and sizes, waits for the machine, and prints its ID",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);
          const stub = server();

          const { code, stdout } = yield* cli(
            ["create", "dev", ...sizes, "--config", config],
            { server: stub }
          );

          expect(code).toBe(0);
          expect(stdout).toBe("dev");
          expect(stub.calls).toStrictEqual(["machine.create", "machine.get"]);
          expect(
            stub.creates.map(({ id, cpu, ramMib, diskGib }) => ({
              id,
              cpu,
              ramMib,
              diskGib,
            }))
          ).toStrictEqual([{ id: "dev", cpu: 2, ramMib: 4096, diskGib: 20 }]);
        })
    );

    it.effect(
      "create --profile NAME reads NAME.json from the profiles directory, with its label and setup",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const profiles = path.join(dir, "profiles");

          yield* mkdir(path.join(profiles, "dev-recipe", "files"));
          yield* write(
            path.join(profiles, "dev-recipe", "setup.sh"),
            "#!/bin/sh\ntrue\n"
          );
          yield* write(path.join(profiles, "dev-recipe", "files", "a"), "a\n");
          yield* write(
            path.join(profiles, "dev.json"),
            JSON.stringify({
              base: "ubuntu",
              cpu: 2,
              ramMib: 4096,
              diskGib: 20,
              setup: { path: "dev-recipe", timeoutSeconds: 900 },
            })
          );

          const config = yield* writeConfig(dir, "profiles");
          const stub = server();

          const { code, stdout } = yield* cli(
            ["create", "box", "--profile", "dev", "--config", config],
            { server: stub }
          );

          const [request] = stub.creates;

          expect(code).toBe(0);
          expect(stdout).toBe("box");
          expect(request?.profile).toBe("dev");
          expect(request?.setup?.timeoutSeconds).toBe(900);
          expect(request?.setup?.script.startsWith("#!/bin/sh\n")).toBe(true);
        })
    );

    it.effect(
      "create has no --host: a client says what it wants, and the control plane places it",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);
          const stub = server();

          const { code, stderr } = yield* cli(
            ["create", "dev", ...sizes, "--host", "linux", "--config", config],
            { server: stub }
          );

          expect(code).toBe(1);
          expect(stderr).toContain("--host");
          expect(stub.calls).toStrictEqual([]);
        })
    );

    it.effect(
      "create takes a name, and refuses an old host-prefixed ID before sending anything",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);
          const stub = server();

          const { code, stdout } = yield* cli(
            ["create", "linux_dev", ...sizes, "--json", "--config", config],
            { server: stub }
          );

          expect(code).toBe(1);
          expect(decodeJsonError(stdout).error).toMatchObject({
            tag: "Invalid",
            retryable: false,
          });
          expect(stub.calls).toStrictEqual([]);
        })
    );

    it.effect("create --profile takes a path to a profile file", () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const file = path.join(dir, "small.json");

        yield* write(
          file,
          JSON.stringify({ base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10 })
        );

        const config = yield* writeConfig(dir);
        const stub = server();

        const { code } = yield* cli(
          ["create", "box", "--profile", file, "--config", config],
          { server: stub }
        );

        expect(code).toBe(0);
        expect(stub.creates[0]?.profile).toBe("small");
      })
    );

    it.effect(
      "create's flags override the profile's fields, its setup and timeout included",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const file = path.join(dir, "dev.json");
          const script = path.join(dir, "other.sh");

          yield* write(
            file,
            JSON.stringify({
              base: "ubuntu",
              cpu: 2,
              ramMib: 4096,
              diskGib: 20,
              setup: { path: "missing.sh", timeoutSeconds: 900 },
            })
          );
          yield* write(script, "#!/bin/sh\necho other\n");

          const config = yield* writeConfig(dir);
          const stub = server({ bases: ["ubuntu", "ubuntu-dev"] });

          const { code } = yield* cli(
            [
              "create",
              "box",
              "--profile",
              file,
              "--base",
              "ubuntu-dev",
              "--cpu",
              "8",
              "--setup",
              script,
              "--setup-timeout",
              "1m",
              "--config",
              config,
            ],
            { server: stub }
          );

          const [request] = stub.creates;

          expect(code).toBe(0);
          expect(request).toMatchObject({
            id: "box",
            base: "ubuntu-dev",
            cpu: 8,
            ramMib: 4096,
            diskGib: 20,
            profile: "dev",
            setup: { timeoutSeconds: 60 },
          });
          expect(request?.setup?.script).toBe("#!/bin/sh\necho other\n");
        })
    );

    it.effect(
      "--setup and --setup-timeout each override the profile's, and a setup with no timeout leaves it to the host",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);
          const script = path.join(dir, "setup.sh");
          const other = path.join(dir, "other.sh");
          const profile = path.join(dir, "small.json");

          yield* write(script, "#!/bin/sh\ntrue\n");
          yield* write(other, "#!/bin/sh\necho other\n");
          yield* write(
            profile,
            JSON.stringify({
              base: "ubuntu",
              cpu: 1,
              ramMib: 1024,
              diskGib: 10,
              setup: { path: "setup.sh", timeoutSeconds: 900 },
            })
          );

          const stub = server();

          for (const [name, args] of [
            ["bare", [...sizes, "--setup", script]],
            ["timed", ["--profile", profile, "--setup-timeout", "60s"]],
            ["scripted", ["--profile", profile, "--setup", other]],
          ] as const) {
            const { code } = yield* cli(
              ["create", name, ...args, "--config", config],
              { server: stub }
            );

            expect(code).toBe(0);
          }

          expect(
            stub.creates.map(({ setup }) => [
              setup?.script,
              setup?.timeoutSeconds,
            ])
          ).toStrictEqual([
            ["#!/bin/sh\ntrue\n", undefined],
            ["#!/bin/sh\ntrue\n", 60],
            ["#!/bin/sh\necho other\n", 900],
          ]);
        })
    );

    it.effect(
      "create refuses --setup-timeout with no setup to time, and a spec missing its base or sizes",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);
          const profile = path.join(dir, "small.json");

          yield* write(
            profile,
            JSON.stringify({
              base: "ubuntu",
              cpu: 1,
              ramMib: 1024,
              diskGib: 10,
            })
          );

          const stub = server();

          const run = (args: readonly string[]) =>
            cli(["create", "box", ...args, "--json", "--config", config], {
              server: stub,
            });

          const runs = [
            yield* run(["--profile", profile, "--setup-timeout", "60s"]),
            yield* run(["--base", "ubuntu"]),
            yield* run(["--profile", profile, "--cpu", "0"]),
          ];

          for (const { code, stdout } of runs) {
            expect(code).toBe(1);
            expect(decodeJsonError(stdout).error.tag).toBe("Invalid");
          }

          expect(
            decodeJsonError(runs[0]?.stdout ?? "").error.message
          ).toContain("--setup-timeout");
          expect(decodeJsonError(runs[1]?.stdout ?? "").error.message).toBe(
            "create: --cpu: missing; --ram: missing; --disk: missing"
          );
          expect(decodeJsonError(runs[2]?.stdout ?? "").error.message).toBe(
            "create: --cpu: Expected a value greater than 0"
          );
          expect(stub.calls).toStrictEqual([]);
        })
    );

    it.effect("create --setup sends a script file as its text", () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir);
        const script = path.join(dir, "setup.sh");

        yield* write(script, "#!/bin/sh\necho set up\n");

        const stub = server();

        const { code } = yield* cli(
          [
            "create",
            "box",
            ...sizes,
            "--setup",
            script,
            "--setup-timeout",
            "60s",
            "--config",
            config,
          ],
          { server: stub }
        );

        expect(code).toBe(0);
        expect(stub.creates[0]?.setup?.script).toBe("#!/bin/sh\necho set up\n");
        expect(stub.creates[0]?.setup?.timeoutSeconds).toBe(60);
      })
    );

    it.effect(
      "create sends the config's authorizedKeys, relative to the config or under ~/, with a setup alone, which needs them",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const key = `${operatorKey}\n`;
          const script = path.join(dir, "setup.sh");
          const relative = path.join(dir, "relative.json");
          const home = path.join(dir, "home.json");
          const keyless = path.join(dir, "keyless.json");

          yield* mkdir(path.join(dir, "keys"));
          yield* write(path.join(dir, "keys", "id.pub"), key);
          yield* write(script, "#!/bin/sh\n");
          yield* write(
            relative,
            JSON.stringify({ server: serverUrl, authorizedKeys: "keys/id.pub" })
          );
          yield* write(
            home,
            JSON.stringify({
              server: serverUrl,
              authorizedKeys: "~/keys/id.pub",
            })
          );
          yield* write(keyless, JSON.stringify({ server: serverUrl }));

          const stub = server();

          const create = (
            name: string,
            config: string,
            ...args: readonly string[]
          ) =>
            cli(["create", name, ...sizes, ...args, "--config", config], {
              server: stub,
              env: { HOME: dir },
            });

          yield* create("a", relative, "--setup", script);
          yield* create("b", home, "--setup", script);
          yield* create("c", relative);

          const refused = yield* create("d", keyless, "--setup", script);

          expect(
            stub.creates.map((sent) => sent.setup?.authorizedKeys)
          ).toStrictEqual([key, key, undefined]);
          expect(refused.stderr).toBe(
            "clankerbox: Invalid: create: a setup needs the client config's authorizedKeys, the public keys the host installs for the login user after it"
          );
        })
    );

    it.effect("deleting a machine that is already gone counts as done", () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir);

        const stub = server();

        const text = yield* cli(["delete", "gone", "--config", config], {
          server: stub,
        });

        const json = yield* cli(
          ["delete", "gone", "--json", "--config", config],
          { server: stub }
        );

        expect(text).toMatchObject({ code: 0, stdout: "" });
        expect(text.stderr).toContain("already gone");
        expect(json).toMatchObject({
          code: 0,
          stdout: JSON.stringify({ deleted: "gone" }),
        });
      })
    );

    it.effect(
      "start, pause, stop and fork each wait for the machine to rest, and print where it came to",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);
          const stub = server({ machines: [machine("dev")] });

          const runs = [
            yield* cli(["start", "dev", "--config", config], { server: stub }),
            yield* cli(["pause", "dev", "--config", config], { server: stub }),
            yield* cli(["stop", "dev", "--config", config], { server: stub }),
            yield* cli(["fork", "dev", "copy", "--config", config], {
              server: stub,
            }),
          ];

          expect(runs.map(({ code }) => code)).toStrictEqual([0, 0, 0, 0]);
          expect(runs.map(({ stdout }) => stdout)).toStrictEqual([
            "dev running",
            "dev paused",
            "dev stopped",
            "copy",
          ]);
          expect(stub.calls).toStrictEqual([
            "machine.start",
            "machine.get",
            "machine.pause",
            "machine.get",
            "machine.stop",
            "machine.get",
            "machine.fork",
            "machine.get",
          ]);
        })
    );

    it.effect(
      "resize sends the sizes it is given, in their units, and prints the sizes the machine then has",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);

          const stub = server({ machines: [machine("dev")] });

          const { code, stdout, stderr } = yield* cli(
            [
              "resize",
              "dev",
              "--ram",
              "2G",
              "--disk",
              "30G",
              "--config",
              config,
            ],
            { server: stub }
          );

          expect(stderr).toBe("");
          expect(code).toBe(0);
          expect(stdout).toBe("dev 1 vCPUs, 2G RAM, 30G disk");
          expect(stub.calls).toStrictEqual(["machine.resize", "machine.get"]);
        })
    );

    it.effect(
      "fork and restore send the sizes they are given, leaving out the rest",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);

          const stub = server({
            machines: [machine("dev")],
            checkpoints: [checkpoint("snap")],
          });

          const runs = [
            yield* cli(
              [
                "fork",
                "dev",
                "copy",
                "--ram",
                "2G",
                "--json",
                "--config",
                config,
              ],
              { server: stub }
            ),
            yield* cli(
              [
                "restore",
                "snap",
                "again",
                "--cpu",
                "4",
                "--disk",
                "40G",
                "--json",
                "--config",
                config,
              ],
              { server: stub }
            ),
          ];

          const decodeSizes = Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                cpu: Schema.Finite,
                ramMib: Schema.Finite,
                diskGib: Schema.Finite,
              })
            )
          );

          const printed = yield* Effect.forEach(runs, ({ stdout }) =>
            Effect.map(decodeSizes(stdout), ({ cpu, ramMib, diskGib }) => [
              cpu,
              ramMib,
              diskGib,
            ])
          );

          expect(runs.map(({ code }) => code)).toStrictEqual([0, 0]);
          expect(printed).toStrictEqual([
            [1, 2048, 10],
            [4, 1024, 40],
          ]);
        })
    );

    it.effect("resize with no size to give is refused before any call", () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir);

        const stub = server({ machines: [machine("dev")] });

        const { code, stderr } = yield* cli(
          ["resize", "dev", "--config", config],
          { server: stub }
        );

        expect(code).toBe(1);
        expect(stderr).toContain(
          "a resize gives at least one of vCPUs, RAM and disk"
        );
        expect(stub.calls).toStrictEqual([]);
      })
    );
  });
});
