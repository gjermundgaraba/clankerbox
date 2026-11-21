import type { ExecCommand } from "@clankerbox/host-contract";
import {
  endTimeout,
  Internal,
  Invalid,
  outputLimit,
  ScriptFailed,
  timedOutExitCode,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Executed } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Exit, Scope, Stream } from "effect";
import { Hex } from "effect/encoding";

import { lastLines, timeoutFail } from "./runtime.ts";
import type {
  Command,
  Interface as Runtime,
  Target,
  RuntimeError,
} from "./runtime.ts";

const keptOutput = () => {
  const decoder = new TextDecoder();
  let kept = "";
  let truncated = false;

  const keep = (text: string) => {
    truncated ||= kept.length + text.length > outputLimit;
    kept = (kept + text).slice(-outputLimit);
  };

  return {
    push: (chunk: Uint8Array) => {
      keep(decoder.decode(chunk, { stream: true }));
    },
    text: () => {
      keep(decoder.decode());

      return kept;
    },
    truncated: () => truncated,
  };
};

export interface Invocation {
  readonly argv: readonly [string, ...string[]];
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly user?: string | undefined;
  readonly stdin?: string | undefined;
}

export const markName = "CLANKERBOX_EXEC";

const markBytes = 16;

const minted = (): string =>
  Hex.encode(globalThis.crypto.getRandomValues(new Uint8Array(markBytes)));

const endedRecords = "${CLANKERBOX_ROOT-}/var/run/clankerbox-ended";

// dash's and bash's `read` take a pipe's input a byte at a time, so the command gets the rest:
// https://git.kernel.org/pub/scm/utils/dash/dash.git/tree/src/miscbltin.c?h=v0.5.12#n151
// https://git.savannah.gnu.org/cgit/bash.git/tree/builtins/read.def?h=bash-5.2#n604
// `env` takes each word holding `=` before the command for a variable, and GNU's, busybox's and
// uutils' take a lone `-` after `--` for `-i`:
// https://pubs.opengroup.org/onlinepubs/9799919799/utilities/env.html
// https://github.com/coreutils/coreutils/blob/v9.5/src/env.c#L833
// bash, as zsh and busybox ash do, runs the last command of a `-c` script in its own process,
// unless another command follows it, and dash and busybox ash print a line on their stderr when a
// command they wait for ends by a signal, but for INT and PIPE:
// https://git.savannah.gnu.org/cgit/bash.git/tree/builtins/evalstring.c?h=bash-5.2#n130
// https://git.kernel.org/pub/scm/utils/dash/dash.git/tree/src/jobs.c?h=v0.5.12#n427
// A shell copies a string whole at each append and `"$@"` whole at each `set`, and bash 3.2 slows
// with each variable it holds, so values wait in at most 1000 variables, named in strings of 100,
// and a value's lines are joined 1000 at a time by `"$*"`, then its pieces at once.
const launcher = [
  "set -e",
  `[ ! -e "${endedRecords}/\${1#${markName}=}" ] || exit 143`,
  "nl='",
  "'",
  `join_lines() { IFS=$nl; joined="$*"; unset IFS; }`,
  "piece() {",
  "  c=0 h= p=",
  `  while [ "$c" -lt "$1" ]; do`,
  "    c=$((c + 1))",
  `    IFS= read -r "l$c"`,
  `    p="$p \\"\\$l$c\\""`,
  "    case $c in *00) h=$h$p p= ;; esac",
  "  done",
  `  eval "join_lines $h$p"`,
  "}",
  "read -r values pairs",
  "i=0",
  "j=0",
  "held=",
  "part=",
  `while [ "$i" -lt "$values" ]; do`,
  "  i=$((i + 1))",
  "  j=$((j + 1))",
  "  IFS= read -r line",
  "  lines=${line%% *}",
  "  value=${line#* }",
  "  left=$((lines - 1)) k=0 pieces='\"$value\"'",
  `  while [ "$left" -gt 0 ]; do`,
  "    k=$((k + 1))",
  "    piece $((left > 1000 ? 1000 : left))",
  `    eval "q$k=\\$joined"`,
  `    pieces="$pieces \\"\\$q$k\\""`,
  "    left=$((left - 1000))",
  "  done",
  `  [ "$k" -eq 0 ] || { eval "join_lines $pieces"; value=$joined; }`,
  `  eval "v$j=\\$value"`,
  `  part="$part \\"\\$v$j\\""`,
  "  case $j in *00) held=$held$part part= ;; esac",
  `  if [ "$j" -eq 1000 ] || [ "$i" -eq "$values" ]; then`,
  `    eval "set -- \\"\\$@\\"$held$part"`,
  "    j=0 held= part=",
  "  fi",
  "done",
  `eval "first=\\\${$((pairs + 2))}"`,
  `case $first in`,
  `  *=*) printf '%s: not run, as env takes a word holding = for a variable\\n' "$first" >&2; exit 127 ;;`,
  `  -) printf '%s: not run, as env takes a lone - for -i\\n' "$first" >&2; exit 127 ;;`,
  "esac",
  "trap : HUP INT QUIT USR1 USR2 PIPE ALRM TERM XCPU XFSZ VTALRM PROF SYS",
  "exec 3>&2 2>/dev/null",
  `(exec env -- "$@" 2>&3 3>&-) || exit`,
].join("\n");

