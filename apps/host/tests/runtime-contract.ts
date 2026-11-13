import type { Handle } from "@clankerbox/host-contract";
import { describe, it } from "@effect/vitest";
import {
  Capacity,
  fitted,
  resizable,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Stream } from "effect";
import type { Duration, Scope } from "effect";
import { expect } from "vite-plus/test";

import type {
  Bind,
  Execution,
  Interface as Runtime,
  Origin,
  Sized,
  Sizes,
} from "../src/runtime.ts";

export type Dropped = "make" | "delete";

export interface Faults {
  readonly drift: (instance: string) => Effect.Effect<void>;
  readonly landLate: (after: Duration.Input) => Effect.Effect<void>;
  readonly quota: (on: boolean) => Effect.Effect<void>;
  readonly dropAnswer: (dropping: Dropped) => Effect.Effect<void>;
}

export interface Fixture {
  readonly runtime: Runtime;
  readonly faults: Faults | undefined;
  /**
   * Puts a machine and a checkpoint in the provider's account without this host's mark, as another
   * host or user of the account would. Every runtime with `owned` gives it.
   */
  readonly unmarked: Effect.Effect<void> | undefined;
}

export interface Subject {
  readonly name: string;
  readonly image: string;
  readonly sizes: Sizes;
  readonly fixture: Effect.Effect<Fixture, never, Scope.Scope>;
}

let nextPort = 23_000;

const bindFor = (runtime: Runtime): Bind => {
  nextPort += 1;

  return runtime.reach._tag === "published"
    ? { _tag: "forward", port: nextPort }
    : { _tag: "none" };
};

const first = "0123456789abcdef".repeat(2);

const second = "76543210".repeat(4);

const third = "fedcba98".repeat(4);

const fourth = "89abcdef".repeat(4);

const outputOf = (execution: Execution) =>
  Stream.mkString(Stream.decodeText(execution.output));

const stateOf = (runtime: Runtime, machine: Sized) =>
  Effect.map(
    runtime.observe([machine]),
    (observed) => observed.get(machine.name) ?? "unknown"
  );

const inCaptureState = (runtime: Runtime, machine: Sized) =>
  runtime.traits.captureFrom === "stopped"
    ? runtime.stop(machine)
    : Effect.void;

const outOfCaptureState = (runtime: Runtime, machine: Sized) =>
  runtime.traits.captureFrom === "stopped"
    ? Effect.void
    : runtime.stop(machine);

