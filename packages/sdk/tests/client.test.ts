import { it } from "@effect/vitest";
import { Clock, DateTime, Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect } from "vite-plus/test";

import {
  Capacity,
  Client,
  Conflict,
  Internal,
  NotFound,
  readTimeout,
  replyTimeout,
  retryable,
  ScriptFailed,
  Unavailable,
  version,
} from "../src/index.ts";
import type { MachineSpec } from "../src/index.ts";
import { elapsing, ticking } from "./clock.ts";
import {
  checkpoint,
  machine,
  Silent,
  stubServer,
  transport,
} from "./stub-server.ts";
import type { Endpoint, StubServer, StubServerOptions } from "./stub-server.ts";

const stubs: StubServer[] = [];

const server = (options?: StubServerOptions) => {
  const stub = stubServer(options);

  stubs.push(stub);

  return stub;
};

const url = "http://cbx.test:8484";

const withClient = <A, E>(
  endpoint: Endpoint,
  use: (client: Client.Interface) => Effect.Effect<A, E>,
  options?: Client.Options
) =>
  Effect.flatMap(Client.make(url, options), use).pipe(
    Effect.provide(transport(new Map([[new URL(url).origin, endpoint]])))
  );

const everyMinute = { pollEvery: Duration.minutes(1) };

const clocked = <A, E>(wait: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const answer = yield* ticking(wait);
    const ended = yield* Clock.currentTimeMillis;

    return { answer, elapsed: Duration.millis(ended - started) };
  });

const spec: MachineSpec = {
  base: "ubuntu",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
};

const full = {
  phase: "failed",
  error: new Capacity({ message: "no room" }),
} as const;

const failing = () => {
  const stub = server({
    machines: [machine("src")],
    checkpoints: [checkpoint("snap")],
  });

  stub.script("new", [full]);
  stub.scriptCheckpoint("new", [full]);

  return stub;
};

const prebuildSpec = { ...spec, setup: { script: "#!/bin/sh\n" } };

const scriptFailed = new ScriptFailed({
  message: "setup exited 1",
  script: "setup",
});

