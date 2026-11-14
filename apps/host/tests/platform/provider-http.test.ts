import { describe, it } from "@effect/vitest";
import { Duration, Effect, Exit } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";

import {
  askedAgain,
  Busy,
  sentUntilHeld,
  Unanswered,
  untilRest,
} from "../../src/platform/provider-http.ts";

const counted = <E>(failure: () => E) => {
  let sends = 0;

  return {
    call: Effect.suspend(() => {
      sends += 1;

      return Effect.fail(failure());
    }),
    sends: () => sends,
  };
};

describe("a provider's call asked again", () => {
  it.effect(
    "is sent six times in all while it is lost, if idempotent, or asked to be waited out",
    () =>
      Effect.gen(function* () {
        const busy = counted(
          () => new Busy({ message: "wait", wait: Duration.seconds(1) })
        );

        const lost = counted(() => new Unanswered({ message: "lost" }));
        const retried = askedAgain("idempotent");

        const ended = yield* Effect.forkChild(
          Effect.all([
            Effect.exit(retried(busy.call)),
            Effect.exit(retried(lost.call)),
          ]),
          { startImmediately: true }
        );

        yield* TestClock.adjust("10 minutes");

        expect(ended.pollUnsafe()).toBeDefined();
        expect([busy.sends(), lost.sends()]).toStrictEqual([6, 6]);
      })
  );

  it.effect(
    "is sent again a quarter second after the first, then half a second, backing off",
    () =>
      Effect.gen(function* () {
        const lost = counted(() => new Unanswered({ message: "lost" }));

        yield* Effect.forkChild(
          Effect.exit(askedAgain("idempotent")(lost.call)),
          { startImmediately: true }
        );

        const sends = [lost.sends()];

        for (const step of [
          "249 millis",
          "1 millis",
          "499 millis",
          "1 millis",
        ] as const) {
          yield* TestClock.adjust(step);
          sends.push(lost.sends());
        }

        expect(sends).toStrictEqual([1, 1, 2, 2, 3]);
      })
  );

  it.effect(
    "is sent once when its answer is lost and it isn't idempotent",
    () =>
      Effect.gen(function* () {
        const lost = counted(() => new Unanswered({ message: "lost" }));

        const ended = yield* Effect.exit(askedAgain("once")(lost.call));

        expect([Exit.isFailure(ended), lost.sends()]).toStrictEqual([true, 1]);
      })
  );
});

describe("a read until rest", () => {
  it.effect("reads a poll apart, and answers what it read at rest", () =>
    Effect.gen(function* () {
      let reads = 0;

      const resting = yield* Effect.forkChild(
        untilRest(
          Effect.sync(() => {
            reads += 1;

            return reads;
          }),
          (read) => read === 3,
          Duration.seconds(1)
        ),
        { startImmediately: true }
      );

      const seen = [reads];

      yield* TestClock.adjust("999 millis");
      seen.push(reads);
      yield* TestClock.adjust("2 seconds");

      expect([seen, resting.pollUnsafe()]).toStrictEqual([
        [1, 1],
        Exit.succeed(3),
      ]);
    })
  );
});

describe("a change sent until it holds", () => {
  it.effect(
    "is sent three times in all while each answer is lost and the resource rests without it",
    () =>
      Effect.gen(function* () {
        const lost = counted(() => new Unanswered({ message: "lost" }));
        let reads = 0;

        const ended = yield* Effect.exit(
          sentUntilHeld({
            send: lost.call,
            rested: Effect.sync(() => {
              reads += 1;

              return "old";
            }),
            holds: (found) => found === "new",
            unheld: (found) => `holds ${found}`,
          })
        );

        expect([ended, lost.sends(), reads]).toStrictEqual([
          Exit.fail("holds old"),
          3,
          3,
        ]);
      })
  );

  it.effect("is sent once when the resource holds it after a lost answer", () =>
    Effect.gen(function* () {
      const lost = counted(() => new Unanswered({ message: "lost" }));

      const ended = yield* Effect.exit(
        sentUntilHeld({
          send: lost.call,
          rested: Effect.succeed("new"),
          holds: (found) => found === "new",
          unheld: (found) => `holds ${found}`,
        })
      );

      expect([Exit.isSuccess(ended), lost.sends()]).toStrictEqual([true, 1]);
    })
  );
});
