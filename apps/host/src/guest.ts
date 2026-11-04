import type { ExecCommand } from "@clankerbox/host-contract";
import {
  loginUser,
  outputLimit,
  ScriptFailed,
  timedOutExitCode,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Executed, Setup } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Option, Redacted, Schema, Stream } from "effect";

import { timeoutFail } from "./runtime.ts";
import type {
  Command,
  Interface as Runtime,
  MachineRef,
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
  machine: MachineRef,
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
  machine: MachineRef,
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
  { machine, argv, user, env, stdin, timeoutSeconds }: ExecCommand
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

const addingMissingKeys = [
  `if [ "$#" -gt 0 ]; then`,
  "  (",
  "    PATH=$root/usr/local/sbin:$root/usr/local/bin:$root/usr/sbin:$root/usr/bin:$root/sbin:$root/bin",
  `    sudo -n -u "$login" -H sh -c 'umask 077 && mkdir -p "$HOME/.ssh" && for key do grep -qxF -e "$key" "$HOME/.ssh/authorized_keys" 2>/dev/null || printf "\\n%s\\n" "$key" >>"$HOME/.ssh/authorized_keys" || exit 1; done' clankerbox-keys "$@"`,
  "  ) || {",
  `    echo "couldn't install the authorized keys for $login: the machine's image, from its setup or its prebuild, must have that user, and sudo"`,
  "    exit 1",
  "  }",
  "fi",
];

const setupRunner = [
  "set -eu",
  "login=$1",
  "shift",
  "root=${CLANKERBOX_ROOT-}",
  "script=$(mktemp /var/tmp/clankerbox-setup.XXXXXX)",
  `trap 'rm -f "$script"' EXIT`,
  `cat >"$script"`,
  `chmod 700 "$script"`,
  `"$script" </dev/null`,
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
  machine: MachineRef,
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
  machine: MachineRef,
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

const tailnetDir = "$root/var/lib/clankerbox/tailscale";

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
  "PATH=$root/usr/local/sbin:$root/usr/local/bin:$root/usr/sbin:$root/usr/bin:$root/sbin:$root/bin:$root/opt/homebrew/bin",
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

export const identityScript = [
  "set -eu",
  "instance=$1",
  "id=$2",
  "root=${CLANKERBOX_ROOT-}",
  "PATH=$root/usr/local/sbin:$root/usr/local/bin:$root/usr/sbin:$root/usr/bin:$root/sbin:$root/bin",
  "state=$root/var/lib/clankerbox",
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
  `  if ls "$root"/etc/ssh/ssh_host_*_key >/dev/null 2>&1; then`,
  `    rm -f "$root"/etc/ssh/ssh_host_*`,
  `    ssh-keygen -q -t ed25519 -N '' -f "$root/etc/ssh/ssh_host_ed25519_key"`,
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
  "PATH=$root/usr/local/sbin:$root/usr/local/bin:$root/usr/sbin:$root/usr/bin:$root/sbin:$root/bin",
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
  machine: MachineRef
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

export const prepare = (
  runtime: Runtime,
  machine: MachineRef
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
  machine: MachineRef,
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
