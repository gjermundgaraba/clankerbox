import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import {
  mkdir,
  outputOf,
  readDirectory,
  scratch,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Duration, Effect, Fiber, Schedule, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import { endScript, guestCommand, markName } from "../src/exec.ts";
import type { Invocation } from "../src/exec.ts";
import { waitFor } from "./support.ts";

export const guestShells = [
  { name: "dash", argv: ["dash"] },
  { name: "bash in POSIX mode", argv: ["bash", "--posix"] },
  { name: "zsh as sh", argv: ["zsh", "--emulate", "sh"] },
  { name: "busybox ash", argv: ["busybox", "sh"] },
].map((shell) => ({
  ...shell,
  installed:
    spawnSync(shell.argv[0] ?? "", [...shell.argv.slice(1), "-c", "exit 0"])
      .status === 0,
}));

export const unsharedMark = () => randomBytes(16).toString("hex");

const treeTimeout = Duration.seconds(5);

const endSeconds = 10;

const confirmedUpTo = 2000;

const graceGrowth = 32;

export const answeredWithin = Duration.seconds(15);

const endsTimeout = (trees: number, ends: number) =>
  Duration.toMillis(
    Duration.sum(
      Duration.times(treeTimeout, trees),
      Duration.times(answeredWithin, ends)
    )
  );

export const statOf = (pid: number) => {
  try {
    const line = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const fields = line.slice(line.lastIndexOf(") ") + 2).split(" ");

    return { state: fields[0], ppid: Number(fields[1]), start: fields[19] };
  } catch {
    return undefined;
  }
};

const runs = (pid: number, start: string | undefined) => {
  const found = statOf(pid);

  return found !== undefined && found.state !== "Z" && found.start === start;
};

const descendantsOf = (pid: number): readonly number[] => {
  const parents = readdirSync("/proc")
    .filter((entry) => /^\d+$/u.test(entry))
    .map((entry) => [Number(entry), statOf(Number(entry))?.ppid] as const);

  const found = [pid];

  for (let grew = true; grew;) {
    grew = false;

    for (const [child, parent] of parents) {
      if (
        parent !== undefined &&
        found.includes(parent) &&
        !found.includes(child)
      ) {
        found.push(child);
        grew = true;
      }
    }
  }

  return found;
};

export interface Marked {
  readonly pid: number;
  readonly start: string | undefined;
}

const marked = (
  root: string,
  script: string,
  count: number,
  mark: string,
  within = treeTimeout
) =>
  Effect.gen(function* () {
    const held = new Map<number, string | undefined>();

    const pid = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          spawn("sh", ["-c", script], {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, CLANKERBOX_ROOT: root, [markName]: mark },
          }).pid ?? 0
      ),
      () =>
        Effect.sync(() => {
          for (const [each, start] of held) {
            if (runs(each, start)) {
              process.kill(each, "SIGKILL");
            }
          }
        })
    );

    const tree = yield* Effect.sync(() => {
      const found = descendantsOf(pid);

      for (const each of found) {
        if (!held.has(each)) {
          held.set(each, statOf(each)?.start);
        }
      }

      return found;
    }).pipe(
      Effect.repeat({
        until: (found) => found.length >= count,
        schedule: Schedule.spaced(Duration.millis(50)),
      }),
      Effect.timeout(within)
    );

    return tree.map((each): Marked => ({ pid: each, start: held.get(each) }));
  });

export const runningOf = (tree: readonly Marked[]) =>
  Effect.sync(() => tree.filter(({ pid, start }) => runs(pid, start)));

const goneWithin = (tree: readonly Marked[], within: Duration.Duration) =>
  runningOf(tree).pipe(
    Effect.repeat({
      until: (left) => left.length === 0,
      schedule: Schedule.spaced(Duration.millis(20)),
    }),
    Effect.timeoutOrElse({
      duration: within,
      orElse: () => runningOf(tree),
    })
  );

const readable = (file: string) => {
  try {
    return readFileSync(file, "latin1");
  } catch {
    return "";
  }
};

const killed = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");

    return true;
  } catch {
    return false;
  }
};

const holdingAny = (needles: readonly string[]) =>
  readdirSync("/proc")
    .filter((entry) => /^\d+$/u.test(entry))
    .map(Number)
    .filter((pid) => {
      const state = statOf(pid)?.state;
      const held = `${readable(`/proc/${pid}/cmdline`)}\0${readable(`/proc/${pid}/environ`)}`;

      return (
        state !== undefined &&
        state !== "Z" &&
        needles.some((needle) => held.includes(needle))
      );
    });

