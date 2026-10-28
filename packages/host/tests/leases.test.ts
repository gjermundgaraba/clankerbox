import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Ref, Scope } from "effect";

import * as Leases from "../src/leases.ts";

describe("leases", () => {
  it.effect(
    "a share asked for while an owner waits comes after the owner",
    () =>
      Effect.gen(function* () {
        const leases = yield* Leases.make;
        const order = yield* Ref.make<readonly string[]>([]);
        const first = yield* Scope.make();

        yield* Scope.provide(
          leases.hold({ checkpoint: Leases.shared("snap") }),
          first
        );

        const owner = yield* Effect.forkChild(
          Effect.scoped(
            Effect.andThen(
              leases.hold({ checkpoint: Leases.owned("snap") }),
              Ref.update(order, (all) => [...all, "own"])
            )
          )
        );

        yield* Effect.yieldNow;

        const sharer = yield* Effect.forkChild(
          Effect.scoped(
            Effect.andThen(
              leases.hold({ checkpoint: Leases.shared("snap") }),
              Ref.update(order, (all) => [...all, "share"])
            )
          )
        );

        yield* Effect.yieldNow;

        const whileShared = yield* Ref.get(order);

        yield* Scope.close(first, Exit.void);
        yield* Fiber.join(owner);
        yield* Fiber.join(sharer);

        expect([whileShared, yield* Ref.get(order)]).toStrictEqual([
          [],
          ["own", "share"],
        ]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "an owner interrupted while it waits holds nothing, and a later owner gets it",
    () =>
      Effect.gen(function* () {
        const leases = yield* Leases.make;
        const first = yield* Scope.make();

        yield* Scope.provide(
          leases.hold({ machine: Leases.shared("dev") }),
          first
        );

        const waiting = yield* Effect.forkChild(
          Effect.scoped(leases.hold({ machine: Leases.owned("dev") }))
        );

        yield* Effect.yieldNow;
        yield* Fiber.interrupt(waiting);
        yield* Scope.close(first, Exit.void);

        const later = yield* Effect.forkChild(
          Effect.scoped(leases.hold({ machine: Leases.owned("dev") }))
        );

        const owned = yield* Effect.repeat(
          Effect.flatMap(Effect.yieldNow, () =>
            Effect.sync(() => later.pollUnsafe())
          ),
          { until: (exit) => exit !== undefined, times: 100 }
        );

        expect([(yield* Fiber.await(waiting))._tag, owned?._tag]).toStrictEqual(
          ["Failure", "Success"]
        );
      }).pipe(Effect.scoped)
  );

  it.effect(
    "shares of one resource hold it side by side, and other resources are apart",
    () =>
      Effect.gen(function* () {
        const leases = yield* Leases.make;

        const holding = yield* Effect.forkChild(
          Effect.all([
            leases.hold({ checkpoint: Leases.shared("snap") }),
            leases.hold({ checkpoint: Leases.shared("snap") }),
            leases.hold({ checkpoint: Leases.owned("other") }),
            leases.hold({ machine: Leases.owned("snap") }),
          ])
        );

        const held = yield* Effect.repeat(
          Effect.flatMap(Effect.yieldNow, () =>
            Effect.sync(() => holding.pollUnsafe())
          ),
          { until: (exit) => exit !== undefined, times: 100 }
        );

        expect(held === undefined ? "blocked" : held._tag).toBe("Success");
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a hold of a machine and a checkpoint takes the checkpoint only once it has the machine",
    () =>
      Effect.gen(function* () {
        const leases = yield* Leases.make;
        const first = yield* Scope.make();

        yield* Scope.provide(
          leases.hold({ machine: Leases.owned("dev") }),
          first
        );

        const both = yield* Effect.forkChild(
          Effect.scoped(
            leases.hold({
              machine: Leases.shared("dev"),
              checkpoint: Leases.owned("snap"),
            })
          )
        );

        yield* Effect.yieldNow;

        const checkpointFree = yield* Effect.forkChild(
          Effect.scoped(leases.hold({ checkpoint: Leases.owned("snap") }))
        );

        const meanwhile = yield* Effect.repeat(
          Effect.flatMap(Effect.yieldNow, () =>
            Effect.sync(() => checkpointFree.pollUnsafe())
          ),
          { until: (exit) => exit !== undefined, times: 100 }
        );

        yield* Scope.close(first, Exit.void);
        yield* Fiber.join(both);

        expect([meanwhile?._tag, both.pollUnsafe()?._tag]).toStrictEqual([
          "Success",
          "Success",
        ]);
      }).pipe(Effect.scoped)
  );
});
