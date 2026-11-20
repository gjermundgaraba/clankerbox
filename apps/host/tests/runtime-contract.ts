import type { Handle } from "@clankerbox/host-contract";
import { fitted, resizeRefusal } from "@clankerbox/host-contract/traits";
import { describe, it } from "@effect/vitest";
import { Capacity, Missing } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Fiber, Schedule, Stream } from "effect";
import type { Scope } from "effect";
import { expect } from "vite-plus/test";

import { runCommand } from "../src/exec.ts";
import type {
  Execution,
  Interface as Runtime,
  Origin,
  Sized,
  Sizes,
} from "../src/runtime.ts";

export type Dropped = "make" | "delete";

export interface Faults {
  readonly drift: (instance: string) => Effect.Effect<void>;
  /** Fails the next make, whose machine lands all the same once the effect it answers runs. */
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
   * as another host or user of the account would, and answers whether each is still there. Every
   * rented runtime, whose provider holds a checkpoint through its machine, gives it.
   */
  readonly unmarked: Effect.Effect<Effect.Effect<boolean>> | undefined;
}

export interface Subject {
  readonly name: string;
  readonly image: string;
  readonly sizes: Sizes;
  /** Each fault its fixture can't give, with why, so each case that needs it is skipped saying so. */
  readonly lacks?: Readonly<Partial<Record<Fault, string>>>;
  /** Why its guest runs no processes of the commands it is given, if it runs none. */
  readonly runsNoGuest?: string | undefined;
  /**
   * Why nothing of a machine lands after its call answered, where its machines lie on the host's
   * own disk, so a provider holds no checkpoint through a machine and no tombstone is kept.
   */
  readonly ownDisk?: string | undefined;
  /** How long, in milliseconds, a case that cuts each provider call of a step short may run. */
  readonly stallTimeout?: number | undefined;
  readonly fixture: Effect.Effect<Fixture, never, Scope.Scope>;
}

const given = <A>(fault: A | undefined) =>
  Effect.orDie(Effect.fromNullishOr(fault));

const stallCaseTimeout = 120_000;

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

const fifth = "13579bdf".repeat(4);

const sixth = "02468ace".repeat(4);

const outputOf = (execution: Execution) =>
  Stream.mkString(Stream.decodeText(execution.output));

const stateOf = (runtime: Runtime, machine: Sized) =>
  Effect.map(
    runtime.observe([machine]),
    (observed) => observed.get(machine.name) ?? "unknown"
  );

const outOfCaptureState = (runtime: Runtime, machine: Sized) =>
  runtime.stop(machine);

const shell = (runtime: Runtime, machine: Sized, script: string) =>
  Effect.flatMap(
    runtime.exec(machine, {
      argv: ["/bin/sh", "-c", `root=\${CLANKERBOX_ROOT-}\n${script}`],
    }),
    (execution) =>
      Effect.map(
        Effect.all([outputOf(execution), execution.exitCode]),
        ([output, exitCode]) => `${exitCode}: ${output.trim()}`
      )
  ).pipe(Effect.scoped);

const marks = (runtime: Runtime, machine: Sized) =>
  shell(
    runtime,
    machine,
    `printf '%s,' "$(cat "$root/etc/clankerbox-mark" 2>/dev/null)" "$(cat "$root/dev/shm/clankerbox-mark" 2>/dev/null)"`
  );

