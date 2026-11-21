import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import {
  Cause,
  Duration,
  Effect,
  Latch,
  Option,
  References,
  Schedule,
} from "effect";
import type { Scope } from "effect";

import type { Activity } from "./chart.ts";
import type { Unreachable } from "./hosts.ts";
import type { Polled } from "./operations.ts";
import { readUntil } from "./store.ts";
import type {
  Advanced,
  Interface as Store,
  Lease,
  Operation,
} from "./store.ts";

const unreachableWait = Duration.seconds(1);

export type Heard = Exclude<Polled, { readonly at: "unreachable" }>;

type Turned = "again" | "rest" | "over";

export interface Resource<R extends { readonly state: string }> {
  readonly kind: Lease["resource"];
  readonly find: (name: string) => Effect.Effect<Option.Option<R>, Internal>;
  readonly store: Pick<Store, "operationOn" | "watch">;
  readonly activityOf: (state: R["state"]) => Activity;
  /** A sweep newer than `sweepAtRest` may stand in for a host read. Otherwise read the host. */
  readonly looking: (
    row: R,
    sweepAtRest: number | undefined
  ) => Effect.Effect<Advanced<R>, Internal | Unreachable>;
  readonly polling: (row: R, op: Operation) => Effect.Effect<Polled, Internal>;
  /** No wake cuts it short, so a stored report is always collected. */
  readonly following: (
    row: R,
    op: Operation,
    heard: Heard
  ) => Effect.Effect<void, Internal>;
}

const ended = <R extends { readonly state: string }>(
  resource: Resource<R>,
  by: Operation
) =>
  Effect.asVoid(
    readUntil(
      resource.store,
      by.resource,
      by.name,
      resource.store.operationOn(by.resource, by.name),
      (op) => !Option.exists(op, ({ id }) => id === by.id)
    )
  );

const looked = <R extends { readonly state: string }>(
  resource: Resource<R>,
  found: R,
  latch: Latch.Latch,
  sweepAtRest: number | undefined
) =>
  Effect.gen(function* () {
    const answer = yield* resource.looking(found, sweepAtRest);

    switch (answer.at) {
      case "absent": {
        return "over" as const;
      }

      case "busy": {
        yield* Effect.raceFirst(ended(resource, answer.by), latch.await);

        return "again" as const;
      }

      case "written": {
        return answer.moved ? ("again" as const) : ("rest" as const);
      }
    }
  }).pipe(
    Effect.catchTag(["Unanswered", "Incompatible", "Unsent"], () =>
      Effect.succeed("rest" as const)
    )
  );

const polledFor = <R extends { readonly state: string }>(
  resource: Resource<R>,
  found: R,
  op: Operation,
  latch: Latch.Latch
) =>
  Effect.gen(function* () {
    const polled = yield* Effect.raceFirst(
      resource.polling(found, op),
      Effect.as(latch.await, { at: "woken" } as const)
    );

    switch (polled.at) {
      case "woken": {
        return;
      }

      case "unreachable": {
        yield* Effect.timeoutOption(latch.await, unreachableWait);

        return;
      }

      case "running":
      case "ended":
      case "lost": {
        yield* resource.following(found, op, polled);
      }
    }
  }).pipe(Effect.annotateLogs({ operation: op.id, step: op.kind }));

const followed = <R extends { readonly state: string }>(
  resource: Resource<R>,
  name: string,
  found: R,
  latch: Latch.Latch
) =>
  Effect.gen(function* () {
    const op = yield* Effect.fromOption(
      yield* resource.store.operationOn(resource.kind, name),
      () =>
        new Internal({
          message: `${resource.kind} ${name} is at ${found.state} with no operation`,
        })
    );

    yield* polledFor(resource, found, op, latch);
  });

const turn = <R extends { readonly state: string }>(
  resource: Resource<R>,
  name: string,
  latch: Latch.Latch,
  sweepAtRest: number | undefined
): Effect.Effect<Turned, Internal> =>
  Effect.gen(function* () {
    const present = yield* resource.find(name);

    if (Option.isNone(present)) {
      return "over" as const;
    }

    const found = present.value;

    switch (resource.activityOf(found.state)) {
      case "read": {
        return yield* looked(resource, found, latch, undefined);
      }

      case "follow": {
        yield* followed(resource, name, found, latch);

        return "again" as const;
      }

      case "recheck": {
        return sweepAtRest === undefined
          ? ("rest" as const)
          : yield* looked(resource, found, latch, sweepAtRest);
      }

      case "none": {
        return "over" as const;
      }
    }
  });

