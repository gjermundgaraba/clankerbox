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
  /**
   * On a recheck, `rested` is the reading count when the loop came to rest: a reading begun after
   * it, with a higher count, saw the row's resource while the row rested, so it may stand in for a
   * read of the host. Any other look reads the host.
   */
  readonly looking: (
    row: R,
    rested: number | undefined
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
  rested: number | undefined
) =>
  Effect.gen(function* () {
    const answer = yield* resource.looking(found, rested);

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
  rested: number | undefined
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
        return rested === undefined
          ? ("rest" as const)
          : yield* looked(resource, found, latch, rested);
      }

      case "none": {
        return "over" as const;
      }
    }
  });

/**
 * Work that outlives the request that began it, such as a loop or a build, logs under its own
 * annotations alone, so none of its lines carries a request that ended long ago.
 */
export const apart =
  (annotations: Readonly<Record<string, string>>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.provideService(References.CurrentLogAnnotations, annotations),
      Effect.provideService(References.CurrentLogSpans, [])
    );

/**
 * Looks until `rests` answers true, again at each write of `resource`'s row `name`, and each second
 * between, as a look also reads a host that may stop answering with no write. A look that fails with
 * `Unavailable` tells of a host's fault, which may pass, so it is tried again, and ends the wait
 * once it has failed for `bound` on end.
 */
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
  /** Starts a name's loop, or wakes the one running. */
  readonly drive: (name: string) => Effect.Effect<void>;
  /** Counts a reading that begins now, for `rechecking` to tell the loops that rested before it. */
  readonly reading: Effect.Effect<number>;
  /**
   * Has a name's loop, if it rested before reading `taken` began, look again at once as at a
   * recheck, which may use that reading. A loop that isn't running stays so.
   */
  readonly rechecking: (name: string, taken: number) => Effect.Effect<void>;
}

/** How long a swept loop rests with no recheck before it looks on its own, as a sweep may fail. */
export const sweptFallback = 3;

interface Loop {
  readonly latch: Latch.Latch;
  rested: number;
  pending: number;
}

/**
 * The loops of one resource, at most one per name, each moving its row a whole step at a time. The
 * activity of its leaf picks each turn. `drive` starts a name's loop, or wakes the one running.
 * A write always comes before its wake, and a turn reads after the latch closes, so a wake is seen
 * by the turn it lands in or by the next. A loop ends only when no wake landed in its last turn.
 *
 * A resting loop looks again at each recheck. Unless `swept`, that is `recheck` after it rested,
 * and a loop's first turn is one. A `swept` loop is told its rechecks by `rechecking`, from a
 * sweep that reads every resting row at once, and looks on its own only once `sweptFallback`
 * rechecks pass with none. A loop rested at the count of readings when the turn that rested began,
 * as only its own turns move a row into a resting leaf, and a request moves it out: so a reading
 * counted after that saw the VM after the last step on it, and one counted before may not have.
 */
export const driver = <R extends { readonly state: string }>(
  recheck: Duration.Duration,
  resource: Resource<R>,
  swept = false
): Effect.Effect<Driven, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const loops = new Map<string, Loop>();
    let readings = 0;

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

          const began = readings;

          if (rechecked) {
            loop.pending = 0;
          }

          const at = yield* turn(
            resource,
            name,
            latch,
            rechecked ? loop.rested : undefined
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
            loop.rested = began;

            const timedOut =
              loop.pending <= loop.rested &&
              Option.isNone(yield* Effect.timeoutOption(latch.await, rest));

            rechecked = timedOut || loop.pending > loop.rested;
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
            rested: readings,
            pending: 0,
          };

          loops.set(name, loop);

          return Effect.asVoid(
            Effect.forkIn(
              apart({ [resource.kind]: name })(looped(name, loop)),
              scope
            )
          );
        }),
      reading: Effect.sync(() => {
        readings += 1;

        return readings;
      }),
      rechecking: (name, taken) =>
        Effect.sync(() => {
          const loop = loops.get(name);

          if (
            loop !== undefined &&
            taken > loop.rested &&
            taken > loop.pending
          ) {
            loop.pending = taken;
            loop.latch.openUnsafe();
          }
        }),
    };
  });
