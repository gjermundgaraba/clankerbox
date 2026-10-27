import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, layer } from "@effect/vitest";
import { outputLimit, ScriptFailed } from "@gjermundgaraba/clankerbox-sdk";
import type { Executed } from "@gjermundgaraba/clankerbox-sdk";
import {
  mkdir,
  write,
  scratch,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { operatorKey } from "@gjermundgaraba/clankerbox-sdk/testing/keys";
import {
  checkpoint,
  machine,
} from "@gjermundgaraba/clankerbox-sdk/testing/stub-host";
import type { StubHost } from "@gjermundgaraba/clankerbox-sdk/testing/stub-host";
import { DateTime, Effect, Schema, Sink, Stdio, Stream } from "effect";
import { afterEach, expect } from "vite-plus/test";

import { UnreachableDocument } from "../src/command.ts";
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

const execOn = (
  args: readonly string[],
  answer: Effect.Effect<Executed> = Effect.succeed({
    exitCode: 3,
    output: "hi\n",
    truncated: false,
  })
) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const config = yield* writeConfig(dir, ["linux"]);
    const printed: string[] = [];

    const linux = host({
      id: "linux",
      bases: ["ubuntu"],
      machines: [machine("linux_dev")],
      exec: () => answer,
    });

    const stdio = Stdio.layerTest({
      stdin: Stream.make(new TextEncoder().encode("the input")),
      stdout: () =>
        Sink.forEachArray((chunks) =>
          Effect.sync(() => {
            printed.push(
              ...chunks.map((chunk) => Buffer.from(chunk).toString())
            );
          })
        ),
    });

    const run = yield* cli(["exec", "--config", config, ...args], {
      endpoints: [["linux", linux]],
      stdio,
    });

    return { ...run, printed: printed.join(""), execs: linux.execs };
  });

