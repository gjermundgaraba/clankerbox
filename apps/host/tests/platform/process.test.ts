import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";

import { processEnded } from "../../src/platform/process.ts";

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "a process that runs has not ended, and one that has exited and been reaped has",
    () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        const pid = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(ChildProcess.make("true", []));

            yield* child.exitCode;

            return child.pid;
          })
        );

        expect({
          running: yield* processEnded(process.pid),
          exited: yield* processEnded(pid),
        }).toStrictEqual({ running: false, exited: true });
      })
  );
});
