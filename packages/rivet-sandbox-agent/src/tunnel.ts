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
import { Duration, Effect, Predicate, Schedule, type Scope } from "effect";

const loopback = "127.0.0.1";

/** How long ssh may take to log in and listen. */
const openWait = Duration.seconds(30);

const openPause = Duration.millis(100);

/** How long ssh may take to end once told to, before it is killed. */
const closeWait = Duration.seconds(5);

/** The last of ssh's stderr an error carries. */
const stderrTail = 600;

export interface Tunnel {
  /** The loopback port of this machine that leads to the Sandbox Agent. */
  readonly port: number;
  /** Whether ssh still runs. A tunnel whose machine stopped has ended. */
  readonly running: () => boolean;
}

/** A loopback port nothing listens on now. */
export const freePort: Effect.Effect<number, Internal> = Effect.callback((resume) => {
  const server = createServer();

  server.once("error", (error) =>
    resume(Effect.fail(new Internal({ message: `couldn't find a free port: ${error.message}` }))),
  );

  server.listen(0, loopback, () => {
    const address = server.address();

    server.close(() =>
      resume(
        address === null || Predicate.isString(address)
          ? Effect.fail(new Internal({ message: "couldn't find a free port" }))
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

/** The arguments that forward `port` to the guest's `agentPort`, after the pinned ones. */
export const forwarding = (port: number, agentPort: number): Array<string> => [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ExitOnForwardFailure=yes",
  "-L",
  `${loopback}:${port}:${loopback}:${agentPort}`,
  "cat",
];

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
 * the last of what it printed.
 */
export const open = (start: Start): Effect.Effect<Tunnel, Internal, Scope.Scope> =>
  Effect.gen(function* () {
    const log = join(start.directory, "ssh.log");

    const said = Effect.map(
      Effect.promise(() => readFile(log, "utf8").catch(() => "")),
      (text) => text.trim().slice(-stderrTail),
    );

    const failed = (why: string) =>
      Effect.flatMap(said, (text) =>
        Effect.fail(
          new Internal({
            message: `the tunnel to ${start.machine} ${why}${text === "" ? "" : `: ${text}`}`,
          }),
        ),
      );

    const child: ChildProcess = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const stderr = openSync(log, "a");

          const spawned = spawn(start.program, start.args, {
            stdio: ["pipe", "ignore", stderr],
          });

          closeSync(stderr);

          // A program that couldn't be run has no pid, and says why here.
          spawned.on("error", () => {});
          spawned.unref();

          if (spawned.stdin instanceof Socket) {
            spawned.stdin.unref();
          }

          // A write to a tunnel that has ended would otherwise be an uncaught error.
          spawned.stdin?.on("error", () => {});

          return spawned;
        },
        catch: (error) =>
          new Internal({
            message: `couldn't run ${start.program}: ${error instanceof Error ? error.message : String(error)}`,
          }),
      }),
      (spawned) =>
        ended(spawned).pipe(
          Effect.timeoutOrElse({
            duration: closeWait,
            orElse: () => Effect.sync(() => spawned.kill("SIGKILL")),
          }),
        ),
    );

    const exited = Effect.callback<void>((resume) => {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
        return resume(Effect.void);
      }

      const done = () => resume(Effect.void);

      child.once("exit", done);

      return Effect.sync(() => child.off("exit", done));
    });

    const listens = listening(start.port).pipe(
      Effect.repeat({ until: (open) => open, schedule: Schedule.spaced(openPause) }),
    );

    yield* Effect.raceFirst(
      listens,
      Effect.andThen(exited, failed("ended before it listened")),
    ).pipe(
      Effect.timeoutOrElse({
        duration: openWait,
        orElse: () => failed(`didn't listen within ${Duration.format(openWait)}`),
      }),
    );

    return {
      port: start.port,
      running: () => child.exitCode === null && child.signalCode === null,
    };
  });

/** Ends ssh and waits for its exit. */
const ended = (child: ChildProcess): Effect.Effect<void> =>
  Effect.callback((resume) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
      return resume(Effect.void);
    }

    child.once("exit", () => resume(Effect.void));
    child.kill("SIGTERM");
  });