/**
 * The launcher leaves faults (ILL, TRAP, BUS, FPE, SEGV) untrapped. zsh names ABRT IOT,
 * and KILL cannot be caught.
 */
export const guestCommand = (
  { argv, env, user, stdin }: Invocation,
  mark: string
): Command => {
  const values = [
    ...Object.entries(env ?? {}).map(([name, value]) => `${name}=${value}`),
    ...argv,
  ];

  return {
    argv: ["/bin/sh", "-c", launcher, "clankerbox", `${markName}=${mark}`],
    user,
    stdin: [
      `${values.length} ${values.length - argv.length}\n`,
      ...values.map((value) => `${value.split("\n").length} ${value}\n`),
      stdin ?? "",
    ].join(""),
  };
};

const killGraceSeconds = 5;

const graceGrowthKeepingGrace = 32;

const endMargin = Duration.seconds(5);

export const endDeadline = Duration.subtract(endTimeout, endMargin);

const recordMinutes = 60;

// Linux's /proc/<pid>/stat holds the command's name in parentheses, which may hold any character,
// a newline too, then the state, the parent and, 19 fields on, the start time:
// https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
// Reading the stat of a process that exits as it is read fails, which ends mawk at a `getline`,
// and `grep -s` passes over; `grep -H` starts each line it prints with its file's name.
// macOS's `ps -E` prints a process's environment after its arguments, also another user's to root,
// a newline in either as `\012`, so each process on a line of its own, and `lstart` as five words.
// A stopped process forks nothing and keeps its children's parent, so what the end stops before it
// kills can't add a process it doesn't list. sudo, on a pty, stops its parent's process group once
// it sees its command stop, which holds smolvm's agent and the end on a restored machine:
// https://github.com/sudo-project/sudo/blob/v1.9.17p2/src/exec_pty.c#L276-L287
// A process of one thread, as sudo is, acts on a pending STOP at its next return from the kernel,
// so one sent STOP before its child sees no system call of its own return, and with it nothing of
// that child's stop; another thread of a process of several can still see it:
// https://man7.org/linux/man-pages/man7/signal.7.html
export const membersProgram = String.raw`
function add(pid, ppid, start, state) {
  rows++
  if (state ~ /^[ZX]/ || pid == 1 || pid == self) return
  n++; P[n] = pid; PP[pid] = ppid; ST[pid] = start
}
function stated() {
  if (spid != "" && match(stat, /\) [^)]*$/)) {
    split(substr(stat, RSTART + 2), s, " ")
    add(spid, s[2], s[20], s[1])
  }
}
NR == 1 { word = $0; next }
part == 0 && $0 == "." { part = 1; next }
part == 0 { if (NF == 3) { H[$1] = $2; F[$1] = $3 }; next }
proc && part == 1 && $0 == "." { part = 2; next }
proc && part == 1 { split($0, p, "/"); M[p[3]] = 1; next }
proc && part == 2 && match($0, /^\/proc\/[0-9]+\/stat:/) {
  pid = substr($0, 7, RLENGTH - 12); line = substr($0, RLENGTH + 1)
  if (pid == spid) stat = stat "\n" line; else { stated(); spid = pid; stat = line }
  next
}
proc && part == 2 { next }
part == 1 { if (index(" " $0 " ", " " word " ")) M[$1] = 1; add($1, $2, $3 $4 $5 $6 $7, $8) }
END {
  stated()
  if (rows == 0) { print "unlisted"; exit }
  for (grown = 1; grown;) {
    grown = 0
    for (i = 1; i <= n; i++) {
      pid = P[i]
      if (!(pid in K) && ((pid in M) || ((pid in H) && H[pid] == ST[pid]) || (PP[pid] in K))) { K[pid] = 1; grown = 1 }
    }
  }
  for (i = 1; i <= n; i++) {
    pid = P[i]
    if (!(pid in K)) continue
    count++
    if (PP[pid] in K) C[PP[pid]] = C[PP[pid]] " " pid; else O[++o] = pid
  }
  for (q = 1; q <= o; q++) { placed[O[q]] = 1; if (O[q] in C) { m = split(C[O[q]], c, " "); for (j = 1; j <= m; j++) if (!(c[j] in placed)) { placed[c[j]] = 1; O[++o] = c[j] } } }
  for (i = 1; i <= n; i++) if ((P[i] in K) && !(P[i] in placed)) O[++o] = P[i]
  for (q = 1; q <= o; q++) {
    pid = O[q]
    sent = ((pid in H) && H[pid] == ST[pid]) ? F[pid] : "-"
    if (!index(sent, signal)) { fresh = fresh " " pid; sent = sent signal }
    all = all " " pid; R[q] = pid " " ST[pid] " " sent
  }
  printf "%d\n%s\n%s\n", count, fresh, all
  for (q = 1; q <= o; q++) print R[q]
}
`;

