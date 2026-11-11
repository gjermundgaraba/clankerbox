import type { ExecCommand } from "@clankerbox/host-contract";
import {
  loginUser,
  outputLimit,
  ScriptFailed,
  timedOutExitCode,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Executed, Kind, Setup } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Option, Redacted, Schema, Stream } from "effect";

import { timeoutFail } from "./runtime.ts";
import type {
  Command,
  Interface as Runtime,
  Native,
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

const drained = (
  runtime: Runtime,
  machine: Native,
  command: Command,
  output: ReturnType<typeof keptOutput>
): Effect.Effect<number, RuntimeError> =>
  Effect.map(
    Effect.scoped(
      Effect.flatMap(runtime.exec(machine, command), (execution) =>
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
  runtime: Runtime,
  script: "setup" | "preparation" | "tailnet",
  machine: Native,
  command: Command,
  timeout: Duration.Duration
): Effect.Effect<string, RuntimeError | ScriptFailed> =>
  Effect.gen(function* () {
    const output = keptOutput();

    const code = yield* drained(runtime, machine, command, output).pipe(
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

export const runCommand = (
  runtime: Runtime,
  {
    machine,
    argv,
    user,
    env,
    stdin,
    timeoutSeconds,
  }: Omit<ExecCommand, "machine"> & { readonly machine: Native }
): Effect.Effect<Executed, RuntimeError> =>
  Effect.gen(function* () {
    const output = keptOutput();

    const pairs = Object.entries(env ?? {}).map(
      ([name, value]) => `${name}=${value}`
    );

    const drain = drained(
      runtime,
      machine,
      {
        argv: pairs.length === 0 ? argv : ["env", ...pairs, ...argv],
        user,
        stdin:
          stdin === undefined ? undefined : new TextEncoder().encode(stdin),
      },
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

const linuxBase = [
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
  `if ! grep -q "^$login:" "$root/etc/passwd"; then`,
  `  useradd -m -s /bin/bash -U "$login"`,
  "fi",
  `mkdir -p "$root/etc/sudoers.d" "$root/etc/ssh/sshd_config.d"`,
  `printf '%s ALL=(ALL) NOPASSWD: ALL\\n' "$login" >"$root/etc/sudoers.d/clankerbox.new"`,
  `chmod 440 "$root/etc/sudoers.d/clankerbox.new"`,
  `mv -f "$root/etc/sudoers.d/clankerbox.new" "$root/etc/sudoers.d/clankerbox"`,
  `echo 'PermitRootLogin no' >"${sshdDropIn}"`,
];

const macBase = [
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

const baseScript = (kind: Kind) =>
  [
    "set -eu",
    "login=$1",
    "joins=$2",
    "root=${CLANKERBOX_ROOT-}",
    brewedPath,
    ...(kind === "linux" ? linuxBase : macBase),
    "",
  ].join("\n");

const baseTimeout = Duration.minutes(10);

/**
 * Makes a base what a setup starts on: the login user with passwordless `sudo`, sshd that refuses
 * root, and `tailscale` where the host joins its machines to the tailnet.
 */
export const prepareBase = (
  runtime: Runtime,
  machine: Native,
  kind: Kind,
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
          baseScript(kind),
          "clankerbox-base",
          loginUser,
          joins ? "joins" : "",
        ],
      },
      baseTimeout
    )
  );

const setupRunner = [
  "set -eu",
  "login=$1",
  "shift",
  "root=${CLANKERBOX_ROOT-}",
  ...addingMissingKeys,
  `sudo -n -u "$login" -H /bin/sh -c 'script=$(mktemp /var/tmp/clankerbox-setup.XXXXXX) && trap "rm -f \\"$script\\"" EXIT && cat >"$script" && chmod 700 "$script" && cd "$HOME" && "$script" </dev/null'`,
  ...addingMissingKeys,
].join("\n");

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
  machine: Native,
  setup: Setup,
  authorizedKeys: string | undefined
): Effect.Effect<void, RuntimeError | ScriptFailed> => {
  const timeout = Duration.seconds(
    setup.timeoutSeconds ?? defaultSetupTimeoutSeconds
  );

  return Effect.asVoid(
    runInGuest(
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
        stdin: new TextEncoder().encode(setup.script),
      },
      timeout
    )
  );
};

export const addMissingKeys = (
  runtime: Runtime,
  machine: Native,
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

const tailnetMarker = "clankerbox-tailnet: ";

export const tailnetScript = [
  "set -eu",
  "hostname=$1",
  "user=$2",
  "root=${CLANKERBOX_ROOT-}",
  brewedPath,
  `dir="${tailnetDir}"`,
  String.raw`ts() { tailscale --socket="$dir/tailscaled.sock" "$@"; }`,
  String.raw`status() { ts status --json --peers=false 2>/dev/null | tr -d '\n'; }`,
  String.raw`up() { ts up --reset --hostname="$hostname" $prefs --timeout=60s "$@"; }`,
  "if ! command -v tailscaled >/dev/null 2>&1 || ! command -v tailscale >/dev/null 2>&1; then",
  `  echo '${tailnetMarker}missing'`,
  "  exit 0",
  "fi",
  "prefs=--accept-dns",
  `if [ "$(uname -s)" = Linux ]; then prefs="$prefs --netfilter-mode=off"; fi`,
  `mkdir -p "$dir"`,
  `chmod 711 "$dir"`,
  `if [ "\${3-}" = join ]; then`,
  `  key=$(mktemp "$dir/key.XXXXXX")`,
  `  trap 'rm -f "$key"' EXIT`,
  `  cat >"$key"`,
  `  up --auth-key="file:$key"`,
  "else",
  ...nodeProcess.map((line) => `  ${line}`),
  // The CLI retries a refused socket for 2 seconds, and up to 5 while any tailscaled runs:
  // https://github.com/tailscale/tailscale/blob/v1.104.4/safesocket/safesocket.go#L43
  "  answering=",
  `  case "$comm" in *tailscaled) if ts status --json >/dev/null 2>&1; then answering=1; fi ;; esac`,
  `  if [ -z "$answering" ]; then`,
  "    if command -v setsid >/dev/null 2>&1; then detach=setsid; else detach=nohup; fi",
  `    TS_PERMIT_CERT_UID="$user" "$detach" tailscaled --statedir="$dir/state" --socket="$dir/tailscaled.sock" --port=0 </dev/null >"$dir/tailscaled.log" 2>&1 &`,
  `    echo "$!" >"$dir/tailscaled.pid"`,
  "  fi",
  "  waited=0",
  String.raw`  until status | grep -Eq '"BackendState": *"(Running|NeedsLogin|NeedsMachineAuth|Stopped)"' || [ "$waited" -ge 150 ]; do`,
  "    sleep 0.1",
  "    waited=$((waited + 1))",
  "  done",
  `  if [ -n "$(status)" ]; then`,
  "    ts set $prefs",
  "  fi",
  "fi",
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
  | { readonly missing: true }
  | {
      readonly missing: false;
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

  if (line === "missing") {
    return { missing: true };
  }

  if (line === "") {
    return { missing: false, backend: "unreachable", name: undefined };
  }

  return Option.getOrUndefined(
    Option.map(decodeStatus(line), ({ BackendState, Self }): TailnetReport => {
      const name = Self?.DNSName?.replace(/\.$/u, "");

      return {
        missing: false,
        backend: BackendState,
        name: name === "" ? undefined : name,
      };
    })
  );
};

const keyWanted = "$state/host-key-wanted";

// https://github.com/smol-machines/smolvm/blob/v1.34.1/src/agent/fork.rs#L3781
/**
 * Runs just before a build is captured. Its copies then hold no host key, so smolvm's re-mint of
 * each skips `ssh-keygen -A`, and their new identity mints the one key each keeps.
 */
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
  machine: Native
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
        stdin: globalThis.crypto.getRandomValues(new Uint8Array(seedBytes)),
      },
      preparationTimeout
    )
  );

export const unkey = (
  runtime: Runtime,
  machine: Native
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
  machine: Native
): Effect.Effect<string | undefined, RuntimeError | ScriptFailed> =>
  runInGuest(
    runtime,
    "preparation",
    machine,
    { argv: ["/bin/sh", "-c", startScript, "clankerbox-start"] },
    preparationTimeout
  ).pipe(Effect.map(hostKeyIn));

const tailnetTimeout = Duration.seconds(90);

export const checkTailnet = (
  runtime: Runtime,
  machine: Native,
  hostname: string,
  key?: Redacted.Redacted
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
        ...(key === undefined ? [] : ["join"]),
      ],
      stdin:
        key === undefined
          ? undefined
          : new TextEncoder().encode(Redacted.value(key)),
    },
    tailnetTimeout
  ).pipe(Effect.map(tailnetIn));

/** Keeps what the guest resolves names with, so `scrubNode` can put it back after a join. */
export const rememberDns = (
  runtime: Runtime,
  machine: Native
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
  machine: Native
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
  `if [ -e "$root/etc/clankerbox/$1" ]; then exec "$root/etc/clankerbox/$1" </dev/null; fi`,
  "",
].join("\n");

/** Runs the guest's hook for what is about to happen to its VM, if it has one, as root. */
export const leave = (
  runtime: Runtime,
  machine: Native,
  leaving: Leaving,
  timeoutSeconds: number
): Effect.Effect<Executed, RuntimeError> =>
  runCommand(runtime, {
    machine,
    argv: ["/bin/sh", "-c", leaveScript, "clankerbox-leave", leaving],
    timeoutSeconds,
  });
