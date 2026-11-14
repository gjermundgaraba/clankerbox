import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, layer } from "@effect/vitest";
import { outputLimit, ScriptFailed } from "@gjermundgaraba/clankerbox-sdk";
import type { Executed } from "@gjermundgaraba/clankerbox-sdk";
import { write, scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import {
  build,
  checkpoint,
  machine,
  template,
} from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import type { StubServer } from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import { DateTime, Effect, Schema, Sink, Stdio, Stream } from "effect";
import { afterEach, expect } from "vite-plus/test";

import {
  cleanup,
  cli,
  decodeJsonError,
  serverIn,
  sizes,
  writeConfig,
} from "./support.ts";

const stubs: StubServer[] = [];

const server = serverIn(stubs);

const decodeJson = <S extends Schema.Top>(schema: S, text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text, {
    onExcessProperty: "ignore",
  });

const Listed = Schema.Struct({
  machines: Schema.Array(Schema.Struct({ id: Schema.String })),
});

const listedIds = (text: string) =>
  Effect.map(decodeJson(Listed, text), ({ machines }) =>
    machines.map(({ id }) => id)
  );

const CheckpointJson = Schema.Struct({
  machine: Schema.String,
  labels: Schema.Record(Schema.String, Schema.String),
  expiresAt: Schema.DateTimeUtcFromString,
});

const execOn = (
  args: readonly string[],
  answer: Effect.Effect<Executed> = Effect.succeed({
    exitCode: 3,
    output: "hi\n",
    truncated: false,
  }),
  env: Record<string, string> = {}
) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const config = yield* writeConfig(dir);
    const printed: string[] = [];

    const stub = server({
      machines: [machine("dev")],
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
      server: stub,
      stdio,
      env,
    });

    return { ...run, printed: printed.join(""), execs: stub.execs, stub };
  });

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
            "TEMPLATE",
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
      "create --template sends the template, or the build named, and the sizes given, with no base or setup",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);

          const stub = server({
            templates: [
              template("web", {
                builds: [build("web@1"), build("web@2")],
              }),
            ],
          });

          const runs = [
            yield* cli(
              ["create", "box", "--template", "web", "--config", config],
              {
                server: stub,
              }
            ),
            yield* cli(
              [
                "create",
                "old",
                "--template",
                "web@1",
                "--cpu",
                "4",
                "--ram",
                "8G",
                "--config",
                config,
              ],
              { server: stub }
            ),
          ];

          expect(runs.map(({ code, stdout }) => [code, stdout])).toStrictEqual([
            [0, "box"],
            [0, "old"],
          ]);
          expect(stub.creates).toStrictEqual([
            { id: "box", template: "web" },
            { id: "old", template: "web@1", cpu: 4, ramMib: 8192 },
          ]);
        })
    );

    it.effect(
      "a create from a template with no ready build fails NotBuilt, which a retry doesn't help",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);

          const { code, stdout } = yield* cli(
            [
              "create",
              "box",
              "--template",
              "web",
              "--json",
              "--config",
              config,
            ],
            { server: server() }
          );

          expect(code).toBe(1);
          expect(decodeJsonError(stdout).error).toMatchObject({
            tag: "NotBuilt",
            template: "web",
            retryable: false,
          });
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

    it.effect(
      "create refuses a base with --template, and a spec missing its base or sizes",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);
          const stub = server();

          const run = (args: readonly string[]) =>
            cli(["create", "box", ...args, "--json", "--config", config], {
              server: stub,
            });

          const runs = [
            yield* run(["--template", "web", "--base", "ubuntu"]),
            yield* run(["--base", "ubuntu"]),
            yield* run(["--cpu", "2"]),
            yield* run(["--template", "web", "--cpu", "0"]),
            yield* run(["--template", "web@x"]),
          ];

          expect(
            runs.map(({ code, stdout }) => {
              const { tag, message } = decodeJsonError(stdout).error;

              return [code, tag, message];
            })
          ).toStrictEqual([
            [
              1,
              "Invalid",
              "create: a template's build has its base, so --template takes no --base",
            ],
            [
              1,
              "Invalid",
              "create: --cpu: missing; --ram: missing; --disk: missing",
            ],
            [
              1,
              "Invalid",
              "create: give --template, or --base with --cpu, --ram and --disk",
            ],
            [1, "Invalid", "create: --cpu: Expected a value greater than 0"],
            [1, "Invalid", expect.stringContaining("create: --template: ")],
          ]);
          expect(stub.calls).toStrictEqual([]);
        })
    );

    it.effect(
      "create takes no --setup or --setup-timeout, as a setup runs only in a template's build, and its help lists neither",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);
          const script = path.join(dir, "setup.sh");

          yield* write(script, "#!/bin/sh\ntrue\n");

          const stub = server();

          const runs = [
            yield* cli(
              [
                "create",
                "box",
                ...sizes,
                "--setup",
                script,
                "--config",
                config,
              ],
              { server: stub }
            ),
            yield* cli(
              [
                "create",
                "box",
                ...sizes,
                "--setup-timeout",
                "60s",
                "--config",
                config,
              ],
              { server: stub }
            ),
          ];

          const help = yield* cli(["create", "--help"]);

          expect(runs.map(({ code, stderr }) => [code, stderr])).toStrictEqual([
            [
              1,
              expect.stringContaining("Unrecognized flag: --setup in command"),
            ],
            [
              1,
              expect.stringContaining("Unrecognized flag: --setup-timeout in"),
            ],
          ]);
          expect(stub.calls).toStrictEqual([]);
          expect(help.code).toBe(0);
          expect(help.stdout).toContain("--template");
          expect(help.stdout).not.toContain("--setup");
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
          expect(stdout).toBe("dev 1 vCPU, 2G RAM, 30G disk");
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

    it.effect(
      "exec sends the command, its user, env, timeout and, with --stdin, this stdin, prints its output and exits with its code",
      () =>
        Effect.gen(function* () {
          const { code, printed, execs } = yield* execOn([
            "--user",
            "user",
            "--env",
            "TOKEN=t-1",
            "--env",
            "URL=https://a.example/?x=1",
            "--stdin",
            "--timeout",
            "2m",
            "dev",
            "--",
            "/bin/sh",
            "-c",
            "cat",
          ]);

          expect(code).toBe(3);
          expect(printed).toBe("hi\n");
          expect(execs).toStrictEqual([
            {
              id: "dev",
              argv: ["/bin/sh", "-c", "cat"],
              user: "user",
              env: { TOKEN: "t-1", URL: "https://a.example/?x=1" },
              stdin: "the input",
              timeoutSeconds: 120,
            },
          ]);
        })
    );

    it.effect(
      "exec --json prints the exit code and output, and sends nothing unasked",
      () =>
        Effect.gen(function* () {
          const { code, stdout, printed, execs } = yield* execOn([
            "--json",
            "dev",
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
          expect(execs).toStrictEqual([{ id: "dev", argv: ["true"] }]);
        })
    );

    it.effect("exec says on stderr when the host cut the output short", () =>
      Effect.gen(function* () {
        const { code, stderr, printed } = yield* execOn(
          ["dev", "--", "true"],
          Effect.succeed({ exitCode: 0, output: "tail", truncated: true })
        );

        expect(code).toBe(0);
        expect(printed).toBe("tail");
        expect(stderr).toContain(`last ${outputLimit} characters`);
      })
    );

    it.effect(
      "exec --env NAME sends NAME's value in this environment, so the value is in no argument",
      () =>
        Effect.gen(function* () {
          const { code, execs } = yield* execOn(
            ["--env", "TOKEN", "--env", "MODE=fast", "dev", "--", "true"],
            undefined,
            { TOKEN: "t=1 secret" }
          );

          expect(code).toBe(3);
          expect(execs).toStrictEqual([
            {
              id: "dev",
              argv: ["true"],
              env: { TOKEN: "t=1 secret", MODE: "fast" },
            },
          ]);
        })
    );

    it.effect(
      "exec --env NAME sends a value this environment sets empty, as set",
      () =>
        Effect.gen(function* () {
          const { code, execs } = yield* execOn(
            ["--env", "EMPTY", "dev", "--", "true"],
            undefined,
            { EMPTY: "" }
          );

          expect(code).toBe(3);
          expect(execs).toStrictEqual([
            { id: "dev", argv: ["true"], env: { EMPTY: "" } },
          ]);
        })
    );

    it.effect(
      "exec --env with a name that isn't a variable's name is refused, naming it, before any call",
      () =>
        Effect.gen(function* () {
          const { code, stderr, execs } = yield* execOn([
            "--env",
            "1BAD=x",
            "dev",
            "--",
            "true",
          ]);

          expect(code).toBe(1);
          expect(stderr).toContain('"1BAD"');
          expect(execs).toStrictEqual([]);
        })
    );

    it.effect(
      "exec --env NAME that this environment doesn't set is refused before any call",
      () =>
        Effect.gen(function* () {
          const { code, stderr, execs } = yield* execOn([
            "--env",
            "TOKEN",
            "dev",
            "--",
            "true",
          ]);

          expect(code).toBe(1);
          expect(stderr).toContain(
            "--env TOKEN takes TOKEN's value from this environment, which doesn't set it"
          );
          expect(execs).toStrictEqual([]);
        })
    );

    it.effect(
      "create --label sends the labels, get shows them, and machines --label lists what carries them",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);

          const stub = server({
            machines: [machine("other", { labels: { app: "api" } })],
          });

          const created = yield* cli(
            [
              "create",
              "dev",
              ...sizes,
              "--label",
              "app=web",
              "--label",
              "env=ci",
              "--config",
              config,
            ],
            { server: stub }
          );

          const got = yield* cli(["get", "dev", "--config", config], {
            server: stub,
          });

          const web = yield* cli(
            ["machines", "--label", "app=web", "--json", "--config", config],
            { server: stub }
          );

          const none = yield* cli(
            [
              "machines",
              "--label",
              "app=web",
              "--label",
              "env=qa",
              "--config",
              config,
            ],
            { server: stub }
          );

          const all = yield* cli(["machines", "--json", "--config", config], {
            server: stub,
          });

          expect(created).toMatchObject({ code: 0, stdout: "dev" });
          expect(stub.creates.map(({ labels }) => labels)).toStrictEqual([
            { app: "web", env: "ci" },
          ]);
          expect(
            got.stdout.split("\n").map((line) => line.split(/\s{2,}/u))
          ).toStrictEqual(
            expect.arrayContaining([["LABELS", "app=web env=ci"]])
          );
          expect(yield* listedIds(web.stdout)).toStrictEqual(["dev"]);
          expect(none.stderr).toBe("clankerbox: no machines to list");
          expect(yield* listedIds(all.stdout)).toStrictEqual(["other", "dev"]);
        })
    );

    it.effect(
      "pause --capture captures first, with --label and --expires on the checkpoint, and pauses",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);
          const stub = server({ machines: [machine("dev")] });
          const before = yield* DateTime.now;

          const paused = yield* cli(
            [
              "pause",
              "dev",
              "--capture",
              "snap",
              "--label",
              "app=web",
              "--expires",
              "1h",
              "--config",
              config,
            ],
            { server: stub }
          );

          const snap = yield* cli(
            ["checkpoint", "get", "snap", "--json", "--config", config],
            { server: stub }
          );

          const {
            labels,
            expiresAt,
            machine: source,
          } = yield* decodeJson(CheckpointJson, snap.stdout);

          const hour =
            DateTime.toEpochMillis(expiresAt) - DateTime.toEpochMillis(before);

          expect(paused).toMatchObject({ code: 0, stdout: "dev paused" });
          expect([source, labels]).toStrictEqual(["dev", { app: "web" }]);
          expect(hour).toBeGreaterThanOrEqual(3_600_000);
          expect(hour).toBeLessThan(3_660_000);
          expect(stub.calls).toStrictEqual([
            "machine.pause",
            "machine.get",
            "checkpoint.get",
            "checkpoint.get",
          ]);
        })
    );

    it.effect(
      "pause --label or --expires without --capture is refused before any call",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const config = yield* writeConfig(dir);
          const stub = server({ machines: [machine("dev")] });

          const { code, stderr } = yield* cli(
            ["pause", "dev", "--label", "app=web", "--config", config],
            { server: stub }
          );

          expect(code).toBe(1);
          expect(stderr).toContain("give --capture NAME");
          expect(stub.calls).toStrictEqual([]);
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