export const apart =
  (annotations: Readonly<Record<string, string>>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.provideService(References.CurrentLogAnnotations, annotations),
      Effect.provideService(References.CurrentLogSpans, [])
    );

export const untilRest = <E extends { readonly _tag: string }>(
  store: Pick<Store, "watch">,
  resource: Lease["resource"],
  name: string,
  bound: Duration.Duration,
  rests: Effect.Effect<boolean, E>
): Effect.Effect<void, E> =>
  readUntil(
    store,
    resource,
    name,
    rests.pipe(
      Effect.retry({
        while: ({ _tag }) => _tag === "Unavailable",
        schedule: Schedule.spaced(unreachableWait).pipe(
          Schedule.upTo({ duration: bound })
        ),
      })
    ),
    (rested) => rested,
    unreachableWait
  ).pipe(Effect.asVoid);

export interface Driven {
  readonly drive: (name: string) => Effect.Effect<void>;
  readonly beginSweep: Effect.Effect<number>;
  readonly rechecking: (name: string, sweepId: number) => Effect.Effect<void>;
}

export const sweptFallback = 3;

interface Loop {
  readonly latch: Latch.Latch;
  sweepAtRest: number;
  pendingSweep: number;
}

/**
 * A write precedes its wake, and each turn reads after closing the latch. A wake before that
 * close is covered by the next read; a wake after it stays visible to this turn or the next.
 * The loop retires only when no wake landed in its last turn.
 *
 * `beginSweep` assigns an ID before each sweep reads the host. A loop records the latest ID at
 * the start of the turn that finds it at rest: only the loop moves the row into rest, and a
 * request moves it out. A sweep with a higher ID therefore reads the VM after its last step;
 * an older sweep may have read before that step ended. A swept loop falls back to its own
 * read after `sweptFallback` recheck intervals without a fresh sweep.
 */
export const driver = <R extends { readonly state: string }>(
  recheck: Duration.Duration,
  resource: Resource<R>,
  swept = false
): Effect.Effect<Driven, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const loops = new Map<string, Loop>();
    let latestSweep = 0;

    const rest = swept ? Duration.times(recheck, sweptFallback) : recheck;

    const leaving = (name: string, { latch }: Loop) =>
      Effect.sync(() => {
        const woken = latch.closeUnsafe();

        if (!woken) {
          loops.delete(name);
        }

        return !woken;
      });

    const looped = (name: string, loop: Loop) =>
      Effect.gen(function* () {
        const { latch } = loop;
        let rechecked = !swept;

        for (;;) {
          yield* latch.close;

          const sweepAtTurnStart = latestSweep;

          if (rechecked) {
            loop.pendingSweep = 0;
          }

          const at = yield* turn(
            resource,
            name,
            latch,
            rechecked ? loop.sweepAtRest : undefined
          ).pipe(
            Effect.withSpan(`${resource.kind}.turn`, {
              root: true,
              attributes: { [resource.kind]: name },
            }),
            Effect.catchCause((cause) =>
              Effect.as(
                Effect.logError(
                  `${resource.kind} ${name}'s loop failed, and runs again at the next recheck:\n${Cause.pretty(cause)}`
                ),
                "rest" as const
              )
            )
          );

          rechecked = false;

          if (at === "rest") {
            loop.sweepAtRest = sweepAtTurnStart;

            const timedOut =
              loop.pendingSweep <= loop.sweepAtRest &&
              Option.isNone(yield* Effect.timeoutOption(latch.await, rest));

            rechecked = timedOut || loop.pendingSweep > loop.sweepAtRest;
          } else if (at === "over" && (yield* leaving(name, loop))) {
            return;
          }
        }
      });

    return {
      drive: (name) =>
        Effect.suspend(() => {
          const running = loops.get(name);

          if (running !== undefined) {
            running.latch.openUnsafe();

            return Effect.void;
          }

          const loop: Loop = {
            latch: Latch.makeUnsafe(false),
            sweepAtRest: latestSweep,
            pendingSweep: 0,
          };

          loops.set(name, loop);

          return Effect.asVoid(
            Effect.forkIn(
              apart({ [resource.kind]: name })(looped(name, loop)),
              scope
            )
          );
        }),
      beginSweep: Effect.sync(() => {
        latestSweep += 1;

        return latestSweep;
      }),
      rechecking: (name, sweepId) =>
        Effect.sync(() => {
          const loop = loops.get(name);

          if (
            loop !== undefined &&
            sweepId > loop.sweepAtRest &&
            sweepId > loop.pendingSweep
          ) {
            loop.pendingSweep = sweepId;
            loop.latch.openUnsafe();
          }
        }),
    };
  });
