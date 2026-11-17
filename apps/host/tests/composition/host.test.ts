import path from "node:path";

import { Handle } from "@clankerbox/host-contract";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { version, versionHeader } from "@gjermundgaraba/clankerbox-sdk";
import { read, scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Duration, Effect, Fiber, Layer, Logger, Schedule } from "effect";
import { expect } from "vite-plus/test";

import { hostLayer } from "../../src/composition/host.ts";
import type { HostLayerConfig } from "../../src/composition/host.ts";
import { fakeRuntime } from "../fake-runtime.ts";
import type { FakeRuntimeName } from "../fake-runtime.ts";
import {
  connection,
  emptyAnswer,
  hostConfig,
  hostOn,
  loopbackServer,
  noHttp,
  suitePorts,
} from "../support.ts";

const started = hostOn(suitePorts.host);

const refused = (
  settings: HostLayerConfig,
  dir: string,
  as?: FakeRuntimeName,
  calls: string[] = []
) =>
  Effect.flip(
    Layer.build(
      hostLayer(
        settings,
        fakeRuntime({
          dir,
          as,
          onCall: (call) => {
            calls.push(call);
          },
        }).layer,
        loopbackServer(settings.listen.port)
      ).pipe(Layer.provide(noHttp))
    )
  ).pipe(Effect.scoped, Effect.provide(Logger.layer([])));

const machineNamed = (name: string, digit: string) => ({
  name,
  instance: digit.repeat(32),
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  handle: Handle.make(`held-${name}`),
});