export const endScript = [
  "IFS=' ' read -r mark seconds || mark=",
  `case $mark in '' | *[!0-9a-f]*) echo "clankerbox: no mark to end" >&2; exit 2 ;; esac`,
  `case $seconds in '' | *[!0-9]*) echo "clankerbox: no deadline for the end of $mark" >&2; exit 2 ;; esac`,
  "ends=$(($(date +%s) + seconds))",
  `word="${markName}=$mark"`,
  `records="${endedRecords}"`,
  `mkdir -p "$records" && : >"$records/$mark" || echo "clankerbox: couldn't record that $mark ended, so a command of it that begins later runs" >&2`,
  `find "$records" -type f -mmin +${recordMinutes} -exec rm -f {} + 2>/dev/null || true`,
  `program='${membersProgram.replaceAll("'", String.raw`'\''`)}'`,
  "held=",
  "found=",
  "all=",
  "count=0",
  "release() {",
  `  [ -z "$found" ] || { kill -s KILL $found; kill -s CONT $found; } 2>/dev/null`,
  `  echo "clankerbox: $1" >&2`,
  "  exit 1",
  "}",
  `trap 'release "its end was cut short, with $count processes of the command running at its last listing"' HUP INT TERM`,
  "trap '' PIPE",
  "if [ -r /proc/self/stat ]; then proc=1; else proc=0; fi",
  "round() {",
  `  [ "$(date +%s)" -lt "$ends" ] || release "$count processes of the command still ran at its last listing when its end's \${seconds}s ran out"`,
  "  listed=$(",
  `    { printf '%s\\n%s\\n.\\n' "$word" "$held"`,
  `      if [ "$proc" = 1 ]; then`,
  `        { printf '%s/cmdline\\n' /proc/[0-9]*; printf '%s/environ\\n' /proc/[0-9]*; } | xargs grep -ls -e "${markName}[=]$mark"`,
  "        echo .",
  `        printf '%s/stat\\n' /proc/[0-9]* | LC_ALL=C xargs grep -Hs -e ''`,
  "      else",
  "        ps -axEww -o pid=,ppid=,lstart=,state=,command=",
  "      fi",
  `    } | awk -v signal="$1" -v self="$$" -v proc="$proc" "$program"`,
  "  )",
  `  count=$(printf '%s\\n' "$listed" | awk 'NR == 1')`,
  `  case $count in '' | *[!0-9]*) release "couldn't list the guest's processes, with /proc or ps, and awk" ;; esac`,
  `  fresh=$(printf '%s\\n' "$listed" | awk 'NR == 2')`,
  `  found=$(printf '%s\\n' "$listed" | awk 'NR == 3')`,
  `  held=$(printf '%s\\n' "$listed" | awk 'NR > 3')`,
  "}",
  "alive() {",
  `  if [ "$proc" = 1 ]; then`,
  `    { IFS= read -r stat <"/proc/$1/stat"; } 2>/dev/null || return 1`,
  "    case ${stat##*) } in Z* | X*) return 1 ;; esac",
  "  else",
  `    kill -0 "$1" 2>/dev/null || return 1`,
  "  fi",
  "}",
  "ended() {",
  `  rm -f "$records/$mark"`,
  "  exit 0",
  "}",
  "termed() {",
  "  round T",
  `  [ "$count" -gt 0 ] || ended`,
  `  [ -z "$fresh" ] || kill -s TERM $fresh 2>/dev/null`,
  "  all=$found termed=$count",
  "}",
  "round T",
  `[ "$count" -gt 0 ] || exit 0`,
  `[ -z "$fresh" ] || kill -s TERM $fresh 2>/dev/null`,
  "all=$found termed=$count",
  `graced=$(($(date +%s) + ${killGraceSeconds}))`,
  `[ "$graced" -lt "$ends" ] || graced=$ends`,
  "if sleep 0.2 2>/dev/null; then tick=0.2 every=2; else tick=1 every=1; fi",
  "ticks=0",
  `while [ "$(date +%s)" -le "$graced" ]; do`,
  "  live=",
  `  for pid in $all; do alive "$pid" && live=1 && break; done`,
  "  ticks=$((ticks + 1))",
  `  if [ -z "$live" ]; then`,
  "    termed",
  "  elif [ $((ticks % every)) -eq 0 ]; then",
  "    round L",
  `    [ "$count" -le $((termed + ${graceGrowthKeepingGrace})) ] || break`,
  "  fi",
  `  sleep "$tick"`,
  "done",
  "while :; do",
  "  round S",
  `  [ "$count" -gt 0 ] || ended`,
  `  if [ -n "$fresh" ]; then`,
  "    kill -s STOP $fresh 2>/dev/null",
  "  else",
  "    kill -s KILL $found 2>/dev/null",
  `    sleep "$tick"`,
  "  fi",
  "done",
].join("\n");

