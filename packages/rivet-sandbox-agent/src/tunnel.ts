import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { connect, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Clock, Data, Duration, Effect, FileSystem, Function } from "effect";
import type { PlatformError, Scope } from "effect";

import { agentPort } from "./agent.ts";

export class LocalTunnelError extends Data.TaggedError("LocalTunnelError")<{
  readonly message: string;
}> {}

const openWait = Duration.seconds(30);

const closeWait = Duration.seconds(5);

const drainWait = Duration.seconds(1);

const stderrTail = 600;

const prefix = "clankerbox-tunnel-";

// https://man7.org/linux/man-pages/man3/mkdtemp.3.html
const madeName = new RegExp(`^${prefix}[0-9A-Za-z]{6}$`, "u");

const socketName = "agent.sock";

const sweptAfter = Duration.times(openWait, 2);

// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/un.h
// https://man7.org/linux/man-pages/man7/unix.7.html
// https://github.com/openssh/openssh-portable/blob/V_10_2_P1/misc.c#L1960-L1965
const socketPathMost = 103;

export interface Tunnel {
  readonly running: () => boolean;
  /** The unix socket its ssh forwards from, in the tunnel's own directory. */
  readonly socket: string;
}

/** A tunnel's own directory, under the temporary directory, which only this user can enter. */
export const tunnelDirectory: Effect.Effect<
  string,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ directory: tmpdir(), prefix })
);

const refuses = (socket: string): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const probe = connect(socket);

    probe.once("connect", () => {
      probe.destroy();
      resume(Effect.succeed(false));
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      resume(
        Effect.succeed(error.code === "ENOENT" || error.code === "ECONNREFUSED")
      );
    });

    return Effect.sync(() => probe.destroy());
  }).pipe(
    Effect.timeoutOrElse({
      duration: drainWait,
      orElse: () => Effect.succeed(false),
    })
  );

/**
 * Removes each directory under `under` that a tunnel of user `uid` left and that is surely dead: a
 * real directory, not a link, of that user's, named as a tunnel's is, older than twice the open
 * wait, so no open still runs in it, and whose socket is missing or refuses a connection, as ssh's
 * is once it has ended. A program ended by a signal runs no exit hook and leaves its tunnels'.
 */
export const sweep = (under: string, uid: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const names = yield* Effect.tryPromise(async () => await readdir(under));

    yield* Effect.forEach(
      names.filter((name) => madeName.test(name)),
      (name) =>
        Effect.gen(function* () {
          const directory = path.join(under, name);

          const stats = yield* Effect.tryPromise(
            async () => await lstat(directory)
          );

          const dead =
            stats.isDirectory() &&
            stats.uid === uid &&
            now - stats.mtimeMs > Duration.toMillis(sweptAfter) &&
            (yield* refuses(path.join(directory, socketName)));

          if (dead) {
            yield* Effect.tryPromise(async () => {
              await rm(directory, { recursive: true, force: true });
            });
          }
        }).pipe(Effect.ignore),
      { discard: true }
    );
  }).pipe(Effect.ignore);

/** `sweep` of this user's tunnel directories, under the temporary directory tunnels are made in. */
export const sweepLeft: Effect.Effect<void> = Effect.suspend(() => {
  const uid = process.getuid?.();

  return uid === undefined ? Effect.void : sweep(tmpdir(), uid);
});

/**
 * Where a tunnel's ssh listens: a unix socket in `directory`, which only this user can enter, so
 * no other program can take it. ssh's `-L` reads `:` as a separator, and a socket's path has a
 * bound, so a directory that breaks either is refused before ssh runs.
 */
export const socketIn = (
  directory: string,
  machine: string
): Effect.Effect<string, LocalTunnelError> => {
  const socket = path.join(directory, socketName);
  const length = Buffer.byteLength(socket);

  if (socket.includes(":")) {
    return Effect.fail(
      new LocalTunnelError({
        message: `the tunnel to ${machine} can't listen on ${socket}: ssh reads a ':' in a forward's path as a separator; set TMPDIR to a directory without one`,
      })
    );
  }

  return length > socketPathMost
    ? Effect.fail(
        new LocalTunnelError({
          message: `the tunnel to ${machine} can't listen on ${socket}: its path is ${length} bytes, over the ${socketPathMost} a unix socket takes; set TMPDIR to a shorter directory`,
        })
      )
    : Effect.succeed(socket);
};

