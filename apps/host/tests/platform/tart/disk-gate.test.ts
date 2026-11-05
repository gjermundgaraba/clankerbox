import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { expect } from "vite-plus/test";

import { make } from "../../../src/platform/tart/disk-gate.ts";

const settle = Effect.repeat(Effect.yieldNow, { times: 20 });

const held = Effect.gen(function* () {
  const entered = yield* Deferred.make<undefined>();
  const release = yield* Deferred.make<undefined>();

  return {
    entered: Deferred.await(entered),
    hasEntered: Deferred.isDone(entered),
    release: Deferred.succeed(release, undefined),
    work: Effect.andThen(
      Deferred.succeed(entered, undefined),
      Deferred.await(release)
    ),
  };
});

describe("DiskGate", () => {
  it.effect("reads run together, and so do openers", () =>
    Effect.gen(function* () {
      const gate = yield* make;

      const [first, second, third, fourth] = yield* Effect.all([
        held,
        held,
        held,
        held,
      ]);

      const reads = yield* Effect.forkChild(
        Effect.all([gate.reading(first.work), gate.reading(second.work)], {
          concurrency: "unbounded",
        })
      );

      yield* settle;

      const reading = [yield* first.hasEntered, yield* second.hasEntered];

      yield* Effect.all([first.release, second.release]);
      yield* Fiber.join(reads);

      const openers = yield* Effect.forkChild(
        Effect.all([gate.opening(third.work), gate.opening(fourth.work)], {
          concurrency: "unbounded",
        })
      );

      yield* settle;

      const opening = [yield* third.hasEntered, yield* fourth.hasEntered];

      yield* Effect.all([third.release, fourth.release]);
      yield* Fiber.join(openers);

      expect(reading).toStrictEqual([true, true]);
      expect(opening).toStrictEqual([true, true]);
    })
  );

  it.effect(
    "an opener waits for the read under way, and a read asked while it waits runs after it",
    () =>
      Effect.gen(function* () {
        const gate = yield* make;
        const [read, opener, later] = yield* Effect.all([held, held, held]);

        const reading = yield* Effect.forkChild(gate.reading(read.work));

        yield* read.entered;

        const opening = yield* Effect.forkChild(gate.opening(opener.work));

        yield* settle;

        const laterRead = yield* Effect.forkChild(gate.reading(later.work));

        yield* settle;

        const whileRead = [yield* opener.hasEntered, yield* later.hasEntered];

        yield* read.release;
        yield* opener.entered;
        yield* settle;

        const whileOpening = yield* later.hasEntered;

        yield* opener.release;
        yield* later.entered;
        yield* later.release;
        yield* Fiber.join(reading);
        yield* Fiber.join(opening);
        yield* Fiber.join(laterRead);

        expect(whileRead).toStrictEqual([false, false]);
        expect(whileOpening).toBe(false);
      })
  );

  it.effect("a waiter cut short holds nothing", () =>
    Effect.gen(function* () {
      const gate = yield* make;
      const [read, opener, after] = yield* Effect.all([held, held, held]);

      const reading = yield* Effect.forkChild(gate.reading(read.work));

      yield* read.entered;

      const waitingOpener = yield* Effect.forkChild(gate.opening(opener.work));

      yield* settle;
      yield* Fiber.interrupt(waitingOpener);

      const laterRead = yield* Effect.forkChild(gate.reading(after.work));

      yield* after.entered;
      yield* Effect.all([read.release, after.release]);
      yield* Fiber.join(reading);
      yield* Fiber.join(laterRead);

      const [blocker, cut] = yield* Effect.all([held, held]);
      const opening = yield* Effect.forkChild(gate.opening(blocker.work));

      yield* blocker.entered;

      const waitingRead = yield* Effect.forkChild(gate.reading(cut.work));

      yield* settle;
      yield* Fiber.interrupt(waitingRead);
      yield* blocker.release;
      yield* Fiber.join(opening);

      const [last] = yield* Effect.all([held]);
      const finalOpener = yield* Effect.forkChild(gate.opening(last.work));

      yield* last.entered;
      yield* last.release;
      yield* Fiber.join(finalOpener);

      expect(yield* opener.hasEntered).toBe(false);
      expect(yield* cut.hasEntered).toBe(false);
    })
  );
});