export const runtimeContract = (subject: Subject): void => {
  const sized = (name: string, instance = first) => ({
    name,
    instance,
    ...subject.sizes,
  });

  const fromImage: Origin = { _tag: "image", image: subject.image };

  const withFixture = <A, E>(
    body: (fixture: Fixture) => Effect.Effect<A, E, Scope.Scope>
  ) => Effect.scoped(Effect.flatMap(subject.fixture, body));

  const made = (runtime: Runtime, name: string, instance = first) =>
    Effect.map(
      runtime.make(sized(name, instance), fromImage, bindFor(runtime)),
      ({ handle }): Sized => ({ ...sized(name, instance), handle })
    );

  describe(`the ${subject.name} runtime`, () => {
    it.live(
      "makes a running machine of sizes it gives, finds it by instance, and nothing once it is deleted",
      () =>
        withFixture(({ runtime }) =>
          Effect.gen(function* () {
            const machine = sized("dev");

            expect(fitted(runtime.traits, subject.sizes)).toBe(true);

            const answer = yield* runtime.make(
              machine,
              fromImage,
              bindFor(runtime)
            );

            const target = { ...machine, handle: answer.handle };

            expect(fitted(runtime.traits, answer.sizes)).toBe(true);
            expect(yield* runtime.find("machine", machine)).toBe(answer.handle);
            expect(yield* stateOf(runtime, target)).toBe("running");

            yield* runtime.stop(target);
            yield* runtime.delete(target, new Set());
            yield* runtime.delete(target, new Set());

            expect(yield* runtime.find("machine", machine)).toBeUndefined();
          })
        )
    );

    it.live("keeps two instances of one name apart", () =>
      withFixture(({ runtime }) =>
        Effect.gen(function* () {
          const older = yield* made(runtime, "dev", first);

          yield* runtime.stop(older);

          const newer = yield* made(runtime, "dev", second);

          expect(newer.handle).not.toBe(older.handle);

          yield* runtime.delete(older, new Set());

          expect({
            older: yield* runtime.find("machine", older),
            newer: yield* runtime.find("machine", newer),
          }).toStrictEqual({ older: undefined, newer: newer.handle });
        })
      )
    );

    it.live("stops a machine, again once it is stopped, and starts it", () =>
      withFixture(({ runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");

          yield* runtime.stop(machine);
          yield* runtime.stop(machine);

          const stopped = yield* stateOf(runtime, machine);

          yield* runtime.start(machine, new Set());

          expect([stopped, yield* stateOf(runtime, machine)]).toStrictEqual([
            "stopped",
            "running",
          ]);
        })
      )
    );

    it.live(
      "pauses a running machine where its pause saves, and a start resumes it",
      () =>
        withFixture(({ runtime }) =>
          Effect.gen(function* () {
            if (runtime.traits.pause !== "saves") {
              return;
            }

            const machine = yield* made(runtime, "dev");

            yield* runtime.pause(machine);

            const paused = yield* stateOf(runtime, machine);

            yield* runtime.start(machine, new Set());

            expect([paused, yield* stateOf(runtime, machine)]).toStrictEqual([
              "paused",
              "running",
            ]);
          })
        )
    );

    it.live(
      "pauses a running machine where its pause stops by stopping it, and a start runs it",
      () =>
        withFixture(({ runtime }) =>
          Effect.gen(function* () {
            if (runtime.traits.pause !== "stops") {
              return;
            }

            const machine = yield* made(runtime, "dev");

            yield* runtime.pause(machine);

            const paused = yield* stateOf(runtime, machine);

            yield* runtime.start(machine, new Set());

            expect([paused, yield* stateOf(runtime, machine)]).toStrictEqual([
              "stopped",
              "running",
            ]);
          })
        )
    );

    it.live(
      "captures a machine only in the state its traits name, and makes a machine of the checkpoint",
      () =>
        withFixture(({ runtime }) =>
          Effect.gen(function* () {
            const machine = yield* made(runtime, "dev");
            const snap = { name: "snap", instance: second };

            yield* outOfCaptureState(runtime, machine);

            const refused = yield* Effect.flip(runtime.capture(machine, snap));

            yield* runtime.traits.captureFrom === "running"
              ? runtime.start(machine, new Set())
              : runtime.stop(machine);

            const handle = yield* runtime.capture(machine, snap);
            const copy = sized("copy", third);

            const restored = yield* runtime.make(
              copy,
              {
                _tag: "checkpoint",
                checkpoint: { ...snap, ...subject.sizes, handle },
              },
              bindFor(runtime)
            );

            expect(refused).toBeInstanceOf(WrongState);
            expect(yield* runtime.find("machine", copy)).toBe(restored.handle);

            yield* runtime.stop({ ...copy, handle: restored.handle });
            yield* runtime.delete(
              { ...copy, handle: restored.handle },
              new Set()
            );
            yield* runtime.deleteCheckpoint({ ...snap, handle });
            yield* runtime.deleteCheckpoint({ ...snap, handle });
          })
        )
    );

    it.live(
      "resizes a machine in a state its resize trait takes, and reads back the sizes it gave",
      () =>
        withFixture(({ runtime }) =>
          Effect.gen(function* () {
            const { traits } = runtime;

            const state = (["stopped", "running"] as const).find(
              (taking) => traits.resize[taking] !== "none"
            );

            const from = subject.sizes;

            const offered =
              traits.sizes._tag === "classes"
                ? traits.sizes.classes.map(({ cpu, ramMib, diskGib }) => ({
                    cpu,
                    ramMib,
                    diskGib,
                  }))
                : [
                    {
                      cpu: from.cpu * 2,
                      ramMib: from.ramMib * 2,
                      diskGib: from.diskGib,
                    },
                  ];

            const to =
              state === undefined
                ? undefined
                : offered.find(
                    (sizes) =>
                      sizes.diskGib >= from.diskGib &&
                      (sizes.cpu !== from.cpu ||
                        sizes.ramMib !== from.ramMib) &&
                      resizable(traits, state, from, sizes) === "resizes"
                  );

            if (state === undefined || to === undefined) {
              return;
            }

            const machine = yield* made(runtime, "dev");
            const running = state === "running";

            if (!running) {
              yield* runtime.stop(machine);
            }

            yield* runtime.sizable(machine, from, to, running);
            yield* runtime.resize(machine, to, running);

            const read = yield* runtime.sizes(machine);

            expect({
              cpu: read.cpu ?? from.cpu,
              ramMib: read.ramMib ?? from.ramMib,
              diskGib: read.diskGib ?? from.diskGib,
            }).toStrictEqual(to);
          })
        )
    );

    it.live("runs a command in the guest with its stdin as text", () =>
      withFixture(({ runtime }) =>
        Effect.gen(function* () {
          const machine = yield* made(runtime, "dev");

          const execution = yield* runtime.exec(machine, {
            argv: ["cat"],
            stdin: "hello from the host\n",
          });

          expect({
            output: yield* outputOf(execution),
            exitCode: yield* execution.exitCode,
          }).toStrictEqual({ output: "hello from the host\n", exitCode: 0 });
        })
      )
    );

    it.live(
      "lists what carries its mark, and deletes with a machine each checkpoint it holds that keep lacks",
      () =>
        withFixture(({ runtime }) =>
          Effect.gen(function* () {
            const { owned } = runtime;

            if (owned === undefined) {
              return;
            }

            const machine = yield* made(runtime, "dev");

            yield* inCaptureState(runtime, machine);

            const kept = yield* runtime.capture(machine, {
              name: "kept",
              instance: first,
            });

            const other = yield* runtime.capture(machine, {
              name: "other",
              instance: second,
            });

            const listed = yield* owned.machines;
            const marked = yield* owned.checkpoints;

            const holds = listed.flatMap(({ checkpoints }) => checkpoints);

            expect(
              listed.map(({ instance, handle }) => [instance, handle])
            ).toStrictEqual([[machine.instance, machine.handle]]);
            expect(
              new Set([...holds, ...marked.map(({ handle }) => handle)])
            ).toStrictEqual(new Set([kept, other]));

            yield* runtime.delete(machine, new Set<Handle>([kept]));

            const restoredFrom = (
              handle: Handle,
              instance: string,
              into: string
            ) =>
              runtime.make(
                sized("copy", into),
                {
                  _tag: "checkpoint",
                  checkpoint: {
                    name: "snap",
                    instance,
                    ...subject.sizes,
                    handle,
                  },
                },
                bindFor(runtime)
              );

            expect(yield* owned.machines).toStrictEqual([]);

            yield* restoredFrom(kept, first, third);

            const otherRestored = yield* Effect.exit(
              restoredFrom(other, second, fourth)
            );

            expect(otherRestored._tag).toBe(
              holds.includes(other) ? "Failure" : "Success"
            );
          })
        )
    );

    it.live(
      "lists nothing that lacks its mark, whoever put it in the account",
      () =>
        withFixture(({ runtime, unmarked }) =>
          Effect.gen(function* () {
            const { owned } = runtime;

            if (owned === undefined) {
              return;
            }

            expect(unmarked).toBeDefined();
            yield* unmarked ?? Effect.void;

            const machine = yield* made(runtime, "dev");
            const listed = yield* owned.machines;

            expect(
              listed.map(({ instance, handle, checkpoints }) => [
                instance,
                handle,
                checkpoints,
              ])
            ).toStrictEqual([[machine.instance, machine.handle, []]]);
            expect(yield* owned.checkpoints).toStrictEqual([]);
          })
        )
    );

    it.live(
      "deletes once a start runs the machine each checkpoint it holds that keep lacks",
      () =>
        withFixture(({ runtime }) =>
          Effect.gen(function* () {
            const { owned } = runtime;

            if (owned === undefined) {
              return;
            }

            const machine = yield* made(runtime, "dev");

            yield* inCaptureState(runtime, machine);

            const kept = yield* runtime.capture(machine, {
              name: "kept",
              instance: first,
            });

            const other = yield* runtime.capture(machine, {
              name: "other",
              instance: second,
            });

            const everything = Effect.map(
              Effect.all([owned.machines, owned.checkpoints]),
              ([listed, marked]) =>
                new Set([
                  ...listed.flatMap(({ checkpoints }) => checkpoints),
                  ...marked.map(({ handle }) => handle),
                ])
            );

            const held = (yield* owned.machines).flatMap(
              ({ checkpoints }) => checkpoints
            );

            yield* runtime.stop(machine);
            yield* runtime.start(machine, new Set<Handle>([kept]));

            expect(yield* stateOf(runtime, machine)).toBe("running");
            expect(yield* everything).toStrictEqual(
              new Set(held.includes(other) ? [kept] : [kept, other])
            );
          })
        )
    );

    it.live(
      "answers a make whose answer was lost with the machine its instance finds, and makes no second one",
      () =>
        withFixture(({ runtime, faults }) =>
          Effect.gen(function* () {
            if (faults === undefined) {
              return;
            }

            yield* faults.dropAnswer("make");

            const machine = yield* made(runtime, "dev");

            expect(yield* runtime.find("machine", machine)).toBe(
              machine.handle
            );
            yield* runtime.delete(machine, new Set());
            expect(yield* runtime.find("machine", machine)).toBeUndefined();
          })
        )
    );

    it.live("refuses a make for want of room and makes nothing", () =>
      withFixture(({ runtime, faults }) =>
        Effect.gen(function* () {
          if (faults === undefined) {
            return;
          }

          yield* faults.quota(true);

          const refused = yield* Effect.flip(made(runtime, "dev"));

          yield* faults.quota(false);

          expect(refused).toBeInstanceOf(Capacity);
          expect(yield* runtime.find("machine", sized("dev"))).toBeUndefined();
        })
      )
    );

    it.live("reads a machine that stopped on its own as stopped", () =>
      withFixture(({ runtime, faults }) =>
        Effect.gen(function* () {
          if (faults === undefined) {
            return;
          }

          const machine = yield* made(runtime, "dev");

          yield* faults.drift(machine.instance);

          expect(yield* stateOf(runtime, machine)).toBe("stopped");
        })
      )
    );

    it.live(
      "finds a machine its make failed to answer once the provider makes it",
      () =>
        withFixture(({ runtime, faults }) =>
          Effect.gen(function* () {
            if (faults === undefined) {
              return;
            }

            yield* faults.landLate("50 millis");
            yield* Effect.flip(made(runtime, "late"));

            const before = yield* runtime.find("machine", sized("late"));

            yield* Effect.sleep("80 millis");

            expect(before).toBeUndefined();
            expect(yield* runtime.find("machine", sized("late"))).toBeDefined();
          })
        )
    );

    it.live("deletes a machine whose delete's answer was lost", () =>
      withFixture(({ runtime, faults }) =>
        Effect.gen(function* () {
          if (faults === undefined) {
            return;
          }

          const machine = yield* made(runtime, "dev");

          yield* faults.dropAnswer("delete");
          yield* runtime.stop(machine);
          yield* runtime.delete(machine, new Set());

          expect(yield* runtime.find("machine", machine)).toBeUndefined();
        })
      )
    );
  });
};
