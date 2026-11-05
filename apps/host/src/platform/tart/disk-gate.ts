import { Effect, Latch } from "effect";

/**
 * Keeps Tart's reads, which open every VM's disk, apart from the commands that need one VM's disk to
 * themselves. Reads run together, and so do openers; each waits while the other side runs, and an
 * opener that waits keeps new reads out, so a run of reads never holds it off.
 */
export interface DiskGate {
  readonly reading: <A, E, R>(
    self: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
  readonly opening: <A, E, R>(
    self: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
}

export const make: Effect.Effect<DiskGate> = Effect.sync(() => {
  let reads = 0;
  let openers = 0;
  const readable = Latch.makeUnsafe(true);
  const openable = Latch.makeUnsafe(true);

  const enterRead = (
    restore: <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (openers > 0) {
        return Effect.andThen(restore(readable.await), enterRead(restore));
      }

      reads += 1;
      openable.closeUnsafe();

      return Effect.void;
    });

  const leaveRead = Effect.sync(() => {
    reads -= 1;

    if (reads === 0) {
      openable.openUnsafe();
    }
  });

  const leaveOpening = Effect.sync(() => {
    openers -= 1;

    if (openers === 0) {
      readable.openUnsafe();
    }
  });

  const untilOpenable = (
    restore: <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  ): Effect.Effect<void> =>
    Effect.suspend(() =>
      reads === 0
        ? Effect.void
        : Effect.andThen(restore(openable.await), untilOpenable(restore))
    );

  return {
    reading: (self) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.andThen(
          enterRead(restore),
          restore(self).pipe(Effect.ensuring(leaveRead))
        )
      ),
    opening: (self) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          openers += 1;
          readable.closeUnsafe();

          return yield* Effect.andThen(
            untilOpenable(restore),
            restore(self)
          ).pipe(Effect.ensuring(leaveOpening));
        })
      ),
  };
});
