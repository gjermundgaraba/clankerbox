import type { ExecCommand } from "@clankerbox/host-contract";
import {
  endTimeout,
  Internal,
  Invalid,
  loginUser,
  outputLimit,
  ScriptFailed,
  timedOutExitCode,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Executed, Setup } from "@gjermundgaraba/clankerbox-sdk";
import {
  Duration,
  Effect,
  Exit,
  Option,
  Redacted,
  Schema,
  Scope,
  Stream,
} from "effect";
import { Hex } from "effect/encoding";

import { timeoutFail } from "./runtime.ts";
import type {
  Command,
  Interface as Runtime,
  Target,
  RuntimeError,
} from "./runtime.ts";

const tailLines = 20;

const tailCharacters = 4000;

export const lastLines = (text: string): string =>
  text
    .trimEnd()
    .split("\n")
    .slice(-tailLines)
    .join("\n")
    .slice(-tailCharacters);

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

/** The name of the variable whose value, fresh for each guest command, marks every process it starts. */
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
  `exec env -- "$@"`,
].join("\n");

/**
 * A guest command as the runtime runs it: one fixed `/bin/sh` launcher, with the command's env and
 * arguments at the head of its stdin, so no process's arguments on the host carry them. Each value
 * is its count of lines, then its lines; the launcher hands them to `env`, which sets the env and
 * runs the command, whatever the guest's `/bin/sh` makes of its own special names. Its one word of
 * its own, `CLANKERBOX_EXEC=<mark>`, is in the launcher's arguments from its start and in the
 * environment of the command and of every process it starts, so an end can find them.
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

const endMargin = Duration.seconds(5);

/**
 * How long an end may list and signal, from its first listing, and begins no listing after: 5 s
 * inside `endTimeout`, room for the runtime's exec of it, about 2 s on a rented host, and for the
 * one listing it may begin just before its deadline.
 */
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
export const membersProgram = String.raw`
function add(pid, ppid, start, state) {
  rows++
  if (state ~ /^[ZX]/ || pid == 1 || pid == self) return
  n++; P[n] = pid; PP[pid] = ppid; ST[pid] = start; STATE[pid] = state
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
    if (!index(sent, signal)) {
      if (signal != "S" || !(PP[pid] in K) || STATE[PP[pid]] ~ /^[Tt]/) { fresh = fresh " " pid; sent = sent signal } else waiting++
    }
    all = all " " pid; R[q] = pid " " ST[pid] " " sent
  }
  printf "%d %d\n%s\n%s\n", count, waiting, fresh, all
  for (q = 1; q <= o; q++) print R[q]
}
`;

/**
 * Ends in the guest each process whose own arguments or environment hold the mark read from stdin,
 * the exec's or not, and what descends from one. It reads the mark and its deadline in seconds,
 * then TERMs what it lists, and once at least the grace has passed, or nothing it TERMed runs, STOPs
 * what it lists until a listing finds none it hasn't stopped, and KILLs them all, again until a
 * listing finds none. It signals each listing's processes ancestors first, and STOPs a process only
 * once a listing finds stopped each ancestor of it that it lists, so no parent that still runs sees
 * its child stop, as sudo, which then stops its own parent's group, would; a process whose parent it
 * doesn't list it STOPs at once. Each listing is two `grep`s over `/proc`, given its paths by `xargs`, as zsh
 * globs a path below each process slowly and a guest's processes may name more paths than a command
 * line holds, or one `ps`, and one `awk` pass, and `awk` picks out each of its lines again, where
 * zsh's patterns take time that grows with the square of the listing, so its cost grows with the
 * guest's processes and not with their square, under every shell, and it writes no file. It begins
 * no listing once its deadline has passed, as `date +%s` counts it, nor the grace past it, and then,
 * or when a TERM, HUP or INT cuts it short, sends KILL and then CONT to every process it last
 * listed, so none is left stopped, and exits 1, saying how many there were: only a listing that
 * finds none confirms the end. A process found once is held by its start time, so one whose parent
 * ended while it cleared its environment is still found. It signals each pid alone, never a group,
 * pid 1 or itself. It records the mark first, so a launcher of it that begins later runs nothing,
 * lets that record go once it has ended what it found, since what it found holds the mark only
 * once that one launcher has begun, and removes each record older than an hour.
 */
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
  "all=",
  "count=0",
  "release() {",
  `  [ -z "$all" ] || { kill -s KILL $all; kill -s CONT $all; } 2>/dev/null`,
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
  `  first=$(printf '%s\\n' "$listed" | awk 'NR == 1')`,
  "  count=${first% *} waiting=${first#* }",
  `  case $count in '' | *[!0-9]*) release "couldn't list the guest's processes, with /proc or ps, and awk" ;; esac`,
  `  fresh=$(printf '%s\\n' "$listed" | awk 'NR == 2')`,
  `  all=$(printf '%s\\n' "$listed" | awk 'NR == 3')`,
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
  "round T",
  `[ "$count" -gt 0 ] || exit 0`,
  `[ -z "$fresh" ] || kill -s TERM $fresh 2>/dev/null`,
  `graced=$(($(date +%s) + ${killGraceSeconds}))`,
  `[ "$graced" -lt "$ends" ] || graced=$ends`,
  "if sleep 0.2 2>/dev/null; then tick=0.2; else tick=1; fi",
  `while [ "$(date +%s)" -le "$graced" ]; do`,
  "  live=",
  `  for pid in $all; do alive "$pid" && live=1 && break; done`,
  `  if [ -z "$live" ]; then`,
  "    round T",
  `    [ "$count" -gt 0 ] || ended`,
  `    [ -z "$fresh" ] || kill -s TERM $fresh 2>/dev/null`,
  "  fi",
  `  sleep "$tick"`,
  "done",
  "while :; do",
  "  round S",
  `  [ "$count" -gt 0 ] || ended`,
  `  if [ -n "$fresh" ]; then`,
  "    kill -s STOP $fresh 2>/dev/null",
  `  elif [ "$waiting" -gt 0 ]; then`,
  `    sleep "$tick"`,
  "  else",
  "    kill -s KILL $all 2>/dev/null",
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
          message: `it didn't end within ${Duration.format(endTimeout)}`,
        })
    ),
    Effect.flatMap((code) =>
      code === 0
        ? Effect.void
        : Effect.fail(
            new Internal({
              message: `it exited ${code}: ${lastLines(output.text())}`,
            })
          )
    )
  );
};