const reaped = (root: string, needles: readonly string[]) =>
  Effect.addFinalizer(() =>
    Effect.sync(() => {
      writeFileSync(path.join(root, "enough"), "");

      for (let pass = 0; pass < 10; pass += 1) {
        const left = holdingAny(needles);

        if (left.length === 0) {
          return;
        }

        for (const pid of left) {
          killed(pid);
        }
      }
    })
  );

const launchedApart = (
  shell: readonly string[],
  root: string,
  invocation: Invocation,
  mark: string,
  needle: string
) =>
  Effect.gen(function* () {
    const command = guestCommand(invocation, mark);

    yield* reaped(root, [`${markName}=${mark}`, needle]);

    const child = yield* Effect.sync(() =>
      spawn(shell[0] ?? "", [...shell.slice(1), ...command.argv.slice(1)], {
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, CLANKERBOX_ROOT: root },
      })
    );

    yield* Effect.sync(() => {
      child.stdin.end(command.stdin);
    });

    return yield* Effect.sync(() => holdingAny([needle])).pipe(
      Effect.repeat({
        until: (found) => found.length > 0,
        schedule: Schedule.spaced(Duration.millis(50)),
      }),
      Effect.timeout(treeTimeout)
    );
  });

const endUnder = (
  shell: readonly string[],
  root: string,
  mark: string,
  seconds = endSeconds,
  env: Readonly<Record<string, string>> = {}
) =>
  outputOf(
    shell[0] ?? "",
    [...shell.slice(1), "-c", endScript, "clankerbox-end"],
    {
      env: { ...env, CLANKERBOX_ROOT: root },
      extendEnv: true,
      input: new TextEncoder().encode(`${mark} ${seconds}\n`),
    }
  );

const launched = (
  shell: readonly string[],
  invocation: Invocation,
  env?: Readonly<Record<string, string>>,
  mark = unsharedMark()
) => {
  const command = guestCommand(invocation, mark);

  return outputOf(
    shell[0] ?? "",
    [...shell.slice(1), ...command.argv.slice(1)],
    { env, input: new TextEncoder().encode(command.stdin ?? "") }
  );
};

const launcherTraps = [
  "HUP",
  "INT",
  "QUIT",
  "USR1",
  "USR2",
  "PIPE",
  "ALRM",
  "TERM",
  "XCPU",
  "XFSZ",
  "VTALRM",
  "PROF",
  "SYS",
] as const;

const guardExit = 99;

const launchedBelowGuard = (
  shell: readonly string[],
  invocation: Invocation
) => {
  const command = guestCommand(invocation, unsharedMark());

  return outputOf(
    "sh",
    [
      "-c",
      `trap 'exit ${guardExit}' ${launcherTraps.join(" ")}; "$@"; exit $?`,
      "guard",
      ...shell,
      ...command.argv.slice(1),
    ],
    { input: new TextEncoder().encode(command.stdin ?? "") }
  );
};

const oddValues = [
  "",
  "-n",
  "two\nlines\n",
  "\n",
  "  led\n  spaced  \n\ttabbed\t\n ",
  "back\\slash\\",
  String.raw`\0101 \c`,
  " 'quoted' \"double\" $HOME `tick` é ✓ ",
  "x=y",
];

const specialNames = [
  "UID",
  "EUID",
  "PPID",
  "GROUPS",
  "SHELLOPTS",
  "SHLVL",
  "RANDOM",
  "SECONDS",
  "OPTIND",
  "LINENO",
  "IFS",
  "ENV",
  "ARGC",
  "status",
  "values",
  "pairs",
  "value",
  "v1",
];

const oneCpu = () =>
  /(?<cpu>\d+)/u.exec(
    spawnSync("taskset", ["-cp", String(process.pid)], { encoding: "utf-8" })
      .stdout.split(":")
      .at(-1) ?? ""
  )?.groups?.["cpu"] ?? "0";

