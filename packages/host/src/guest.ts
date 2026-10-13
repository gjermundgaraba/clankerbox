/**
 * Nothing here logs a script: setup can carry secrets, and preparation's seed is fresh
 * randomness. Errors carry a script's output, never its text.
 */
import { type HostError, Precondition, type Setup } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Stream } from "effect";
import { type Command, type MachineRef, Runtime, timeoutFail } from "./runtime.ts";

const tailLines = 20;

const tailCharacters = 4000;

/**
 * `lastLines` trims trailing whitespace before it cuts, so output that ends in up to 12000
 * characters of whitespace still gives a full tail.
 */
const keptCharacters = 4 * tailCharacters;

export const lastLines = (text: string): string =>
  text.trimEnd().split("\n").slice(-tailLines).join("\n").slice(-tailCharacters);

const outputTail = () => {
  const decoder = new TextDecoder();
  let kept = "";

  return {
    push: (chunk: Uint8Array) => {
      kept = (kept + decoder.decode(chunk, { stream: true })).slice(-keptCharacters);
    },
    text: () => lastLines(kept + decoder.decode()),
  };
};

const runInGuest = (
  what: string,
  machine: MachineRef,
  command: Command,
  timeout: Duration.Duration,
): Effect.Effect<string, HostError, Runtime> =>
  Effect.gen(function* () {
    const runtime = yield* Runtime;
    const tail = outputTail();

    const [, code] = yield* Effect.scoped(
      Effect.flatMap(runtime.exec(machine, command), (execution) =>
        Effect.all(
          [
            Stream.runForEach(execution.output, (chunk) => Effect.sync(() => tail.push(chunk))),
            execution.exitCode,
          ],
          { concurrency: "unbounded" },
        ),
      ),
    ).pipe(
      timeoutFail(
        timeout,
        () =>
          new Precondition({
            message: `${what} ran past its ${Duration.format(timeout)} timeout; its last output:\n${tail.text()}`,
          }),
      ),
    );

    const output = tail.text();

    if (code !== 0) {
      return yield* new Precondition({
        message: `${what} exited ${code}; its last output:\n${output}`,
      });
    }

    return output;
  });

/**
 * The script arrives on stdin, so it never appears in a process list. `/var/tmp` is never
 * mounted `noexec`. A killed exec may leave the file: smolvm SIGKILLs the guest command and its
 * descendants, so no trap runs (seen live; the bump-smolvm skill).
 */
const setupRunner = [
  "set -eu",
  "script=$(mktemp /var/tmp/clankerbox-setup.XXXXXX)",
  `trap 'rm -f "$script"' EXIT`,
  `cat >"$script"`,
  `chmod 700 "$script"`,
  `"$script" </dev/null`,
].join("\n");

const defaultSetupTimeoutSeconds = 600;

export const runSetup = (
  machine: MachineRef,
  setup: Setup,
): Effect.Effect<void, HostError, Runtime> => {
  const timeout = Duration.seconds(setup.timeoutSeconds ?? defaultSetupTimeoutSeconds);

  return Effect.asVoid(
    runInGuest(
      "setup",
      machine,
      { argv: ["/bin/sh", "-c", setupRunner], stdin: new TextEncoder().encode(setup.script) },
      timeout,
    ),
  );
};

const hostKeyMarker = "clankerbox-host-key: ";

/**
 * The kernel RNG is reseeded first, as a RAM restore clones the guest's CRNG. The instance is
 * written last, so a crash before it repeats the identity steps. sshd re-executes itself on
 * SIGHUP, which loads the new keys and keeps its listener under whatever launched it;
 * `/proc/<pid>/comm` guards against a stale pid file, and macOS has no `/run/sshd.pid`, as
 * launchd starts sshd per connection. Tests set `CLANKERBOX_ROOT` to a temporary root.
 */
export const preparationScript = [
  "set -eu",
  "instance=$1",
  "id=$2",
  "root=${CLANKERBOX_ROOT-}",
  "PATH=$PATH:$root/usr/local/sbin:$root/usr/local/bin:$root/usr/sbin:$root/usr/bin:$root/sbin:$root/bin",
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

/**
 * P3 measured at most 0.55 s for a re-mint plus an sshd restart and 1.52 s for a `start` with a
 * clankercreds sync after a cold start; 60 s leaves room for a slow network.
 */
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
  machine: MachineRef,
): Effect.Effect<string | undefined, HostError, Runtime> =>
  runInGuest(
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