type Drained =
  | { readonly _tag: "exited"; readonly code: number }
  | { readonly _tag: "cut"; readonly limit: Duration.Duration }
  | {
      readonly _tag: "unended";
      readonly limit: Duration.Duration;
      readonly why: string;
    };

const drained = (
  runtime: Pick<Runtime, "exec">,
  machine: Target,
  invocation: Invocation,
  output: ReturnType<typeof keptOutput>,
  limit: Duration.Duration | undefined
): Effect.Effect<Drained, RuntimeError> =>
  Effect.suspend(() => {
    let unended: Internal | undefined;

    return Effect.scoped(
      Effect.gen(function* () {
        const mark = minted();
        const held = yield* Scope.make();
        let finished = false;

        yield* Effect.addFinalizer((exit) =>
          Effect.andThen(
            finished
              ? Effect.void
              : ended(runtime, machine, mark).pipe(
                  Effect.catch((error) =>
                    Effect.andThen(
                      Effect.logWarning(
                        `couldn't end in ${machine.name} the command of an exec that ended before its exit code, which may still run there: ${error.message}`
                      ),
                      Effect.sync(() => {
                        unended = error;
                      })
                    )
                  )
                ),
            Scope.close(held, exit)
          )
        );

        const execution = yield* Scope.provide(
          attached(runtime, machine, invocation, mark, output),
          held
        );

        const exited = Effect.map(execution.exitCode, (code): Drained => {
          finished = true;

          return { _tag: "exited", code };
        });

        return limit === undefined
          ? yield* exited
          : yield* Effect.timeoutOrElse(exited, {
              duration: limit,
              orElse: () => Effect.succeed<Drained>({ _tag: "cut", limit }),
            });
      })
    ).pipe(
      Effect.map((ending): Drained =>
        ending._tag === "cut" && unended !== undefined
          ? { ...ending, _tag: "unended", why: unended.message }
          : ending
      )
    );
  });

const runInGuest = (
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
      timeout
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
          message: `${script} ran past its ${Duration.format(ending.limit)} timeout; ${tail}`,
          script,
        });
      }

      case "unended": {
        return yield* new ScriptFailed({
          message: `${script} ran past its ${Duration.format(ending.limit)} timeout and couldn't then be ended, so it may still run in the guest: ${ending.why}; ${tail}`,
          script,
        });
      }
    }
  });

type GuestCommand = Omit<ExecCommand, "machine"> & {
  readonly machine: Target;
};

const ran = (
  runtime: Runtime,
  { machine, argv, user, env, stdin, timeoutSeconds }: GuestCommand
): Effect.Effect<Executed, RuntimeError> =>
  Effect.gen(function* () {
    const output = keptOutput();

    const ending = yield* drained(
      runtime,
      machine,
      { argv, env, user, stdin },
      output,
      timeoutSeconds === undefined
        ? undefined
        : Duration.seconds(timeoutSeconds)
    );

    const kept = { output: output.text(), truncated: output.truncated() };

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
  });

