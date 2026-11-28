import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import {
  Internal,
  outputLimit,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  read as readFile,
  readDirectory,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import {
  Duration,
  Effect,
  Fiber,
  Logger,
  Option,
  Schedule,
  Stream,
} from "effect";
import { describe, expect } from "vite-plus/test";

import { markName, membersProgram, runCommand } from "../src/exec.ts";
import { Runtime } from "../src/runtime.ts";
import type { Execution } from "../src/runtime.ts";
import type { Marked } from "./exec-cases.ts";
import {
  answeredWithin,
  daemonCases,
  runningOf,
  statOf,
  stormCases,
  underEachShell,
  unsharedMark,
} from "./exec-cases.ts";
import { based, madeOn, waitFor } from "./support.ts";

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  for (const as of ["tart", "smolvm"] as const) {
    it.effect(
      `a timed command on a fake ${as} answers 124 only once its cut has ended it in the guest, TERM first`,
      () =>
        Effect.gen(function* () {
          const { runtime, fake, machine } = yield* madeOn(as);
          const root = fake.root(machine.name) ?? "";

          const ran = yield* runCommand(runtime, {
            machine,
            argv: [
              "sh",
              "-c",
              `trap 'echo termed >"$CLANKERBOX_ROOT/termed"; exit 0' TERM; echo $$ >"$CLANKERBOX_ROOT/pid"; sleep 300 & wait`,
            ],
            timeoutSeconds: 1,
          });

          expect(ran.exitCode).toBe(124);
          expect(yield* readFile(path.join(root, "termed"))).toBe("termed\n");
        })
    );
  }

  it.effect(
    "an exec its caller cuts short on a runtime that leaves its command ends in the guest the command and what it started, and not another exec's command",
    () =>
      Effect.gen(function* () {
        const { runtime, fake, machine } = yield* madeOn("tart");
        const root = fake.root(machine.name) ?? "";

        const started = (name: string, script: string, count: number) =>
          Effect.gen(function* () {
            const file = path.join(root, name);

            const fiber = yield* Effect.forkChild(
              runCommand(runtime, { machine, argv: ["sh", "-c", script] })
            );

            const pids = yield* Effect.orElseSucceed(
              readFile(file),
              () => ""
            ).pipe(
              Effect.map((text) =>
                text
                  .split("\n")
                  .filter((line) => line !== "")
                  .map(Number)
              ),
              Effect.repeat({
                until: (found) => found.length >= count,
                schedule: Schedule.spaced(Duration.millis(20)),
              })
            );

            return {
              fiber,
              tree: pids.map((pid) => ({ pid, start: statOf(pid)?.start })),
            };
          });

        const cut = yield* started(
          "cut",
          `echo $$ >>"$CLANKERBOX_ROOT/cut"; sleep 300 & echo $! >>"$CLANKERBOX_ROOT/cut"; setsid sleep 300 & echo $! >>"$CLANKERBOX_ROOT/cut"; wait`,
          3
        );

        const beside = yield* started(
          "beside",
          `echo $$ >>"$CLANKERBOX_ROOT/beside"; sleep 300`,
          1
        );

        yield* Fiber.interrupt(cut.fiber);

        expect(yield* runningOf(cut.tree)).toStrictEqual([]);
        expect(yield* runningOf(beside.tree)).toStrictEqual(beside.tree);

        yield* Fiber.interrupt(beside.fiber);

        expect(yield* runningOf(beside.tree)).toStrictEqual([]);
      })
  );

  it.effect(
    "an exec cut before its runtime has answered with its execution ends the command its guest began, with what it started",
    () =>
      Effect.gen(function* () {
        const { runtime, fake, machine } = yield* madeOn("tart");
        const root = fake.root(machine.name) ?? "";
        const file = path.join(root, "pids");

        const answeringLate = Runtime.of({
          ...runtime,
          exec: (target, command) =>
            (command.stdin ?? "").includes("clankerbox-end")
              ? runtime.exec(target, command)
              : Effect.andThen(runtime.exec(target, command), Effect.never),
        });

        const fiber = yield* Effect.forkChild(
          runCommand(answeringLate, {
            machine,
            argv: [
              "sh",
              "-c",
              `echo $$ >>"$CLANKERBOX_ROOT/pids"; sleep 300 & echo $! >>"$CLANKERBOX_ROOT/pids"; wait`,
            ],
          })
        );

        const pids = yield* Effect.orElseSucceed(readFile(file), () => "").pipe(
          Effect.map((text) =>
            text
              .split("\n")
              .filter((line) => line !== "")
              .map(Number)
          ),
          Effect.repeat({
            until: (found) => found.length >= 2,
            schedule: Schedule.spaced(Duration.millis(20)),
          })
        );

        const tree = pids.map((pid) => ({ pid, start: statOf(pid)?.start }));

        yield* Fiber.interrupt(fiber);

        expect(yield* runningOf(tree)).toStrictEqual([]);
      })
  );

  it.effect(
    "an exec whose runtime fails before the command's exit code ends the command its guest began, with what it started, and fails with the runtime's error",
    () =>
      Effect.gen(function* () {
        const { runtime, fake, machine } = yield* madeOn("tart");
        const root = fake.root(machine.name) ?? "";
        const file = path.join(root, "pids");
        let tree: readonly Marked[] = [];

        const begun = Effect.sync(() =>
          existsSync(file) ? readFileSync(file, "utf-8") : ""
        ).pipe(
          Effect.map((text) =>
            text
              .split("\n")
              .filter((line) => line !== "")
              .map(Number)
          ),
          Effect.repeat({
            until: (found) => found.length >= 2,
            schedule: Schedule.spaced(Duration.millis(20)),
          })
        );

        const dropping = Runtime.of({
          ...runtime,
          exec: (target, command) =>
            (command.stdin ?? "").includes("clankerbox-end")
              ? runtime.exec(target, command)
              : Effect.map(runtime.exec(target, command), (execution) => ({
                  ...execution,
                  exitCode: Effect.flatMap(begun, (pids) => {
                    tree = pids.map((pid) => ({
                      pid,
                      start: statOf(pid)?.start,
                    }));

                    return Effect.fail(
                      new Internal({ message: "the guest's agent went away" })
                    );
                  }),
                })),
        });

        const failed = yield* Effect.flip(
          runCommand(dropping, {
            machine,
            argv: [
              "sh",
              "-c",
              `echo $$ >>"$CLANKERBOX_ROOT/pids"; sleep 300 & echo $! >>"$CLANKERBOX_ROOT/pids"; wait`,
            ],
          })
        );

        expect([failed._tag, failed.message]).toStrictEqual([
          "Internal",
          "the guest's agent went away",
        ]);
        expect(tree).toHaveLength(2);
        expect(yield* runningOf(tree)).toStrictEqual([]);
      })
  );

  it.effect(
    "a timed command whose runtime never answers with its execution answers 124 at its limit, ending what the guest may have begun",
    () =>
      Effect.gen(function* () {
        const { runtime, machine } = yield* madeOn("tart");

        const attaching = Runtime.of({
          ...runtime,
          exec: (target, command) =>
            (command.stdin ?? "").includes("clankerbox-end")
              ? runtime.exec(target, command)
              : Effect.never,
        });

        const answer = yield* Effect.timed(
          runCommand(attaching, { machine, argv: ["true"], timeoutSeconds: 1 })
        ).pipe(Effect.timeoutOption(Duration.seconds(10)));

        const [took, ran] = Option.getOrThrow(answer);

        expect(ran).toStrictEqual({
          exitCode: 124,
          output: "",
          truncated: false,
        });
        expect(Duration.toSeconds(took)).toBeGreaterThanOrEqual(1);
        expect(Duration.toSeconds(took)).toBeLessThan(3);
      }),
    30_000
  );

  it.effect(
    "a timed command that ignores TERM is KILLed 5 s after it, and its 124 answers within the end's bound",
    () =>
      Effect.gen(function* () {
        const { runtime, fake, machine } = yield* madeOn("tart");
        const root = fake.root(machine.name) ?? "";

        const [took, ran] = yield* Effect.timed(
          runCommand(runtime, {
            machine,
            argv: [
              "sh",
              "-c",
              `trap '' TERM; echo $$ >"$CLANKERBOX_ROOT/pid"; sleep 300 & wait`,
            ],
            timeoutSeconds: 1,
          })
        );

        const pid = Number((yield* readFile(path.join(root, "pid"))).trim());

        expect(ran.exitCode).toBe(124);
        expect(ran.mayStillRun).toBeUndefined();
        expect(statOf(pid)?.state ?? "gone").toMatch(/^(?:gone|Z)$/u);
        expect(Duration.toSeconds(took)).toBeGreaterThanOrEqual(6);
        expect(Duration.toSeconds(took)).toBeLessThan(
          1 + Duration.toSeconds(answeredWithin)
        );
      }),
    30_000
  );

  it.effect(
    "a timed command whose end isn't confirmed answers 124 with its output, saying why it may still run, also an end that printed nothing, within 15 s of its timeout, and logs it as cut at its limit",
    () => {
      const logged: unknown[] = [];

      return Effect.gen(function* () {
        const { runtime, machine } = yield* madeOn("tart");

        const ending = (end: Effect.Effect<Execution>): Runtime["Service"] =>
          Runtime.of({
            ...runtime,
            exec: (target, command) =>
              (command.stdin ?? "").includes("clankerbox-end")
                ? end
                : runtime.exec(target, command),
          });

        const timed = (on: Runtime["Service"]) =>
          Effect.timed(
            runCommand(on, {
              machine,
              argv: ["sh", "-c", "echo owed; sleep 3"],
              timeoutSeconds: 1,
            })
          );

        const [took, stalled] = yield* timed(
          ending(
            Effect.succeed({ output: Stream.never, exitCode: Effect.never })
          )
        );

        const [, left] = yield* timed(
          ending(
            Effect.succeed({
              output: Stream.make(
                new TextEncoder().encode(
                  "clankerbox: 3 processes of the command still ran at its last listing when its end's 10s ran out\n"
                )
              ),
              exitCode: Effect.succeed(1),
            })
          )
        );

        const [, silent] = yield* timed(
          ending(
            Effect.succeed({
              output: Stream.empty,
              exitCode: Effect.succeed(125),
            })
          )
        );

        expect([stalled, left, silent]).toStrictEqual([
          {
            exitCode: 124,
            output: "owed\n",
            truncated: false,
            mayStillRun: "the end didn't finish within 15s",
          },
          {
            exitCode: 124,
            output: "owed\n",
            truncated: false,
            mayStillRun:
              "the end exited 1: clankerbox: 3 processes of the command still ran at its last listing when its end's 10s ran out",
          },
          {
            exitCode: 124,
            output: "owed\n",
            truncated: false,
            mayStillRun: "the end exited 125 and printed nothing",
          },
        ]);
        expect(Duration.toSeconds(took)).toBeGreaterThanOrEqual(
          1 + Duration.toSeconds(answeredWithin)
        );
        expect(Duration.toSeconds(took)).toBeLessThan(
          2 + Duration.toSeconds(answeredWithin)
        );
        expect(logged.flat()).toStrictEqual([
          "couldn't end in dev the command of an exec past its 1s limit, which may still run there: the end didn't finish within 15s",
          "couldn't end in dev the command of an exec past its 1s limit, which may still run there: the end exited 1: clankerbox: 3 processes of the command still ran at its last listing when its end's 10s ran out",
          "couldn't end in dev the command of an exec past its 1s limit, which may still run there: the end exited 125 and printed nothing",
        ]);
      }).pipe(
        Effect.provide(
          Logger.layer([Logger.make(({ message }) => logged.push(message))])
        )
      );
    },
    60_000
  );

  it.effect(
    "an exec whose machine a step leaves answers WrongState in that step's phase, saying its command may still run when its end isn't confirmed, and logs it as cut short by the step",
    () => {
      const logged: unknown[] = [];

      return Effect.gen(function* () {
        const { runtime, machine } = yield* madeOn("tart");

        const unconfirmed = Runtime.of({
          ...runtime,
          exec: (target, command) =>
            (command.stdin ?? "").includes("clankerbox-end")
              ? Effect.succeed({
                  output: Stream.empty,
                  exitCode: Effect.succeed(125),
                })
              : runtime.exec(target, command),
        });

        const error = yield* Effect.flip(
          runCommand(
            unconfirmed,
            { machine, argv: ["sh", "-c", "sleep 30"] },
            Effect.succeed("stop")
          )
        );

        expect(error).toStrictEqual(
          new WrongState({
            message:
              "machine dev's stop ended this exec's command first, though it may still run in the guest: the end exited 125 and printed nothing",
            machine: "dev",
            state: "stopping",
          })
        );
        expect(logged.flat()).toStrictEqual([
          "couldn't end in dev the command of an exec that its machine's stop cut short, which may still run there: the end exited 125 and printed nothing",
        ]);
      }).pipe(
        Effect.provide(
          Logger.layer([Logger.make(({ message }) => logged.push(message))])
        )
      );
    }
  );

  it.effect(
    "an exec whose runtime fails before its exit code, and whose end then fails too, fails with the runtime's own error, not saying it may still run, and logs the end's",
    () => {
      const logged: unknown[] = [];

      return Effect.gen(function* () {
        const { runtime, machine } = yield* madeOn("tart");

        const failing = Runtime.of({
          ...runtime,
          exec: (_target, command) =>
            Effect.succeed({
              output: Stream.empty,
              exitCode: Effect.fail(
                (command.stdin ?? "").includes("clankerbox-end")
                  ? new Internal({ message: "the agent is gone" })
                  : new Internal({ message: "the connection dropped" })
              ),
            }),
        });

        const error = yield* Effect.flip(
          runCommand(failing, { machine, argv: ["true"] })
        );

        expect({ _tag: error._tag, message: error.message }).toStrictEqual({
          _tag: "Internal",
          message: "the connection dropped",
        });
        expect(logged.flat()).toStrictEqual([
          "couldn't end in dev the command of an exec whose runtime failed before its exit code, which may still run there: the agent is gone",
        ]);
      }).pipe(
        Effect.provide(
          Logger.layer([Logger.make(({ message }) => logged.push(message))])
        )
      );
    }
  );

  for (const as of ["tart", "smolvm"] as const) {
    it.effect(
      `a stop of a fake ${as} machine ends an exec in flight whose command ignores TERM, as its VM going down does`,
      () =>
        Effect.gen(function* () {
          const { runtime, fake, machine } = yield* madeOn(as);
          const root = fake.root(machine.name) ?? "";

          const exec = yield* Effect.forkChild(
            runCommand(runtime, {
              machine,
              argv: [
                "sh",
                "-c",
                `trap '' TERM; echo $$ >"$CLANKERBOX_ROOT/pid"; sleep 300`,
              ],
            })
          );

          const pid = Number(
            (yield* waitFor(path.join(root, "pid"), "\n")).trim()
          );

          yield* runtime.stop(machine);

          const ran = yield* Fiber.join(exec);

          expect(ran.exitCode).not.toBe(0);
          expect(statOf(pid)?.state ?? "gone").toMatch(/^(?:gone|Z)$/u);
        }),
      30_000
    );
  }

  it.effect(
    "a command that exits leaves running what it started with its output closed, and ends nothing",
    () =>
      Effect.gen(function* () {
        const { runtime, fake, machine } = yield* madeOn("tart");
        const root = fake.root(machine.name) ?? "";

        const ran = yield* runCommand(runtime, {
          machine,
          argv: [
            "sh",
            "-c",
            `sleep 300 >/dev/null 2>&1 & echo $! >"$CLANKERBOX_ROOT/background"`,
          ],
        });

        const pid = Number(
          (yield* readFile(path.join(root, "background"))).trim()
        );

        const tree = [{ pid, start: statOf(pid)?.start }];

        expect(ran.exitCode).toBe(0);
        expect(yield* runningOf(tree)).toStrictEqual(tree);
        expect(
          yield* Effect.orElseSucceed(
            readDirectory(path.join(root, "var", "run", "clankerbox-ended")),
            () => []
          )
        ).toStrictEqual([]);

        yield* Effect.sync(() => {
          process.kill(pid, "SIGKILL");
        });
      })
  );

  it.effect(
    "a command whose environment sets the exec's mark is refused as Invalid and runs nothing",
    () =>
      Effect.gen(function* () {
        const { runtime, machine } = yield* based;

        const refused = yield* Effect.flip(
          runCommand(runtime, {
            machine,
            argv: ["true"],
            env: { CLANKERBOX_EXEC: "x" },
          })
        );

        expect([refused._tag, refused.message]).toStrictEqual([
          "Invalid",
          "a command's environment can't set CLANKERBOX_EXEC, which marks the processes of its exec, so a cut one is ended",
        ]);
      })
  );

  it.effect(
    "a command runs as the user named, root by default, with its env and stdin, and answers its exit code and output",
    () =>
      Effect.gen(function* () {
        const { runtime, machine } = yield* based;

        const argv = [
          "/bin/sh",
          "-c",
          'echo "$CLANKERBOX_USER $TOKEN"; cat; exit 3',
        ] as const;

        const asUser = yield* runCommand(runtime, {
          machine,
          argv: [...argv],
          user: "user",
          env: { TOKEN: "t-1" },
          stdin: "hello\n",
        });

        const asRoot = yield* runCommand(runtime, { machine, argv: [...argv] });

        expect(asUser).toStrictEqual({
          exitCode: 3,
          output: "user t-1\nhello\n",
          truncated: false,
        });
        expect(asRoot).toStrictEqual({
          exitCode: 3,
          output: "root \n",
          truncated: false,
        });
      })
  );

  it.effect(
    "a command gets its arguments, env and stdin exactly as given, whatever they hold",
    () =>
      Effect.gen(function* () {
        const { runtime, machine } = yield* based;

        const odd = [
          "",
          "-n",
          "two\nlines\n",
          "back\\slash\\",
          String.raw`\0101 \c`,
          " 'quoted' \"double\" $HOME `tick` é ✓",
        ];

        const executed = yield* runCommand(runtime, {
          machine,
          argv: [
            "/bin/sh",
            "-c",
            'printf "[%s]" "$@"; printf "<%s>" "$A" "$values" "$pairs" "$exports"; cat',
            "zero",
            ...odd,
          ],
          env: {
            A: odd.join("|"),
            values: "v",
            pairs: "p",
            exports: "e",
          },
          stdin: "first\n\nno newline at its end",
        });

        expect(executed.exitCode).toBe(0);
        expect(executed.output).toBe(
          `${odd.map((value) => `[${value}]`).join("")}<${odd.join("|")}><v><p><e>first\n\nno newline at its end`
        );

        const missing = yield* runCommand(runtime, {
          machine,
          argv: ["no-such-command-3e1f"],
        });

        expect(missing.exitCode).toBe(127);
        expect(missing.output).toContain("no-such-command-3e1f");
      })
  );

  it.effect(
    "a command that runs past its timeout is ended, and answers 124 with the output it had",
    () =>
      Effect.gen(function* () {
        const { runtime, machine } = yield* based;

        const executed = yield* runCommand(runtime, {
          machine,
          argv: ["/bin/sh", "-c", "echo started; sleep 30"],
          timeoutSeconds: 1,
        });

        expect(executed).toStrictEqual({
          exitCode: 124,
          output: "started\n",
          truncated: false,
        });
      })
  );

  it.effect(
    "a command's output keeps its last outputLimit characters, and says when it was cut",
    () =>
      Effect.gen(function* () {
        const { runtime, machine } = yield* based;

        const executed = yield* runCommand(runtime, {
          machine,
          argv: [
            "/bin/sh",
            "-c",
            `head -c ${outputLimit} /dev/zero | tr '\\0' a; printf end`,
          ],
        });

        expect(executed.exitCode).toBe(0);
        expect(executed.truncated).toBe(true);
        expect(executed.output).toHaveLength(outputLimit);
        expect(executed.output.endsWith("aaaend")).toBe(true);
      })
  );
});

