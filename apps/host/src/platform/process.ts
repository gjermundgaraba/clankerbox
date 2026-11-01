import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Stream } from "effect";
import type { PlatformError, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { lastLines } from "../guest.ts";
import type { Execution } from "../runtime.ts";

export const describe = (error: PlatformError.PlatformError): string =>
  `${error.reason._tag}: ${error.reason.method}${error.reason.description === undefined ? "" : `: ${error.reason.description}`}`;

export interface Ran {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const failure = (what: string, ran: Ran): Internal =>
  new Internal({
    message: `${what} exited ${ran.exitCode}: ${lastLines(ran.stderr)}`,
  });

export const expect = (
  ran: Ran,
  what: string,
  ok: readonly number[] = [0]
): Effect.Effect<Ran, Internal> =>
  ok.includes(ran.exitCode)
    ? Effect.succeed(ran)
    : Effect.fail(failure(what, ran));

export const files = <A>(
  what: string,
  effect: Effect.Effect<A, PlatformError.PlatformError>
): Effect.Effect<A, Internal> =>
  Effect.mapError(
    effect,
    (error) => new Internal({ message: `${what}: ${describe(error)}` })
  );

const commandIn =
  (env: Readonly<Record<string, string | undefined>>) =>
  (file: string, args: readonly string[], stdin: ChildProcess.CommandInput) =>
    ChildProcess.make(file, args, {
      env,
      extendEnv: false,
      stdin,
      forceKillAfter: Duration.seconds(5),
    });

export const cliIn = (env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const command = commandIn(env);

    const run = (file: string, args: readonly string[], what: string) =>
      Effect.scoped(
        Effect.flatMap(spawner.spawn(command(file, args, "ignore")), (handle) =>
          Effect.all(
            {
              exitCode: handle.exitCode,
              stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
              stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
            },
            { concurrency: "unbounded" }
          )
        )
      ).pipe(
        Effect.mapError(
          (error) => new Internal({ message: `${what}: ${describe(error)}` })
        )
      );

    const exec = (
      file: string,
      args: readonly string[],
      stdin: Uint8Array | undefined,
      what: string
    ): Effect.Effect<Execution, Internal, Scope.Scope> => {
      const failed = (error: PlatformError.PlatformError) =>
        new Internal({ message: `${what}: ${describe(error)}` });

      return Effect.map(
        Effect.mapError(
          spawner.spawn(
            command(
              file,
              args,
              stdin === undefined ? "ignore" : Stream.make(stdin)
            )
          ),
          failed
        ),
        (handle) => ({
          output: Stream.mapError(handle.all, failed),
          exitCode: Effect.mapError(handle.exitCode, failed),
        })
      );
    };

    return { command, run, exec };
  });
