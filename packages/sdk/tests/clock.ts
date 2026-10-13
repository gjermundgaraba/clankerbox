import { type Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

/**
 * Runs `effect` and moves the test clock by `duration` once `waiting` is done: a timer that
 * starts after the move would never fire, so `waiting` is whatever shows the timer has started,
 * such as a request reaching its host.
 */
export const elapsing = <A, E>(
  duration: Duration.Input,
  effect: Effect.Effect<A, E>,
  waiting: Effect.Effect<unknown>,
) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);

    yield* waiting;
    yield* TestClock.adjust(duration);

    return yield* Fiber.join(fiber);
  });
