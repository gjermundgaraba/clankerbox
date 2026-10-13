/**
 * A sandbox's tunnel: the system `ssh` forwarding a loopback port of this machine to the Sandbox
 * Agent's port on the guest's loopback, over the machine's one published port, guest port 22.
 *
 * The tunnel runs `cat` in the guest and holds the pipe to its stdin, so it ends when this
 * process does, however that ends: the pipe closes, `cat` reads its end, and ssh exits. Neither
 * the child nor the pipe keeps the event loop alive, so a program that leaves a sandbox running
 * still exits. That takes `node:child_process` itself: Effect's process handle has no way to
 * unref the pipe.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { connect, createServer, Socket } from "node:net";
import { join } from "node:path";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Data, Duration, Effect, Predicate, Schedule, type Scope } from "effect";
import { agentPort } from "./agent.ts";

const loopback = "127.0.0.1";

/**
 * A tunnel that couldn't open for a reason of this machine's: its port taken, ssh not runnable,
 * its files not written. No start of the sandbox's machine changes it.
 */
export class LocalTunnelError extends Data.TaggedError("LocalTunnelError")<{
  readonly message: string;
}> {}

/**
 * How long ssh may take to log in and listen: ssh's own default ConnectTimeout is the system's
 * TCP timeout, minutes, and a tunnel the SDK waits on should fail sooner than that.
 */
const openWait = Duration.seconds(30);

/** How often the port is tried while ssh logs in: a login takes about a second. */
const openPause = Duration.millis(100);

/** How long ssh may take to end once told to, before it is killed: it ends in milliseconds. */
const closeWait = Duration.seconds(5);

/** The last of ssh's stderr an error carries: enough for its last few lines, such as a refusal. */
const stderrTail = 600;

export interface Tunnel {
  /** Whether ssh still runs. A tunnel whose machine stopped has ended. */
  readonly running: () => boolean;
}

/** A loopback port nothing listens on now. */
export const freePort: Effect.Effect<number, LocalTunnelError> = Effect.callback((resume) => {
  const server = createServer();

  server.once("error", (error) =>
    resume(
      Effect.fail(new LocalTunnelError({ message: `couldn't find a free port: ${error.message}` })),
    ),
  );

  server.listen(0, loopback, () => {
    const address = server.address();

    server.close(() =>
      resume(
        address === null || Predicate.isString(address)
          ? Effect.fail(new LocalTunnelError({ message: "couldn't find a free port" }))
          : Effect.succeed(address.port),
      ),
    );
  });
});

/** Whether something accepts a connection on the loopback port. */
const listening = (port: number): Effect.Effect<boolean> =>
  Effect.callback((resume) => {
    const socket = connect({ host: loopback, port });

    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.succeed(true));
    });

    socket.once("error", () => resume(Effect.succeed(false)));

    return Effect.sync(() => socket.destroy());
  });

/**
 * The arguments that forward `port` to the guest's Sandbox Agent, after the pinned ones, with the
 * caller's `extra` among them. The forward is this ssh's own, never a connection master's, which
 * would outlive it; and keepalives end it when the guest stops answering without closing. These
 * come before `extra`: OpenSSH keeps an option's first value, so neither `extra` nor the user's
 * ssh config can change them.
 */
export const forwarding = (port: number, extra: ReadonlyArray<string>): Array<string> => [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
  ...extra,
  "-L",
  `${loopback}:${port}:${loopback}:${agentPort}`,
  "cat",
];

/** Whether the child has ended, or failed to start: Node sets an exit code for either. */
const over = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/**
 * Waits for the child to end. A program that couldn't be run says so in an `error` event, with
 * no `exit`.
 */
const exited = (child: ChildProcess): Effect.Effect<void> =>
  Effect.callback((resume) => {
    if (over(child)) {
      return resume(Effect.void);
    }

    const done = () => resume(Effect.void);

    child.once("exit", done);
    child.once("error", done);

    return Effect.sync(() => {
      child.off("exit", done);
      child.off("error", done);
    });
  });

/** What starting the tunnel's ssh needs. */
export interface Start {
  /** The ssh to run: `ssh`, or a stand-in in tests. */
  readonly program: string;
  /** Its arguments, the forward included. */
  readonly args: ReadonlyArray<string>;
  /** A directory of the tunnel's own, which holds ssh's stderr. */
  readonly directory: string;
  readonly port: number;
  /** The machine's ID, for errors. */
  readonly machine: string;
}

/**
 * Starts ssh and waits until it listens on the port. Closing the scope ends it, and waits for
 * its exit, so the port is free for the next tunnel. An ssh that exits first fails the open with
 * the last of what it printed, and one that couldn't be run with why. A port another program
 * holds is refused first: the wait for the port to listen can't tell whose listener it finds.
 */
export const open = (
  start: Start,
): Effect.Effect<Tunnel, Internal | LocalTunnelError, Scope.Scope> =>
  Effect.gen(function* () {
    if (yield* listening(start.port)) {
      return yield* new LocalTunnelError({
        message: `the tunnel to ${start.machine} can't use port ${start.port}: another program listens on it`,
      });
    }

    const log = join(start.directory, "ssh.log");

    const said = Effect.map(
      Effect.promise(() => readFile(log, "utf8").catch(() => "")),
      (text) => text.trim().slice(-stderrTail),
    );

    // Why the program couldn't be run, if it couldn't.
    let unrun: Error | undefined;

    const failed = (why: string) =>
      Effect.flatMap(said, (text) => {
        const reason = (detail: string) =>
          `the tunnel to ${start.machine} ${why}${detail === "" ? "" : `: ${detail}`}`;

        return Effect.fail(
          unrun === undefined
            ? new Internal({ message: reason(text) })
            : new LocalTunnelError({
                message: reason(`couldn't run ${start.program}: ${unrun.message}`),
              }),
        );
      });

    const child: ChildProcess = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const stderr = openSync(log, "a");

          const spawned = spawn(start.program, start.args, {
            stdio: ["pipe", "ignore", stderr],
          });

          closeSync(stderr);

          spawned.on("error", (error) => {
            unrun = error;
          });
          spawned.unref();

          if (spawned.stdin instanceof Socket) {
            spawned.stdin.unref();
          }

          // A write to a tunnel that has ended would otherwise be an uncaught error.
          spawned.stdin?.on("error", () => {});

          return spawned;
        },
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
                exited(spawned),
              ),
          }),
        ),
    );

    const listens = listening(start.port).pipe(
      Effect.repeat({ until: (open) => open, schedule: Schedule.spaced(openPause) }),
    );

    yield* Effect.raceFirst(
      listens,
      Effect.andThen(exited(child), failed("ended before it listened")),
    ).pipe(
      Effect.timeoutOrElse({
        duration: openWait,
        orElse: () => failed(`didn't listen within ${Duration.format(openWait)}`),
      }),
    );

    return { running: () => !over(child) };
  });
