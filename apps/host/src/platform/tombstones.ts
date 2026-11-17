import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import {
  Context,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import type { Scope } from "effect";

import type { Handle, Identity } from "../runtime.ts";

/**
 * A machine carrying this host's mark at its provider, the instance the mark names, and the handle
 * of each checkpoint the provider holds through it.
 */
export interface Marked {
  readonly instance: string;
  readonly handle: Handle;
  readonly checkpoints: readonly Handle[];
}

/**
 * What a rented runtime keeps of each machine instance its delete answered for, so it keeps the
 * port's promise that anything of that instance which lands at the provider later is deleted.
 */
export interface Tombstones {
  /** Keeps a tombstone of `instance`, once its delete answered. */
  readonly bury: (instance: string) => Effect.Effect<void, Internal>;
  /**
   * Refuses a make of an instance with a tombstone, which only a control plane restored from a
   * backup sends: the machine would be swept as it lands.
   */
  readonly refuse: (machine: Identity) => Effect.Effect<void, Internal>;
}

/** How often a sweep runs while a tombstone is kept. */
export const SweepEvery = Context.Reference<Duration.Duration>(
  "@clankerbox/host/platform/tombstones/SweepEvery",
  { defaultValue: () => Duration.seconds(30) }
);

/** How long a tombstone lasts from the first sweep that left nothing of its instance. */
export const tombstoneLast = Duration.days(1);

const Kept = Schema.Array(
  Schema.Struct({
    instance: Schema.String,
    quietSince: Schema.NullOr(Schema.DateTimeUtcFromString),
  })
);

const decodeKept = Schema.decodeUnknownEffect(Schema.fromJsonString(Kept));

const encodeKept = Schema.encodeEffect(Schema.fromJsonString(Kept));

interface Stone {
  readonly quietSince: DateTime.Utc | undefined;
}

/**
 * The tombstones of a rented runtime, kept in a file in `dir`, under the host's state directory, so a host
 * that restarts keeps them, and a sweep in the scope that makes them. Every `SweepEvery`, while a
 * tombstone is kept, the sweep lists what carries this host's mark, and so a host with nothing to
 * delete pays for no list, and deletes each machine whose instance has a tombstone through
 * `remove`, keeping every checkpoint it holds, as a row may still want one. A tombstone lasts
 * `tombstoneLast` from the first sweep that left nothing of its instance, and one whose delete
 * failed waits for a sweep that deletes it. A tombstone only ever deletes, so a host with none, or
 * one that lost its file, keeps every machine a row wants.
 */
export const make = (options: {
  readonly dir: string;
  readonly provider: string;
  readonly marked: Effect.Effect<readonly Marked[], Internal>;
  readonly remove: (machine: Marked) => Effect.Effect<void, Internal>;
}): Effect.Effect<Tombstones, Internal, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { provider } = options;
    const file = `${options.dir}/tombstones.json`;

    const failed = (what: string) => (error: { readonly message: string }) =>
      new Internal({ message: `couldn't ${what} ${file}: ${error.message}` });

    const read = yield* fs
      .makeDirectory(options.dir, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.andThen(fs.exists(file)),
        Effect.flatMap((found) =>
          found ? fs.readFileString(file) : Effect.succeed("[]")
        ),
        Effect.flatMap(decodeKept),
        Effect.mapError(failed("read the tombstones in"))
      );

    const stones = new Map<string, Stone>(
      read.map(({ instance, quietSince }) => [
        instance,
        { quietSince: quietSince ?? undefined },
      ])
    );

    const writing = yield* Semaphore.make(1);
    const undeleted = new Set<string>();

    const written = Effect.suspend(() =>
      encodeKept(
        [...stones].map(([instance, { quietSince }]) => ({
          instance,
          quietSince: quietSince ?? null,
        }))
      )
    ).pipe(
      Effect.flatMap((text) =>
        Effect.andThen(
          fs.writeFileString(`${file}.next`, text),
          fs.rename(`${file}.next`, file)
        )
      ),
      Effect.mapError(failed("write the tombstones to"))
    );

    const bury: Tombstones["bury"] = (instance) =>
      writing.withPermits(1)(
        Effect.suspend(() => {
          stones.set(instance, { quietSince: undefined });

          return written;
        })
      );

    const swept = (machine: Marked): Effect.Effect<boolean> =>
      Effect.suspend(() => {
        const what = `machine ${machine.instance} (${machine.handle})`;
        const again = undeleted.has(machine.instance);

        return options.remove(machine).pipe(
          Effect.tap(() =>
            Effect.andThen(
              Effect.sync(() => undeleted.delete(machine.instance)),
              Effect.logInfo(
                `sweep: deleted ${what}, which landed at ${provider} after its delete`
              )
            )
          ),
          Effect.as(true),
          Effect.catch((error) =>
            Effect.as(
              Effect.andThen(
                Effect.sync(() => undeleted.add(machine.instance)),
                again
                  ? Effect.logDebug(
                      `sweep: still couldn't delete ${what}: ${error.message}`
                    )
                  : Effect.logWarning(
                      `sweep: couldn't delete ${what}, which landed at ${provider} after its delete, so each sweep tries again: ${error.message}`
                    )
              ),
              false
            )
          )
        );
      });

    const sweep = Effect.gen(function* () {
      const before = new Map(stones);

      if (before.size === 0) {
        return;
      }

      const listed = yield* options.marked;

      const left = new Set(
        (yield* Effect.forEach(
          listed.filter(({ instance }) => before.has(instance)),
          (machine) =>
            Effect.map(swept(machine), (deleted) =>
              deleted ? [] : [machine.instance]
            ),
          { concurrency: "unbounded" }
        )).flat()
      );

      const now = yield* DateTime.now;
      const forgotten = DateTime.subtractDuration(now, tombstoneLast);

      yield* writing.withPermits(1)(
        Effect.suspend(() => {
          for (const [instance, stone] of before) {
            if (stones.get(instance) !== stone) {
              continue;
            }

            const quietSince = left.has(instance)
              ? undefined
              : (stone.quietSince ?? now);

            if (
              quietSince !== undefined &&
              DateTime.isLessThanOrEqualTo(quietSince, forgotten)
            ) {
              stones.delete(instance);
              undeleted.delete(instance);
            } else if (quietSince !== stone.quietSince) {
              stones.set(instance, { quietSince });
            }
          }

          return written;
        })
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `sweep: couldn't sweep what landed at ${provider} after its delete, so the next sweep tries again: ${error.message}`
        )
      )
    );

    yield* Effect.forkScoped(
      Effect.repeat(sweep, Schedule.spaced(yield* SweepEvery))
    );

    return {
      bury,
      refuse: (machine) =>
        stones.has(machine.instance)
          ? Effect.fail(
              new Internal({
                message: `make ${machine.name}: this host deleted instance ${machine.instance} already, and makes no instance it deleted again`,
              })
            )
          : Effect.void,
    } satisfies Tombstones;
  });