/** Runs a caller's command, refusing one that sets the mark's variable, which is the exec's own, as `Invalid`. */
export const runCommand = (
  runtime: Runtime,
  command: GuestCommand
): Effect.Effect<Executed, Invalid | RuntimeError> => {
  if (command.env !== undefined && Object.hasOwn(command.env, markName)) {
    return Effect.fail(
      new Invalid({
        message: `a command's environment can't set ${markName}, which marks the processes of its exec, so a cut one is ended`,
      })
    );
  }

  return ran(runtime, command);
};

const preparationTimeout = Duration.seconds(60);

const guestPath =
  "PATH=$root/usr/local/sbin:$root/usr/local/bin:$root/usr/sbin:$root/usr/bin:$root/sbin:$root/bin";

const brewedPath = `${guestPath}:$root/opt/homebrew/bin`;

const stateDir = "$root/var/lib/clankerbox";

const addingMissingKeys = [
  `if [ "$#" -gt 0 ]; then`,
  "  (",
  `    ${guestPath}`,
  `    sudo -n -u "$login" -H sh -c 'umask 077 && mkdir -p "$HOME/.ssh" && for key do grep -qxF -e "$key" "$HOME/.ssh/authorized_keys" 2>/dev/null || printf "\\n%s\\n" "$key" >>"$HOME/.ssh/authorized_keys" || exit 1; done' clankerbox-keys "$@"`,
  "  ) || {",
  `    echo "couldn't install the authorized keys for $login: the machine's image, from its setup or its template, must have that user, and sudo"`,
  "    exit 1",
  "  }",
  "fi",
];

const sshdDropIn = "$root/etc/ssh/sshd_config.d/10-clankerbox.conf";

const debianBase = [
  "if ! command -v apt-get >/dev/null 2>&1; then",
  `  echo "clankerbox prepares a linux base with apt-get, and this image has none: build on a Debian or Ubuntu image"`,
  "  exit 1",
  "fi",
  "export DEBIAN_FRONTEND=noninteractive",
  `rm -rf "$root/var/lib/apt/lists/"*`,
  "apt-get -o Acquire::Retries=5 -o APT::Update::Error-Mode=any update",
  "apt-get -o Acquire::Retries=5 install -y --no-install-recommends ca-certificates curl openssh-server sudo perl libnss-myhostname",
  `if [ "$joins" = joins ] && ! command -v tailscaled >/dev/null 2>&1; then`,
  `  distro=$(. "$root/etc/os-release" && echo "$ID")`,
  `  codename=$(. "$root/etc/os-release" && echo "$VERSION_CODENAME")`,
  `  curl -fsSL "https://pkgs.tailscale.com/stable/$distro/$codename.noarmor.gpg" -o "$root/usr/share/keyrings/tailscale-archive-keyring.gpg"`,
  `  chmod 0644 "$root/usr/share/keyrings/tailscale-archive-keyring.gpg"`,
  `  curl -fsSL "https://pkgs.tailscale.com/stable/$distro/$codename.tailscale-keyring.list" -o "$root/etc/apt/sources.list.d/tailscale.list"`,
  "  apt-get -o Acquire::Retries=5 -o APT::Update::Error-Mode=any update",
  "  apt-get -o Acquire::Retries=5 install -y --no-install-recommends tailscale",
  "fi",
  // systemd's own test that it booted the system:
  // https://www.freedesktop.org/software/systemd/man/latest/sd_booted.html
  `if [ "$joins" = joins ] && [ -d "$root/run/systemd/system" ] && systemctl cat tailscaled.service >/dev/null 2>&1; then`,
  "  systemctl disable --now tailscaled.service",
  "fi",
  `if ! grep -q "^$login:" "$root/etc/passwd"; then`,
  `  useradd -m -s /bin/bash -U "$login"`,
  "fi",
  `mkdir -p "$root/etc/sudoers.d" "$root/etc/ssh/sshd_config.d"`,
  `printf '%s ALL=(ALL) NOPASSWD: ALL\\n' "$login" >"$root/etc/sudoers.d/clankerbox.new"`,
  `chmod 440 "$root/etc/sudoers.d/clankerbox.new"`,
  `mv -f "$root/etc/sudoers.d/clankerbox.new" "$root/etc/sudoers.d/clankerbox"`,
  `echo 'PermitRootLogin no' >"${sshdDropIn}"`,
];

