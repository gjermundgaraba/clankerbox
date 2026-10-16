import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Ref, Scope } from "effect";
import * as Leases from "../src/leases.ts";

describe("leases", () => {
  it.effect("a share asked for while an owner waits comes after the owner", () =>
    Effect.gen(function* () {
      const leases = yield* Leases.make;
      const order = yield* Ref.make<ReadonlyArray<string>>([]);
      const first = yield* Scope.make();

      yield* Scope.provide(leases.share("checkpoint", "snap"), first);

      const owner = yield* Effect.forkChild(
        Effect.scoped(
          Effect.andThen(
            leases.own("checkpoint", "snap"),
            Ref.update(order, (all) => [...all, "own"]),
          ),
        ),
      );

      yield* Effect.yieldNow;

      const sharer = yield* Effect.forkChild(
        Effect.scoped(
          Effect.andThen(
            leases.share("checkpoint", "snap"),
            Ref.update(order, (all) => [...all, "share"]),
          ),
        ),
      );

      yield* Effect.yieldNow;

      const whileShared = yield* Ref.get(order);

      yield* Scope.close(first, Exit.void);
      yield* Fiber.join(owner);
      yield* Fiber.join(sharer);

      expect([whileShared, yield* Ref.get(order)]).toEqual([[], ["own", "share"]]);
    }).pipe(Effect.scoped),
  );

  it.effect("an owner interrupted while it waits holds nothing, and a later owner gets it", () =>
    Effect.gen(function* () {
      const leases = yield* Leases.make;
      const first = yield* Scope.make();

      yield* Scope.provide(leases.share("machine", "dev"), first);

      const waiting = yield* Effect.forkChild(Effect.scoped(leases.own("machine", "dev")));

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(waiting);
      yield* Scope.close(first, Exit.void);

      const later = yield* Effect.forkChild(Effect.scoped(leases.own("machine", "dev")));

      const owned = yield* Effect.repeat(
        Effect.flatMap(Effect.yieldNow, () => Effect.sync(() => later.pollUnsafe())),
        { until: (exit) => exit !== undefined, times: 100 },
      );

      expect([(yield* Fiber.await(waiting))._tag, owned?._tag]).toEqual(["Failure", "Success"]);
    }).pipe(Effect.scoped),
  );

  it.effect("shares of one resource hold it side by side, and other resources are apart", () =>
    Effect.gen(function* () {
      const leases = yield* Leases.make;

      const holding = yield* Effect.forkChild(
        Effect.all([
          leases.share("checkpoint", "snap"),
          leases.share("checkpoint", "snap"),
          leases.own("checkpoint", "other"),
          leases.own("machine", "snap"),
        ]),
      );

      const held = yield* Effect.repeat(
        Effect.flatMap(Effect.yieldNow, () => Effect.sync(() => holding.pollUnsafe())),
        { until: (exit) => exit !== undefined, times: 100 },
      );

      expect(held === undefined ? "blocked" : held._tag).toBe("Success");
    }).pipe(Effect.scoped),
  );
});
