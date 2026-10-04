/** A process spawner for unit tests that runs nothing: each process answers as a test scripts it. */
import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** One process the runtime started. */
export interface Call {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  readonly env: unknown;
  readonly stdin: string | undefined;
}

/** What a scripted process prints and how it exits. */
export interface Reply {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

const encoder = new TextEncoder();

/**
 * A spawner that runs nothing: each process answers with `reply(call)`, and exits 0 with no
 * output when that is `undefined`. A process's stdin is read whole before it answers.
 */
export const scripted = (reply: (call: Call) => Reply | undefined) => {
  const calls: Array<Call> = [];

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
        args: command.args,
        env: command.options.env,
        stdin,
      };

      calls.push(call);

      const answer = reply(call) ?? {};
      const stdout = answer.stdout ?? "";
      const stderr = answer.stderr ?? "";

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(answer.exitCode ?? 0)),
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
    }),
  );

  return { calls, layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner) };
};

export type Scripted = ReturnType<typeof scripted>;