const macosBase = [
  `if [ "$joins" = joins ] && ! command -v tailscaled >/dev/null 2>&1; then`,
  `  sudo -n -u "$login" -H env HOMEBREW_NO_AUTO_UPDATE=1 "$root/opt/homebrew/bin/brew" install --quiet tailscale`,
  "fi",
];

const baseScripts = { debian: debianBase, macos: macosBase } as const;

const baseScript = (guest: Runtime["guest"]) =>
  [
    "set -eu",
    "login=$1",
    "joins=$2",
    "root=${CLANKERBOX_ROOT-}",
    brewedPath,
    ...baseScripts[guest],
    "",
  ].join("\n");

const baseTimeout = Duration.minutes(10);

/**
 * Makes a base what a setup starts on, by the guest's script: on Debian, the login user with
 * passwordless `sudo` and sshd that refuses root; on macOS, the guest's DNS servers and clock; on
 * both, `tailscale` where the host joins its machines to the tailnet.
 */
export const prepareBase = (
  runtime: Runtime,
  machine: Target,
  joins: boolean
): Effect.Effect<void, RuntimeError | ScriptFailed> =>
  Effect.asVoid(
    runInGuest(
      runtime,
      "preparation",
      machine,
      {
        argv: [
          "/bin/sh",
          "-c",
          baseScript(runtime.guest),
          "clankerbox-base",
          loginUser,
          joins ? "joins" : "nojoin",
        ],
      },
      baseTimeout
    )
  );

// A guest's /dev/shm may be mounted noexec. A kernel gives the rest of a `#!` line to its
// interpreter, on Linux as one argument and on macOS split on blanks, and a script without one
// runs under sh:
// https://man7.org/linux/man-pages/man2/execve.2.html#DESCRIPTION
const setupHeld = [
  "set -eu",
  "kernel=$2",
  `script=$(mktemp "$1/clankerbox-setup.XXXXXX")`,
  `trap "rm -f \\"$script\\"" EXIT`,
  `cat >"$script"`,
  `cd "$HOME"`,
  `IFS= read -r first <"$script" || true`,
  `case "$first" in`,
  `  "#!"*)`,
  "    shebang=${first#??}",
  `    shebang=\${shebang#"\${shebang%%[![:blank:]]*}"}`,
  "    interpreter=${shebang%%[[:blank:]]*}",
  `    argument=\${shebang#"$interpreter"}`,
  `    argument=\${argument#"\${argument%%[![:blank:]]*}"}`,
  `    argument=\${argument%"\${argument##*[![:blank:]]}"}`,
  `    if [ -z "$argument" ]; then set --; elif [ "$kernel" = Linux ]; then set -- "$argument"; else set -f; set -- $argument; set +f; fi`,
  `    "$interpreter" "$@" "$script" </dev/null`,
  "    ;;",
  `  *) /bin/sh "$script" </dev/null ;;`,
  "esac",
].join("\n");

const heldDir = [
  // /dev/shm is a tmpfs, which lives in memory:
  // https://www.kernel.org/doc/html/latest/filesystems/tmpfs.html
  "kernel=$(uname -s)",
  `if [ "$kernel" = Linux ]; then held="$root/dev/shm"; else held="$root/var/tmp"; fi`,
];

const setupRunner = [
  "set -eu",
  "login=$1",
  "shift",
  "root=${CLANKERBOX_ROOT-}",
  ...addingMissingKeys,
  ...heldDir,
  `sudo -n -u "$login" -H env "${markName}=$${markName}" /bin/sh -c '${setupHeld}' clankerbox-setup "$held" "$kernel"`,
  ...addingMissingKeys,
].join("\n");

const unholdScript = [
  "set -eu",
  "root=${CLANKERBOX_ROOT-}",
  ...heldDir,
  `rm -f "$held"/clankerbox-setup.*`,
].join("\n");

const unholdTimeout = Duration.seconds(10);

const unhold = (runtime: Runtime, machine: Target) =>
  runInGuest(
    runtime,
    "setup",
    machine,
    { argv: ["/bin/sh", "-c", unholdScript, "clankerbox-unhold"] },
    unholdTimeout
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `couldn't remove ${machine.name}'s setup script after its setup ended early: ${error.message}`
      )
    )
  );

const keysRunner = [
  "set -eu",
  "login=$1",
  "shift",
  "root=${CLANKERBOX_ROOT-}",
  ...addingMissingKeys,
].join("\n");

const keyLines = (keys: string | undefined) =>
  keys?.split("\n").filter((line) => line.trim() !== "") ?? [];

const defaultSetupTimeoutSeconds = 600;

