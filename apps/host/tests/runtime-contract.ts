import type { Handle } from "@clankerbox/host-contract";
import { fitted, resizeRefusal } from "@clankerbox/host-contract/traits";
import { describe, it } from "@effect/vitest";
import { Capacity, Missing, WrongState } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Fiber, Schedule, Stream } from "effect";
import type { Scope } from "effect";
import { expect } from "vite-plus/test";

import { runCommand } from "../src/guest.ts";
import type {
  Execution,
  Identity,
  Interface as Runtime,
  Origin,
  Sized,
  Sizes,
} from "../src/runtime.ts";

export type Dropped = "make" | "delete";

export interface Faults {
  readonly drift: (instance: string) => Effect.Effect<void>;
  /** Fails the next make as though its answer were lost; the effect it answers lands its machine. */
  readonly landLate: Effect.Effect<Effect.Effect<void>>;
  readonly quota: (on: boolean) => Effect.Effect<void>;
  readonly dropAnswer: (dropping: Dropped) => Effect.Effect<void>;
  /**
   * Holds the provider call `after` calls from now at its start, before it does its work, or at
   * its end, once it has, where a case cuts short what made it, as a later request or the host's
   * end does; the call never answers. A case asks the step's fiber to end and then releases the
   * call, which ends a step that masks the request as the host's end would.
   */
  readonly stall?: (after: number, at: StallAt) => Effect.Effect<Stalled>;
}

export type Fault = keyof Faults;

/** Where a stalled call is held: before it does its work, or once it has done it. */
export type StallAt = "start" | "end";

/**
 * A held call: `reached` once it is held, and `release`, which ends it as a host that ends does,
 * or disarms the stall when no call reached it.
 */
export interface Stalled {
  readonly reached: Effect.Effect<void>;
  readonly release: Effect.Effect<void>;
}

const stallsAt: readonly StallAt[] = ["start", "end"];

export interface Fixture {
  readonly runtime: Runtime;
  readonly faults: Partial<Faults>;
  /**
   * Puts a machine, with a checkpoint it holds, in the provider's account without this host's mark,
   * as another host or user of the account would. Every runtime with `owned` gives it.
   */
  readonly unmarked: Effect.Effect<void> | undefined;
}

export interface Subject {
  readonly name: string;
  readonly image: string;
  readonly sizes: Sizes;
  /** Each fault its fixture can't give, with why, so each case that needs it is skipped saying so. */
  readonly lacks?: Readonly<Partial<Record<Fault, string>>>;
  /** Why its guest runs no processes of the commands it is given, if it runs none. */
  readonly runsNoGuest?: string | undefined;
  readonly fixture: Effect.Effect<Fixture, never, Scope.Scope>;
}

const given = <A>(fault: A | undefined) =>
  Effect.orDie(Effect.fromNullishOr(fault));

const stallCaseTimeout = 120_000;

const heldOf = (runtime: Runtime, machine: Identity) =>
  Effect.gen(function* () {
    const found = yield* runtime.find(machine);

    const marked =
      runtime.owned === undefined
        ? []
        : (yield* runtime.owned.machines)
            .filter(({ instance }) => instance === machine.instance)
            .map(({ handle }) => handle);

    return { found, marked };
  });

const roundInstance = (at: StallAt, after: number) =>
  `${at === "start" ? "5" : "e"}${after.toString(16).padStart(7, "0")}${"ab".repeat(12)}`;

const cutAt = <A, E>(stalled: Stalled, call: Fiber.Fiber<A, E>) =>
  Effect.raceFirst(
    Effect.as(stalled.reached, true),
    Effect.as(Fiber.await(call), false)
  ).pipe(
    Effect.tap((cut) =>
      cut
        ? Effect.andThen(
            Effect.sync(() => {
              call.interruptUnsafe();
            }),
            Effect.andThen(stalled.release, Fiber.await(call))
          )
        : stalled.release
    )
  );

let nextPort = 23_000;