const guestAwks = [
  ["awk"],
  ["mawk"],
  ["gawk"],
  ["original-awk"],
  ["busybox", "awk"],
].filter(
  ([file = "", ...rest]) =>
    spawnSync(file, [...rest, "BEGIN { exit 0 }"]).status === 0
);

interface Listed {
  readonly pid: number;
  readonly ppid: number;
  readonly state: "R" | "S" | "T";
  readonly root: boolean;
}

const ascending = (a: number, b: number) => a - b;

const seeded = (seed: number) => {
  let state = seed;

  return (below: number) => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;

    return state % below;
  };
};

const commandOfWrappedPids = (seed: number): readonly Listed[] => {
  const pick = seeded(seed);
  const pids = new Set<number>();

  while (pids.size < 40) {
    pids.add(2 + pick(32_000));
  }

  const inOrder = [...pids];

  const tree = inOrder.map((pid, at): Listed => {
    const root = at === 0 || pick(8) === 0;

    return {
      pid,
      ppid: root ? 90_000 + at : (inOrder[pick(at)] ?? 0),
      state: (["R", "S", "T"] as const)[pick(3)] ?? "S",
      root,
    };
  });

  return tree
    .map((each) => ({ each, at: pick(1_000_000) }))
    .toSorted((a, b) => a.at - b.at)
    .map(({ each }) => each);
};

