import { Deferred, Effect } from "effect";

import type { Stalled, StallAt } from "./runtime-contract.ts";

interface Armed {
  after: number;
  readonly at: StallAt;
  readonly reached: Deferred.Deferred<undefined>;
  readonly released: Deferred.Deferred<undefined>;
}

/**
 * The provider calls a fixture counts for `Faults.stall`: `stall` arms the call `after` calls on,
 * and `next` answers, for each call made, where to hold it, which only the armed call does.
 */
export const callStalls = () => {
  let armed: Armed | undefined;

  const held = (stall: Armed | undefined) => (at: StallAt) =>
    stall?.at === at
      ? Effect.andThen(
          Deferred.succeed(stall.reached, undefined),
          Effect.andThen(
            Deferred.await(stall.released),
            Effect.die(new Error(`the host ended in this call, at its ${at}`))
          )
        )
      : Effect.void;

  return {
    stall: (after: number, at: StallAt): Effect.Effect<Stalled> =>
      Effect.gen(function* () {
        const stall: Armed = {
          after,
          at,
          reached: yield* Deferred.make<undefined>(),
          released: yield* Deferred.make<undefined>(),
        };

        armed = stall;

        return {
          reached: Deferred.await(stall.reached),
          release: Effect.andThen(
            Effect.sync(() => {
              if (armed === stall) {
                armed = undefined;
              }
            }),
            Effect.asVoid(Deferred.succeed(stall.released, undefined))
          ),
        };
      }),
    next: (): ((at: StallAt) => Effect.Effect<void>) => {
      if (armed === undefined) {
        return held(undefined);
      }

      if (armed.after > 0) {
        armed.after -= 1;

        return held(undefined);
      }

      const here = armed;

      armed = undefined;

      return held(here);
    },
  };
};