const sudoLikeWatcher = [
  'use POSIX ":sys_wait_h";',
  '$SIG{TERM} = "IGNORE";',
  "my $c = fork;",
  'if (!$c) { exec "sh", "-c", "trap \\"\\" TERM; sleep 300"; }',
  "while (1) {",
  "  my $w = waitpid($c, WUNTRACED);",
  "  last if $w <= 0;",
  "  last if !WIFSTOPPED(${^CHILD_ERROR_NATIVE});",
  '  open my $f, ">>", "$ENV{CLANKERBOX_ROOT}/saw-a-stop";',
  '  print $f "$$\\n";',
  "  close $f;",
  "}",
].join(" ");

const manyLinesSeconds = 5;

const chainDepth = 400;

const daemonSeconds = 30;

const guestsOwnSh = "/bin/sh";

export const daemonCases = (shell: readonly string[]) => {
  layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    it.effect(
      "a daemon its command starts on stdio of its own holds none of the exec's output, so the exec ends with its command",
      () =>
        Effect.gen(function* () {
          const [took, ran] = yield* Effect.timed(
            launched(shell, {
              argv: [
                guestsOwnSh,
                "-c",
                `sleep ${daemonSeconds} </dev/null >/dev/null 2>&1 & echo $!`,
              ],
            })
          );

          killed(Number(ran.stdout.trim()));

          expect(ran.code).toBe(0);
          expect(Duration.toSeconds(took)).toBeLessThan(daemonSeconds / 2);
        }),
      daemonSeconds * 2000
    );
  });
};