// https://github.com/openssh/openssh-portable/blob/V_10_2_P1/ssh.c#L768-L769
const withValue = new Set("bceilmopBDEFIJLOPQRSwW");

const flagRefusals = new Map([
  ["f", "forks ssh away from the tunnel"],
  ["M", "makes ssh a connection master, which can outlive the tunnel"],
  ["N", "leaves out the session cat runs in"],
  ["n", "takes the session's input"],
  ["O", "sends a command to a connection master"],
  ["S", "hands the forward to a connection master, which outlives the tunnel"],
  ["s", "replaces the session cat runs in"],
  ["t", "asks for a terminal, which garbles the echo"],
  ["W", "replaces the session with a stdio forward"],
  ["G", "prints ssh's configuration and exits before it connects"],
  ["Q", "prints what ssh supports and exits before it connects"],
  ["V", "prints ssh's version and exits before it connects"],
]);

/**
 * Why `extra` can't go to a tunnel's ssh, if it can't: ssh takes a short flag wherever it stands,
 * so the flags that would change the session or who holds the forward, or keep ssh from
 * connecting, are refused, and so is a word that isn't an option, which ssh would run as the
 * command.
 */
export const refusal = (extra: readonly string[]): string | undefined => {
  for (let at = 0; at < extra.length; at += 1) {
    const arg = extra[at] ?? "";

    if (arg === "--" || !arg.startsWith("-") || arg === "-") {
      return `sshArguments: ${arg === "" ? "an empty word" : arg} isn't an option, and ssh would run what follows it as the tunnel's command`;
    }

    for (let index = 1; index < arg.length; index += 1) {
      const flag = arg.charAt(index);
      const why = flagRefusals.get(flag);

      if (why !== undefined) {
        return arg === `-${flag}`
          ? `sshArguments: ${arg} ${why}`
          : `sshArguments: ${arg} holds -${flag}, which ${why}`;
      }

      if (withValue.has(flag)) {
        if (index === arg.length - 1) {
          at += 1;

          if (at === extra.length) {
            return `sshArguments: ${arg} needs a value`;
          }
        }

        break;
      }
    }
  }

  return undefined;
};

/**
 * These precede `extra`: OpenSSH keeps the first value of an option given with `-o` or in a config
 * file, so neither can clear the forward, fork it, leave out its session or the session's input,
 * hand it to a connection master or replace its command. `cat` holds the session open and echoes
 * `answer`, so the echo comes only once the forward is bound.
 */
export const forwarding = (
  socket: string,
  extra: readonly string[]
): string[] => [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "ClearAllForwardings=no",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
  "-o",
  "SessionType=default",
  "-o",
  "StdinNull=no",
  "-o",
  "ForkAfterAuthentication=no",
  "-o",
  "RemoteCommand=none",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
  ...extra,
  "-L",
  `${socket}:127.0.0.1:${agentPort}`,
  "cat",
];

// OpenSSH binds each -L listener, and with ExitOnForwardFailure ends when one fails, before it
// opens the session the remote command runs in:
// https://github.com/openssh/openssh-portable/blob/V_10_2_P1/ssh.c#L2288
// https://github.com/openssh/openssh-portable/blob/V_10_2_P1/ssh.c#L2133-L2134
// https://github.com/openssh/openssh-portable/blob/V_10_2_P1/ssh.c#L2336
const answer = "clankerbox-tunnel-open";

const answered = (child: ChildProcess): Effect.Effect<void> =>
  Effect.callback((resume) => {
    let partial = "";

    const read = (chunk: string) => {
      const lines = `${partial}${chunk}`.split("\n");

      partial = lines.pop() ?? "";

      if (lines.includes(answer)) {
        resume(Effect.void);
      }
    };

    child.stdout?.on("data", read);
    child.stdin?.write(`${answer}\n`);

    return Effect.sync(() => child.stdout?.off("data", read));
  });

const over = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null;

