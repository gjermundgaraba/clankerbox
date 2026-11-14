import type { ExecCommand } from "@clankerbox/host-contract";
import {
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
  readonly timeoutSeconds?: number | undefined;
}

const killGraceSeconds = 5;

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
// A timed command runs under the guest's `timeout`, if it takes `-k`. GNU's, BSD's and uutils'
// send TERM to the process group they run the command in, so its children end too; busybox's,
// which takes `-k` from 1.35, signals the command alone:
// https://github.com/coreutils/coreutils/blob/v9.5/src/timeout.c#L239
// https://github.com/mirror/busybox/blob/1_36_0/coreutils/timeout.c#L130
const launcher = [
  "set -e",
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
  "read -r values pairs limit",
  "timed=",
  `if [ "$limit" -gt 0 ] && timeout -k 1 -- 1 true >/dev/null 2>&1; then timed="timeout -k ${killGraceSeconds} -- $limit"; fi`,
  `if [ "$pairs" -eq 0 ]; then set -- $timed; else set --; fi`,
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
  `  if [ "$i" -eq "$pairs" ]; then part="$part $timed"; fi`,
  "  case $j in *00) held=$held$part part= ;; esac",
  `  if [ "$j" -eq 1000 ] || [ "$i" -eq "$values" ]; then`,
  `    eval "set -- \\"\\$@\\"$held$part"`,
  "    j=0 held= part=",
  "  fi",
  "done",
  `if [ -n "$timed" ]; then skip=5; else skip=0; fi`,
  `eval "first=\\\${$((pairs + skip + 1))}"`,
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
 * runs the command, whatever the guest's `/bin/sh` makes of its own special names.
 */
export const guestCommand = ({
  argv,
  env,
  user,
  stdin,
  timeoutSeconds,
}: Invocation): Command => {
  const values = [
    ...Object.entries(env ?? {}).map(([name, value]) => `${name}=${value}`),
    ...argv,
  ];

  return {
    argv: ["/bin/sh", "-c", launcher, "clankerbox"],
    user,
    stdin: [
      `${values.length} ${values.length - argv.length} ${timeoutSeconds ?? 0}\n`,
      ...values.map((value) => `${value.split("\n").length} ${value}\n`),
      stdin ?? "",
    ].join(""),
  };
};

const drained = (
  runtime: Pick<Runtime, "exec">,
  machine: Target,
  invocation: Invocation,
  output: ReturnType<typeof keptOutput>
): Effect.Effect<number, RuntimeError> =>
  Effect.map(
    Effect.scoped(
      Effect.flatMap(
        runtime.exec(machine, guestCommand(invocation)),
        (execution) =>
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
          )
      )
    ),
    ([, exitCode]) => exitCode
  );

const runInGuest = (
  runtime: Pick<Runtime, "exec">,
  script: "setup" | "preparation" | "tailnet",
  machine: Target,
  invocation: Invocation,
  timeout: Duration.Duration
): Effect.Effect<string, RuntimeError | ScriptFailed> =>
  Effect.gen(function* () {
    const output = keptOutput();

    const code = yield* drained(runtime, machine, invocation, output).pipe(
      timeoutFail(
        timeout,
        () =>
          new ScriptFailed({
            message: `${script} ran past its ${Duration.format(timeout)} timeout; its last output:\n${lastLines(output.text())}`,
            script,
          })
      )
    );

    const text = output.text();

    if (code !== 0) {
      return yield* new ScriptFailed({
        message: `${script} exited ${code}; its last output:\n${lastLines(text)}`,
        script,
      });
    }

    return text;
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

    const drain = drained(
      runtime,
      machine,
      { argv, env, user, stdin, timeoutSeconds },
      output
    );

    const exitCode =
      timeoutSeconds === undefined
        ? yield* drain
        : yield* Effect.timeoutOrElse(drain, {
            duration: Duration.seconds(timeoutSeconds),
            orElse: () => Effect.succeed(timedOutExitCode),
          });

    return { exitCode, output: output.text(), truncated: output.truncated() };
  });

/** Runs a caller's command, refusing one that holds a NUL, which no process takes, as `Invalid`. */
export const runCommand = (
  runtime: Runtime,
  command: GuestCommand
): Effect.Effect<Executed, Invalid | RuntimeError> =>
  [...command.argv, ...Object.values(command.env ?? {})].some((value) =>
    value.includes("\0")
  )
    ? Effect.fail(
        new Invalid({
          message:
            "a command's arguments and environment can't hold a NUL character, which no process takes",
        })
      )
    : ran(runtime, command);

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
  "networksetup -listallnetworkservices | while IFS= read -r service; do",
  `  case "$service" in "An asterisk"*) continue ;; esac`,
  '  networksetup -setdnsservers "${service#\\*}" 1.1.1.1 9.9.9.9',
  "done",
  "systemsetup -setnetworktimeserver time.apple.com >/dev/null 2>&1 || true",
  "tries=24",
  String.raw`until sntp time.apple.com 2>/dev/null | awk '/\+\/-/ { offset = $1 } END { exit !(offset != "" && offset > -2 && offset < 2) }'; do`,
  "  tries=$((tries - 1))",
  `  if [ "$tries" -le 0 ]; then`,
  `    echo "the clock is still more than 2 seconds off time.apple.com"`,
  "    exit 1",
  "  fi",
  "  sleep 5",
  "done",
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
  `sudo -n -u "$login" -H /bin/sh -c '${setupHeld}' clankerbox-setup "$held" "$kernel"`,
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
