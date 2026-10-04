/**
 * Setup and preparation: host-side scripts run over `Runtime.exec`, as root in the guest, with
 * no runtime cases. Nothing here logs a script: setup can carry secrets, and preparation's
 * seed is fresh randomness. Errors carry a script's output, never its text.
 */
import { randomBytes } from "node:crypto";
import { type HostError, Precondition, type Setup } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Option, Stream } from "effect";
import { type Command, type MachineRef, Runtime } from "./runtime.ts";

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

/** How a script run in the guest ended. */
interface Ran {
  /** The exit code, or none when the script ran past its timeout. */
  readonly exitCode: Option.Option<number>;
  /** The last lines of its output. */
  readonly output: string;
}

/** Runs `command` in the guest until it exits or `timeout` passes, keeping its output's tail. */
const runInGuest = (
  machine: MachineRef,
  command: Command,
  timeout: Duration.Duration,
): Effect.Effect<Ran, HostError, Runtime> =>
  Effect.gen(function* () {
    const runtime = yield* Runtime;
    const tail = outputTail();

    const exitCode = yield* Effect.scoped(
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
      Effect.map(([, code]) => code),
      Effect.timeoutOption(timeout),
    );

    return { exitCode, output: tail.text() };
  });

/** Fails the action when the script exited non-zero or ran past its timeout. */
const succeeded = (what: string, timeout: Duration.Duration, ran: Ran) =>
  Option.match(ran.exitCode, {
    onNone: () =>
      Effect.fail(
        new Precondition({
          message: `${what} ran past its ${Duration.format(timeout)} timeout; its last output:\n${ran.output}`,
        }),
      ),
    onSome: (code) =>
      code === 0
        ? Effect.void
        : Effect.fail(
            new Precondition({
              message: `${what} exited ${code}; its last output:\n${ran.output}`,
            }),
          ),
  });

/**
 * Runs a setup script that arrives on stdin, so it never appears in a process list. It runs
 * as its own file, honouring its `#!` line, with stdin closed. The file is under `/var/tmp`,
 * which nothing mounts `noexec`, and is removed however setup ends. The exit trap covers an
 * exit or a signal the shell sees. A killed exec gives it no chance: smolvm then SIGKILLs the
 * guest command and every process descended from it (phase 3, live). So a guard that has left
 * that tree removes the file once the shell is gone: `perl` forks it, the parent exits so the
 * guest's init adopts it, and it takes a session of its own. The shell waits for that parent,
 * so the guard runs before the file holds anything. `perl` is stock Ubuntu's `perl-base`, as
 * preparation's reseed uses.
 */
const setupRunner = [
  "set -eu",
  "script=$(mktemp /var/tmp/clankerbox-setup.XXXXXX)",
  `perl -e 'use POSIX; fork and exit; POSIX::setsid(); exec @ARGV' /bin/sh -c 'while kill -0 "$1" 2>/dev/null; do sleep 1; done; rm -f "$2"' clankerbox-setup-guard "$$" "$script" </dev/null >/dev/null 2>&1`,
  `trap 'rm -f "$script"' EXIT`,
  "trap 'exit 1' HUP INT TERM",
  `cat >"$script"`,
  `chmod 700 "$script"`,
  `"$script" </dev/null`,
].join("\n");

/** Runs the create request's setup once, after the first boot and before preparation. */
export const runSetup = (
  machine: MachineRef,
  setup: Setup,
): Effect.Effect<void, HostError, Runtime> => {
  const timeout = Duration.seconds(setup.timeoutSeconds);

  return runInGuest(
    machine,
    { argv: ["/bin/sh", "-c", setupRunner], stdin: new TextEncoder().encode(setup.script) },
    timeout,
  ).pipe(Effect.flatMap((ran) => succeeded("setup", timeout, ran)));
};

/** Precedes the host key on preparation's output. */
const hostKeyMarker = "clankerbox-host-key: ";

/**
 * Preparation, run after every create and start (and later fork and restore). Its arguments
 * are the row's instance and the machine's ID; a fresh random seed arrives on stdin.
 *
 * 1. Identity, when `/var/lib/clankerbox/instance` isn't the row's instance: reseed the kernel
 *    RNG first (the seed into `/dev/random`, then `RNDRESEEDCRNG` on Linux, as a RAM restore
 *    clones the guest's CRNG); re-mint the SSH host keys if there are any; make a running
 *    sshd load them; write the machine ID; run the `new-identity` hook; and write the
 *    instance last, so a crash before it repeats these steps.
 * 2. `/etc/clankerbox/start`, if it exists, on every activation.
 * 3. The SSH host public key, if there is one, after a marker.
 *
 * sshd re-executes itself on SIGHUP, which loads the new keys and keeps its listener under
 * whatever launched it: a `start` script, or boat's systemd unit. `/proc/<pid>/comm` guards
 * against a stale pid file; macOS has no `/run/sshd.pid`, as launchd starts sshd per
 * connection. `CLANKERBOX_ROOT` is unset in a guest; tests run the script against a
 * temporary directory as the root.
 */
export const preparationScript = [
  "set -eu",
  "instance=$1",
  "id=$2",
  "root=${CLANKERBOX_ROOT-}",
  "PATH=$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "state=$root/var/lib/clankerbox",
  `if [ "$(cat "$state/instance" 2>/dev/null || true)" != "$instance" ]; then`,
  `  cat >"$root/dev/random"`,
  `  if [ "$(uname -s)" = Linux ]; then`,
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
export const preparationTimeout = Duration.seconds(60);

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
  ).pipe(
    Effect.tap((ran) => succeeded("preparation", preparationTimeout, ran)),
    Effect.map((ran) => hostKeyIn(ran.output)),
  );