const exited = (child: ChildProcess): Effect.Effect<void> =>
  Effect.callback((resume) => {
    if (over(child)) {
      resume(Effect.void);

      return;
    }

    const done = () => {
      resume(Effect.void);
    };

    child.once("exit", done);
    child.once("error", done);

    return Effect.sync(() => {
      child.off("exit", done);
      child.off("error", done);
    });
  });

const leftAtExit = new Set<string>();

const removeLeft = () => {
  for (const directory of leftAtExit) {
    rmSync(directory, { recursive: true, force: true });
  }
};

const removedAtExit = (directory: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      if (leftAtExit.size === 0) {
        process.once("exit", removeLeft);
      }

      leftAtExit.add(directory);
    }),
    () =>
      Effect.sync(() => {
        leftAtExit.delete(directory);

        if (leftAtExit.size === 0) {
          process.off("exit", removeLeft);
        }
      })
  );

const closed = (out: Readable | null): Effect.Effect<void> =>
  Effect.callback((resume) => {
    if (out === null || out.closed) {
      resume(Effect.void);

      return;
    }

    const done = () => {
      resume(Effect.void);
    };

    out.once("close", done);

    return Effect.sync(() => out.off("close", done));
  });

const drained = (child: ChildProcess): Effect.Effect<void> =>
  closed(child.stderr).pipe(
    Effect.timeoutOrElse({ duration: drainWait, orElse: () => Effect.void })
  );

export interface Start {
  readonly program: string;
  readonly args: readonly string[];
  readonly directory: string;
  readonly socket: string;
  readonly machine: string;
}

const spawnTiedToThisProcess = (
  program: string,
  args: readonly string[],
  onError: (error: Error) => void
): ChildProcess => {
  const spawned = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });

  spawned.on("error", onError);
  spawned.unref();

  for (const pipe of [spawned.stdin, spawned.stdout, spawned.stderr]) {
    if (pipe instanceof Socket) {
      pipe.unref();
    }
  }

  for (const out of [spawned.stdout, spawned.stderr]) {
    out?.setEncoding("utf-8");
    out?.resume();
  }

  spawned.stdin?.on("error", Function.constVoid);

  return spawned;
};

/**
 * An ssh forward from `start.socket`, in `start.directory`. ssh leaves its socket file however it
 * ends, so the directory goes when the process exits too, when no scope's finalizer runs. The last
 * of what ssh printed on stderr is kept in memory, for a failure to quote.
 */
export const open = (
  start: Start
): Effect.Effect<Tunnel, Internal | LocalTunnelError, Scope.Scope> =>
  Effect.gen(function* () {
    yield* removedAtExit(start.directory);

    let unrun: Error | undefined;

    const child: ChildProcess = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          spawnTiedToThisProcess(start.program, start.args, (error) => {
            unrun = error;
          }),
        catch: (error) =>
          new LocalTunnelError({
            message: `couldn't run ${start.program}: ${error instanceof Error ? error.message : String(error)}`,
          }),
      }),
      (spawned) =>
        Effect.sync(() => spawned.kill("SIGTERM")).pipe(
          Effect.andThen(exited(spawned)),
          Effect.timeoutOrElse({
            duration: closeWait,
            orElse: () =>
              Effect.andThen(
                Effect.sync(() => spawned.kill("SIGKILL")),
                exited(spawned)
              ),
          })
        )
    );

    let stderr = "";

    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-stderrTail);
    });

    const failure = (
      why: string,
      printed: string
    ): Internal | LocalTunnelError => {
      const reason = (detail: string) =>
        `the tunnel to ${start.machine} ${why}${detail === "" ? "" : `: ${detail}`}`;

      return unrun === undefined
        ? new Internal({ message: reason(printed) })
        : new LocalTunnelError({
            message: reason(`couldn't run ${start.program}: ${unrun.message}`),
          });
    };

    const failed = (why: string) =>
      Effect.failSync(() => failure(why, stderr.trim()));

    yield* Effect.raceFirst(
      answered(child),
      exited(child).pipe(
        Effect.andThen(drained(child)),
        Effect.andThen(failed("ended before it opened"))
      )
    ).pipe(
      Effect.timeoutOrElse({
        duration: openWait,
        orElse: () => failed(`didn't open within ${Duration.format(openWait)}`),
      })
    );

    return { running: () => !over(child), socket: start.socket };
  });
