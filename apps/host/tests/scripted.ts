import { Deferred, Effect, Layer, Redacted, Sink, Stream } from "effect";
import type { Duration } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { StallAt } from "./runtime-contract.ts";

export interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: unknown;
  readonly stdin: string | undefined;
}

export interface Reply {
  readonly exitCode?: number;
  readonly hangs?: boolean;
  readonly until?: Effect.Effect<void>;
  readonly stdout?: string;
  readonly stderr?: string;
}

const encoder = new TextEncoder();

interface Stall {
  after: number;
  readonly at: StallAt;
  readonly hold: Duration.Input;
  readonly reached: Deferred.Deferred<undefined>;
}

export const scripted = (reply: (call: Call) => Reply | undefined) => {
  const calls: Call[] = [];
  let stalled: Stall | undefined;

  const stalledHere = () => {
    if (stalled === undefined) {
      return undefined;
    }

    if (stalled.after > 0) {
      stalled.after -= 1;

      return undefined;
    }

    const here = stalled;

    stalled = undefined;

    return here;
  };

  const holding = (stall: Stall | undefined, at: StallAt) =>
    stall?.at === at
      ? Effect.andThen(
          Deferred.succeed(stall.reached, undefined),
          Effect.sleep(stall.hold)
        )
      : Effect.void;

  const stall = (after: number, at: StallAt, hold: Duration.Input) =>
    Effect.map(Deferred.make<undefined>(), (reached) => {
      stalled = { after, at, hold, reached };

      return Deferred.await(reached);
    });

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* Effect.die("the runtime runs no pipelines");
      }

      const input = command.options.stdin;

      const stdin = Stream.isStream(input)
        ? yield* Stream.mkString(Stream.decodeText(input))
        : undefined;

      const call: Call = {
        file: command.command,
        args: command.args.map((arg) =>
          Redacted.isRedacted(arg) ? Redacted.value(arg) : arg
        ),
        env: command.options.env,
        stdin,
      };

      const here = stalledHere();

      yield* holding(here, "start");
      calls.push(call);

      const answer = reply(call) ?? {};
      const stdout = answer.stdout ?? "";
      const stderr = answer.stderr ?? "";

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode:
          answer.hangs === true
            ? Effect.never
            : Effect.as(
                Effect.andThen(
                  answer.until ?? Effect.void,
                  holding(here, "end")
                ),
                ChildProcessSpawner.ExitCode(answer.exitCode ?? 0)
              ),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(stdout)),
        stderr: Stream.make(encoder.encode(stderr)),
        all: Stream.make(encoder.encode(stdout + stderr)),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    })
  );

  return {
    calls,
    stall,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  };
};

export type Scripted = ReturnType<typeof scripted>;