const requestHead = (action: string, length: number) =>
  `POST /host/${action} HTTP/1.1\r\nhost: host\r\ncontent-type: application/json\r\n${versionHeader}: ${version}\r\ncontent-length: ${length}\r\n\r\n`;

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect("a host clears what its runtime left before it serves", () =>
    Effect.gen(function* () {
      const { fake } = yield* started();

      expect(fake.calls).toStrictEqual(["startup"]);
    })
  );

  it.effect(
    "a host that restarts answers another boot, and holds no operation of the last",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const first = yield* started({ dir });

        yield* first.operations.run({
          id: "op-1",
          boot: first.operations.boot,
          scope: { resource: "machine", name: "dev" },
          sequence: 1,
          step: {
            _tag: "remove",
            keep: [],
            machine: { name: "dev", instance: "1".repeat(32) },
          },
        });
        yield* first.dispose;

        const second = yield* started({ dir });
        const report = yield* second.operations.wait("op-1");

        expect(report.status).toBe("absent");
        expect(report.boot).toBe(second.operations.boot);
        expect(report.boot).not.toBe(first.operations.boot);
      })
  );

  it.effect(
    "a host told to stop ends an exec still running at once, rather than wait for it, ending its command in the guest first, TERM first, and logs no error for it",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const errors: unknown[] = [];

        const host = yield* started({
          dir,
          logger: Logger.make(({ message, logLevel }) => {
            if (logLevel === "Error" || logLevel === "Fatal") {
              errors.push(message);
            }
          }),
        });

        const handle = Handle.make("held-dev");

        const machine = {
          name: "dev",
          instance: "1".repeat(32),
          cpu: 1,
          ramMib: 1024,
          diskGib: 10,
          handle,
        };

        const began = path.join(dir, "began");
        const termed = path.join(dir, "termed");

        host.fake.hold({
          state: "running",
          name: machine.name,
          root: "",
          instance: machine.instance,
          handle,
        });

        const exec = yield* Effect.forkChild(
          Effect.promise(
            async () =>
              await fetch(`${host.url}/host/execMachine`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  [versionHeader]: version,
                },
                body: JSON.stringify({
                  machine,
                  argv: [
                    "/bin/sh",
                    "-c",
                    `trap 'echo termed >"${termed}"; exit 0' TERM; : >"${began}"; sleep 30 & wait`,
                  ],
                }),
              }).then(
                (response) => response.status,
                () => 0
              )
          )
        );

        yield* read(began).pipe(
          Effect.retry(Schedule.spaced(Duration.millis(20)))
        );

        const [took] = yield* Effect.timed(host.dispose);

        expect(Duration.toMillis(took)).toBeLessThan(1000);
        expect(yield* Fiber.join(exec)).not.toBe(200);
        expect(yield* read(termed)).toBe("termed\n");
        expect(errors).toStrictEqual([]);
      })
  );

  it.effect(
    "a host that is stopping answers each request at once with 503, sends none to its runtime, and its stop ends once the exec it was ending has",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const host = yield* started({ dir });
        const began = path.join(dir, "began");
        const ran = path.join(dir, "ran");

        const held = (name: string, digit: string) => {
          const machine = {
            name,
            instance: digit.repeat(32),
            cpu: 1,
            ramMib: 1024,
            diskGib: 10,
            handle: Handle.make(`held-${name}`),
          };

          host.fake.hold({
            state: "running",
            name,
            root: "",
            instance: machine.instance,
            handle: machine.handle,
          });

          return machine;
        };

        const dev = held("dev", "1");
        const other = held("other", "2");

        const answered = (action: string, body: unknown) =>
          Effect.timed(
            Effect.promise(
              async () =>
                await fetch(`${host.url}/host/${action}`, {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    [versionHeader]: version,
                  },
                  body: JSON.stringify(body),
                  signal: AbortSignal.timeout(3000),
                }).then(
                  (response) => response.status,
                  () => "no answer"
                )
            )
          ).pipe(
            Effect.map(([took, status]) => ({
              action,
              status,
              atOnce: Duration.toMillis(took) < 1000,
            }))
          );

        yield* Effect.forkChild(
          answered("execMachine", {
            machine: dev,
            argv: ["/bin/sh", "-c", `trap '' TERM; : >"${began}"; sleep 30`],
          })
        );

        yield* read(began).pipe(
          Effect.retry(Schedule.spaced(Duration.millis(20)))
        );

        const stopping = yield* Effect.forkChild(Effect.timed(host.dispose));

        yield* Effect.sleep(Duration.millis(300));

        const answers = yield* Effect.all(
          [
            answered("readHost", {}),
            answered("readMachines", { machines: [other] }),
            answered("readSizes", { machine: other }),
            answered("execMachine", {
              machine: other,
              argv: ["/bin/sh", "-c", `: >"${ran}"`],
            }),
            answered("runOperation", {
              id: "op-during-stop",
              boot: host.operations.boot,
              scope: { resource: "machine", name: "other" },
              sequence: 1,
              step: {
                _tag: "remove",
                keep: [],
                machine: { name: other.name, instance: other.instance },
              },
            }),
            answered("waitOperation", { id: "op-during-stop" }),
            answered("collectOperation", { id: "op-during-stop" }),
          ],
          { concurrency: "unbounded" }
        );

        const [took] = yield* Fiber.join(stopping).pipe(
          Effect.timeout(Duration.seconds(30))
        );

        expect(answers).toStrictEqual(
          answers.map(({ action }) => ({ action, status: 503, atOnce: true }))
        );
        expect(
          host.fake.calls.filter((call) => call.endsWith(" other"))
        ).toStrictEqual([]);
        expect(yield* Effect.flip(read(ran))).toBeDefined();
        expect(Duration.toMillis(took)).toBeLessThan(10_000);
      }),
    60_000
  );

  it.effect(
    "a host's stop waits on no connection whose request never completes, one that sent part of its headers, one pipelined part way behind an exec, or one whose body never comes, and ends with the exec it was ending",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const host = yield* started({ dir });
        const began = path.join(dir, "began");
        const dev = machineNamed("dev", "1");

        host.fake.hold({
          state: "running",
          name: dev.name,
          root: "",
          instance: dev.instance,
          handle: dev.handle,
        });

        const exec = yield* connection(host.url);
        const unsent = yield* connection(host.url);
        const partial = yield* connection(host.url);

        const execInput = JSON.stringify({
          machine: dev,
          argv: ["/bin/sh", "-c", `trap '' TERM; : >"${began}"; sleep 30`],
        });

        exec.socket.write(
          requestHead("execMachine", Buffer.byteLength(execInput)) + execInput
        );
        unsent.socket.write(`${requestHead("readHost", 100_000)}{"padding":"`);

        yield* read(began).pipe(
          Effect.retry(Schedule.spaced(Duration.millis(20)))
        );

        const stopping = yield* Effect.forkChild(host.dispose);

        yield* Effect.sleep(Duration.millis(300));

        const partway = "POST /host/readHost HTTP/1.1\r\nhost: host\r\n";

        partial.socket.write(partway);
        exec.socket.write(partway);

        yield* Effect.sync(exec.read).pipe(
          Effect.repeat({
            until: (answer) => answer.startsWith("HTTP/1.1 503"),
            schedule: Schedule.spaced(Duration.millis(20)),
          }),
          Effect.timeout(Duration.seconds(20))
        );

        const ended = yield* Fiber.join(stopping).pipe(
          Effect.timeoutOption(Duration.seconds(1))
        );

        const closed = yield* Effect.forEach(
          [exec, unsent, partial],
          ({ closedWithin }) => closedWithin(Duration.millis(100))
        );

        for (const { socket } of [exec, unsent, partial]) {
          socket.destroy();
        }

        expect({ stopEnded: ended._tag, closed }).toStrictEqual({
          stopEnded: "Some",
          closed: [true, true, true],
        });
      }),
    60_000
  );

  it.effect(
    "the client of an exec a host's stop cuts that reads slowly reads the host's whole 503 once the stop has ended",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const host = yield* started({ dir });
        const began = path.join(dir, "began");
        const dev = machineNamed("dev", "1");

        host.fake.hold({
          state: "running",
          name: dev.name,
          root: "",
          instance: dev.instance,
          handle: dev.handle,
        });

        const exec = yield* connection(host.url);

        const execInput = JSON.stringify({
          machine: dev,
          argv: ["/bin/sh", "-c", `trap '' TERM; : >"${began}"; sleep 30`],
        });

        exec.socket.write(
          requestHead("execMachine", Buffer.byteLength(execInput)) + execInput
        );

        yield* read(began).pipe(
          Effect.retry(Schedule.spaced(Duration.millis(20)))
        );

        exec.socket.pause();

        yield* host.dispose;

        exec.socket.resume();

        const closed = yield* exec.closedWithin(Duration.seconds(1));

        exec.socket.destroy();

        expect({ answer: emptyAnswer(exec.read()), closed }).toStrictEqual({
          answer: "HTTP/1.1 503 Service Unavailable",
          closed: true,
        });
      }),
    60_000
  );

  it.effect("a host whose address is taken says where it couldn't listen", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const { url } = yield* started({ dir });
      const port = Number(new URL(url).port);

      const failure = yield* refused(
        { ...hostConfig(dir), listen: { address: "127.0.0.1", port } },
        dir
      );

      expect(failure._tag).toBe("Internal");
      expect(failure.message).toContain(`couldn't listen on 127.0.0.1:${port}`);
    })
  );
});