export const runSetup = (
  runtime: Runtime,
  machine: Target,
  setup: Setup,
  authorizedKeys: string | undefined
): Effect.Effect<void, RuntimeError | ScriptFailed> => {
  const timeout = Duration.seconds(
    setup.timeoutSeconds ?? defaultSetupTimeoutSeconds
  );

  return runInGuest(
    runtime,
    "setup",
    machine,
    {
      argv: [
        "/bin/sh",
        "-c",
        setupRunner,
        "clankerbox-setup",
        loginUser,
        ...keyLines(authorizedKeys),
      ],
      stdin: setup.script,
    },
    timeout
  ).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit) ? Effect.void : unhold(runtime, machine)
    ),
    Effect.asVoid
  );
};

export const addMissingKeys = (
  runtime: Runtime,
  machine: Target,
  authorizedKeys: string
): Effect.Effect<void, RuntimeError | ScriptFailed> =>
  Effect.asVoid(
    runInGuest(
      runtime,
      "preparation",
      machine,
      {
        argv: [
          "/bin/sh",
          "-c",
          keysRunner,
          "clankerbox-keys",
          loginUser,
          ...keyLines(authorizedKeys),
        ],
      },
      preparationTimeout
    )
  );

const hostKeyMarker = "clankerbox-host-key: ";

const tailnetDir = `${stateDir}/tailscale`;

const nodeProcess = [
  `pid=$(cat "${tailnetDir}/tailscaled.pid" 2>/dev/null || true)`,
  `comm=$(cat "$root/proc/$pid/comm" 2>/dev/null || ps -p "$pid" -o comm= 2>/dev/null || true)`,
];

const dropNode = [
  ...nodeProcess,
  `case "$comm" in *tailscaled) kill -9 "$pid" 2>/dev/null || true ;; esac`,
  `rm -rf "${tailnetDir}"`,
];

const resolver = `${stateDir}/resolv.conf`;

// smolvm writes the guest's /etc/resolv.conf again at every exec:
// https://github.com/smol-machines/smolvm/blob/v1.34.1/crates/smolvm-agent/src/storage.rs#L4546
// Tailscale puts its own back only while the overwrites differ and stay under 10 in 5 seconds:
// https://github.com/tailscale/tailscale/blob/v1.104.6/net/dns/direct.go#L511
// and writes in place a file it can't rename, as a bind mount is:
// https://github.com/tailscale/tailscale/blob/v1.104.6/net/dns/direct.go#L270
const ownResolver = [
  `if [ "$(uname -s)" = Linux ] && [ -f "$root/etc/resolv.conf" ] && [ ! -L "$root/etc/resolv.conf" ] && ! mountpoint -q "$root/etc/resolv.conf"; then`,
  `  cat "$root/etc/resolv.conf" >"${resolver}"`,
  `  mount --bind "${resolver}" "$root/etc/resolv.conf"`,
  "fi",
];

const tailnetMarker = "clankerbox-tailnet: ";

