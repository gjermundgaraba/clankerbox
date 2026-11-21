import type { RuntimeTraits } from "@clankerbox/host-contract/traits";
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

import type { Handle, Interface, RuntimeError, Target } from "../runtime.ts";

export interface MarkedMachine {
  readonly instance: string;
  readonly handle: Handle;
  readonly checkpoints: readonly Handle[];
}

export type Found = Omit<Interface, "delete"> & {
  readonly delete: (
    machine: Target,
    keep: ReadonlySet<Handle>
  ) => Effect.Effect<void, RuntimeError>;
};

export const SweepEvery = Context.Reference<Duration.Duration>(
  "@clankerbox/host/platform/tombstones/SweepEvery",
  { defaultValue: () => Duration.seconds(30) }
);

export const tombstoneLast = Duration.days(1);

const Kept = Schema.Array(
  Schema.Struct({
    instance: Schema.String,
    buriedAt: Schema.DateTimeUtcFromString,
  })
);

const decodeKept = Schema.decodeUnknownEffect(Schema.fromJsonString(Kept));

const encodeKept = Schema.encodeEffect(Schema.fromJsonString(Kept));

interface Options {
  readonly dir: string;
  readonly marked: Effect.Effect<readonly MarkedMachine[], RuntimeError>;
}

export const tombstoned = <
  R extends Pick<Found, "make" | "delete"> & {
    readonly traits: Pick<RuntimeTraits, "runtime">;
  },
>(
  runtime: R,
  { dir, marked }: Options
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${dir}/tombstones.json`;
    const provider = runtime.traits.runtime;

    const failed = (what: string) => (error: { readonly message: string }) =>
      new Internal({ message: `couldn't ${what} ${file}: ${error.message}` });

    const read = yield* fs
      .makeDirectory(dir, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.andThen(fs.exists(file)),
        Effect.flatMap((found) =>
          found ? fs.readFileString(file) : Effect.succeed("[]")
        ),
        Effect.flatMap(decodeKept),
        Effect.mapError(failed("read the tombstones in"))
      );

    const buried = new Map(
      read.map(({ instance, buriedAt }) => [instance, buriedAt])
    );

    const writing = yield* Semaphore.make(1);
    const undeleted = new Set<string>();

    const written = (next: ReadonlyMap<string, DateTime.Utc>) =>
      encodeKept(
        [...next].map(([instance, buriedAt]) => ({ instance, buriedAt }))
      ).pipe(
        Effect.flatMap((text) =>
          Effect.andThen(
            fs.writeFileString(`${file}.next`, text),
            fs.rename(`${file}.next`, file)
          )
        ),
        Effect.mapError(failed("write the tombstones to"))
      );

    const bury = (instance: string) =>
      writing.withPermits(1)(
        Effect.gen(function* () {
          if (buried.has(instance)) {
            return;
          }

          const buriedAt = yield* DateTime.now;

          yield* written(new Map(buried).set(instance, buriedAt));
          buried.set(instance, buriedAt);
        })
      );

    const swept = (machine: MarkedMachine): Effect.Effect<void> =>
      Effect.suspend(() => {
        const { instance, handle } = machine;
        const what = `machine ${instance} (${handle})`;
        const again = undeleted.has(instance);

        return runtime
          .delete(
            { name: instance, instance, handle },
            new Set(machine.checkpoints)
          )
          .pipe(
            Effect.tap(() =>
              Effect.andThen(
                Effect.sync(() => undeleted.delete(instance)),
                Effect.logInfo(
                  `sweep: deleted ${what}, which landed at ${provider} after its delete`
                )
              )
            ),
            Effect.catch((error) =>
              Effect.andThen(
                Effect.sync(() => undeleted.add(instance)),
                again
                  ? Effect.logDebug(
                      `sweep: still couldn't delete ${what}: ${error.message}`
                    )
                  : Effect.logWarning(
                      `sweep: couldn't delete ${what}, which landed at ${provider} after its delete, so each sweep tries again: ${error.message}`
                    )
              )
            )
          );
      });

    const sweep = Effect.gen(function* () {
      if (buried.size === 0) {
        return;
      }

      const found = (yield* marked).filter(({ instance }) =>
        buried.has(instance)
      );

      yield* Effect.forEach(found, swept, {
        concurrency: "unbounded",
        discard: true,
      });

      const left = new Set(found.map(({ instance }) => instance));

      const before = DateTime.subtractDuration(
        yield* DateTime.now,
        tombstoneLast
      );

      yield* writing.withPermits(1)(
        Effect.suspend(() => {
          const old = [...buried].filter(
            ([instance, buriedAt]) =>
              !left.has(instance) &&
              DateTime.isLessThanOrEqualTo(buriedAt, before)
          );

          if (old.length === 0) {
            return Effect.void;
          }

          const next = new Map(buried);

          for (const [instance] of old) {
            next.delete(instance);
          }

          return Effect.andThen(
            written(next),
            Effect.sync(() => {
              for (const [instance] of old) {
                buried.delete(instance);
                undeleted.delete(instance);
              }
            })
          );
        })
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `sweep: couldn't sweep what landed at ${provider} after its delete, so the next sweep tries again: ${error.message}`
        )
      ),
      Effect.catchDefect((defect) =>
        Effect.logError(
          `sweep: a sweep of what landed at ${provider} after its delete died, so the next sweep tries again`,
          defect
        )
      )
    );

    const refuse = (machine: {
      readonly name: string;
      readonly instance: string;
    }) =>
      buried.has(machine.instance)
        ? Effect.fail(
            new Internal({
              message: `make ${machine.name}: this host deleted instance ${machine.instance} already, and makes no instance it deleted again`,
            })
          )
        : Effect.void;

    const make: Interface["make"] = (machine, origin, port, tailnet) =>
      Effect.andThen(
        refuse(machine),
        runtime.make(machine, origin, port, tailnet)
      );

    const remove: Interface["delete"] = ({ handle, ...machine }, keep) =>
      Effect.andThen(
        handle === undefined
          ? Effect.void
          : runtime.delete({ ...machine, handle }, keep),
        bury(machine.instance)
      );

    return { runtime: { ...runtime, make, delete: remove }, sweep };
  });

export const rented = (
  runtime: Found,
  options: Options
): Effect.Effect<Interface, Internal, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const kept = yield* tombstoned(runtime, options);

    yield* Effect.forkScoped(
      Effect.repeat(kept.sweep, Schedule.spaced(yield* SweepEvery))
    );

    return kept.runtime;
  });
