import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Effect, Fiber, Schedule, Stream } from "effect";
import { expect } from "vite-plus/test";

import type { Interface, RuntimeError, Target } from "../src/runtime.ts";

const poll = Schedule.spaced("20 millis");

/** What `file` holds once something writes it. */
export const written = (file: string) =>
  Effect.repeat(
    Effect.sync(() => (existsSync(file) ? readFileSync(file, "utf8") : "")),
    { until: (text) => text.endsWith("\n"), schedule: poll }
  );

export const holdsPid = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

/** Ends once no process holds `pid`. */
export const gone = (pid: number) =>
  Effect.repeat(
    Effect.sync(() => holdsPid(pid)),
    { until: (alive) => !alive, schedule: poll }
  );

const shell = (script: string) => ({
  argv: ["/bin/sh", "-c", script],
  stdin: "",
});

/**
 * Cuts an exec short while its command waits for the test, and has the test let it on: a provider
 * leaves the command running, so it goes on to write `ran`, holding the status of a write to its
 * stdout after the cut, and runs until `end` ends it.
 */
export const cutAndLeftRunning = <E, R>(
  runtime: Interface,
  machine: Target,
  root: string,
  end: Effect.Effect<void, E, R>
) =>
  Effect.gen(function* () {
    const exec = yield* Effect.forkChild(
      Effect.scoped(
        Effect.flatMap(
          runtime.exec(
            machine,
            shell(
              'echo $$ > "$CLANKERBOX_ROOT/pid"; until [ -e "$CLANKERBOX_ROOT/go" ]; do sleep 0.05; done; (echo after); echo $? > "$CLANKERBOX_ROOT/ran"; exec sleep 30'
            )
          ),
          ({ exitCode }) => Effect.ignore(exitCode)
        )
      )
    );

    const pid = Number(yield* written(path.join(root, "pid")));

    yield* Fiber.interrupt(exec);
    yield* Effect.sync(() => {
      writeFileSync(path.join(root, "go"), "");
    });

    const ran = (yield* written(path.join(root, "ran"))).trim();

    expect(holdsPid(pid)).toBe(true);
    yield* end;
    yield* gone(pid);

    return ran;
  });

/** Runs an exec that leaves a command in the background, its stdio its own, and answers its PID once the exec and its scope end. */
export const leftInTheBackground = (
  runtime: Interface,
  machine: Target,
  root: string
): Effect.Effect<number, RuntimeError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const execution = yield* runtime.exec(
        machine,
        shell(
          'sleep 30 </dev/null >/dev/null 2>&1 & echo $! > "$CLANKERBOX_ROOT/background"'
        )
      );

      expect(
        yield* Effect.andThen(
          Stream.runDrain(execution.output),
          execution.exitCode
        )
      ).toBe(0);

      return Number(yield* written(path.join(root, "background")));
    })
  ).pipe(
    Effect.tap((pid) =>
      Effect.sync(() => {
        expect(holdsPid(pid)).toBe(true);
      })
    )
  );
