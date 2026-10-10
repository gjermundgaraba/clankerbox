/**
 * Setup and preparation: host-side scripts run over `Runtime.exec`, as root in the guest, with
 * no runtime cases. Nothing here logs a script: setup can carry secrets, and preparation's
 * seed is fresh randomness. Errors carry a script's output, never its text.
 */
import { randomBytes } from "node:crypto";
import { type HostError, Precondition, type Setup } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Stream } from "effect";
import { type Command, type MachineRef, Runtime, timeoutFail } from "./runtime.ts";

/** How much of a script's output an error carries: its last lines, and at most this many characters. */
const tailLines = 20;

const tailCharacters = 4000;

/**
 * How much output the tail buffer keeps. `lastLines` trims trailing whitespace before it cuts,
 * so the buffer holds more than it returns: output that ends in up to 12000 characters of
 * whitespace still gives a full tail, and more only gives a shorter one.
 */
const keptCharacters = 4 * tailCharacters;

/** The end of some output, as an error carries it: its last lines, without a trailing newline. */
export const lastLines = (text: string): string =>
  text.trimEnd().split("\n").slice(-tailLines).join("\n").slice(-tailCharacters);

/** Keeps the end of a stream of output, so a long setup's log never piles up in memory. */
const outputTail = () => {
  const decoder = new TextDecoder();
  let kept = "";

  return {
    push: (chunk: Uint8Array) => {
      kept = (kept + decoder.decode(chunk, { stream: true })).slice(-keptCharacters);
    },
    /** The last lines, without a trailing newline. */
    text: () => lastLines(kept + decoder.decode()),
  };
};

/**
 * Runs `command` in the guest, keeping its output's tail, and returns that tail. A run past
 * `timeout`, or a non-zero exit, fails the action with the tail; `what` names the script.
 */
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
 * Runs a setup script that arrives on stdin, so it never appears in a process list. It runs
 * as its own file, honouring its `#!` line, with stdin closed. The file is under `/var/tmp`,
 * which nothing mounts `noexec`, and the exit trap removes it when the shell exits. A killed
 * exec (a timeout, or a host crash) may leave it: smolvm SIGKILLs the guest command and every
 * process descended from it, so no trap runs (seen live; the bump-smolvm skill).
 */
const setupRunner = [
  "set -eu",
  "script=$(mktemp /var/tmp/clankerbox-setup.XXXXXX)",
  `trap 'rm -f "$script"' EXIT`,
  `cat >"$script"`,
  `chmod 700 "$script"`,
  `"$script" </dev/null`,
].join("\n");

/** How long a setup may run when its create doesn't say. */
const defaultSetupTimeoutSeconds = 600;

/** Runs the create request's setup once, after the first boot and before preparation. */
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

/** Precedes the host key on preparation's output. */
const hostKeyMarker = "clankerbox-host-key: ";

/**
 * Preparation, run after every create, start, fork and restore. Its arguments
 * are the row's instance and the machine's ID; a fresh random seed arrives on stdin.
 *
 * 1. Identity, when `/var/lib/clankerbox/instance` isn't the row's instance: reseed the kernel
 *    RNG first (the seed into `/dev/random`, then `RNDRESEEDCRNG` on Linux through `perl`,
 *    as a RAM restore clones the guest's CRNG); re-mint the SSH host keys if there are any;
 *    make a running sshd load them; write the machine ID; run the `new-identity` hook; and
 *    write the instance last, so a crash before it repeats these steps.
 * 2. `/etc/clankerbox/start`, if it exists, on every activation.
 * 3. The SSH host public key, if there is one, after a marker.
 *
 * sshd re-executes itself on SIGHUP, which loads the new keys and keeps its listener under
 * whatever launched it: a `start` script, or boat's systemd unit. `/proc/<pid>/comm` guards
 * against a stale pid file; macOS has no `/run/sshd.pid`, as launchd starts sshd per
 * connection. `CLANKERBOX_ROOT` is unset in a guest; tests run the script against a
 * temporary directory as the root, so the directories it adds to `PATH` are under it too.
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
 * Bounds the whole of preparation. P3 measured at most 0.55 s for a re-mint plus an sshd
 * restart and 1.52 s for a `start` with a clankercreds sync right after a cold start; 60 s
 * leaves room for a slow network.
 */
const preparationTimeout = Duration.seconds(60);

/** The seed preparation writes into the guest's `/dev/random`, as `RNDRESEEDCRNG` expects. */
const seedBytes = 64;

const hostKeyPattern = /^[a-z0-9@.-]+ [A-Za-z0-9+/]+={0,3}$/u;

/** The host key preparation printed last, if it printed one. */
export const hostKeyIn = (output: string): string | undefined => {
  const line = output
    .split("\n")
    .findLast((candidate) => candidate.startsWith(hostKeyMarker))
    ?.slice(hostKeyMarker.length);

  return line !== undefined && hostKeyPattern.test(line) ? line : undefined;
};

/** Runs preparation and returns the guest's SSH host public key, if it has one. */
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
      stdin: randomBytes(seedBytes),
    },
    preparationTimeout,
  ).pipe(Effect.map(hostKeyIn));