export const runtimeContract = (subject: Subject): void => {
  const lacking = subject.lacks ?? {};

  const lacks = (fault: Fault) => lacking[fault] !== undefined;

  const needing = (fault: Fault, title: string) => {
    const why = lacking[fault];

    return why === undefined ? title : `${title}, skipped: ${why}`;
  };

  const rented = subject.ownDisk === undefined;

  const ifRented = (title: string) =>
    rented ? title : `${title}, skipped: ${subject.ownDisk}`;

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
      "captures a machine only in the state its traits name, and makes a machine of the checkpoint",
      () =>
        withFixture(({ runtime }) =>
          Effect.gen(function* () {
            const { captureFrom } = runtime.traits;
            const machine = yield* made(runtime, "dev");
            const snap = { name: "snap", instance: second };

            const refused =
              captureFrom === "either"
                ? undefined
                : yield* Effect.gen(function* () {
                    yield* outOfCaptureState(runtime, machine);

                    const refusal = yield* Effect.flip(
                      runtime.capture(machine, snap)
                    );

                    yield* runtime.start(machine, new Set());

                    return refusal;
                  });

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

            expect(refused?._tag ?? "none").toBe(
              captureFrom === "either" ? "none" : "WrongState"
            );
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

    const guestRuns = subject.runsNoGuest === undefined;

    it.live.skipIf(!guestRuns)(
      `forks and restores a machine in each state its traits copy into a machine booted from a copy of its disk, holding none of its memory, leaving the source as it was${guestRuns ? "" : `: ${subject.runsNoGuest}`}`,
      () =>
        withFixture(({ runtime }) =>
          Effect.gen(function* () {
            const { captureFrom } = runtime.traits;
            const source = yield* made(runtime, "dev");

            const wrote = yield* shell(
              runtime,
              source,
              [
                `printf disk >"$root/etc/clankerbox-mark"`,
                `printf memory >"$root/dev/shm/clankerbox-mark"`,
                "sync",
              ].join("\n")
            );

            const copyOf = (name: string, instance: string, origin: Origin) =>
              Effect.map(
                runtime.make(sized(name, instance), origin, nextFree()),
                ({ handle }) => ({ ...sized(name, instance), handle })
              );

            const forked = yield* copyOf("fork", third, {
              _tag: "machine",
              machine: source,
            });

            const snap = { name: "snap", instance: fifth };
            const handle = yield* runtime.capture(source, snap);

            const restored = yield* copyOf("restored", sixth, {
              _tag: "checkpoint",
              checkpoint: { ...snap, ...subject.sizes, handle },
            });

            const kept = {
              source: yield* stateOf(runtime, source),
              fork: yield* stateOf(runtime, forked),
              copied: yield* marks(runtime, forked),
              restored: yield* marks(runtime, restored),
            };

            yield* shell(
              runtime,
              forked,
              `printf fork >"$root/etc/clankerbox-mark"`
            );

            const sourceAfter = yield* marks(runtime, source);
            const copies = [forked, restored];

            const stoppedHalf =
              captureFrom === "either"
                ? yield* Effect.gen(function* () {
                    yield* runtime.stop(source);

                    const later = yield* copyOf("later", fourth, {
                      _tag: "machine",
                      machine: source,
                    });

                    copies.push(later);

                    return {
                      stoppedSource: yield* stateOf(runtime, source),
                      laterFork: yield* stateOf(runtime, later),
                      laterCopied: yield* marks(runtime, later),
                    };
                  })
                : {};

            expect({
              wrote,
              ...kept,
              sourceAfter,
              ...stoppedHalf,
            }).toStrictEqual({
              wrote: "0: ",
              source: "running",
              fork: "running",
              copied: "0: disk,,",
              restored: "0: disk,,",
              sourceAfter: "0: disk,memory,",
              ...(captureFrom === "either"
                ? {
                    stoppedSource: "stopped",
                    laterFork: "running",
                    laterCopied: "0: disk,,",
                  }
                : {}),
            });

            for (const copy of copies) {
              yield* runtime.stop(copy);
              yield* runtime.delete(copy, new Set());
            }

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
                      `echo $$ >>"\${CLANKERBOX_ROOT-}/var/tmp/${file}"; sleep 300 & echo $! >>"\${CLANKERBOX_ROOT-}/var/tmp/${file}"; wait`,
                    ],
                  })
                );

                const pids = yield* inGuest(
                  `cat "\${CLANKERBOX_ROOT-}/var/tmp/${file}" 2>/dev/null`
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

    const restoredFrom = (
      runtime: Runtime,
      handle: Handle,
      instance: string,
      into: string
    ) =>
      Effect.exit(
        runtime.make(
          sized("copy", into),
          {
            _tag: "checkpoint",
            checkpoint: { name: "snap", instance, ...subject.sizes, handle },
          },
          nextFree()
        )
      );

    it.live.skipIf(!rented)(
      ifRented(
        "deletes with a machine each checkpoint it holds that keep lacks"
      ),
      () =>
        withFixture(({ runtime }) =>
          Effect.gen(function* () {
            const machine = yield* made(runtime, "dev");

            const kept = yield* runtime.capture(machine, {
              name: "kept",
              instance: first,
            });

            const other = yield* runtime.capture(machine, {
              name: "other",
              instance: second,
            });

            yield* runtime.delete(machine, new Set<Handle>([kept]));

            const keptRestored = yield* restoredFrom(
              runtime,
              kept,
              first,
              third
            );

            const otherRestored = yield* restoredFrom(
              runtime,
              other,
              second,
              fourth
            );

            expect(yield* runtime.find(machine)).toBeUndefined();
            expect(keptRestored._tag).toBe("Success");
            expect(otherRestored._tag).toBe("Failure");
          })
        )
    );

    it.live.skipIf(!rented)(
      ifRented(
        "deletes once a start runs the machine each checkpoint it holds that keep lacks"
      ),
      () =>
        withFixture(({ runtime }) =>
          Effect.gen(function* () {
            const machine = yield* made(runtime, "dev");

            const kept = yield* runtime.capture(machine, {
              name: "kept",
              instance: first,
            });

            const other = yield* runtime.capture(machine, {
              name: "other",
              instance: second,
            });

            yield* runtime.stop(machine);
            yield* runtime.start(machine, new Set<Handle>([kept]));

            const running = yield* stateOf(runtime, machine);

            const keptRestored = yield* restoredFrom(
              runtime,
              kept,
              first,
              third
            );

            const otherRestored = yield* restoredFrom(
              runtime,
              other,
              second,
              fourth
            );

            expect(running).toBe("running");
            expect(keptRestored._tag).toBe("Success");
            expect(otherRestored._tag).toBe("Failure");
          })
        )
    );

    it.live.skipIf(!rented)(
      ifRented(
        "deletes what lands of an instance after its delete answered, refuses a make of it, and deletes nothing that lacks its mark"
      ),
      () =>
        withFixture(({ runtime, faults, unmarked }) =>
          Effect.gen(function* () {
            const theirs = yield* yield* given(unmarked);
            const land = yield* yield* given(faults.landLate);
            const late = sized("late");

            yield* Effect.flip(made(runtime, "late"));
            yield* runtime.delete(
              { ...late, handle: yield* runtime.find(late) },
              new Set()
            );
            yield* land;

            const swept = yield* runtime.find(late).pipe(
              Effect.repeat({
                until: (found) => found === undefined,
                schedule: Schedule.spaced("50 millis"),
              }),
              Effect.timeoutOption("20 seconds")
            );

            const remade = yield* Effect.exit(made(runtime, "late"));

            expect(swept._tag).toBe("Some");
            expect(remade._tag).toBe("Failure");
            expect(yield* runtime.find(late)).toBeUndefined();
            expect(yield* theirs).toBe(true);
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

    it.live.skipIf(!rented)(
      ifRented(
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

                const handle =
                  (yield* runtime.find(machine)) ??
                  (yield* runtime.make(machine, fromImage, nextFree())).handle;

                yield* runtime.delete({ ...machine, handle }, new Set());

                expect(
                  yield* runtime.find(machine),
                  `a make cut at the ${at} of its call ${after}`
                ).toBeUndefined();
              }
            }
          })
        ),
      subject.stallTimeout ?? stallCaseTimeout
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
      subject.stallTimeout ?? stallCaseTimeout
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
                  yield* runtime.find(machine),
                  `a delete cut at the ${at} of its call ${after}`
                ).toBeUndefined();

                if (!cut) {
                  expect(after, "the calls it cut").toBeGreaterThan(0);

                  break;
                }
              }
            }
          })
        ),
      subject.stallTimeout ?? stallCaseTimeout
    );
  });
};