const listingOf = (word: string, tree: readonly Listed[]) =>
  [
    word,
    ".",
    ...tree.flatMap(({ pid, root }) => (root ? [`/proc/${pid}/cmdline`] : [])),
    ".",
    ...tree.map(
      ({ pid, ppid, state }) =>
        `/proc/${pid}/stat:${pid} (sh) ${state} ${ppid} ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${1000 + pid} 0`
    ),
    "",
  ].join("\n");

describe.each(guestAwks.map((argv) => ({ name: argv.join(" "), argv })))(
  "an end's listing, by $name",
  ({ argv }) => {
    layer(NodeServices.layer)((it) => {
      it("STOPs, and then KILLs, each process it lists, each after its listed parent, however the guest numbers and lists them", () => {
        const word = `${markName}=${unsharedMark()}`;

        for (const seed of Array.from({ length: 25 }, (_, i) => i + 1)) {
          const tree = commandOfWrappedPids(seed);
          const byPid = new Map(tree.map((each) => [each.pid, each]));

          const { stdout } = spawnSync(
            argv[0] ?? "",
            [
              ...argv.slice(1),
              "-v",
              "signal=S",
              "-v",
              "self=1",
              "-v",
              "proc=1",
              membersProgram,
            ],
            { input: listingOf(word, tree), encoding: "utf-8" }
          );

          const [count = "", toStop = "", toKill = ""] = stdout.split("\n");

          expect(count, `seed ${seed}`).toBe(String(tree.length));

          for (const line of [toStop, toKill]) {
            const order = line.trim().split(" ").map(Number);

            expect(order.toSorted(ascending), `seed ${seed}`).toStrictEqual(
              tree.map(({ pid }) => pid).toSorted(ascending)
            );

            for (const pid of order) {
              const parent = byPid.get(byPid.get(pid)?.ppid ?? 0);

              expect(
                parent === undefined ||
                  order.indexOf(parent.pid) < order.indexOf(pid),
                `seed ${seed}: ${pid} is listed before its parent`
              ).toBe(true);
            }
          }
        }
      });
    });
  }
);

underEachShell(stormCases);

const macSh = ["/bin/sh"] as const;

const shIsBash32 = /version 3\.2\./u.test(
  spawnSync(macSh[0], ["--version"], { encoding: "utf-8" }).stdout ?? ""
);

describe.runIf(shIsBash32)("under bash 3.2, macOS's sh", () => {
  daemonCases(macSh);
});
