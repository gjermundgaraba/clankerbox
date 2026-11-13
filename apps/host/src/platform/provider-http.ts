import { Duration, Effect, Option, Schedule, Schema } from "effect";
import type { HttpClientResponse } from "effect/http";

import { timeoutFail } from "../runtime.ts";

export type Asked = "read" | "change" | "settle";

/**
 * How long a provider's API may take to answer a request, by what it asks: a `read`, a `change`
 * it answers once it has taken it, or one it answers only once the machine has `settle`d, as smol
 * cloud's start and capture do. A request not answered in time leaves its outcome unknown, as a
 * dropped connection does, so a stalled connection costs its step a read, not its whole deadline.
 */
export const answerWithin: Readonly<Record<Asked, Duration.Duration>> = {
  read: Duration.seconds(30),
  change: Duration.minutes(1),
  settle: Duration.minutes(5),
};

/** No answer, a gateway's, or one that couldn't be read, so whether the request happened is unknown. */
export class Unanswered extends Schema.TaggedError<
  Unanswered,
  { readonly brand: unique symbol }
>()("Unanswered", {
  message: Schema.String,
}) {}

/** The provider asked to be waited out, so it didn't take the request, which is sent again. */
export class Busy extends Schema.TaggedError<
  Busy,
  { readonly brand: unique symbol }
>()("Busy", {
  message: Schema.String,
}) {}

/** A list answered a record of this host's that the adapter can't read; asking again reads the same. */
export class Unreadable extends Schema.TaggedError<
  Unreadable,
  { readonly brand: unique symbol }
>()("Unreadable", {
  message: Schema.String,
}) {}

export const lost =
  (call: string) =>
  (error: { readonly message: string }): Unanswered =>
    new Unanswered({ message: `${call}: ${error.message}` });

export const within =
  (asked: Asked, call: string) =>
  <A, E, R>(answer: Effect.Effect<A, E, R>) =>
    answer.pipe(
      timeoutFail(
        answerWithin[asked],
        () =>
          new Unanswered({
            message: `${call}: no answer within ${Duration.format(answerWithin[asked])}`,
          })
      )
    );

/**
 * A 5xx whose body is no answer of the provider's is a gateway's, whatever that body holds, which
 * leaves the outcome unknown. Each adapter says what its provider's own answer looks like.
 */
export const fromGateway = (
  call: string,
  status: number,
  answered: boolean
): Unanswered | undefined =>
  status >= 500 && !answered
    ? new Unanswered({
        message: `${call}: HTTP ${status} with no answer of the provider's, as a gateway gives`,
      })
    : undefined;

const longestWait = Duration.seconds(30);

/** The wait a refusal's `Retry-After` asks, a second when it names none, and at most 30 seconds. */
export const retryAfter = (
  response: HttpClientResponse.HttpClientResponse
): Duration.Duration => {
  const seconds = Number(response.headers["retry-after"] ?? "1");

  return Duration.min(
    Duration.seconds(Number.isFinite(seconds) && seconds > 0 ? seconds : 1),
    longestWait
  );
};

/** Waits as `response` asks, within the clamp, and fails `Busy`, so `askedAgain` sends the call again. */
export const waitedOut = (
  call: string,
  response: HttpClientResponse.HttpClientResponse,
  why: string
): Effect.Effect<never, Busy> =>
  Effect.andThen(
    Effect.sleep(retryAfter(response)),
    Effect.fail(new Busy({ message: `${call}: ${why}, waited out` }))
  );

/** How many times a call is sent while its answer is lost or asks to be waited out. */
export const triesPerCall = 6;

/** Sends `call` again, backing off, while it fails with one of `tags`, at most `triesPerCall` sends in all. */
export const askedAgain =
  (tags: ReadonlySet<string>) =>
  <A, E extends { readonly _tag: string }, R>(
    call: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> =>
    Effect.retry(call, {
      while: (error) => tags.has(error._tag),
      schedule: Schedule.exponential(Duration.millis(250)),
      times: triesPerCall - 1,
    });

/** How many times a change whose answer is lost is sent, the resource read until it rests between sends. */
export const triesAfterLoss = 3;

/** Reads `read` a `poll` apart until what it answers `rests`, which it then answers. */
export function untilRest<A, B extends A, E, R>(
  read: Effect.Effect<A, E, R>,
  rests: (found: A) => found is B,
  poll: Duration.Duration
): Effect.Effect<B, E, R>;
export function untilRest<A, E, R>(
  read: Effect.Effect<A, E, R>,
  rests: (found: A) => boolean,
  poll: Duration.Duration
): Effect.Effect<A, E, R>;
export function untilRest<A, E, R>(
  read: Effect.Effect<A, E, R>,
  rests: (found: A) => boolean,
  poll: Duration.Duration
): Effect.Effect<A, E, R> {
  return Effect.repeat(read, { until: rests, schedule: Schedule.spaced(poll) });
}

export interface Change<A, E, F, G, R> {
  readonly send: Effect.Effect<void, E | Unanswered, R>;
  /** Reads the resource until it rests. */
  readonly rested: Effect.Effect<A, F, R>;
  readonly holds: (rested: A) => boolean;
  /** The failure once `triesAfterLoss` sends were lost and the resource rests without the change. */
  readonly unheld: (rested: A) => G;
}

/**
 * Sends a change that may be taken though its answer is lost: after a lost answer it reads the
 * resource until it rests, is done when that holds the change, and sends it again otherwise, at
 * most `triesAfterLoss` times in all, so a change the provider took is never sent twice.
 */
export const sentUntilHeld = <A, E, F, G, R>(
  change: Change<A, E, F, G, R>
): Effect.Effect<void, E | F | G, R> => {
  const sent = (tries: number): Effect.Effect<void, E | F | G, R> =>
    Effect.catchIf(
      change.send,
      (error): error is Unanswered => error instanceof Unanswered,
      () =>
        Effect.flatMap(change.rested, (found) => {
          if (change.holds(found)) {
            return Effect.void;
          }

          return tries > 1
            ? sent(tries - 1)
            : Effect.fail(change.unheld(found));
        })
    );

  return sent(triesAfterLoss);
};

export interface Records<A> {
  readonly call: string;
  readonly what: string;
  readonly read: (record: unknown) => Option.Option<A>;
  /** Whether a record `read` refused is still this host's, which then fails the list. */
  readonly ours: (record: unknown) => boolean;
  readonly label: (record: unknown) => string;
}

/**
 * Reads a list's records one at a time, as an account others share may hold records this host
 * can't read. One that `ours` claims fails the list `Unreadable`; any other is skipped, logged the
 * first time.
 */
export const recordReader = () => {
  const skipped = new Set<string>();

  return <A>(
    records: readonly unknown[],
    list: Records<A>
  ): Effect.Effect<A[], Unreadable> =>
    Effect.map(
      Effect.forEach(records, (record): Effect.Effect<A[], Unreadable> => {
        const read = list.read(record);

        if (Option.isSome(read)) {
          return Effect.succeed([read.value]);
        }

        const label = list.label(record);

        if (list.ours(record)) {
          return Effect.fail(
            new Unreadable({
              message: `${list.call} answered ${list.what} ${label}, which is this host's and couldn't be read`,
            })
          );
        }

        if (skipped.has(label)) {
          return Effect.succeed([]);
        }

        skipped.add(label);

        return Effect.as(
          Effect.logWarning(
            `${list.call} answered ${list.what} ${label}, which couldn't be read and isn't this host's, so its lists skip it`
          ),
          []
        );
      }),
      (kept) => kept.flat()
    );
};
