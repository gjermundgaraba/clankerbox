import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export interface Call {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  readonly env: unknown;
  readonly stdin: string | undefined;
}

export interface Reply {
  readonly exitCode?: number;
  readonly hangs?: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
}

const encoder = new TextEncoder();

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
        exitCode:
          answer.hangs === true
            ? Effect.never
            : Effect.succeed(ChildProcessSpawner.ExitCode(answer.exitCode ?? 0)),
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
