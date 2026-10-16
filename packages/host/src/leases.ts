import { Context, Effect, Layer, RcMap, type Scope, Semaphore } from "effect";
import type { Kind } from "./ids.ts";

const holders = 1024;

/**
 * In memory only: a host that ends drops every lease with the work that held it. A step takes its
 * machines' leases before its checkpoints', so no two steps wait on each other.
 */
export interface Interface {
  /**
   * Held until the scope closes, beside any other share: what copies a resource shares it, so it
   * doesn't change under the copy.
   */
  readonly share: (kind: Kind, name: string) => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Held alone until the scope closes: what changes a resource owns it. A share asked for while an
   * owner waits comes after the owner. Either waits interruptibly, so a step cut short while it
   * waits holds nothing.
   */
  readonly own: (kind: Kind, name: string) => Effect.Effect<void, never, Scope.Scope>;
}

export class Leases extends Context.Service<Leases, Interface>()("@clankerbox/host/Leases") {}

export const make: Effect.Effect<Interface, never, Scope.Scope> = Effect.gen(function* () {
  const locks = yield* RcMap.make({
    lookup: (_key: string) =>
      Effect.all({ gate: Semaphore.make(1), permits: Semaphore.make(holders) }),
  });

  const hold =
    (permits: number) =>
    (kind: Kind, name: string): Effect.Effect<void, never, Scope.Scope> =>
      Effect.flatMap(RcMap.get(locks, `${kind} ${name}`), (lock) =>
        lock.gate.withPermits(1)(
          Effect.uninterruptibleMask((restore) =>
            Effect.andThen(
              restore(lock.permits.withPermits(permits)(Effect.void)),
              Effect.acquireRelease(lock.permits.take(permits), () =>
                lock.permits.release(permits),
              ),
            ),
          ),
        ),
      );

  return { share: hold(1), own: hold(holders) };
});

export const layer: Layer.Layer<Leases> = Layer.effect(Leases, make);
