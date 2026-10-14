import { type Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

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
