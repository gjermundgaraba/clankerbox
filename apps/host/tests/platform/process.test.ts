import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { read, scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect, Fiber, Schedule } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";

import { cliIn, processEnded } from "../../src/platform/process.ts";

const groups = (stdout: string) => stdout.trim().split(/\s+/u).map(Number);

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

  it.effect(
    "a command runs in a process group of its own, or with detached: false in the host's",
    () =>
      Effect.gen(function* () {
        const env = { PATH: process.env["PATH"] };
        const groupOf = ["-c", "ps -o pgid= -p $$ -p $PPID"];

        const [own, hosts] = yield* Effect.all([
          Effect.flatMap(cliIn(env), ({ run }) => run("sh", groupOf, "own")),
          Effect.flatMap(cliIn(env, { detached: false }), ({ run }) =>
            run("sh", groupOf, "host's")
          ),
        ]);

        const [ownChild, ownHost] = groups(own.stdout);
        const [hostsChild, hostsHost] = groups(hosts.stdout);

        expect({
          own: ownChild === ownHost,
          hosts: hostsChild === hostsHost,
        }).toStrictEqual({ own: false, hosts: true });
      })
  );

  it.effect(
    "a command in the host's process group still ends when the host stops waiting for it",
    () =>
      Effect.gen(function* () {
        const file = `${yield* scratch}/pid`;

        const { run } = yield* cliIn(
          { PATH: process.env["PATH"] },
          { detached: false }
        );

        const waiting = yield* Effect.forkChild(
          run("sh", ["-c", `echo $$ >${file}; exec sleep 30`], "sleep")
        );

        const pid = Number(
          yield* read(file).pipe(
            Effect.filterOrFail((text) => text.endsWith("\n")),
            Effect.retry(Schedule.spaced("20 millis")),
            Effect.timeout("5 seconds")
          )
        );

        yield* Fiber.interrupt(waiting);

        expect(
          yield* processEnded(pid).pipe(
            Effect.repeat({
              until: (ended) => ended,
              schedule: Schedule.spaced("50 millis"),
            }),
            Effect.timeout("10 seconds")
          )
        ).toBe(true);
      })
  );
});
