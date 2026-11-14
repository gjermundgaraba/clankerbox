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
import type {
  Advanced,
  Interface as Store,
  Lease,
  Operation,
} from "./store.ts";

const busyWait = Duration.millis(100);

const unreachableWait = Duration.seconds(1);

const restPoll = Duration.millis(100);

/** What a look at an operation found that its resource acts on. */
export type Heard = Exclude<Polled, { readonly at: "unreachable" }>;

type Turned = "again" | "rest" | "over";

export interface Resource<R extends { readonly state: string }> {
  readonly kind: Lease["resource"];
  readonly find: (name: string) => Effect.Effect<Option.Option<R>, Internal>;
  readonly operationOn: Store["operationOn"];
  readonly activityOf: (state: R["state"]) => Activity;
  /** Reads what the chart's `read` needs, and writes it. */
  readonly looking: (
    row: R
  ) => Effect.Effect<Advanced<R>, Internal | Unreachable>;
  readonly polling: (row: R, op: Operation) => Effect.Effect<Polled, Internal>;
  /** Stores what a look found, which no wake cuts short, so a stored report is always collected. */
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
  resource.operationOn(by.resource, by.name).pipe(
    Effect.repeat({
      until: (op) => !Option.exists(op, ({ id }) => id === by.id),
      schedule: Schedule.spaced(busyWait),
    }),
    Effect.asVoid
  );

const looked = <R extends { readonly state: string }>(
  resource: Resource<R>,
  found: R,
  latch: Latch.Latch
) =>
  Effect.gen(function* () {
    const answer = yield* resource.looking(found);

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
    Effect.catchTags({
      Unanswered: () => Effect.succeed("rest" as const),
      Incompatible: () => Effect.succeed("rest" as const),
      Unsent: () => Effect.succeed("rest" as const),
    })
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
      yield* resource.operationOn(resource.kind, name),
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
  rechecked: boolean
): Effect.Effect<Turned, Internal> =>
  Effect.gen(function* () {
    const present = yield* resource.find(name);

    if (Option.isNone(present)) {
      return "over" as const;
    }

    const found = present.value;

    switch (resource.activityOf(found.state)) {
      case "read": {
        return yield* looked(resource, found, latch);
      }

      case "follow": {
        yield* followed(resource, name, found, latch);

        return "again" as const;
      }

      case "recheck": {
        return rechecked
          ? yield* looked(resource, found, latch)
          : ("rest" as const);
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
 * Looks until `rests` answers true. A look that fails with `Unavailable` tells of a host's fault,
 * which may pass, so it is tried again, and ends the wait once it has failed for `bound` on end.
 */
export const untilRest = <E extends { readonly _tag: string }>(
  bound: Duration.Duration,
  rests: Effect.Effect<boolean, E>
): Effect.Effect<void, E> =>
  rests.pipe(
    Effect.retry({
      while: ({ _tag }) => _tag === "Unavailable",
      schedule: Schedule.spaced(restPoll).pipe(
        Schedule.upTo({ duration: bound })
      ),
    }),
    Effect.repeat({
      until: (rested) => rested,
      schedule: Schedule.spaced(restPoll),
    }),
    Effect.asVoid
  );

/**
 * The loops of one resource, at most one per name, each moving its row a whole step at a time. The
 * activity of its leaf picks each turn. The answer starts a name's loop, or wakes the one running.
 * A write always comes before its wake, and a turn reads after the latch closes, so a wake is seen
 * by the turn it lands in or by the next. A loop ends only when no wake landed in its last turn.
 */
export const driver = <R extends { readonly state: string }>(
  recheck: Duration.Duration,
  resource: Resource<R>
): Effect.Effect<(name: string) => Effect.Effect<void>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const wakes = new Map<string, Latch.Latch>();

    const leaving = (name: string, latch: Latch.Latch) =>
      Effect.sync(() => {
        const woken = latch.closeUnsafe();

        if (!woken) {
          wakes.delete(name);
        }

        return !woken;
      });

    const looped = (name: string, latch: Latch.Latch) =>
      Effect.gen(function* () {
        let rechecked = true;

        for (;;) {
          yield* latch.close;

          const at = yield* turn(resource, name, latch, rechecked).pipe(
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
            rechecked = Option.isNone(
              yield* Effect.timeoutOption(latch.await, recheck)
            );
          } else if (at === "over" && (yield* leaving(name, latch))) {
            return;
          }
        }
      });

    return (name) =>
      Effect.suspend(() => {
        const running = wakes.get(name);

        if (running !== undefined) {
          running.openUnsafe();

          return Effect.void;
        }

        const latch = Latch.makeUnsafe(false);

        wakes.set(name, latch);

        return Effect.asVoid(
          Effect.forkIn(
            apart({ [resource.kind]: name })(looped(name, latch)),
            scope
          )
        );
      });
  });