const attached = (
  runtime: Pick<Runtime, "exec">,
  machine: Target,
  invocation: Invocation,
  mark: string,
  output: ReturnType<typeof keptOutput>
): Effect.Effect<
  { readonly exitCode: Effect.Effect<number, RuntimeError> },
  RuntimeError,
  Scope.Scope
> =>
  Effect.map(
    runtime.exec(machine, guestCommand(invocation, mark)),
    (execution) => ({
      exitCode: Effect.map(
        Effect.all(
          [
            Stream.runForEach(execution.output, (chunk) =>
              Effect.sync(() => {
                output.push(chunk);
              })
            ),
            execution.exitCode,
          ],
          { concurrency: "unbounded" }
        ),
        ([, exitCode]) => exitCode
      ),
    })
  );

const ended = (
  runtime: Pick<Runtime, "exec">,
  machine: Target,
  mark: string
): Effect.Effect<void, Internal> => {
  const output = keptOutput();

  return Effect.scoped(
    Effect.flatMap(
      attached(
        runtime,
        machine,
        {
          argv: ["/bin/sh", "-c", endScript, "clankerbox-end"],
          stdin: `${mark} ${Duration.toSeconds(endDeadline)}\n`,
        },
        minted(),
        output
      ),
      ({ exitCode }) => exitCode
    )
  ).pipe(
    timeoutFail(
      endTimeout,
      () =>
        new Internal({
          message: `the end didn't finish within ${Duration.format(endTimeout)}`,
        })
    ),
    Effect.flatMap((code) => {
      if (code === 0) {
        return Effect.void;
      }

      const text = lastLines(output.text());

      return Effect.fail(
        new Internal({
          message:
            text === ""
              ? `the end exited ${code} and printed nothing`
              : `the end exited ${code}: ${text}`,
        })
      );
    })
  );
};

