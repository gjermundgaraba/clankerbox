/**
 * The CLI calls a runtime makes: a program run to its end, or a guest command whose output
 * streams, each in exactly the runtime's environment. Errors name the call by `what`, never by
 * its arguments: an exec's arguments carry the preparation script, which nothing logs.
 */
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, type PlatformError, type Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { lastLines } from "./guest.ts";
import type { Execution, MachineRef } from "./runtime.ts";

/** A spawn or file system failure, without the command line. */
export const describe = (error: PlatformError.PlatformError): string =>
  `${error.reason._tag}: ${error.reason.method}${error.reason.description === undefined ? "" : `: ${error.reason.description}`}`;

/** A finished CLI call. */
export interface Ran {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A call that exited with a code it shouldn't have, with the last lines of its stderr. */
export const failure = (what: string, ran: Ran): Internal =>
  new Internal({ message: `${what} exited ${ran.exitCode}: ${lastLines(ran.stderr)}` });

/** A call that succeeds with one of the exit codes `ok`. */
export const expect = (
  ran: Ran,
  what: string,
  ok: ReadonlyArray<number> = [0],
): Effect.Effect<Ran, Internal> =>
  ok.includes(ran.exitCode) ? Effect.succeed(ran) : Effect.fail(failure(what, ran));

/** A file system call of a runtime's own; `what` names it in errors. */
export const files = <A>(
  what: string,
  effect: Effect.Effect<A, PlatformError.PlatformError>,
): Effect.Effect<A, Internal> =>
  Effect.mapError(effect, (error) => new Internal({ message: `${what}: ${describe(error)}` }));

/** The machine's host port, which a runtime with a `publishAddress` gave every row. */
export const portOf = (machine: MachineRef): Effect.Effect<number, Internal> =>
  machine.port === undefined
    ? Effect.fail(new Internal({ message: `machine ${machine.id} has no host port` }))
    : Effect.succeed(machine.port);

/** CLI calls in `env` and nothing else. */
export const cliIn = (env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const command = (file: string, args: ReadonlyArray<string>, stdin: ChildProcess.CommandInput) =>
      ChildProcess.make(file, args, { env, extendEnv: false, stdin });

    /** Runs a call to its end; `what` names it in errors. */
    const run = (file: string, args: ReadonlyArray<string>, what: string) =>
      Effect.scoped(
        Effect.flatMap(spawner.spawn(command(file, args, "ignore")), (handle) =>
          Effect.all(
            {
              exitCode: handle.exitCode,
              stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
              stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
            },
            { concurrency: "unbounded" },
          ),
        ),
      ).pipe(Effect.mapError((error) => new Internal({ message: `${what}: ${describe(error)}` })));

    /** Starts a guest command, its `stdin` written whole; `what` names it in errors. */
    const exec = (
      file: string,
      args: ReadonlyArray<string>,
      stdin: Uint8Array | undefined,
      what: string,
    ): Effect.Effect<Execution, Internal, Scope.Scope> => {
      const failed = (error: PlatformError.PlatformError) =>
        new Internal({ message: `${what}: ${describe(error)}` });

      return Effect.map(
        Effect.mapError(
          spawner.spawn(command(file, args, stdin === undefined ? "ignore" : Stream.make(stdin))),
          failed,
        ),
        (handle) => ({
          output: Stream.mapError(handle.all, failed),
          exitCode: Effect.mapError(handle.exitCode, failed),
        }),
      );
    };

    return { command, run, exec };
  });