const nextFree = () => {
  nextPort += 1;

  return nextPort;
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
  const lacking = subject.lacks ?? {};

  const lacks = (fault: Fault) => lacking[fault] !== undefined;

  const needing = (fault: Fault, title: string) => {
    const why = lacking[fault];

    return why === undefined ? title : `${title}, skipped: ${why}`;
  };

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
      runtime.make(sized(name, instance), fromImage, nextFree()),
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

            const answer = yield* runtime.make(machine, fromImage, nextFree());

            const target = { ...machine, handle: answer.handle };

            expect(fitted(runtime.traits, answer.sizes)).toBe(true);
            expect(yield* runtime.find(machine)).toBe(answer.handle);
            expect(yield* stateOf(runtime, target)).toBe("running");

            yield* runtime.stop(target);
            yield* runtime.delete(target, new Set());
            yield* runtime.delete(target, new Set());

            expect(yield* runtime.find(machine)).toBeUndefined();
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
            older: yield* runtime.find(older),
            newer: yield* runtime.find(newer),
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
              nextFree()
            );

            expect(refused).toBeInstanceOf(WrongState);
            expect(yield* runtime.find(copy)).toBe(restored.handle);

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
      "answers a capture with the handle it derives from the checkpoint's identity, where it derives one, and a delete of a derived one it doesn't hold is done",
      () =>
        withFixture(({ runtime }) =>
          Effect.gen(function* () {
            const machine = yield* made(runtime, "dev");
            const snap = { name: "snap", instance: second };
            const unheld = { name: "other", instance: third };

            yield* inCaptureState(runtime, machine);

            const handle = yield* runtime.capture(machine, snap);
            const absent = runtime.checkpointHandle(unheld);

            if (absent !== undefined) {
              yield* runtime.deleteCheckpoint({ ...unheld, handle: absent });
            }

            yield* runtime.deleteCheckpoint({ ...snap, handle });

            expect(runtime.checkpointHandle(snap) ?? handle).toBe(handle);
          })
        )
    );

    it.live(
      "refuses a make from a checkpoint it no longer holds as Missing, naming the checkpoint, and makes nothing",
      () =>
        withFixture(({ runtime }) =>
          Effect.gen(function* () {
            const machine = yield* made(runtime, "dev");
            const snap = { name: "snap", instance: second };

            yield* inCaptureState(runtime, machine);

            const handle = yield* runtime.capture(machine, snap);

            yield* runtime.deleteCheckpoint({ ...snap, handle });

            const copy = sized("copy", third);

            const refused = yield* Effect.flip(
              runtime.make(
                copy,
                {
                  _tag: "checkpoint",
                  checkpoint: { ...snap, ...subject.sizes, handle },
                },
                nextFree()
              )
            );

            expect(refused).toBeInstanceOf(Missing);
            expect(refused).toMatchObject({ checkpoint: "snap" });
            expect(yield* runtime.find(copy)).toBeUndefined();
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
                      (sizes.cpu !== from.cpu ||
                        sizes.ramMib !== from.ramMib) &&
                      resizeRefusal(traits, "dev", state, from, sizes) ===
                        undefined
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

    it.live.skipIf(subject.runsNoGuest !== undefined)(
      `ends in the guest, with what it started, a command whose exec is cut short, and not one beside it${subject.runsNoGuest === undefined ? "" : `: ${subject.runsNoGuest}`}`,
      () =>
        withFixture(({ runtime }) =>
          Effect.gen(function* () {
            const machine = yield* made(runtime, "dev");

            const inGuest = (script: string) =>
              Effect.map(
                runCommand(runtime, {
                  machine,
                  argv: ["/bin/sh", "-c", script],
                }),
                ({ output }) => output.split("\n").filter((line) => line !== "")
              );

            const started = (file: string, count: number) =>
              Effect.gen(function* () {
                const fiber = yield* Effect.forkChild(
                  runCommand(runtime, {
                    machine,
                    argv: [
                      "/bin/sh",
                      "-c",
                      `echo $$ >>"$CLANKERBOX_ROOT/${file}"; sleep 300 & echo $! >>"$CLANKERBOX_ROOT/${file}"; wait`,
                    ],
                  })
                );

                const pids = yield* inGuest(
                  `cat "$CLANKERBOX_ROOT/${file}" 2>/dev/null`
                ).pipe(
                  Effect.repeat({
                    until: (found) => found.length >= count,
                    schedule: Schedule.spaced("20 millis"),
                  })
                );

                return { fiber, pids };
              });

            const running = (pids: readonly string[]) =>
              inGuest(
                `for pid in ${pids.join(" ")}; do state=$(sed 's/.*) //' "/proc/$pid/stat" 2>/dev/null | cut -c1); [ -z "$state" ] || [ "$state" = Z ] || echo "$pid"; done`
              );

            const cut = yield* started("cut", 2);
            const beside = yield* started("beside", 2);

            yield* Fiber.interrupt(cut.fiber);

            expect(yield* running(cut.pids)).toStrictEqual([]);
            expect(yield* running(beside.pids)).toStrictEqual(beside.pids);

            yield* Fiber.interrupt(beside.fiber);
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

            expect(
              listed.map(({ instance, handle, checkpoints }) => [
                instance,
                handle,
                new Set(checkpoints),
              ])
            ).toStrictEqual([
              [machine.instance, machine.handle, new Set([kept, other])],
            ]);

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
                nextFree()
              );

            expect(yield* owned.machines).toStrictEqual([]);

            yield* restoredFrom(kept, first, third);

            const otherRestored = yield* Effect.exit(
              restoredFrom(other, second, fourth)
            );

            expect(otherRestored._tag).toBe("Failure");
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

            const held = Effect.map(
              owned.machines,
              (listed) =>
                new Set(listed.flatMap(({ checkpoints }) => checkpoints))
            );

            const before = yield* held;

            yield* runtime.stop(machine);
            yield* runtime.start(machine, new Set<Handle>([kept]));

            expect(before).toStrictEqual(new Set([kept, other]));
            expect(yield* stateOf(runtime, machine)).toBe("running");
            expect(yield* held).toStrictEqual(new Set([kept]));
          })
        )
    );

    it.live.skipIf(lacks("dropAnswer"))(
      needing(
        "dropAnswer",
        "answers a make whose answer was lost with the machine its instance finds, and makes no second one"
      ),
      () =>
        withFixture(({ runtime, faults }) =>
          Effect.gen(function* () {
            yield* (yield* given(faults.dropAnswer))("make");

            const machine = yield* made(runtime, "dev");

            expect(yield* runtime.find(machine)).toBe(machine.handle);
            yield* runtime.delete(machine, new Set());
            expect(yield* runtime.find(machine)).toBeUndefined();
          })
        )
    );

    it.live.skipIf(lacks("quota"))(
      needing(
        "quota",
        "refuses a make for want of room as Capacity, and the undo that follows leaves nothing"
      ),
      () =>
        withFixture(({ runtime, faults }) =>
          Effect.gen(function* () {
            const quota = yield* given(faults.quota);

            yield* quota(true);

            const refused = yield* Effect.flip(made(runtime, "dev"));

            yield* quota(false);

            const left = yield* runtime.find(sized("dev"));

            if (left !== undefined) {
              yield* runtime.delete(
                { ...sized("dev"), handle: left },
                new Set()
              );
            }

            expect(refused).toBeInstanceOf(Capacity);
            expect(yield* runtime.find(sized("dev"))).toBeUndefined();
          })
        )
    );

    it.live.skipIf(lacks("drift"))(
      needing("drift", "reads a machine that stopped on its own as stopped"),
      () =>
        withFixture(({ runtime, faults }) =>
          Effect.gen(function* () {
            const machine = yield* made(runtime, "dev");

            expect(yield* stateOf(runtime, machine)).toBe("running");

            yield* (yield* given(faults.drift))(machine.instance);

            expect(yield* stateOf(runtime, machine)).toBe("stopped");
          })
        )
    );

    it.live.skipIf(lacks("landLate"))(
      needing(
        "landLate",
        "finds a machine its make failed to answer once the provider makes it"
      ),
      () =>
        withFixture(({ runtime, faults }) =>
          Effect.gen(function* () {
            const land = yield* yield* given(faults.landLate);

            yield* Effect.flip(made(runtime, "late"));

            const before = yield* runtime.find(sized("late"));

            yield* land;

            expect(before).toBeUndefined();
            expect(yield* runtime.find(sized("late"))).toBeDefined();
          })
        )
    );

    it.live.skipIf(lacks("dropAnswer"))(
      needing("dropAnswer", "deletes a machine whose delete's answer was lost"),
      () =>
        withFixture(({ runtime, faults }) =>
          Effect.gen(function* () {
            const machine = yield* made(runtime, "dev");

            yield* (yield* given(faults.dropAnswer))("delete");
            yield* runtime.stop(machine);
            yield* runtime.delete(machine, new Set());

            expect(yield* runtime.find(machine)).toBeUndefined();
          })
        )
    );

    it.live.skipIf(lacks("stall"))(
      needing(
        "stall",
        "leaves a make cut short at any of its provider calls found, so its delete clears it, or not begun, so a make of it again makes it"
      ),
      () =>
        withFixture(({ runtime, faults }) =>
          Effect.gen(function* () {
            const stall = yield* given(faults.stall);

            for (const at of stallsAt) {
              for (let after = 0; ; after += 1) {
                const machine = sized("cut", roundInstance(at, after));
                const reached = yield* stall(after, at);

                const making = yield* Effect.forkChild(
                  runtime.make(machine, fromImage, nextFree())
                );

                if (!(yield* cutAt(reached, making))) {
                  expect(yield* runtime.find(machine)).toBeDefined();
                  expect(after, "the calls it cut").toBeGreaterThan(0);

                  break;
                }

                const found = yield* runtime.find(machine);

                if (found !== undefined) {
                  yield* runtime.delete(
                    { ...machine, handle: found },
                    new Set()
                  );
                }

                const again = yield* runtime.make(
                  machine,
                  fromImage,
                  nextFree()
                );

                yield* runtime.delete(
                  { ...machine, handle: again.handle },
                  new Set()
                );

                expect(
                  yield* heldOf(runtime, machine),
                  `a make cut at the ${at} of its call ${after}`
                ).toStrictEqual({ found: undefined, marked: [] });
              }
            }
          })
        ),
      stallCaseTimeout
    );

    it.live.skipIf(lacks("stall"))(
      needing(
        "stall",
        "stops a machine whose last stop was cut short at any of its provider calls"
      ),
      () =>
        withFixture(({ runtime, faults }) =>
          Effect.gen(function* () {
            const stall = yield* given(faults.stall);
            const machine = yield* made(runtime, "dev");

            for (const at of stallsAt) {
              for (let after = 0; ; after += 1) {
                const reached = yield* stall(after, at);
                const stopping = yield* Effect.forkChild(runtime.stop(machine));
                const cut = yield* cutAt(reached, stopping);

                yield* runtime.stop(machine);

                expect(
                  yield* stateOf(runtime, machine),
                  `a stop cut at the ${at} of its call ${after}`
                ).toBe("stopped");

                yield* runtime.start(machine, new Set());

                if (!cut) {
                  expect(after, "the calls it cut").toBeGreaterThan(0);

                  break;
                }
              }
            }
          })
        ),
      stallCaseTimeout
    );

    it.live.skipIf(lacks("stall"))(
      needing(
        "stall",
        "deletes a machine whose last delete was cut short at any of its provider calls"
      ),
      () =>
        withFixture(({ runtime, faults }) =>
          Effect.gen(function* () {
            const stall = yield* given(faults.stall);

            for (const at of stallsAt) {
              for (let after = 0; ; after += 1) {
                const machine = yield* made(
                  runtime,
                  "gone",
                  roundInstance(at, after)
                );

                const reached = yield* stall(after, at);

                const deleting = yield* Effect.forkChild(
                  runtime.delete(machine, new Set())
                );

                const cut = yield* cutAt(reached, deleting);

                yield* runtime.delete(machine, new Set());

                expect(
                  yield* heldOf(runtime, machine),
                  `a delete cut at the ${at} of its call ${after}`
                ).toStrictEqual({ found: undefined, marked: [] });

                if (!cut) {
                  expect(after, "the calls it cut").toBeGreaterThan(0);

                  break;
                }
              }
            }
          })
        ),
      stallCaseTimeout
    );
  });
};