export const tailnetScript = [
  "set -eu",
  "hostname=$1",
  "user=$2",
  "joining=${3-}",
  "root=${CLANKERBOX_ROOT-}",
  brewedPath,
  `dir="${tailnetDir}"`,
  String.raw`ts() { tailscale --socket="$dir/tailscaled.sock" "$@"; }`,
  String.raw`status() { ts status --json --peers=false 2>/dev/null | tr -d '\n'; }`,
  String.raw`up() { ts up --reset --hostname="$hostname" $prefs --timeout=60s "$@"; }`,
  // A map request for a node control no longer has fails with its 404, which tailscaled logs, and
  // the node isn't online; the log keeps the line after a later login succeeds:
  // https://github.com/tailscale/tailscale/blob/v1.104.6/control/controlclient/direct.go#L1215
  // https://github.com/tailscale/tailscale/blob/v1.104.6/ipn/ipnlocal/local.go#L1881
  String.raw`lost() { ! status | grep -Eq '"Online": *true' && grep -q 'initial fetch failed 404' "$dir/tailscaled.log" 2>/dev/null; }`,
  "if ! command -v tailscaled >/dev/null 2>&1 || ! command -v tailscale >/dev/null 2>&1; then",
  `  echo '${tailnetMarker}missing'`,
  "  exit 0",
  "fi",
  "prefs=--accept-dns",
  `if [ "$(uname -s)" = Linux ]; then prefs="$prefs --netfilter-mode=off"; fi`,
  `if [ "$joining" = rejoin ]; then`,
  ...dropNode.map((line) => `  ${line}`),
  "fi",
  `mkdir -p "$dir"`,
  `chmod 711 "$dir"`,
  ...ownResolver,
  `if [ "$joining" != join ]; then`,
  ...nodeProcess.map((line) => `  ${line}`),
  // The CLI retries a refused socket for 2 seconds, and up to 5 while any tailscaled runs:
  // https://github.com/tailscale/tailscale/blob/v1.104.4/safesocket/safesocket.go#L43
  "  answering=",
  "  started=",
  `  case "$comm" in *tailscaled) if ts status --json >/dev/null 2>&1; then answering=1; fi ;; esac`,
  `  if [ -z "$answering" ]; then`,
  "    if command -v setsid >/dev/null 2>&1; then detach=setsid; else detach=nohup; fi",
  `    TS_PERMIT_CERT_UID="$user" "$detach" tailscaled --statedir="$dir/state" --socket="$dir/tailscaled.sock" --port=0 </dev/null >"$dir/tailscaled.log" 2>&1 &`,
  "    started=$!",
  `    echo "$started" >"$dir/tailscaled.pid"`,
  "  fi",
  "  waited=0",
  String.raw`  until status | grep -Eq '"BackendState": *"(Running|NeedsLogin|NeedsMachineAuth|Stopped)"' || lost || [ "$waited" -ge 150 ] || { [ -n "$started" ] && ! kill -0 "$started" 2>/dev/null; }; do`,
  "    sleep 0.1",
  "    waited=$((waited + 1))",
  "  done",
  "fi",
  `case "$joining" in`,
  "  join | rejoin)",
  `    key=$(mktemp "$dir/key.XXXXXX")`,
  `    trap 'rm -f "$key"' EXIT`,
  `    cat >"$key"`,
  `    up --auth-key="file:$key"`,
  "    ;;",
  "  *)",
  `    if [ -n "$(status)" ]; then`,
  "      ts set $prefs",
  "    fi",
  "    waited=0",
  String.raw`    while status | grep -Eq '"BackendState": *"Running"' && status | grep -Eq '"Online": *false' && ! lost && [ "$waited" -lt 100 ]; do`,
  "      sleep 0.1",
  "      waited=$((waited + 1))",
  "    done",
  "    if lost; then",
  `      echo '${tailnetMarker}lost'`,
  "      exit 0",
  "    fi",
  "    ;;",
  "esac",
  `printf '${tailnetMarker}%s\\n' "$(status)"`,
  "",
].join("\n");

const dnsBeforeJoin = `${stateDir}/resolv.conf.before-join`;

export const beforeJoinScript = [
  "set -eu",
  "root=${CLANKERBOX_ROOT-}",
  brewedPath,
  `mkdir -p "${stateDir}"`,
  `rm -f "${dnsBeforeJoin}"`,
  `if [ -e "$root/etc/resolv.conf" ]; then`,
  `  cat "$root/etc/resolv.conf" >"${dnsBeforeJoin}"`,
  "fi",
  "",
].join("\n");

const scrubMarker = "clankerbox-scrub: ";

export const scrubScript = [
  "set -eu",
  "root=${CLANKERBOX_ROOT-}",
  brewedPath,
  ...nodeProcess,
  `case "$comm" in *tailscaled)`,
  `  if ! tailscale --socket="${tailnetDir}/tailscaled.sock" logout >/dev/null 2>&1; then`,
  `    echo '${scrubMarker}its logout failed, so its node stays on the tailnet until Tailscale drops it as ephemeral'`,
  "  fi ;;",
  "esac",
  ...dropNode,
  `if [ -e "${dnsBeforeJoin}" ]; then`,
  `  if [ "$(cat "${dnsBeforeJoin}")" != "$(cat "$root/etc/resolv.conf" 2>/dev/null || true)" ]; then`,
  `    if [ "$(uname -s)" = Linux ]; then`,
  `      cat "${dnsBeforeJoin}" >"$root/etc/resolv.conf"`,
  `      echo '${scrubMarker}its /etc/resolv.conf still differed after the logout from what it was before the join, so it is restored'`,
  "    else",
  `      echo '${scrubMarker}its /etc/resolv.conf differs from what it was before the join, and its build keeps it'`,
  "    fi",
  "  fi",
  `  rm -f "${dnsBeforeJoin}"`,
  "fi",
  "",
].join("\n");

export type TailnetReport =
  | { readonly state: "missing" }
  | { readonly state: "lost" }
  | {
      readonly state: "reported";
      readonly backend: string;
      readonly name: string | undefined;
    };

const TailscaleStatus = Schema.fromJsonString(
  Schema.Struct({
    BackendState: Schema.String,
    Self: Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({ DNSName: Schema.optionalKey(Schema.String) })
      )
    ),
  })
);

const decodeStatus = Schema.decodeUnknownOption(TailscaleStatus);

