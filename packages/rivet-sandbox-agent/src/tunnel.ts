import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { connect, createServer, Socket } from "node:net";
import path from "node:path";

import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Data, Duration, Effect, Function, Predicate, Schedule } from "effect";
import type { Scope } from "effect";

import { agentPort } from "./agent.ts";

const loopback = "127.0.0.1";

export class LocalTunnelError extends Data.TaggedError("LocalTunnelError")<{
  readonly message: string;
}> {}

const openWait = Duration.seconds(30);

const openPause = Duration.millis(100);

const closeWait = Duration.seconds(5);

const stderrTail = 600;

export interface Tunnel {
  readonly running: () => boolean;
}

export const freePort: Effect.Effect<number, LocalTunnelError> =
  Effect.callback((resume) => {
    const server = createServer();

    server.once("error", (error) => {
      resume(
        Effect.fail(
          new LocalTunnelError({
            message: `couldn't find a free port: ${error.message}`,
          })
        )
      );
    });

    server.listen(0, loopback, () => {
      const address = server.address();

      server.close(() => {
        resume(
          address === null || Predicate.isString(address)
            ? Effect.fail(
                new LocalTunnelError({ message: "couldn't find a free port" })
              )
            : Effect.succeed(address.port)
        );
      });
    });
  });

const listening = (port: number): Effect.Effect<boolean> =>
  Effect.callback((resume) => {
    const socket = connect({ host: loopback, port });

    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.succeed(true));
    });

    socket.once("error", () => {
      resume(Effect.succeed(false));
    });

    return Effect.sync(() => socket.destroy());
  });

/**
 * No connection master, which would outlive the forward, and keepalives that end it when the
 * guest stops answering. These precede `extra`: OpenSSH keeps an option's first value.
 */
export const forwarding = (
  port: number,
  extra: readonly string[]
): string[] => [
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

export interface Start {
  readonly program: string;
  readonly args: readonly string[];
  readonly directory: string;
  readonly port: number;
  readonly machine: string;
}

const refuseTakenPort = (start: Start): Effect.Effect<void, LocalTunnelError> =>
  Effect.flatMap(listening(start.port), (taken) =>
    taken
      ? Effect.fail(
          new LocalTunnelError({
            message: `the tunnel to ${start.machine} can't use port ${start.port}: another program listens on it`,
          })
        )
      : Effect.void
  );

const spawnTiedToThisProcess = (
  program: string,
  args: readonly string[],
  log: string,
  onError: (error: Error) => void
): ChildProcess => {
  const stderr = openSync(log, "a");

  const spawned = spawn(program, args, {
    stdio: ["pipe", "ignore", stderr],
  });

  closeSync(stderr);

  spawned.on("error", onError);
  spawned.unref();

  if (spawned.stdin instanceof Socket) {
    spawned.stdin.unref();
  }

  spawned.stdin?.on("error", Function.constVoid);

  return spawned;
};

export const open = (
  start: Start
): Effect.Effect<Tunnel, Internal | LocalTunnelError, Scope.Scope> =>
  Effect.gen(function* () {
    yield* refuseTakenPort(start);

    const log = path.join(start.directory, "ssh.log");

    const said = Effect.map(
      Effect.tryPromise(async () => await readFile(log, "utf-8")).pipe(
        Effect.orElseSucceed(() => "")
      ),
      (text) => text.trim().slice(-stderrTail)
    );

    let unrun: Error | undefined;

    const failed = (why: string) =>
      Effect.flatMap(said, (text) => {
        const reason = (detail: string) =>
          `the tunnel to ${start.machine} ${why}${detail === "" ? "" : `: ${detail}`}`;

        return Effect.fail(
          unrun === undefined
            ? new Internal({ message: reason(text) })
            : new LocalTunnelError({
                message: reason(
                  `couldn't run ${start.program}: ${unrun.message}`
                ),
              })
        );
      });

    const child: ChildProcess = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          spawnTiedToThisProcess(start.program, start.args, log, (error) => {
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

    const listens = listening(start.port).pipe(
      Effect.repeat({
        until: (opened) => opened,
        schedule: Schedule.spaced(openPause),
      })
    );

    yield* Effect.raceFirst(
      listens,
      Effect.andThen(exited(child), failed("ended before it listened"))
    ).pipe(
      Effect.timeoutOrElse({
        duration: openWait,
        orElse: () =>
          failed(`didn't listen within ${Duration.format(openWait)}`),
      })
    );

    return { running: () => !over(child) };
  });
