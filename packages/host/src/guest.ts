import { ScriptFailed, type Setup } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Option, Redacted, Schema, Stream } from "effect";
import {
  type Command,
  type Interface as Runtime,
  type MachineRef,
  type RuntimeError,
  timeoutFail,
} from "./runtime.ts";

const tailLines = 20;

const tailCharacters = 4000;

const keptCharacters = 64 * 1024;

export const lastLines = (text: string): string =>
  text.trimEnd().split("\n").slice(-tailLines).join("\n").slice(-tailCharacters);

const keptOutput = () => {
  const decoder = new TextDecoder();
  let kept = "";

  return {
    push: (chunk: Uint8Array) => {
      kept = (kept + decoder.decode(chunk, { stream: true })).slice(-keptCharacters);
    },
    text: () => kept + decoder.decode(),
  };
};

const runInGuest = (
  runtime: Runtime,
  script: "setup" | "preparation" | "tailnet",
  machine: MachineRef,
  command: Command,
  timeout: Duration.Duration,
): Effect.Effect<string, RuntimeError | ScriptFailed> =>
  Effect.gen(function* () {
    const output = keptOutput();

    const [, code] = yield* Effect.scoped(
      Effect.flatMap(runtime.exec(machine, command), (execution) =>
        Effect.all(
          [
            Stream.runForEach(execution.output, (chunk) => Effect.sync(() => output.push(chunk))),
            execution.exitCode,
          ],
          { concurrency: "unbounded" },
        ),
      ),
    ).pipe(
      timeoutFail(
        timeout,
        () =>
          new ScriptFailed({
            message: `${script} ran past its ${Duration.format(timeout)} timeout; its last output:\n${lastLines(output.text())}`,
            script,
          }),
      ),
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

const setupRunner = [
  "set -eu",
  "login=$1",
  "root=${CLANKERBOX_ROOT-}",
  "script=$(mktemp /var/tmp/clankerbox-setup.XXXXXX)",
  `trap 'rm -f "$script"' EXIT`,
  `cat >"$script"`,
  `chmod 700 "$script"`,
  `"$script" </dev/null`,
  `if [ "$#" -gt 1 ]; then`,
  "  (",
  "    PATH=$root/usr/local/sbin:$root/usr/local/bin:$root/usr/sbin:$root/usr/bin:$root/sbin:$root/bin",
  `    sudo -n -u "$login" -H sh -c 'umask 077 && mkdir -p "$HOME/.ssh" && printf "\\n%s\\n" "$1" >>"$HOME/.ssh/authorized_keys"' clankerbox-keys "$2"`,
  "  ) || {",
  `    echo "couldn't install the authorized keys for $login: setup must leave that user, and sudo"`,
  "    exit 1",
  "  }",
  "fi",
].join("\n");

const defaultSetupTimeoutSeconds = 600;

export const runSetup = (
  runtime: Runtime,
  machine: MachineRef,
  setup: Setup,
): Effect.Effect<void, RuntimeError | ScriptFailed> => {
  const timeout = Duration.seconds(setup.timeoutSeconds ?? defaultSetupTimeoutSeconds);
  const keys = setup.authorizedKeys === undefined ? [] : [setup.authorizedKeys];

  return Effect.asVoid(
    runInGuest(
      runtime,
      "setup",
      machine,
      {
        argv: ["/bin/sh", "-c", setupRunner, "clankerbox-setup", runtime.loginUser, ...keys],
        stdin: new TextEncoder().encode(setup.script),
      },
      timeout,
    ),
  );
};

const hostKeyMarker = "clankerbox-host-key: ";

const tailnetDir = "$root/var/lib/clankerbox/tailscale";

const dropNode = [
  `pid=$(cat "${tailnetDir}/tailscaled.pid" 2>/dev/null || true)`,
  `comm=$(cat "$root/proc/$pid/comm" 2>/dev/null || ps -p "$pid" -o comm= 2>/dev/null || true)`,
  `case "$comm" in *tailscaled) kill -9 "$pid" 2>/dev/null || true ;; esac`,
  `rm -rf "${tailnetDir}"`,
];

const tailnetMarker = "clankerbox-tailnet: ";

export const tailnetScript = [
  "set -eu",
  "hostname=$1",
  "root=${CLANKERBOX_ROOT-}",
  "PATH=$root/usr/local/sbin:$root/usr/local/bin:$root/usr/sbin:$root/usr/bin:$root/sbin:$root/bin:$root/opt/homebrew/bin",
  `dir="${tailnetDir}"`,
  String.raw`ts() { tailscale --socket="$dir/tailscaled.sock" "$@"; }`,
  String.raw`status() { ts status --json --peers=false 2>/dev/null | tr -d '\n'; }`,
  String.raw`up() { ts up --reset --hostname="$hostname" --accept-dns=false --timeout=60s "$@"; }`,
  "if ! command -v tailscaled >/dev/null 2>&1 || ! command -v tailscale >/dev/null 2>&1; then",
  `  echo '${tailnetMarker}missing'`,
  "  exit 0",
  "fi",
  `mkdir -p "$dir"`,
  `chmod 700 "$dir"`,
  `if [ "\${2-}" = join ]; then`,
  `  key=$(mktemp "$dir/key.XXXXXX")`,
  `  trap 'rm -f "$key"' EXIT`,
  `  cat >"$key"`,
  `  up --auth-key="file:$key"`,
  "else",
  `  if ! ts status --json >/dev/null 2>&1; then`,
  "    if command -v setsid >/dev/null 2>&1; then detach=setsid; else detach=nohup; fi",
  `    "$detach" tailscaled --tun=userspace-networking --statedir="$dir/state" --socket="$dir/tailscaled.sock" --port=0 </dev/null >"$dir/tailscaled.log" 2>&1 &`,
  `    echo "$!" >"$dir/tailscaled.pid"`,
  "  fi",
  "  waited=0",
  String.raw`  until status | grep -Eq '"BackendState": *"(Running|NeedsLogin|NeedsMachineAuth|Stopped)"' || [ "$waited" -ge 150 ]; do`,
  "    sleep 0.1",
  "    waited=$((waited + 1))",
  "  done",
  "fi",
  `printf '${tailnetMarker}%s\\n' "$(status)"`,
  "",
].join("\n");

/** What the tailnet script reported: no `tailscaled`, or its backend state and MagicDNS name. */
export type TailnetReport =
  | { readonly missing: true }
  | { readonly missing: false; readonly backend: string; readonly name: string | undefined };

const TailscaleStatus = Schema.fromJsonString(
  Schema.Struct({
    BackendState: Schema.String,
    Self: Schema.optionalKey(
      Schema.NullOr(Schema.Struct({ DNSName: Schema.optionalKey(Schema.String) })),
    ),
  }),
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

  return Option.match(decodeStatus(line), {
    onNone: () => undefined,
    onSome: ({ BackendState, Self }) => ({
      missing: false,
      backend: BackendState,
      name: Self?.DNSName?.replace(/\.$/u, "") || undefined,
    }),
  });
};

export const preparationScript = [
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
  "    ssh-keygen -A >/dev/null",
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

const preparationTimeout = Duration.seconds(60);

const seedBytes = 64;

const hostKeyPattern = /^[a-z0-9@.-]+ [A-Za-z0-9+/]+={0,3}$/u;

export const hostKeyIn = (output: string): string | undefined => {
  const line = output
    .split("\n")
    .findLast((candidate) => candidate.startsWith(hostKeyMarker))
    ?.slice(hostKeyMarker.length);

  return line !== undefined && hostKeyPattern.test(line) ? line : undefined;
};

export const prepare = (
  runtime: Runtime,
  machine: MachineRef,
): Effect.Effect<string | undefined, RuntimeError | ScriptFailed> =>
  runInGuest(
    runtime,
    "preparation",
    machine,
    {
      argv: [
        "/bin/sh",
        "-c",
        preparationScript,
        "clankerbox-prepare",
        machine.instance,
        machine.id,
      ],
      stdin: globalThis.crypto.getRandomValues(new Uint8Array(seedBytes)),
    },
    preparationTimeout,
  ).pipe(Effect.map(hostKeyIn));

const tailnetTimeout = Duration.seconds(90);

export const checkTailnet = (
  runtime: Runtime,
  machine: MachineRef,
  hostname: string,
  key?: Redacted.Redacted<string>,
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
        ...(key === undefined ? [] : ["join"]),
      ],
      stdin: key === undefined ? undefined : new TextEncoder().encode(Redacted.value(key)),
    },
    tailnetTimeout,
  ).pipe(Effect.map(tailnetIn));