export const tailnetIn = (output: string): TailnetReport | undefined => {
  const line = output
    .split("\n")
    .findLast((candidate) => candidate.startsWith(tailnetMarker))
    ?.slice(tailnetMarker.length)
    .trim();

  if (line === undefined) {
    return undefined;
  }

  if (line === "missing" || line === "lost") {
    return { state: line };
  }

  if (line === "") {
    return { state: "reported", backend: "unreachable", name: undefined };
  }

  return Option.getOrUndefined(
    Option.map(decodeStatus(line), ({ BackendState, Self }): TailnetReport => {
      const name = Self?.DNSName?.replace(/\.$/u, "");

      return {
        state: "reported",
        backend: BackendState,
        name: name === "" ? undefined : name,
      };
    })
  );
};

const keyWanted = "$state/host-key-wanted";

export const unkeyScript = [
  "set -eu",
  "root=${CLANKERBOX_ROOT-}",
  guestPath,
  `state=${stateDir}`,
  `if ls "$root"/etc/ssh/ssh_host_*_key >/dev/null 2>&1; then`,
  `  mkdir -p "$state"`,
  `  : >"${keyWanted}"`,
  `  rm -f "$root"/etc/ssh/ssh_host_*`,
  "fi",
  "",
].join("\n");

export const identityScript = [
  "set -eu",
  "instance=$1",
  "id=$2",
  "root=${CLANKERBOX_ROOT-}",
  guestPath,
  `state=${stateDir}`,
  `if [ "$(cat "$state/instance" 2>/dev/null || true)" != "$instance" ]; then`,
  `  cat >"$root/dev/random"`,
  `  if [ "$(uname -s)" = Linux ]; then`,
  "    if ! command -v perl >/dev/null 2>&1; then",
  `      echo "preparation needs perl, for RNDRESEEDCRNG" >&2`,
  "      exit 1",
  "    fi",
  `    perl -e 'open(my $f, "<", $ARGV[0]) or die "$ARGV[0]: $!\\n"; ioctl($f, 0x5207, 0) or die "RNDRESEEDCRNG: $!\\n"' "$root/dev/urandom"`,
  "  fi",
  ...dropNode.map((line) => `  ${line}`),
  `  if ls "$root"/etc/ssh/ssh_host_*_key >/dev/null 2>&1 || [ -e "${keyWanted}" ]; then`,
  `    rm -f "$root"/etc/ssh/ssh_host_*`,
  `    ssh-keygen -q -t ed25519 -N '' -f "$root/etc/ssh/ssh_host_ed25519_key"`,
  `    rm -f "${keyWanted}"`,
  "  fi",
  `  pid=$(cat "$root/run/sshd.pid" 2>/dev/null || true)`,
  `  if [ -n "$pid" ] && [ "$(cat "$root/proc/$pid/comm" 2>/dev/null || true)" = sshd ]; then`,
  `    kill -HUP "$pid" || true`,
  "  fi",
  `  mkdir -p "$state"`,
  `  printf '%s\\n' "$id" >"$state/machine-id.new"`,
  `  mv "$state/machine-id.new" "$state/machine-id"`,
  `  if [ -e "$root/etc/clankerbox/new-identity" ]; then`,
  `    "$root/etc/clankerbox/new-identity" </dev/null`,
  "  fi",
  `  printf '%s\\n' "$instance" >"$state/instance.new"`,
  `  mv "$state/instance.new" "$state/instance"`,
  "fi",
  "",
].join("\n");

export const startScript = [
  "set -eu",
  "root=${CLANKERBOX_ROOT-}",
  guestPath,
  `if [ -e "${sshdDropIn}" ] && [ -x "$root/usr/sbin/sshd" ]; then`,
  `  mkdir -p "$root/run/sshd"`,
  `  pid=$(cat "$root/run/sshd.pid" 2>/dev/null || true)`,
  `  if [ -z "$pid" ] || [ "$(cat "$root/proc/$pid/comm" 2>/dev/null || true)" != sshd ]; then`,
  `    "$root/usr/sbin/sshd"`,
  "  fi",
  "fi",
  `if [ -e "$root/etc/clankerbox/start" ]; then`,
  `  "$root/etc/clankerbox/start" </dev/null`,
  "fi",
  "for type in ed25519 ecdsa rsa; do",
  '  key="$root/etc/ssh/ssh_host_${type}_key.pub"',
  `  if [ -r "$key" ]; then`,
  `    printf '${hostKeyMarker}%s\\n' "$(cut -d ' ' -f 1,2 "$key")"`,
  "    break",
  "  fi",
  "done",
  "",
].join("\n");

const seedBytes = 64;

const hostKeyPattern = /^[a-z0-9@.-]+ [A-Za-z0-9+/]+={0,3}$/u;