describe("client", () => {
  afterEach(async () => {
    await Promise.all(
      stubs.splice(0).map(async (stub) => {
        await stub.dispose();
      })
    );
  });

  describe("one URL", () => {
    it.effect("every call goes to the one URL it is given", () =>
      Effect.gen(function* () {
        const stub = server({ machines: [machine("dev")] });

        const found = yield* withClient(stub, (client) =>
          client.getMachine({ id: "dev" })
        );

        expect(found.id).toBe("dev");
        expect(stub.calls).toStrictEqual(["machine.get"]);
      })
    );

    it.effect("a server URL that isn't a URL is Invalid", () =>
      Effect.gen(function* () {
        for (const bad of ["//cbx.test:8484/", "not a url"]) {
          const error = yield* Effect.flip(Client.make(bad)).pipe(
            Effect.provide(transport(new Map()))
          );

          expect(error._tag, bad).toBe("Invalid");
          expect(error.message).toContain("the server URL");
        }
      })
    );

    it.effect("the lists, hosts and capacity are what the server reports", () =>
      Effect.gen(function* () {
        const stub = server({
          machines: [machine("dev")],
          checkpoints: [
            checkpoint("snap"),
            checkpoint("taking", { phase: "capturing" }),
          ],
          capacity: {
            usage: [{ host: "linux", resource: "cpu", used: 2 }],
            unreachable: ["mac"],
          },
        });

        const seen = yield* withClient(stub, (client) =>
          Effect.all({
            machines: client.machines,
            checkpoints: client.checkpoints,
            hosts: client.hosts,
            capacity: client.capacity,
          })
        );

        expect(seen.machines.map(({ id }) => id)).toStrictEqual(["dev"]);
        expect(seen.checkpoints.map(({ id }) => id)).toStrictEqual(["snap"]);
        expect(seen.hosts).toMatchObject([{ state: "up", bases: ["ubuntu"] }]);
        expect(seen.capacity.unreachable).toStrictEqual(["mac"]);
      })
    );

    it.effect("every call kind sends the SDK's version", () =>
      Effect.gen(function* () {
        const stub = server();

        yield* withClient(stub, (client) =>
          Effect.gen(function* () {
            yield* client.hosts;
            yield* client.machines;
            yield* client.checkpoints;
            yield* client.capacity;
            yield* client.create("dev", spec);
            yield* client.getMachine({ id: "dev" });
            yield* client.startMachine({ id: "dev" });
            yield* client.stopMachine({ id: "dev" });
            yield* client.pauseMachine({ id: "dev" });
            yield* client.resizeMachine({ id: "dev", cpu: 2 });
            yield* client.forkMachine({ machine: "dev", name: "copy" });
            yield* client.captureCheckpoint({ machine: "dev", name: "snap" });
            yield* client.getCheckpoint({ id: "snap" });
            yield* client.restoreMachine({ checkpoint: "snap", name: "again" });
            yield* client.prebuild({
              ...spec,
              setup: { script: "#!/bin/sh\n" },
            });
            yield* client.deleteCheckpoint({ id: "snap" });
            yield* client.deleteMachine({ id: "dev" });
          })
        );

        expect(stub.calls).toContain("prebuild.get");
        expect(stub.versions).toStrictEqual(stub.calls.map(() => version));
      })
    );

    it.effect("a create asks the server to run the setup with `fresh`", () =>
      Effect.gen(function* () {
        const stub = server();

        yield* withClient(stub, (client) =>
          Effect.andThen(
            client.create("plain", spec),
            client.create("fresh", spec, { fresh: true })
          )
        );

        expect(stub.creates.map(({ id, fresh }) => [id, fresh])).toStrictEqual([
          ["plain", undefined],
          ["fresh", true],
        ]);
      })
    );
  });

  describe("errors", () => {
    it.effect(
      "the server's error comes back naming the action and the ID",
      () =>
        Effect.gen(function* () {
          const error = yield* withClient(server(), (client) =>
            Effect.flip(client.getMachine({ id: "gone" }))
          );

          expect(error._tag).toBe("NotFound");
          expect(error).toMatchObject({ action: "getMachine", id: "gone" });
          expect(error).not.toHaveProperty("host");
        })
    );

    it.effect("a base no host offers is NotOffered naming the base", () =>
      Effect.gen(function* () {
        const error = yield* withClient(
          server({ bases: ["macos"] }),
          (client) => Effect.flip(client.create("dev", spec))
        );

        expect(error._tag).toBe("NotOffered");
        expect(error).toMatchObject({
          action: "createMachine",
          base: "ubuntu",
          made: "dev",
        });
      })
    );

    it.effect(
      "a create name that isn't a valid name is Invalid and sends nothing",
      () =>
        Effect.gen(function* () {
          const stub = server();

          for (const name of ["2dev", "not a name", "linux_dev"]) {
            const error = yield* withClient(stub, (client) =>
              Effect.flip(client.create(name, spec))
            );

            expect(error._tag, name).toBe("Invalid");
            expect(error.message).toContain(`createMachine ${name}`);
            expect(error.message).toContain("starts with a letter");
            expect(error).toMatchObject({ action: "createMachine" });
          }

          expect(stub.calls).toStrictEqual([]);
        })
    );

    it.effect(
      "a malformed ID is Invalid naming the action and sends nothing",
      () =>
        Effect.gen(function* () {
          const stub = server();

          const error = yield* withClient(stub, (client) =>
            Effect.flip(client.startMachine({ id: "not an id" }))
          );

          expect(error._tag).toBe("Invalid");
          expect(error).toMatchObject({ action: "startMachine" });
          expect(stub.calls).toStrictEqual([]);
        })
    );

    it.effect(
      "a spec that doesn't encode is Invalid, sends nothing, and never carries its script",
      () =>
        Effect.gen(function* () {
          const stub = server();
          const marker = "setup-text-marker";

          const error = yield* withClient(stub, (client) =>
            Effect.flip(
              client.create("dev", {
                ...spec,
                cpu: 0,
                setup: {
                  script: `#!/bin/sh\necho ${marker}\n`,
                  timeoutSeconds: 60,
                },
              })
            )
          );

          expect(error._tag).toBe("Invalid");
          expect(error.message).toContain("createMachine dev");
          expect(error.message).not.toContain(marker);
          expect(stub.calls).toStrictEqual([]);
        })
    );

    it.effect(
      "the server's Unavailable is its reply: a refusal it says can be retried",
      () =>
        Effect.gen(function* () {
          const stub = server({
            refuse: {
              createMachine: new Unavailable({
                message: "no host answered",
                readOnly: true,
              }),
            },
          });

          const error = yield* withClient(stub, (client) =>
            Effect.flip(client.create("dev", spec))
          );

          expect(error._tag).toBe("Unavailable");
          expect(retryable(error)).toBe(true);
          expect(stub.calls).toStrictEqual(["machine.create"]);
        })
    );

    it.effect(
      "a name that is taken is Conflict, naming what the call makes",
      () =>
        Effect.gen(function* () {
          const stub = server({
            refuse: {
              createMachine: new Conflict({ message: "dev exists", id: "dev" }),
            },
          });

          const error = yield* withClient(stub, (client) =>
            Effect.flip(client.create("dev", spec))
          );

          expect(error._tag).toBe("Conflict");
          expect(error).toMatchObject({ id: "dev", made: "dev" });
        })
    );
  });

  describe("no reply", () => {
    it.effect(
      "a mutation whose reply is lost is Unavailable, names the ID, and is not retried",
      () =>
        Effect.gen(function* () {
          const stub = server();

          const error = yield* withClient({ lost: stub }, (client) =>
            Effect.flip(client.create("dev", spec))
          );

          expect(error._tag).toBe("Unavailable");
          expect(retryable(error)).toBe(false);
          expect(error.message).toContain("read dev");
          expect(error.message).toContain("may have run");
          expect(error).toMatchObject({ readOnly: false, made: "dev" });
          expect(stub.calls).toStrictEqual(["machine.create"]);
        })
    );

    it.effect(
      "a fork whose reply is lost is about its source and names the machine it makes",
      () =>
        Effect.gen(function* () {
          const stub = server({ machines: [machine("src")] });

          const error = yield* withClient({ lost: stub }, (client) =>
            Effect.flip(client.forkMachine({ machine: "src", name: "copy" }))
          );

          expect(error._tag).toBe("Unavailable");
          expect(retryable(error)).toBe(false);
          expect(error.message).toContain("read copy");
          expect(error).toMatchObject({
            action: "forkMachine",
            id: "src",
            made: "copy",
          });
          expect(stub.calls).toStrictEqual(["machine.fork"]);
        })
    );

    it.effect(
      "a read that can't reach the server is Unavailable and retryable",
      () =>
        Effect.gen(function* () {
          const error = yield* withClient("down", (client) =>
            Effect.flip(client.getMachine({ id: "dev" }))
          );

          expect(error._tag).toBe("Unavailable");
          expect(error.message).toContain(url);
          expect(retryable(error)).toBe(true);
        })
    );

    it.effect(
      "a list that can't reach the server is Unavailable and retryable",
      () =>
        Effect.gen(function* () {
          const error = yield* withClient("down", (client) =>
            Effect.flip(client.machines)
          );

          expect(error._tag).toBe("Unavailable");
          expect(retryable(error)).toBe(true);
        })
    );

    it.effect(
      "an origin nothing serves is the same as a server that's down",
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flatMap(
            Client.make("http://elsewhere.test"),
            (client) => Effect.flip(client.machines)
          ).pipe(Effect.provide(transport(new Map())));

          expect(error._tag).toBe("Unavailable");
        })
    );

    it.effect(
      "a read that outlasts the reply timeout is Unavailable and retryable",
      () =>
        Effect.gen(function* () {
          const silent = new Silent();

          const error = yield* elapsing(
            "50 millis",
            withClient(
              silent,
              (client) => Effect.flip(client.getMachine({ id: "dev" })),
              { replyTimeout: Duration.millis(50) }
            ),
            silent.reached
          );

          expect(error._tag).toBe("Unavailable");
          expect(retryable(error)).toBe(true);
          expect(silent.aborted).toBe(1);
        })
    );

    it.effect(
      "a mutation that outlasts the reply timeout is a lost reply, naming the ID to read",
      () =>
        Effect.gen(function* () {
          const silent = new Silent();

          const error = yield* elapsing(
            "50 millis",
            withClient(
              silent,
              (client) => Effect.flip(client.create("dev", spec)),
              { replyTimeout: Duration.millis(50) }
            ),
            silent.reached
          );

          expect(error._tag).toBe("Unavailable");
          expect(retryable(error)).toBe(false);
          expect(error.message).toContain("timed out after 50ms");
          expect(error.message).toContain("may have run: read dev to see");
        })
    );

    it.effect(
      "a reply is waited for past the control plane's wait on a host, and the wait's timeout doesn't bound it",
      () =>
        Effect.gen(function* () {
          const error = yield* withClient(
            new Silent(),
            (client) =>
              Effect.gen(function* () {
                const read = yield* Effect.forkChild(
                  Effect.flip(client.getMachine({ id: "dev" }))
                );

                yield* Effect.yieldNow;
                yield* TestClock.adjust(readTimeout);

                expect(read.pollUnsafe()).toBeUndefined();

                yield* TestClock.adjust(
                  Duration.subtract(replyTimeout, readTimeout)
                );

                return yield* Fiber.join(read);
              }),
            { timeout: Duration.millis(50) }
          );

          expect(error._tag).toBe("Unavailable");
          expect(error.message).toContain(
            `timed out after ${Duration.format(replyTimeout)}`
          );
        })
    );
  });

  describe("the wait on a machine", () => {
    it.effect(
      "a mutation answers with the first rest it reads, sleeping for nothing",
      () =>
        Effect.gen(function* () {
          const stub = server();

          const made = yield* withClient(stub, (client) =>
            client.create("dev", spec)
          );

          expect(made).toMatchObject({
            id: "dev",
            state: "running",
            desired: "running",
            phase: "settled",
          });
          expect(stub.calls).toStrictEqual(["machine.create", "machine.get"]);
        })
    );

    it.effect("each phase on the way is read past, up to the rest", () =>
      Effect.gen(function* () {
        for (const phase of [
          "observing",
          "creating",
          "starting",
          "stopping",
          "pausing",
          "resizing",
          "deleting",
        ] as const) {
          const stub = server({
            machines: [
              machine("dev", { state: "stopped", desired: "stopped" }),
            ],
          });

          stub.script("dev", [phase, "settled"]);

          const answer = yield* ticking(
            withClient(
              stub,
              (client) => client.startMachine({ id: "dev" }),
              everyMinute
            )
          );

          expect(answer.state, phase).toBe("running");
          expect(stub.calls, phase).toStrictEqual([
            "machine.start",
            "machine.get",
            "machine.get",
          ]);
        }
      })
    );

    it.effect("each request rests at what it asked", () =>
      Effect.gen(function* () {
        const stub = server({ machines: [machine("dev")] });

        const states = yield* withClient(stub, (client) =>
          Effect.gen(function* () {
            const paused = yield* client.pauseMachine({ id: "dev" });
            const started = yield* client.startMachine({ id: "dev" });
            const stopped = yield* client.stopMachine({ id: "dev" });
            const staysStopped = yield* client.pauseMachine({ id: "dev" });

            return [paused, started, stopped, staysStopped].map(
              ({ state }) => state
            );
          })
        );

        expect(states).toStrictEqual([
          "paused",
          "running",
          "stopped",
          "stopped",
        ]);
      })
    );

    it.effect(
      "a resize rests at the sizes, under what the machine was asked to be",
      () =>
        Effect.gen(function* () {
          const stub = server({
            machines: [
              machine("dev", { state: "stopped", desired: "stopped" }),
            ],
          });

          stub.script("dev", ["resizing", "settled"]);

          const resized = yield* ticking(
            withClient(
              stub,
              (client) => client.resizeMachine({ id: "dev", cpu: 4 }),
              everyMinute
            )
          );

          expect(resized).toMatchObject({ cpu: 4, state: "stopped" });
        })
    );

    it.effect(
      "a resize rests at its sizes under a wish asked after it, as any wish but a delete leaves it to run",
      () =>
        Effect.gen(function* () {
          const stub = server({ machines: [machine("dev")] });

          stub.script("dev", [
            { desired: "stopped", phase: "resizing" },
            { desired: "stopped", state: "stopped", phase: "settled" },
          ]);

          const resized = yield* ticking(
            withClient(
              stub,
              (client) => client.resizeMachine({ id: "dev", cpu: 4 }),
              everyMinute
            )
          );

          expect(resized).toMatchObject({ cpu: 4, desired: "stopped" });
        })
    );

    it.effect("a resize a delete lands on is Superseded by it", () =>
      Effect.gen(function* () {
        const stub = server({ machines: [machine("dev")] });

        stub.script("dev", [
          {
            desired: "deleted",
            phase: "failed",
            error: new Internal({ message: "the VM wouldn't go" }),
          },
        ]);

        const error = yield* withClient(stub, (client) =>
          Effect.flip(client.resizeMachine({ id: "dev", cpu: 4 }))
        );

        expect(error).toMatchObject({ _tag: "Superseded", by: "deleted" });
      })
    );

    it.effect(
      "a failed resize answers the row's error, keeping the action",
      () =>
        Effect.gen(function* () {
          const stub = server({ machines: [machine("dev")] });

          stub.script("dev", [
            { phase: "failed", error: new Internal({ message: "part way" }) },
          ]);

          const error = yield* withClient(stub, (client) =>
            Effect.flip(client.resizeMachine({ id: "dev", cpu: 4 }))
          );

          expect(error._tag).toBe("Internal");
          expect(error).toMatchObject({ action: "resizeMachine", id: "dev" });
        })
    );

    it.effect(
      "a rest at failed answers the row's error, naming the action",
      () =>
        Effect.gen(function* () {
          const stub = server({ machines: [machine("dev")] });

          stub.script("dev", [{ phase: "failed", error: scriptFailed }]);

          const error = yield* withClient(stub, (client) =>
            Effect.flip(client.startMachine({ id: "dev" }))
          );

          expect(error._tag).toBe("ScriptFailed");
          expect(error.message).toBe("setup exited 1");
          expect(error).toMatchObject({
            action: "startMachine",
            id: "dev",
            script: "setup",
          });
        })
    );

    it.effect("a rest at failed with no error is Internal", () =>
      Effect.gen(function* () {
        const stub = server({ machines: [machine("dev")] });

        stub.script("dev", ["failed"]);

        const error = yield* withClient(stub, (client) =>
          Effect.flip(client.stopMachine({ id: "dev" }))
        );

        expect(error._tag).toBe("Internal");
        expect(error.message).toContain("saying nothing");
      })
    );

    it.effect("a rest at lost is Missing: it can only be deleted", () =>
      Effect.gen(function* () {
        const stub = server({ machines: [machine("dev")] });

        stub.script("dev", ["lost"]);

        const error = yield* withClient(stub, (client) =>
          Effect.flip(client.startMachine({ id: "dev" }))
        );

        expect(error._tag).toBe("Missing");
        expect(error).toMatchObject({
          machine: "dev",
          action: "startMachine",
        });
        expect(retryable(error)).toBe(false);
      })
    );

    it.effect(
      "a machine whose host can't be read tells nothing of the request, so the wait reads on",
      () =>
        Effect.gen(function* () {
          const stub = server();

          stub.script("dev", ["waiting", "waiting", "settled"]);

          const made = yield* ticking(
            withClient(
              stub,
              (client) => client.create("dev", spec),
              everyMinute
            )
          );

          expect(made.phase).toBe("settled");
        })
    );

    it.effect(
      "a host that stays unread ends the wait as a long outage does, saying the request is saved, and isn't retryable",
      () =>
        Effect.gen(function* () {
          const stub = server();

          stub.script("dev", ["down", "waiting"]);

          const { answer: error, elapsed } = yield* clocked(
            withClient(
              stub,
              (client) => Effect.flip(client.create("dev", spec)),
              everyMinute
            )
          );

          expect(error._tag).toBe("Unavailable");
          expect(error).toMatchObject({ readOnly: false, made: "dev" });
          expect(error.message).toContain("can't be reached");
          expect(error.message).toContain("the request is saved");
          expect(retryable(error)).toBe(false);
          expect(
            Duration.isGreaterThanOrEqualTo(elapsed, Duration.minutes(2))
          ).toBe(true);
          expect(Duration.isLessThan(elapsed, Duration.minutes(4))).toBe(true);
        })
    );

    it.effect(
      "a machine deleted and made again under its name during the wait is Superseded by the delete",
      () =>
        Effect.gen(function* () {
          const stub = server({
            machines: [
              machine("dev", { state: "stopped", desired: "stopped" }),
            ],
          });

          stub.script("dev", [
            {
              createdAt: DateTime.makeUnsafe("2026-10-02T00:00:00Z"),
              state: "running",
              desired: "running",
              phase: "settled",
            },
          ]);

          const error = yield* withClient(stub, (client) =>
            Effect.flip(client.startMachine({ id: "dev" }))
          );

          expect(error).toMatchObject({
            _tag: "Superseded",
            by: "deleted",
            action: "startMachine",
            id: "dev",
          });
        })
    );

    it.effect(
      "a later request's rest is Superseded, naming what it asked",
      () =>
        Effect.gen(function* () {
          const stub = server({ machines: [machine("dev")] });

          stub.script("dev", [
            { desired: "stopped", state: "stopped", phase: "settled" },
          ]);

          const error = yield* withClient(stub, (client) =>
            Effect.flip(client.startMachine({ id: "dev" }))
          );

          expect(error._tag).toBe("Superseded");
          expect(error).toMatchObject({
            by: "stopped",
            action: "startMachine",
            id: "dev",
          });
        })
    );

    it.effect("a later request wins over how the row failed", () =>
      Effect.gen(function* () {
        const stub = server({ machines: [machine("dev")] });

        stub.script("dev", [
          { desired: "paused", phase: "failed", error: scriptFailed },
        ]);

        const error = yield* withClient(stub, (client) =>
          Effect.flip(client.startMachine({ id: "dev" }))
        );

        expect(error).toMatchObject({ _tag: "Superseded", by: "paused" });
      })
    );

    it.effect("a row deleted during the wait is Superseded by the delete", () =>
      Effect.gen(function* () {
        const stub = server({ machines: [machine("dev")] });

        stub.script("dev", ["starting", "gone"]);

        const error = yield* ticking(
          withClient(
            stub,
            (client) => Effect.flip(client.startMachine({ id: "dev" })),
            everyMinute
          )
        );

        expect(error._tag).toBe("Superseded");
        expect(error).toMatchObject({
          by: "deleted",
          action: "startMachine",
          id: "dev",
        });
      })
    );

    it.effect(
      "a recorded row that already says deleted is Superseded at once, sending no read",
      () =>
        Effect.gen(function* () {
          for (const noWait of [false, true]) {
            const stub = server({
              machines: [
                machine("dev", { desired: "deleted", phase: "deleting" }),
              ],
            });

            const error = yield* withClient(
              stub,
              (client) => Effect.flip(client.startMachine({ id: "dev" })),
              { noWait }
            );

            expect(error).toMatchObject({ _tag: "Superseded", by: "deleted" });
            expect(stub.calls).toStrictEqual(["machine.start"]);
          }
        })
    );

    it.effect("answerOf says of a rest what the wait would", () =>
      Effect.gen(function* () {
        const rest = machine("dev");

        expect(yield* Client.answerOf(rest, "running")).toBe(rest);

        const superseded = yield* Effect.flip(Client.answerOf(rest, "stopped"));

        expect(superseded).toMatchObject({ _tag: "Superseded", by: "running" });
      })
    );
  });

  describe("a delete", () => {
    it.effect("a delete waits for the row to go", () =>
      Effect.gen(function* () {
        const stub = server({ machines: [machine("dev")] });

        stub.script("dev", ["deleting", "deleting", "gone"]);

        const deleted = yield* ticking(
          withClient(
            stub,
            (client) => client.deleteMachine({ id: "dev" }),
            everyMinute
          )
        );

        expect(deleted).toBe("deleted");
        expect(stub.held()).toStrictEqual([]);
        expect(stub.calls).toStrictEqual([
          "machine.delete",
          "machine.get",
          "machine.get",
          "machine.get",
        ]);
      })
    );

    it.effect(
      "a delete of a resource that is already gone is absent, and done",
      () =>
        Effect.gen(function* () {
          const stub = server({
            machines: [machine("dev")],
            checkpoints: [checkpoint("snap")],
          });

          const deleted = yield* withClient(stub, (client) =>
            Effect.all([
              client.deleteMachine({ id: "dev" }),
              client.deleteMachine({ id: "dev" }),
              client.deleteCheckpoint({ id: "snap" }),
              client.deleteCheckpoint({ id: "snap" }),
            ])
          );

          expect(deleted).toStrictEqual([
            "deleted",
            "absent",
            "deleted",
            "absent",
          ]);
        })
    );

    it.effect("a failed delete answers the row's error", () =>
      Effect.gen(function* () {
        const stub = server({ machines: [machine("dev")] });

        stub.script("dev", [
          {
            phase: "failed",
            error: new Internal({ message: "the VM wouldn't go" }),
          },
        ]);

        const error = yield* withClient(stub, (client) =>
          Effect.flip(client.deleteMachine({ id: "dev" }))
        );

        expect(error._tag).toBe("Internal");
        expect(error.message).toBe("the VM wouldn't go");
        expect(error).toMatchObject({ action: "deleteMachine", id: "dev" });
      })
    );

    it.effect(
      "a delete reads on through a host it can't read, and through a step it cut short, whose failure isn't the delete's",
      () =>
        Effect.gen(function* () {
          const stub = server({ machines: [machine("dev")] });

          stub.script("dev", [
            {
              desired: "deleted",
              phase: "deleting",
              error: new Internal({ message: "the disk didn't grow" }),
            },
            "waiting",
            "gone",
          ]);

          const deleted = yield* ticking(
            withClient(
              stub,
              (client) => client.deleteMachine({ id: "dev" }),
              everyMinute
            )
          );

          expect(deleted).toBe("deleted");
        })
    );

    it.effect(
      "a delete whose host stays unread ends saying it is saved, and isn't retryable",
      () =>
        Effect.gen(function* () {
          const stub = server({ machines: [machine("dev")] });

          stub.script("dev", ["waiting"]);

          const error = yield* ticking(
            withClient(
              stub,
              (client) => Effect.flip(client.deleteMachine({ id: "dev" })),
              everyMinute
            )
          );

          expect(error._tag).toBe("Unavailable");
          expect(error.message).toContain("the request is saved");
          expect(retryable(error)).toBe(false);
        })
    );

    it.effect(
      "a create of the name during the wait ends it: the delete is done",
      () =>
        Effect.gen(function* () {
          const stub = server({ machines: [machine("dev")] });

          stub.script("dev", [
            { desired: "running", phase: "creating", state: "unknown" },
          ]);

          const deleted = yield* withClient(stub, (client) =>
            client.deleteMachine({ id: "dev" })
          );

          expect(deleted).toBe("deleted");
        })
    );

    it.effect(
      "a create of the name whose host can't be read still ends the delete's wait: the delete is done",
      () =>
        Effect.gen(function* () {
          const stub = server({ machines: [machine("dev")] });

          stub.script("dev", [{ desired: "running", phase: "waiting" }]);

          const deleted = yield* ticking(
            withClient(
              stub,
              (client) => client.deleteMachine({ id: "dev" }),
              everyMinute
            )
          );

          expect(deleted).toBe("deleted");
        })
    );

    it.effect("a checkpoint's delete waits for it to go", () =>
      Effect.gen(function* () {
        const stub = server({ checkpoints: [checkpoint("snap")] });

        stub.scriptCheckpoint("snap", ["deleting", "gone"]);

        const deleted = yield* ticking(
          withClient(
            stub,
            (client) => client.deleteCheckpoint({ id: "snap" }),
            everyMinute
          )
        );

        expect(deleted).toBe("deleted");
        expect(stub.calls).toStrictEqual([
          "checkpoint.delete",
          "checkpoint.get",
          "checkpoint.get",
        ]);
      })
    );

    it.effect("a checkpoint's failed delete answers its error", () =>
      Effect.gen(function* () {
        const stub = server({ checkpoints: [checkpoint("snap")] });

        stub.scriptCheckpoint("snap", [
          { error: new Internal({ message: "still there" }) },
        ]);

        const error = yield* withClient(stub, (client) =>
          Effect.flip(client.deleteCheckpoint({ id: "snap" }))
        );

        expect(error.message).toBe("still there");
        expect(error).toMatchObject({
          action: "deleteCheckpoint",
          id: "snap",
        });
      })
    );

    it.effect(
      "a capture of the name during the wait ends it: the delete is done",
      () =>
        Effect.gen(function* () {
          const stub = server({ checkpoints: [checkpoint("snap")] });

          stub.scriptCheckpoint("snap", ["capturing"]);

          const deleted = yield* withClient(stub, (client) =>
            client.deleteCheckpoint({ id: "snap" })
          );

          expect(deleted).toBe("deleted");
        })
    );
  });

  describe("the wait on a checkpoint and a prebuild", () => {
    it.effect("a capture waits for ready", () =>
      Effect.gen(function* () {
        const stub = server({ machines: [machine("dev")] });

        stub.scriptCheckpoint("snap", ["capturing", "ready"]);

        const captured = yield* ticking(
          withClient(
            stub,
            (client) =>
              client.captureCheckpoint({ machine: "dev", name: "snap" }),
            everyMinute
          )
        );

        expect(captured).toMatchObject({
          id: "snap",
          machine: "dev",
          phase: "ready",
        });
        expect(stub.calls).toStrictEqual([
          "checkpoint.capture",
          "checkpoint.get",
          "checkpoint.get",
        ]);
      })
    );

    it.effect("a capture that fails answers its error", () =>
      Effect.gen(function* () {
        const stub = server({ machines: [machine("dev")] });

        stub.scriptCheckpoint("snap", ["failed"]);

        const silent = yield* withClient(stub, (client) =>
          Effect.flip(
            client.captureCheckpoint({ machine: "dev", name: "snap" })
          )
        );

        expect(silent._tag).toBe("Internal");
        expect(silent.message).toContain("checkpoint snap failed");
      })
    );

    it.effect("a checkpoint deleted during a capture's wait is NotFound", () =>
      Effect.gen(function* () {
        const stub = server({ machines: [machine("dev")] });

        stub.scriptCheckpoint("snap", ["gone"]);

        const error = yield* withClient(stub, (client) =>
          Effect.flip(
            client.captureCheckpoint({ machine: "dev", name: "snap" })
          )
        );

        expect(error._tag).toBe("NotFound");
        expect(error).toMatchObject({
          action: "captureCheckpoint",
          id: "snap",
          made: "snap",
        });
      })
    );

    it.effect("a prebuild waits for its build to end", () =>
      Effect.gen(function* () {
        const stub = server();

        stub.scriptBuild("prebuilt-0", ["building", "built"]);

        const build = yield* ticking(
          withClient(
            stub,
            (client) => client.prebuild(prebuildSpec),
            everyMinute
          )
        );

        expect(build).toStrictEqual({ id: "prebuilt-0", phase: "built" });
        expect(stub.heldCheckpoints()).toStrictEqual(["prebuilt-0"]);
      })
    );

    it.effect("a prebuild that fails answers the build's error", () =>
      Effect.gen(function* () {
        const stub = server();

        stub.scriptBuild("prebuilt-0", [
          { phase: "failed", error: scriptFailed },
        ]);

        const error = yield* withClient(stub, (client) =>
          Effect.flip(client.prebuild(prebuildSpec))
        );

        expect(error._tag).toBe("ScriptFailed");
        expect(error).toMatchObject({
          action: "prebuildCheckpoint",
          id: "prebuilt-0",
        });
      })
    );

    it.effect("a build the server forgot is NotFound", () =>
      Effect.gen(function* () {
        const stub = server();

        stub.scriptBuild("prebuilt-0", ["gone"]);

        const error = yield* withClient(stub, (client) =>
          Effect.flip(client.prebuild(prebuildSpec))
        );

        expect(error._tag).toBe("NotFound");
      })
    );
  });

  describe("an outage during a wait", () => {
    it.effect("a short outage is read through", () =>
      Effect.gen(function* () {
        const stub = server();

        stub.script("dev", ["down", "down", "settled"]);

        const made = yield* ticking(
          withClient(stub, (client) => client.create("dev", spec), everyMinute)
        );

        expect(made.phase).toBe("settled");
      })
    );

    it.effect(
      "a long outage ends Unavailable, saying the request is saved, and isn't retryable",
      () =>
        Effect.gen(function* () {
          const stub = server();

          stub.script("dev", ["down"]);

          const { answer: error, elapsed } = yield* clocked(
            withClient(
              stub,
              (client) => Effect.flip(client.create("dev", spec)),
              everyMinute
            )
          );

          expect(error._tag).toBe("Unavailable");
          expect(error.message).toContain("the request is saved");
          expect(error).toMatchObject({
            readOnly: false,
            action: "createMachine",
            id: "dev",
            made: "dev",
          });
          expect(retryable(error)).toBe(false);
          expect(
            Duration.isGreaterThanOrEqualTo(elapsed, Duration.minutes(2))
          ).toBe(true);
          expect(Duration.isLessThan(elapsed, Duration.minutes(4))).toBe(true);
        })
    );

    it.effect("a read between outages starts the outage over", () =>
      Effect.gen(function* () {
        const stub = server();

        stub.script("dev", [
          "down",
          "down",
          "creating",
          "down",
          "down",
          "settled",
        ]);

        const made = yield* ticking(
          withClient(stub, (client) => client.create("dev", spec), {
            pollEvery: Duration.seconds(90),
          })
        );

        expect(made.phase).toBe("settled");
      })
    );

    it.effect(
      "an outage is measured in time: a server gone silent ends the wait as one gone down does",
      () =>
        Effect.gen(function* () {
          const stub = server({ machines: [machine("dev")] });
          const { origin } = new URL(url);
          const network = new Map<string, Endpoint>([[origin, stub]]);

          stub.script("dev", ["starting"]);

          const { answer: error, elapsed } = yield* clocked(
            Effect.gen(function* () {
              const client = yield* Client.make(url, {
                pollEvery: Duration.seconds(1),
              });

              const waited = yield* Effect.forkChild(
                Effect.flip(client.startMachine({ id: "dev" }))
              );

              while (!stub.calls.includes("machine.get")) {
                yield* TestClock.withLive(Effect.sleep(Duration.millis(1)));
              }

              network.set(origin, new Silent());

              return yield* Fiber.join(waited);
            }).pipe(Effect.provide(transport(network)))
          );

          expect(error._tag).toBe("Unavailable");
          expect(retryable(error)).toBe(false);
          expect(Duration.isLessThan(elapsed, Duration.minutes(4))).toBe(true);
        })
    );
  });

  describe("options", () => {
    it.effect(
      "a wait that outlasts `timeout` is Unavailable: the request goes on",
      () =>
        Effect.gen(function* () {
          const stub = server();

          stub.script("dev", ["creating"]);

          const { answer: error, elapsed } = yield* clocked(
            withClient(
              stub,
              (client) => Effect.flip(client.create("dev", spec)),
              { timeout: Duration.minutes(5), ...everyMinute }
            )
          );

          expect(error._tag).toBe("Unavailable");
          expect(error.message).toContain("didn't rest within 5m");
          expect(error.message).toContain("the request is saved");
          expect(error).toMatchObject({
            readOnly: false,
            action: "createMachine",
            made: "dev",
          });
          expect(retryable(error)).toBe(false);
          expect(Duration.isLessThan(elapsed, Duration.minutes(6))).toBe(true);
        })
    );

    it.effect(
      "`noWait` answers the recorded row of every mutation, reading nothing",
      () =>
        Effect.gen(function* () {
          const stub = server({
            machines: [machine("dev")],
            checkpoints: [checkpoint("snap")],
          });

          const answers = yield* withClient(
            stub,
            (client) =>
              Effect.all({
                created: client.create("new", spec),
                started: client.startMachine({ id: "dev" }),
                stopped: client.stopMachine({ id: "dev" }),
                paused: client.pauseMachine({ id: "dev" }),
                resized: client.resizeMachine({ id: "dev", cpu: 2 }),
                forked: client.forkMachine({ machine: "dev", name: "copy" }),
                restored: client.restoreMachine({
                  checkpoint: "snap",
                  name: "again",
                }),
                captured: client.captureCheckpoint({
                  machine: "dev",
                  name: "taken",
                }),
                built: client.prebuild(prebuildSpec),
                deleted: client.deleteMachine({ id: "dev" }),
                discarded: client.deleteCheckpoint({ id: "snap" }),
              }),
            { noWait: true }
          );

          expect(answers).toMatchObject({
            created: { phase: "observing" },
            started: { phase: "observing", desired: "running" },
            stopped: { phase: "observing", desired: "stopped" },
            paused: { phase: "observing", desired: "paused" },
            resized: { phase: "observing", cpu: 2 },
            forked: { phase: "observing" },
            restored: { phase: "observing" },
            captured: { phase: "capturing" },
            built: { phase: "building" },
            deleted: "deleted",
            discarded: "deleted",
          });
          expect(
            stub.calls.filter((call) => call.endsWith(".get"))
          ).toStrictEqual([]);
        })
    );
  });

  describe("made", () => {
    it.effect("a failure of a create names what it makes", () =>
      Effect.gen(function* () {
        const error = yield* withClient(failing(), (client) =>
          Effect.flip(client.create("new", spec))
        );

        expect(error).toMatchObject({
          _tag: "Capacity",
          action: "createMachine",
          id: "new",
          made: "new",
        });
        expect(retryable(error)).toBe(true);
      })
    );

    it.effect("a failure of a fork names what it makes", () =>
      Effect.gen(function* () {
        const error = yield* withClient(failing(), (client) =>
          Effect.flip(client.forkMachine({ machine: "src", name: "new" }))
        );

        expect(error).toMatchObject({
          _tag: "Capacity",
          action: "forkMachine",
          made: "new",
        });
      })
    );

    it.effect("a failure of a restore names what it makes", () =>
      Effect.gen(function* () {
        const error = yield* withClient(failing(), (client) =>
          Effect.flip(
            client.restoreMachine({ checkpoint: "snap", name: "new" })
          )
        );

        expect(error).toMatchObject({
          _tag: "Capacity",
          action: "restoreMachine",
          made: "new",
        });
      })
    );

    it.effect("a failure of a capture names what it makes", () =>
      Effect.gen(function* () {
        const error = yield* withClient(failing(), (client) =>
          Effect.flip(client.captureCheckpoint({ machine: "src", name: "new" }))
        );

        expect(error).toMatchObject({
          _tag: "Capacity",
          action: "captureCheckpoint",
          made: "new",
        });
      })
    );

    it.effect(
      "a refusal of a restore is about the checkpoint and names what it makes",
      () =>
        Effect.gen(function* () {
          const error = yield* withClient(server(), (client) =>
            Effect.flip(
              client.restoreMachine({ checkpoint: "gone", name: "new" })
            )
          );

          expect(error).toMatchObject({
            _tag: "NotFound",
            action: "restoreMachine",
            id: "gone",
            made: "new",
          });
        })
    );

    it.effect(
      "a capture of a machine that isn't there names what it makes",
      () =>
        Effect.gen(function* () {
          const stub = server({
            refuse: {
              captureCheckpoint: new NotFound({
                message: "no machine",
                id: "dev",
              }),
            },
          });

          const error = yield* withClient(stub, (client) =>
            Effect.flip(
              client.captureCheckpoint({ machine: "dev", name: "new" })
            )
          );

          expect(error).toMatchObject({ id: "dev", made: "new" });
        })
    );
  });
});