describe("machines", () => {
  afterEach(async () => {
    await cleanup(stubs);
  });

  layer(NodeServices.layer)((it) => {
    it.effect(
      "machines shows each machine's age, and names a host that didn't answer",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir, ["linux", "mac"]);

          const createdAt = DateTime.subtract(yield* DateTime.now, {
            days: 3,
            hours: 2,
          });

          const { code, stdout, stderr } = yield* cli(
            ["machines", "--config", config],
            {
              endpoints: [
                [
                  "linux",
                  host({
                    id: "linux",
                    bases: ["ubuntu"],
                    machines: [machine("linux_dev", { createdAt })],
                  }),
                ],
                ["mac", "down"],
              ],
            }
          );

          const row = stdout
            .split("\n")
            .find((line) => line.startsWith("linux_dev"));

          expect(code).toBe(0);
          expect(stdout.split("\n")[0]).toContain("AGE");
          expect(row?.split(/\s+/u)).toContain("3d");
          expect(stderr).toContain("mac");
        })
    );

    const held = machine("linux_dev", {
      ssh: { user: "admin", host: "100.64.0.7", port: 10_022 },
      hostKey: "ssh-ed25519 AAAAexample",
      tailnet: { state: "joined", name: "linux-dev.example.ts.net" },
    });

    const failing = machine("linux_other", {
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
          const config = yield* writeConfig(dir, ["linux"]);

          const { stdout } = yield* cli(["machines", "--config", config], {
            endpoints: [
              [
                "linux",
                host({
                  id: "linux",
                  bases: ["ubuntu"],
                  machines: [held, failing],
                }),
              ],
            ],
          });

          const rows = stdout.split("\n");

          expect(rows).toHaveLength(3);
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
        })
    );

    it.effect(
      "get reads one machine a field a line, with what it was asked to be, its last error, its host key and its tailnet",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir, ["linux"]);

          const unnamed = machine("linux_plain", {
            tailnet: { state: "joined" },
          });

          const endpoints = [
            [
              "linux",
              host({
                id: "linux",
                bases: ["ubuntu"],
                machines: [held, failing, unnamed],
              }),
            ],
          ] as const;

          const fields = (id: string) =>
            Effect.map(
              cli(["get", id, "--config", config], { endpoints }),
              ({ stdout }) =>
                stdout.split("\n").map((line) => line.split(/\s{2,}/u))
            );

          const json = yield* cli(
            ["get", "linux_dev", "--json", "--config", config],
            { endpoints }
          );

          const gone = yield* cli(
            ["get", "linux_gone", "--json", "--config", config],
            { endpoints }
          );

          expect(yield* fields("linux_dev")).toStrictEqual(
            expect.arrayContaining([
              ["ID", "linux_dev"],
              ["STATE", "running"],
              ["RAM", "1G"],
              ["DISK", "10G"],
              ["DESIRED", "running"],
              ["PHASE", "settled"],
              ["SSH", "admin@100.64.0.7:10022"],
              ["ERROR", "-"],
              ["HOST_KEY", "ssh-ed25519 AAAAexample"],
              ["TAILNET", "linux-dev.example.ts.net"],
            ])
          );
          expect(yield* fields("linux_other")).toStrictEqual(
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
          expect(yield* fields("linux_plain")).toStrictEqual(
            expect.arrayContaining([
              ["TAILNET", "joined, with no MagicDNS name"],
            ])
          );
          expect(JSON.parse(json.stdout)).toMatchObject({
            id: "linux_dev",
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

    it.effect(
      "machines --json carries the machines and the unreachable hosts",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir, ["linux", "mac"]);

          const { code, stdout } = yield* cli(
            ["machines", "--json", "--config", config],
            {
              endpoints: [
                [
                  "linux",
                  host({
                    id: "linux",
                    bases: ["ubuntu"],
                    machines: [machine("linux_dev")],
                  }),
                ],
                ["mac", "down"],
              ],
            }
          );

          const document = yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                machines: Schema.Array(
                  Schema.Struct({ id: Schema.String, createdAt: Schema.String })
                ),
                unreachable: Schema.Array(UnreachableDocument),
              })
            )
          )(stdout);

          expect(code).toBe(0);
          expect(document.machines.map(({ id }) => id)).toStrictEqual([
            "linux_dev",
          ]);
          expect(document.machines[0]?.createdAt).toBe(
            "2026-10-01T00:00:00.000Z"
          );
          expect(document.unreachable).toMatchObject([
            { host: "mac", error: { tag: "Unavailable", retryable: true } },
          ]);
        })
    );

    it.effect(
      "create NAME is placed on the first host that offers the base and prints the new ID",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir, ["mac", "linux"]);
          const linux = host({ id: "linux", bases: ["ubuntu"] });

          const { code, stdout } = yield* cli(
            ["create", "dev", ...sizes, "--config", config],
            {
              endpoints: [
                ["mac", host({ id: "mac", bases: ["macos"] })],
                ["linux", linux],
              ],
            }
          );

          expect(code).toBe(0);
          expect(stdout).toBe("linux_dev");
          expect(
            linux.creates.map(({ id, cpu, ramMib, diskGib }) => ({
              id,
              cpu,
              ramMib,
              diskGib,
            }))
          ).toStrictEqual([
            { id: "linux_dev", cpu: 2, ramMib: 4096, diskGib: 20 },
          ]);
        })
    );

    it.effect(
      "create --profile NAME reads NAME.json from the profiles directory, with its label, setup and host",
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
              host: "hetzner",
            })
          );

          const config = yield* writeConfig(
            dir,
            ["linux", "hetzner"],
            "profiles"
          );

          const linux = host({ id: "linux", bases: ["ubuntu"] });
          const hetzner = host({ id: "hetzner", bases: ["ubuntu"] });

          const { code, stdout } = yield* cli(
            ["create", "box", "--profile", "dev", "--config", config],
            {
              endpoints: [
                ["linux", linux],
                ["hetzner", hetzner],
              ],
            }
          );

          const [request] = hetzner.creates;

          expect(code).toBe(0);
          expect(stdout).toBe("hetzner_box");
          expect(linux.creates).toHaveLength(0);
          expect(request?.profile).toBe("dev");
          expect(request?.setup?.timeoutSeconds).toBe(900);
          expect(request?.setup?.script.startsWith("#!/bin/sh\n")).toBe(true);
        })
    );

    it.effect(
      "create --host sends the create to that host, over placement and the profile's host",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const file = path.join(dir, "dev.json");

          yield* write(
            file,
            JSON.stringify({
              base: "ubuntu",
              cpu: 1,
              ramMib: 1024,
              diskGib: 10,
              host: "linux",
            })
          );

          const config = yield* writeConfig(dir, ["linux", "hetzner"]);
          const linux = host({ id: "linux", bases: ["ubuntu"] });
          const hetzner = host({ id: "hetzner", bases: ["ubuntu"] });

          const endpoints = [
            ["linux", linux],
            ["hetzner", hetzner],
          ] as const;

          const bySizes = yield* cli(
            ["create", "a", ...sizes, "--host", "hetzner", "--config", config],
            {
              endpoints,
            }
          );

          const byProfile = yield* cli(
            [
              "create",
              "b",
              "--profile",
              file,
              "--host",
              "hetzner",
              "--config",
              config,
            ],
            { endpoints }
          );

          expect([bySizes.stdout, byProfile.stdout]).toStrictEqual([
            "hetzner_a",
            "hetzner_b",
          ]);
          expect(linux.calls).toStrictEqual([]);
        })
    );

    it.effect(
      "create takes a name, not an ID, and refuses one with '_' before sending anything",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir, ["linux"]);
          const linux = host({ id: "linux", bases: ["ubuntu"] });

          const { code, stdout } = yield* cli(
            ["create", "linux_dev", ...sizes, "--json", "--config", config],
            { endpoints: [["linux", linux]] }
          );

          expect(code).toBe(1);
          expect(decodeJsonError(stdout).error).toMatchObject({
            tag: "Invalid",
            retryable: false,
          });
          expect(linux.calls).toStrictEqual([]);
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

        const config = yield* writeConfig(dir, ["linux"]);
        const linux = host({ id: "linux", bases: ["ubuntu"] });

        const { code } = yield* cli(
          ["create", "box", "--profile", file, "--config", config],
          {
            endpoints: [["linux", linux]],
          }
        );

        expect(code).toBe(0);
        expect(linux.creates[0]?.profile).toBe("small");
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

          const config = yield* writeConfig(dir, ["linux"]);
          const linux = host({ id: "linux", bases: ["ubuntu", "ubuntu-dev"] });

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
            { endpoints: [["linux", linux]] }
          );

          const [request] = linux.creates;

          expect(code).toBe(0);
          expect(request).toMatchObject({
            id: "linux_box",
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
          const config = yield* writeConfig(dir, ["linux"]);
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

          const linux = host({ id: "linux", bases: ["ubuntu"] });

          for (const [name, args] of [
            ["bare", [...sizes, "--setup", script]],
            ["timed", ["--profile", profile, "--setup-timeout", "60s"]],
            ["scripted", ["--profile", profile, "--setup", other]],
          ] as const) {
            const { code } = yield* cli(
              ["create", name, ...args, "--config", config],
              {
                endpoints: [["linux", linux]],
              }
            );

            expect(code).toBe(0);
          }

          expect(
            linux.creates.map(({ setup }) => [
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
          const config = yield* writeConfig(dir, ["linux"]);
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

          const linux = host({ id: "linux", bases: ["ubuntu"] });

          const run = (args: readonly string[]) =>
            cli(["create", "box", ...args, "--json", "--config", config], {
              endpoints: [["linux", linux]],
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
          expect(linux.calls).toStrictEqual([]);
        })
    );

    it.effect("create --setup sends a script file as its text", () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir, ["linux"]);
        const script = path.join(dir, "setup.sh");

        yield* write(script, "#!/bin/sh\necho set up\n");

        const linux = host({ id: "linux", bases: ["ubuntu"] });

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
          { endpoints: [["linux", linux]] }
        );

        expect(code).toBe(0);
        expect(linux.creates[0]?.setup?.script).toBe(
          "#!/bin/sh\necho set up\n"
        );
        expect(linux.creates[0]?.setup?.timeoutSeconds).toBe(60);
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
          const hosts = [{ id: "linux", url: url("linux") }];

          yield* mkdir(path.join(dir, "keys"));
          yield* write(path.join(dir, "keys", "id.pub"), key);
          yield* write(script, "#!/bin/sh\n");
          yield* write(
            relative,
            JSON.stringify({ hosts, authorizedKeys: "keys/id.pub" })
          );
          yield* write(
            home,
            JSON.stringify({ hosts, authorizedKeys: "~/keys/id.pub" })
          );
          yield* write(keyless, JSON.stringify({ hosts }));

          const linux = host({ id: "linux", bases: ["ubuntu"] });

          const create = (config: string, ...args: readonly string[]) =>
            cli(["create", "box", ...sizes, ...args, "--config", config], {
              endpoints: [["linux", linux]],
              env: { HOME: dir },
            });

          yield* create(relative, "--setup", script);
          yield* create(home, "--setup", script);
          yield* create(relative);

          const refused = yield* create(keyless, "--setup", script);

          expect(
            linux.creates.map((sent) => sent.setup?.authorizedKeys)
          ).toStrictEqual([key, key, undefined]);
          expect(refused.stderr).toBe(
            "clankerbox: Invalid: create: a setup needs the client config's authorizedKeys, the public keys the host installs for the login user after it"
          );
        })
    );

    it.effect("deleting a machine that is already gone counts as done", () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir, ["linux"]);

        const endpoints = [
          ["linux", host({ id: "linux", bases: ["ubuntu"] })],
        ] as const;

        const text = yield* cli(["delete", "linux_gone", "--config", config], {
          endpoints,
        });

        const json = yield* cli(
          ["delete", "linux_gone", "--json", "--config", config],
          {
            endpoints,
          }
        );

        expect(text).toMatchObject({ code: 0, stdout: "" });
        expect(text.stderr).toContain("already gone");
        expect(json).toMatchObject({
          code: 0,
          stdout: JSON.stringify({ deleted: "linux_gone" }),
        });
      })
    );

    it.effect("start, pause, stop and fork route by ID", () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir, ["mac", "linux"]);
        const mac = host({ id: "mac", bases: ["macos"] });

        const linux = host({
          id: "linux",
          bases: ["ubuntu"],
          machines: [machine("linux_dev")],
        });

        const endpoints = [
          ["mac", mac],
          ["linux", linux],
        ] as const;

        const runs = [
          yield* cli(["start", "linux_dev", "--config", config], { endpoints }),
          yield* cli(["pause", "linux_dev", "--config", config], { endpoints }),
          yield* cli(["stop", "linux_dev", "--config", config], { endpoints }),
          yield* cli(["fork", "linux_dev", "copy", "--config", config], {
            endpoints,
          }),
        ];

        expect(runs.map(({ code }) => code)).toStrictEqual([0, 0, 0, 0]);
        expect(runs.map(({ stdout }) => stdout)).toStrictEqual([
          "linux_dev running",
          "linux_dev paused",
          "linux_dev stopped",
          "linux_copy",
        ]);
        expect(linux.calls).toStrictEqual([
          "machine.start",
          "machine.pause",
          "machine.stop",
          "machine.fork",
        ]);
        expect(mac.calls).toStrictEqual([]);
      })
    );

    it.effect(
      "resize sends the sizes it is given, in their units, and prints the sizes the machine then has",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir, ["linux"]);

          const linux = host({
            id: "linux",
            bases: ["ubuntu"],
            machines: [machine("linux_dev")],
          });

          const { code, stdout, stderr } = yield* cli(
            [
              "resize",
              "linux_dev",
              "--ram",
              "2G",
              "--disk",
              "30G",
              "--config",
              config,
            ],
            { endpoints: [["linux", linux]] }
          );

          expect(stderr).toBe("");
          expect(code).toBe(0);
          expect(stdout).toBe("linux_dev 1 vCPUs, 2G RAM, 30G disk");
          expect(linux.calls).toStrictEqual(["machine.resize"]);
        })
    );

    it.effect(
      "fork and restore send the sizes they are given, leaving out the rest",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir, ["linux"]);

          const linux = host({
            id: "linux",
            bases: ["ubuntu"],
            machines: [machine("linux_dev")],
            checkpoints: [checkpoint("linux_snap")],
          });

          const endpoints = [["linux", linux]] as const;

          const runs = [
            yield* cli(
              [
                "fork",
                "linux_dev",
                "copy",
                "--ram",
                "2G",
                "--json",
                "--config",
                config,
              ],
              {
                endpoints,
              }
            ),
            yield* cli(
              [
                "restore",
                "linux_snap",
                "again",
                "--cpu",
                "4",
                "--disk",
                "40G",
                "--json",
                "--config",
                config,
              ],
              { endpoints }
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
        const config = yield* writeConfig(dir, ["linux"]);

        const linux = host({
          id: "linux",
          bases: ["ubuntu"],
          machines: [machine("linux_dev")],
        });

        const { code, stderr } = yield* cli(
          ["resize", "linux_dev", "--config", config],
          {
            endpoints: [["linux", linux]],
          }
        );

        expect(code).toBe(1);
        expect(stderr).toContain(
          "a resize gives at least one of vCPUs, RAM and disk"
        );
        expect(linux.calls).toStrictEqual([]);
      })
    );

    it.effect(
      "exec sends the command, its user and, with --stdin, this stdin, prints its output and exits with its code",
      () =>
        Effect.gen(function* () {
          const { code, printed, execs } = yield* execOn([
            "--user",
            "user",
            "--stdin",
            "--timeout",
            "2m",
            "linux_dev",
            "--",
            "/bin/sh",
            "-c",
            "cat",
          ]);

          expect(code).toBe(3);
          expect(printed).toBe("hi\n");
          expect(execs).toStrictEqual([
            {
              id: "linux_dev",
              argv: ["/bin/sh", "-c", "cat"],
              user: "user",
              stdin: "the input",
            },
          ]);
        })
    );

    it.effect(
      "exec --json prints the exit code and output, and sends no stdin unasked",
      () =>
        Effect.gen(function* () {
          const { code, stdout, printed, execs } = yield* execOn([
            "--json",
            "linux_dev",
            "--",
            "true",
          ]);

          expect(code).toBe(3);
          expect(JSON.parse(stdout)).toStrictEqual({
            exitCode: 3,
            output: "hi\n",
            truncated: false,
          });
          expect(printed).toBe("");
          expect(execs).toStrictEqual([
            {
              id: "linux_dev",
              argv: ["true"],
              user: undefined,
              stdin: undefined,
            },
          ]);
        })
    );

    it.effect("exec says on stderr when the host cut the output short", () =>
      Effect.gen(function* () {
        const { code, printed, stderr } = yield* execOn(
          ["linux_dev", "--", "true"],
          Effect.succeed({ exitCode: 0, output: "the end\n", truncated: true })
        );

        expect(code).toBe(0);
        expect(printed).toBe("the end\n");
        expect(stderr).toContain(`only its last ${outputLimit} characters`);
      })
    );
  });

  layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    it.effect("exec past its --timeout ends the call and exits 124", () =>
      Effect.gen(function* () {
        const { code, stderr } = yield* execOn(
          ["--timeout", "1s", "linux_dev", "--", "sleep", "60"],
          Effect.never
        );

        expect(code).toBe(124);
        expect(stderr).toContain(
          "the command ran past --timeout 1s and was ended"
        );
      })
    );
  });
});