export const hostKeyIn = (output: string): string | undefined => {
  const line = output
    .split("\n")
    .findLast((candidate) => candidate.startsWith(hostKeyMarker))
    ?.slice(hostKeyMarker.length);

  return line !== undefined && hostKeyPattern.test(line) ? line : undefined;
};

export const identify = (
  runtime: Runtime,
  machine: Target
): Effect.Effect<void, RuntimeError | ScriptFailed> =>
  Effect.asVoid(
    runInGuest(
      runtime,
      "preparation",
      machine,
      {
        argv: [
          "/bin/sh",
          "-c",
          identityScript,
          "clankerbox-identity",
          machine.instance,
          machine.name,
        ],
        stdin: Hex.encode(
          globalThis.crypto.getRandomValues(new Uint8Array(seedBytes))
        ),
      },
      preparationTimeout
    )
  );

export const unkey = (
  runtime: Pick<Runtime, "exec">,
  machine: Target
): Effect.Effect<void, RuntimeError | ScriptFailed> =>
  Effect.asVoid(
    runInGuest(
      runtime,
      "preparation",
      machine,
      { argv: ["/bin/sh", "-c", unkeyScript, "clankerbox-unkey"] },
      preparationTimeout
    )
  );

export const prepare = (
  runtime: Runtime,
  machine: Target
): Effect.Effect<string | undefined, RuntimeError | ScriptFailed> =>
  runInGuest(
    runtime,
    "preparation",
    machine,
    { argv: ["/bin/sh", "-c", startScript, "clankerbox-start"] },
    preparationTimeout
  ).pipe(Effect.map(hostKeyIn));

const tailnetTimeout = Duration.seconds(90);

interface TailnetJoin {
  readonly key: Redacted.Redacted;
  readonly rejoin: boolean;
}

export const checkTailnet = (
  runtime: Runtime,
  machine: Target,
  hostname: string,
  join?: TailnetJoin
): Effect.Effect<TailnetReport | undefined, RuntimeError | ScriptFailed> =>
  runInGuest(
    runtime,
    "tailnet",
    machine,
    {
      argv: [
        "/bin/sh",
        "-c",
        tailnetScript,
        "clankerbox-tailnet",
        hostname,
        loginUser,
        ...(join === undefined ? [] : [join.rejoin ? "rejoin" : "join"]),
      ],
      stdin: join === undefined ? undefined : Redacted.value(join.key),
    },
    tailnetTimeout
  ).pipe(Effect.map(tailnetIn));

/** Keeps what the guest resolves names with, so `scrubNode` can put it back after a join. */
export const rememberDns = (
  runtime: Runtime,
  machine: Target
): Effect.Effect<void, RuntimeError | ScriptFailed> =>
  Effect.asVoid(
    runInGuest(
      runtime,
      "tailnet",
      machine,
      { argv: ["/bin/sh", "-c", beforeJoinScript, "clankerbox-dns"] },
      preparationTimeout
    )
  );

/**
 * Logs the guest's node out of the tailnet, drops its state, and on linux puts back the DNS
 * `rememberDns` kept, answering what it couldn't do cleanly.
 */
export const scrubNode = (
  runtime: Runtime,
  machine: Target
): Effect.Effect<readonly string[], RuntimeError | ScriptFailed> =>
  runInGuest(
    runtime,
    "tailnet",
    machine,
    { argv: ["/bin/sh", "-c", scrubScript, "clankerbox-scrub"] },
    tailnetTimeout
  ).pipe(
    Effect.map((output) =>
      output
        .split("\n")
        .filter((line) => line.startsWith(scrubMarker))
        .map((line) => line.slice(scrubMarker.length))
    )
  );

/** What is about to happen to a running VM, each with its hook in `/etc/clankerbox`. */
export type Leaving = "stop" | "pause" | "delete";

const leaveScript = [
  "root=${CLANKERBOX_ROOT-}",
  guestPath,
  "hook=$root/etc/clankerbox/$1",
  `if [ -e "$hook" ] && [ "$(cat "${stateDir}/instance" 2>/dev/null || true)" = "$2" ]; then exec "$hook" </dev/null; fi`,
  "",
].join("\n");

/**
 * Runs the guest's hook for what is about to happen to its VM, if it has one, as root, but only in a
 * guest that has taken this machine's identity: until then a copy is still its source.
 */
export const leave = (
  runtime: Runtime,
  machine: Target,
  leaving: Leaving,
  timeoutSeconds: number
): Effect.Effect<Executed, RuntimeError> =>
  ran(runtime, {
    machine,
    argv: [
      "/bin/sh",
      "-c",
      leaveScript,
      "clankerbox-leave",
      leaving,
      machine.instance,
    ],
    timeoutSeconds,
  });