export const shellCases = (shell: readonly string[]) => {
  daemonCases(shell);

  layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    it.effect(
      `a command gets its arguments, env and the rest of stdin exactly as given, its own uid, and many arguments`,
      () =>
        Effect.gen(function* () {
          const many = Array.from(
            { length: 2345 },
            (_, i) => oddValues[i % oddValues.length] ?? ""
          );

          const printed = yield* launched(shell, {
            argv: ["printf", "[%s]", ...oddValues],
            env: { A: "two\nlines\n" },
          });

          const env = yield* launched(shell, {
            argv: ["env"],
            env: Object.fromEntries(
              specialNames.map((special) => [special, `v-${special}`])
            ),
          });

          const uid = yield* launched(shell, {
            argv: ["id", "-u"],
            env: { UID: "4321", EUID: "4321" },
          });

          const stdin = yield* launched(shell, {
            argv: ["cat"],
            env: { A: "a" },
            stdin: "first\n\nno newline at its end",
          });

          const printedMany = yield* launched(shell, {
            argv: ["printf", "[%s]", ...many],
          });

          expect(printed.stdout).toBe(
            oddValues.map((arg) => `[${arg}]`).join("")
          );
          expect(
            env.stdout
              .split("\n")
              .filter((line) =>
                specialNames.some((special) => line.startsWith(`${special}=`))
              )
              .toSorted()
          ).toStrictEqual(
            specialNames.map((special) => `${special}=v-${special}`).toSorted()
          );
          expect(uid.stdout.trim()).toBe(String(process.getuid?.()));
          expect(stdin.stdout).toBe("first\n\nno newline at its end");
          expect(printedMany.stdout).toBe(
            many.map((arg) => `[${arg}]`).join("")
          );
        })
    );

    it.effect(
      "a value of 60,000 lines reaches its command whole, in time linear in its lines",
      () =>
        Effect.gen(function* () {
          const value = Array.from({ length: 60_000 }, () => "a").join("\n");

          const [took, printed] = yield* Effect.timed(
            launched(shell, { argv: ["printf", "[%s]", value] })
          );

          expect(printed.stdout).toBe(`[${value}]`);
          expect(Duration.toSeconds(took)).toBeLessThan(manyLinesSeconds);
        }),
      120_000
    );

    it.effect(
      `a command named as an option, an assignment or nothing answers 127 and runs nothing`,
      () =>
        Effect.gen(function* () {
          const named = [
            ["-l"],
            ["-i", "echo", "ran"],
            ["--", "echo", "ran"],
            ["-", "echo", "ran"],
            ["-"],
            ["A=B", "echo", "ran"],
            ["/opt/x=1/echo", "ran"],
            [""],
          ] as const;

          const answered = yield* Effect.forEach(named, (argv) =>
            Effect.map(
              Effect.all([
                launched(shell, { argv }),
                launched(shell, { argv, env: { A: "a" } }),
              ]),
              (both) => both.map(({ code, stdout }) => ({ code, stdout }))
            )
          );

          expect(answered.flat()).toStrictEqual(
            named.flatMap(() => [
              { code: 127, stdout: "" },
              { code: 127, stdout: "" },
            ])
          );
        })
    );

    it.effect(
      "the launcher gives the command the exec's mark, and runs nothing once an end has recorded it",
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;
          const mark = unsharedMark();
          const env = { CLANKERBOX_ROOT: root };
          const argv = ["sh", "-c", "echo $CLANKERBOX_EXEC; echo ran"] as const;

          const before = yield* launched(shell, { argv }, env, mark);

          yield* mkdir(path.join(root, "var", "run", "clankerbox-ended"));
          yield* write(
            path.join(root, "var", "run", "clankerbox-ended", mark),
            ""
          );

          const after = yield* launched(shell, { argv }, env, mark);

          expect(
            [before, after].map(({ code, stdout }) => ({ code, stdout }))
          ).toStrictEqual([
            { code: 0, stdout: `${mark}\nran\n` },
            { code: 143, stdout: "" },
          ]);
        })
    );

    it.effect(
      "an end ends by TERM what holds its mark, in its environment or arguments, and what descends from it, also a child that took its own group or cleared its environment, and keeps no record of a mark it has ended",
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;
          const mark = unsharedMark();

          const tree = yield* marked(
            root,
            "sleep 300 & setsid sleep 300 & env -i sh -c 'sleep 300 & wait' & wait",
            5,
            mark
          );

          const other = yield* marked(
            root,
            "sleep 300 & wait",
            2,
            unsharedMark()
          );

          const ended = yield* endUnder(shell, root, mark);

          expect(ended.code, ended.stderr).toBe(0);
          expect(yield* runningOf(tree)).toStrictEqual([]);
          expect(yield* runningOf(other)).toStrictEqual(other);
          expect(
            yield* readDirectory(
              path.join(root, "var", "run", "clankerbox-ended")
            )
          ).toStrictEqual([]);
        }),
      endsTimeout(2, 1)
    );

    it.effect(
      "an end KILLs what still runs 5 s after its TERM, and ends at once where nothing holds its mark",
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;
          const mark = unsharedMark();

          const tree = yield* marked(
            root,
            "trap '' TERM; sleep 300 & wait",
            2,
            mark
          );

          const [took, ended] = yield* Effect.timed(
            endUnder(shell, root, mark)
          );

          const unseen = unsharedMark();

          const [tookNone, none] = yield* Effect.timed(
            endUnder(shell, root, unseen)
          );

          expect([ended.code, none.code]).toStrictEqual([0, 0]);
          expect(yield* runningOf(tree)).toStrictEqual([]);
          expect(Duration.toSeconds(took)).toBeGreaterThanOrEqual(5);
          expect(Duration.toSeconds(took)).toBeLessThan(endSeconds);
          expect(Duration.toSeconds(tookNone)).toBeLessThan(2);
          expect(
            yield* readDirectory(
              path.join(root, "var", "run", "clankerbox-ended")
            )
          ).toStrictEqual([unseen]);
        }),
      endsTimeout(1, 2)
    );

    it.effect(
      "an end leaves nothing of a command that ignores TERM and keeps forking, neither the children that keep its mark nor those that cleared their environment",
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;
          const mark = unsharedMark();
          const lasts = `30.${randomBytes(3).readUIntBE(0, 3)}`;
          const needles = [`${markName}=${mark}`, `sleep\0${lasts}\0`];

          yield* reaped(root, needles);
          yield* marked(
            root,
            `trap '' TERM; while [ ! -e "$CLANKERBOX_ROOT/enough" ]; do sleep ${lasts} & env -i sleep ${lasts} & sleep 0.02; done`,
            3,
            mark
          );

          const ended = yield* endUnder(shell, root, mark);

          expect(ended.code, ended.stderr).toBe(0);
          expect(holdingAny(needles)).toStrictEqual([]);
        }),
      endsTimeout(1, 1)
    );

    it.effect(
      `an end stops a command that grows by more than ${graceGrowth} processes after its TERM within a second of it, as it isn't winding down, not at its grace's end`,
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;
          const mark = unsharedMark();
          const lasts = `30.${randomBytes(3).readUIntBE(0, 3)}`;
          const needles = [`${markName}=${mark}`, `sleep\0${lasts}\0`];

          yield* reaped(root, needles);
          yield* marked(
            root,
            `trap '' TERM; while [ ! -e "$CLANKERBOX_ROOT/enough" ]; do sleep ${lasts} & sleep 0.01; done`,
            3,
            mark
          );

          const [took, ended] = yield* Effect.timed(
            endUnder(shell, root, mark)
          );

          expect(ended.code, ended.stderr).toBe(0);
          expect(holdingAny(needles)).toStrictEqual([]);
          expect(Duration.toSeconds(took)).toBeLessThan(3);
        }),
      endsTimeout(1, 1)
    );

    it.effect(
      `an end gives its whole grace to a command whose TERM handler runs ${graceGrowth / 2} children at once, then a few more, before it exits`,
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;
          const mark = unsharedMark();

          const children = Array.from(
            { length: graceGrowth / 2 },
            () => "sleep 1.5 &"
          ).join(" ");

          const tree = yield* marked(
            root,
            `trap '${children} wait; for i in 1 2 3; do sleep 0.5; done; : >"$CLANKERBOX_ROOT/cleaned"; exit 0' TERM; while :; do sleep 0.1; done`,
            2,
            mark
          );

          const [took, ended] = yield* Effect.timed(
            endUnder(shell, root, mark)
          );

          expect(ended.code, ended.stderr).toBe(0);
          expect(existsSync(path.join(root, "cleaned"))).toBe(true);
          expect(yield* runningOf(tree)).toStrictEqual([]);
          expect(Duration.toSeconds(took)).toBeGreaterThanOrEqual(3);
        }),
      endsTimeout(1, 1)
    );

    it.effect(
      "an end KILLs what it found by descent once, also after the marked process it descends from has ended and orphaned it",
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;
          const mark = unsharedMark();

          const tree = yield* marked(
            root,
            `trap 'exit 0' TERM; env -i sh -c 'trap "" TERM; sleep 300 & wait' & wait`,
            3,
            mark
          );

          const ended = yield* endUnder(shell, root, mark);

          expect(ended.code, ended.stderr).toBe(0);
          expect(yield* runningOf(tree)).toStrictEqual([]);
        }),
      endsTimeout(1, 1)
    );

    it.effect(
      "the launcher exits as its command does, 0, 1, 126 and 127, and with 128 and the signal's number, saying nothing of its own, for one a signal ended",
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;
          const unrunnable = path.join(root, "unrunnable");

          yield* write(unrunnable, "#!/bin/sh\necho ran\n");

          const codes = yield* Effect.forEach(
            [
              ["true"],
              ["false"],
              [unrunnable],
              ["no-such-command-of-clankerbox"],
              ["sh", "-c", "kill -s KILL $$"],
              ["sh", "-c", "kill -s TERM $$"],
            ] as const,
            (argv) =>
              Effect.map(launched(shell, { argv }), ({ code, stderr }) =>
                code > 128 ? { code, stderr } : { code }
              )
          );

          expect(codes).toStrictEqual([
            { code: 0 },
            { code: 1 },
            { code: 126 },
            { code: 127 },
            { code: 137, stderr: "" },
            { code: 143, stderr: "" },
          ]);
        })
    );

    it.effect(
      "the launcher outlives each signal it traps, sent to it alone, and exits as its command then does, which keeps each signal's default",
      () =>
        Effect.gen(function* () {
          const codes = yield* Effect.forEach(
            launcherTraps,
            (signal) =>
              Effect.map(
                Effect.all([
                  launchedBelowGuard(shell, {
                    argv: [
                      "sh",
                      "-c",
                      `kill -s ${signal} $PPID; sleep 0.5; exit 7`,
                    ],
                  }),
                  launchedBelowGuard(shell, {
                    argv: ["perl", "-e", `kill "${signal}", $$; sleep 1`],
                  }),
                ]),
                ([toLauncher, toCommand]) => ({
                  signal,
                  toLauncher: toLauncher.code,
                  toCommand: toCommand.code,
                })
              ),
            { concurrency: "unbounded" }
          );

          expect(codes).toStrictEqual(
            launcherTraps.map((signal) => ({
              signal,
              toLauncher: 7,
              toCommand: 128 + constants.signals[`SIG${signal}`],
            }))
          );
        })
    );

    it.effect(
      "an end ends a command that clears its environment, also one that execs into it, with nothing above the launcher to carry the mark",
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;

          const results = yield* Effect.forEach(
            [
              (lasts: string) => ["env", "-i", "sleep", lasts] as const,
              (lasts: string) =>
                ["sh", "-c", `echo begun; exec env -i sleep ${lasts}`] as const,
            ],
            (argvOf) =>
              Effect.gen(function* () {
                const mark = unsharedMark();
                const lasts = `30.${randomBytes(3).readUIntBE(0, 3)}`;
                const needle = `sleep\0${lasts}\0`;
                const argv = argvOf(lasts);

                yield* launchedApart(shell, root, { argv }, mark, needle);

                const ended = yield* endUnder(shell, root, mark);

                return { code: ended.code, left: holdingAny([needle]).length };
              })
          );

          expect(results).toStrictEqual([
            { code: 0, left: 0 },
            { code: 0, left: 0 },
          ]);
        }),
      endsTimeout(2, 2)
    );

    it.effect(
      "an end ends a process whose name holds a newline, and what it started",
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;
          const mark = unsharedMark();

          const tree = yield* marked(
            root,
            "printf 'x\\n/proc/1/st' >/proc/$$/comm; trap '' TERM; while :; do sleep 300; done",
            2,
            mark
          );

          const ended = yield* endUnder(shell, root, mark);

          expect(ended.code, ended.stderr).toBe(0);
          expect(yield* runningOf(tree)).toStrictEqual([]);
        }),
      endsTimeout(1, 1)
    );

    it.effect(
      "an end whose deadline passes lists no more, sends what it last listed KILL and CONT, and exits 1 saying how many it held",
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;
          const mark = unsharedMark();

          const tree = yield* marked(
            root,
            "trap '' TERM; sleep 300 & wait",
            2,
            mark
          );

          const [took, ended] = yield* Effect.timed(
            endUnder(shell, root, mark, 2)
          );

          expect(ended.code).toBe(1);
          expect(ended.stderr).toContain(
            "clankerbox: 2 processes of the command still ran at its last listing when its end's 2s ran out"
          );
          expect(yield* goneWithin(tree, Duration.seconds(1))).toStrictEqual(
            []
          );
          expect(Duration.toSeconds(took)).toBeLessThan(4);
        }),
      endsTimeout(1, 1)
    );

    it.effect(
      "an end cut short by TERM sends what it last listed KILL and CONT, so none is left running or stopped, and exits 1",
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;
          const mark = unsharedMark();
          const termed = path.join(root, "termed");

          const tree = yield* marked(
            root,
            `trap 'echo termed >"$CLANKERBOX_ROOT/termed"' TERM; sleep 300 & while :; do sleep 0.1; done`,
            3,
            mark
          );

          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

          const end = yield* spawner.spawn(
            ChildProcess.make(
              shell[0] ?? "",
              [...shell.slice(1), "-c", endScript, "clankerbox-end"],
              {
                env: { CLANKERBOX_ROOT: root },
                extendEnv: true,
                stdin: Stream.make(
                  new TextEncoder().encode(`${mark} ${endSeconds}\n`)
                ),
                killSignal: "SIGKILL",
              }
            )
          );

          const said = yield* Effect.forkChild(
            Stream.mkString(Stream.decodeText(end.all))
          );

          yield* waitFor(termed, "termed");

          const [shellOf] = tree;

          yield* Effect.sync(() => {
            process.kill(shellOf?.pid ?? 0, "SIGSTOP");
            process.kill(Number(end.pid), "SIGTERM");
          });

          const code = yield* end.exitCode;

          expect(Number(code)).toBe(1);
          expect(yield* Fiber.join(said)).toMatch(
            /clankerbox: its end was cut short, with \d+ processes of the command running at its last listing/u
          );
          expect(yield* goneWithin(tree, Duration.seconds(1))).toStrictEqual(
            []
          );
        }),
      endsTimeout(1, 1)
    );

    it.effect(
      "an end refuses a stdin that holds no mark, or no deadline, and signals nothing",
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;
          const mark = unsharedMark();

          const tree = yield* marked(root, "sleep 300 & wait", 2, mark);

          const refused = yield* Effect.forEach(
            ["", "not-a-mark", "*", mark, `${mark} soon`],
            (stdin) =>
              Effect.map(
                outputOf(
                  shell[0] ?? "",
                  [...shell.slice(1), "-c", endScript, "clankerbox-end"],
                  {
                    env: { CLANKERBOX_ROOT: root },
                    extendEnv: true,
                    input: new TextEncoder().encode(`${stdin}\n`),
                  }
                ),
                ({ code }) => code
              )
          );

          expect(refused).toStrictEqual([2, 2, 2, 2, 2]);
          expect(yield* runningOf(tree)).toStrictEqual(tree);
        }),
      endsTimeout(1, 5)
    );
  });
};