interface Limited {
  readonly _tag: "limit";
  readonly limit: Duration.Duration;
}

interface LeftUnder {
  readonly _tag: "left";
  readonly leaving: Leaving;
}

type Cut = Limited | LeftUnder;

export const limited = (limit: Duration.Duration): Effect.Effect<Limited> =>
  Effect.as(Effect.sleep(limit), { _tag: "limit", limit } as const);

const cutAt = (timeoutSeconds: number | undefined): Effect.Effect<Limited> =>
  timeoutSeconds === undefined
    ? Effect.never
    : limited(Duration.seconds(timeoutSeconds));

const endedBy = (exit: Exit.Exit<unknown, unknown>, cut: Cut | undefined) => {
  if (cut !== undefined) {
    return cut._tag === "limit"
      ? `past its ${Duration.format(cut.limit)} limit`
      : `that its machine's ${cut.leaving} cut short`;
  }

  return Exit.hasInterrupts(exit)
    ? "whose request ended before its exit code"
    : "whose runtime failed before its exit code";
};

type Drained<C extends Cut> =
  | { readonly _tag: "exited"; readonly code: number }
  | { readonly _tag: "cut"; readonly by: C }
  | { readonly _tag: "unended"; readonly by: C; readonly why: string };

const drained = <C extends Cut>(
  runtime: Pick<Runtime, "exec">,
  machine: Target,
  invocation: Invocation,
  output: ReturnType<typeof keptOutput>,
  cut: Effect.Effect<C>
): Effect.Effect<Drained<C>, RuntimeError> =>
  Effect.suspend(() => {
    let unended: Internal | undefined;
    let cutBy: Cut | undefined;

    return Effect.scoped(
      Effect.gen(function* () {
        const mark = minted();
        const held = yield* Scope.make();
        let finished = false;

        yield* Effect.addFinalizer((exit) =>
          (finished
            ? Effect.void
            : ended(runtime, machine, mark).pipe(
                Effect.catch((error) =>
                  Effect.andThen(
                    Effect.logWarning(
                      `couldn't end in ${machine.name} the command of an exec ${endedBy(exit, cutBy)}, which may still run there: ${error.message}`
                    ),
                    Effect.sync(() => {
                      unended = error;
                    })
                  )
                )
              )
          ).pipe(Effect.ensuring(Scope.close(held, exit)))
        );

        const exited = Effect.flatMap(
          Scope.provide(
            attached(runtime, machine, invocation, mark, output),
            held
          ),
          (execution) =>
            Effect.map(execution.exitCode, (code): Drained<C> => {
              finished = true;

              return { _tag: "exited", code };
            })
        );

        return yield* Effect.raceFirst(
          exited,
          Effect.map(cut, (by): Drained<C> => {
            cutBy = by;

            return { _tag: "cut", by };
          })
        );
      })
    ).pipe(
      Effect.map((drain): Drained<C> =>
        drain._tag === "cut" && unended !== undefined
          ? { _tag: "unended", by: drain.by, why: unended.message }
          : drain
      )
    );
  });

