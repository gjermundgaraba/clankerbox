import { Context, Effect, Layer, RcMap, Semaphore } from "effect";
import type { Scope } from "effect";

import type { Resource } from "./ids.ts";

const holders = 1024;

export interface Lease {
  readonly mode: "share" | "own";
  readonly name: string;
}

export const shared = (name: string): Lease => ({ mode: "share", name });

export const owned = (name: string): Lease => ({ mode: "own", name });

export interface Wanted {
  readonly machine?: Lease;
  readonly checkpoint?: Lease;
}

export interface Interface {
  readonly hold: (wanted: Wanted) => Effect.Effect<void, never, Scope.Scope>;
}

export class Leases extends Context.Service<Leases, Interface>()(
  "@clankerbox/host/Leases"
) {}

export const make: Effect.Effect<Interface, never, Scope.Scope> = Effect.gen(
  function* () {
    const locks = yield* RcMap.make({
      lookup: (_key: string) =>
        Effect.all({
          gate: Semaphore.make(1),
          permits: Semaphore.make(holders),
        }),
    });

    const take = (
      leased: Resource,
      { mode, name }: Lease
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.flatMap(RcMap.get(locks, `${leased} ${name}`), (lock) => {
        const permits = mode === "share" ? 1 : holders;

        return lock.gate.withPermits(1)(
          Effect.uninterruptibleMask((restore) =>
            Effect.andThen(
              restore(lock.permits.withPermits(permits)(Effect.void)),
              Effect.acquireRelease(lock.permits.take(permits), () =>
                lock.permits.release(permits)
              )
            )
          )
        );
      });

    return {
      hold: ({ machine, checkpoint }) =>
        Effect.andThen(
          machine === undefined ? Effect.void : take("machine", machine),
          checkpoint === undefined
            ? Effect.void
            : take("checkpoint", checkpoint)
        ),
    };
  }
);

export const layer: Layer.Layer<Leases> = Layer.effect(Leases, make);
