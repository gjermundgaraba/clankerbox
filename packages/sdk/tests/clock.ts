import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

export const elapsing = <A, E>(
  duration: Duration.Input,
  effect: Effect.Effect<A, E>,
  waiting: Effect.Effect<unknown>
) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);

    yield* waiting;
    yield* TestClock.adjust(duration);

    return yield* Fiber.join(fiber);
  });

export const ticking = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);

    while (fiber.pollUnsafe() === undefined) {
      yield* TestClock.withLive(Effect.sleep(Duration.millis(1)));
      yield* TestClock.adjust(Duration.seconds(10));
    }

    return yield* Fiber.join(fiber);
  });