export const runInGuest = (
  runtime: Pick<Runtime, "exec">,
  script: "setup" | "preparation" | "tailnet",
  machine: Target,
  invocation: Invocation,
  timeout: Duration.Duration
): Effect.Effect<string, RuntimeError | ScriptFailed> =>
  Effect.gen(function* () {
    const output = keptOutput();

    const ending = yield* drained(
      runtime,
      machine,
      invocation,
      output,
      limited(timeout)
    );

    const text = output.text();
    const tail = `its last output:\n${lastLines(text)}`;

    switch (ending._tag) {
      case "exited": {
        if (ending.code === 0) {
          return text;
        }

        return yield* new ScriptFailed({
          message: `${script} exited ${ending.code}; ${tail}`,
          script,
        });
      }

      case "cut": {
        return yield* new ScriptFailed({
          message: `${script} ran past its ${Duration.format(ending.by.limit)} timeout; ${tail}`,
          script,
        });
      }

      case "unended": {
        return yield* new ScriptFailed({
          message: `${script} ran past its ${Duration.format(ending.by.limit)} timeout and couldn't then be ended, so it may still run in the guest: ${ending.why}; ${tail}`,
          script,
        });
      }
    }
  });

type GuestCommand = Omit<ExecCommand, "machine"> & {
  readonly machine: Target;
};

export const ran = <C extends Cut>(
  runtime: Pick<Runtime, "exec">,
  { machine, argv, user, env, stdin }: Omit<GuestCommand, "timeoutSeconds">,
  cut: Effect.Effect<C>
) =>
  Effect.gen(function* () {
    const output = keptOutput();

    const ending = yield* drained(
      runtime,
      machine,
      { argv, env, user, stdin },
      output,
      cut
    );

    return {
      ending,
      kept: { output: output.text(), truncated: output.truncated() },
    };
  });

export const executed = (
  ending: Drained<Cut>,
  kept: Omit<Executed, "exitCode" | "mayStillRun">
): Executed => {
  switch (ending._tag) {
    case "exited": {
      return { exitCode: ending.code, ...kept };
    }

    case "cut": {
      return { exitCode: timedOutExitCode, ...kept };
    }

    case "unended": {
      return { exitCode: timedOutExitCode, ...kept, mayStillRun: ending.why };
    }
  }
};

export type Leaving = "stop" | "pause" | "delete";

const leavingPhase = {
  stop: "stopping",
  pause: "pausing",
  delete: "deleting",
} as const satisfies Record<Leaving, string>;

export const runCommand = (
  runtime: Pick<Runtime, "exec">,
  command: GuestCommand,
  left: Effect.Effect<Leaving> = Effect.never
): Effect.Effect<Executed, Invalid | WrongState | RuntimeError> => {
  if (command.env !== undefined && Object.hasOwn(command.env, markName)) {
    return Effect.fail(
      new Invalid({
        message: `a command's environment can't set ${markName}, which marks the processes of its exec, so a cut one is ended`,
      })
    );
  }

  const leftUnder = Effect.map(left, (leaving): LeftUnder => ({
    _tag: "left",
    leaving,
  }));

  return Effect.flatMap(
    ran(
      runtime,
      command,
      Effect.raceFirst(cutAt(command.timeoutSeconds), leftUnder)
    ),
    ({ ending, kept }) => {
      if (ending._tag === "exited" || ending.by._tag === "limit") {
        return Effect.succeed(executed(ending, kept));
      }

      const { name } = command.machine;
      const { leaving } = ending.by;

      const still =
        ending._tag === "unended"
          ? `, though it may still run in the guest: ${ending.why}`
          : "";

      return Effect.fail(
        new WrongState({
          message: `machine ${name}'s ${leaving} ended this exec's command first${still}`,
          machine: name,
          state: leavingPhase[leaving],
        })
      );
    }
  );
};