export const serialStormCases = (shell: readonly string[]) => {
  layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    it.effect(
      "an end confirms the end of a command on a guest where no temporary file can be written, as when a full disk cut it",
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;
          const mark = unsharedMark();
          const unwritable = path.join(root, "no-temporary-files");

          writeFileSync(unwritable, "");

          const tree = yield* marked(
            root,
            "trap '' TERM; sleep 300 & wait",
            2,
            mark
          );

          const ended = yield* endUnder(shell, root, mark, endSeconds, {
            TMPDIR: unwritable,
          });

          expect(ended.code, ended.stderr).toBe(0);
          expect(yield* runningOf(tree)).toStrictEqual([]);
        }),
      endsTimeout(1, 1)
    );

    it.effect(
      `an end confirms, by a listing it begins within its ${endSeconds} s deadline, the end of a command of ${confirmedUpTo} processes that ignore TERM, half of them with a cleared environment, within the ${Duration.toSeconds(answeredWithin)} s its host waits`,
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;
          const mark = unsharedMark();
          const lasts = `30.${randomBytes(3).readUIntBE(0, 3)}`;
          const needles = [`${markName}=${mark}`, `sleep\0${lasts}\0`];

          yield* reaped(root, needles);
          yield* marked(
            root,
            `trap '' TERM; i=0; while [ "$i" -lt ${confirmedUpTo / 2} ]; do sleep ${lasts} & env -i sleep ${lasts} & i=$((i + 1)); done; wait`,
            confirmedUpTo + 1,
            mark,
            Duration.seconds(60)
          );

          const [took, ended] = yield* Effect.timed(
            endUnder(shell, root, mark)
          );

          expect(ended.code, ended.stderr).toBe(0);
          expect(holdingAny(needles)).toStrictEqual([]);
          expect(Duration.toSeconds(took)).toBeLessThan(
            Duration.toSeconds(answeredWithin)
          );
        }),
      120_000
    );

    it.effect(
      "an end stops no process before the parent that watches it, as sudo does, so no parent that still runs sees its child stop",
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;
          const mark = unsharedMark();
          const watchers = 12;

          const cpu = oneCpu();

          const tree = yield* marked(
            root,
            `taskset -cp ${cpu} $$ >/dev/null; for i in ${Array.from({ length: watchers }, (_, i) => i).join(" ")}; do perl -e '${sudoLikeWatcher}' & done; wait`,
            1 + watchers * 3,
            mark
          );

          const ended = yield* endUnder(
            ["taskset", "-c", cpu, ...shell],
            root,
            mark
          );

          expect(ended.code, ended.stderr).toBe(0);
          expect(yield* runningOf(tree)).toStrictEqual([]);
          expect(existsSync(path.join(root, "saw-a-stop"))).toBe(false);
        }),
      endsTimeout(1, 1)
    );

    it.effect(
      `an end confirms within its ${endSeconds} s deadline the end of a chain of ${chainDepth} processes that ignore TERM, each the parent of the next, on one CPU`,
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;
          const mark = unsharedMark();
          const cpu = oneCpu();
          const chain = path.join(root, "chain");

          yield* write(
            chain,
            `trap '' TERM; if [ "$1" -gt 0 ]; then sh "$0" $(($1 - 1)); exit; fi; sleep 300`
          );

          const tree = yield* marked(
            root,
            `taskset -cp ${cpu} $$ >/dev/null; sh ${chain} ${chainDepth}`,
            chainDepth + 2,
            mark,
            Duration.seconds(60)
          );

          const ended = yield* endUnder(
            ["taskset", "-c", cpu, ...shell],
            root,
            mark
          );

          expect(ended.code, ended.stderr).toBe(0);
          expect(yield* runningOf(tree)).toStrictEqual([]);
        }),
      120_000
    );
  });
};

export const shellsRequired = process.env["CI"] !== undefined;

export const underShell = (
  shell: string,
  cases: (argv: readonly string[]) => void
) => {
  describe.each(guestShells.filter(({ name }) => name === shell))(
    "under $name",
    ({ argv, installed }) => {
      describe.skipIf(!installed && !shellsRequired)(
        "where it is installed, as CI requires",
        () => {
          cases(argv);
        }
      );
    }
  );
};
