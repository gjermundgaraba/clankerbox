import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import {
  Clock,
  Duration,
  Effect,
  FileSystem,
  Option,
  Redacted,
  Result,
  Schedule,
  Schema,
} from "effect";
import { Headers, HttpClientRequest } from "effect/http";
import type { HttpClient, HttpClientResponse } from "effect/http";

import { CannotStart, timeoutFail } from "../runtime.ts";
import { describe } from "./process.ts";

/**
 * What a request asks of a provider's API, which bounds how long it may take to answer: a `read`, a
 * `change` it answers once it has taken it, or one it answers only once the machine has `settle`d,
 * as smol cloud's start and capture do. A request not answered in time is a lost answer, so a
 * stalled connection costs its step a read, not its whole deadline.
 */
export type Asked = "read" | "change" | "settle";

const answerWithin: Readonly<Record<Asked, Duration.Duration>> = {
  read: Duration.seconds(30),
  change: Duration.minutes(1),
  settle: Duration.minutes(5),
};

export const stepWithin = Duration.minutes(10);

/**
 * Runs a step on a provider whole, its calls billed and uncut by a later request, which waits for
 * it, and ends it failed `Internal` once it has taken `stepWithin`.
 */
export const bounded =
  (provider: string, what: string) =>
  <A, E, R>(step: Effect.Effect<A, E, R>): Effect.Effect<A, E | Internal, R> =>
    step.pipe(
      timeoutFail(
        stepWithin,
        () =>
          new Internal({
            message: `${what} didn't end at ${provider} within ${Duration.format(stepWithin)}`,
          })
      ),
      Effect.uninterruptible
    );

/** No answer, a gateway's, or one that couldn't be read, so whether the request happened is unknown. */
export class Unanswered extends Schema.TaggedError<
  Unanswered,
  { readonly brand: unique symbol }
>()("Unanswered", {
  message: Schema.String,
}) {}

/** The provider asked to be waited out `wait`, so it didn't take the request, which is sent again. */
export class Busy extends Schema.TaggedError<
  Busy,
  { readonly brand: unique symbol }
>()("Busy", {
  message: Schema.String,
  wait: Schema.Duration,
}) {}

/** A list answered a record of this host's that the adapter can't read; asking again reads the same. */
export class Unreadable extends Schema.TaggedError<
  Unreadable,
  { readonly brand: unique symbol }
>()("Unreadable", {
  message: Schema.String,
}) {}

const lost =
  (call: string) =>
  (error: { readonly message: string }): Unanswered =>
    new Unanswered({ message: `${call}: ${error.message}` });

const within =
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

const waits = { minimum: Duration.seconds(1), maximum: Duration.seconds(30) };

/**
 * The wait a refusal's `Retry-After` asks, in whole seconds or until an HTTP date, within 1 and 30
 * seconds, so one that names neither, or less, waits a second.
 */
export const retryAfter = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<Duration.Duration> =>
  Effect.map(Clock.currentTimeMillis, (now) =>
    Duration.clamp(
      Option.match(Headers.get(response.headers, "retry-after"), {
        onNone: () => Duration.zero,
        onSome: (asked) =>
          Result.match(Headers.parseRetryAfter(asked), {
            onFailure: () => Duration.zero,
            onSuccess: (parsed) => Headers.retryAfterDelay(parsed, now),
          }),
      }),
      waits
    )
  );

/** The provider took nothing and asks to be waited out, unless its answer says there is no room. */
export const tooManyRequests = 429;

export const askedToWait = (
  call: string,
  response: HttpClientResponse.HttpClientResponse,
  why: string
): Effect.Effect<never, Busy> =>
  Effect.flatMap(retryAfter(response), (wait) =>
    Effect.fail(
      new Busy({
        message: `${call} answered ${why}, which asks to be waited out`,
        wait,
      })
    )
  );

export const apiKey = (
  provider: string,
  file: string
): Effect.Effect<Redacted.Redacted, CannotStart, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs.readFileString(file).pipe(
      Effect.map((text) => Redacted.make(text.trim())),
      Effect.mapError(
        (error) =>
          new CannotStart({
            message: `couldn't read ${provider}'s API key from ${file}: ${describe(error)}`,
          })
      )
    );
  });

/**
 * Sends `request` to the API at `url` with the account's `key`, asking JSON, and answers what
 * `read` makes of the response, within the bound of what it `asked`; no answer, or one that
 * couldn't be received, is a lost answer.
 */
export const exchanged = <A>(
  http: HttpClient.HttpClient,
  url: string,
  key: Redacted.Redacted,
  request: HttpClientRequest.HttpClientRequest,
  asked: Asked,
  read: (
    response: HttpClientResponse.HttpClientResponse
  ) => Effect.Effect<A, Unanswered>
): Effect.Effect<A, Unanswered> => {
  const call = `${request.method} ${request.url}`;

  return http
    .execute(
      request.pipe(
        HttpClientRequest.prependUrl(url),
        HttpClientRequest.bearerToken(key),
        HttpClientRequest.acceptJson
      )
    )
    .pipe(
      Effect.mapError(lost(call)),
      Effect.flatMap(read),
      within(asked, call)
    );
};

const triesPerCall = 6;

/**
 * Whether sending a call twice does no more than sending it once, as a read, or a delete, does.
 * Only such a call is sent again after a lost answer; any other only once the provider said it
 * took nothing, and its caller reads what the provider holds before it sends it again.
 */
export type Repeats = "idempotent" | "once";

const backoff = Schedule.exponential(Duration.millis(250)).pipe(
  Schedule.modifyDelay(({ input, duration }) =>
    Effect.succeed(
      input instanceof Busy ? Duration.max(duration, input.wait) : duration
    )
  )
);

/**
 * Sends `call` again, backing off, while the provider asks to be waited out, and while its answer
 * is lost if it is `idempotent`, at most `triesPerCall` sends in all. A send the provider asked to
 * wait out waits the longer of that and the backoff; a call still asked to wait at its last send
 * fails saying so.
 */
export const askedAgain =
  (repeats: Repeats) =>
  <A, E, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E | Busy, R> =>
    Effect.retry(call, {
      while: (error) =>
        error instanceof Busy ||
        (repeats === "idempotent" && error instanceof Unanswered),
      schedule: backoff,
      times: triesPerCall - 1,
    }).pipe(
      Effect.catchIf(
        (error): error is E & Busy => error instanceof Busy,
        (busy) =>
          Effect.fail(
            new Busy({
              message: `${busy.message}, still at the last of its ${triesPerCall} sends`,
              wait: busy.wait,
            })
          )
      )
    );

export const triesAfterLoss = 3;

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

export interface Change<A, S, E, F, G, R> {
  readonly send: Effect.Effect<S, E | Unanswered, R>;
  /** A refusal that may still have been taken, which is read for as a lost answer is. */
  readonly lost?: ((error: E) => boolean) | undefined;
  readonly rested: Effect.Effect<A, F, R>;
  readonly holds: (rested: A) => boolean;
  /** The failure once `triesAfterLoss` sends went unanswered and the resource rests without the change. */
  readonly unheld: (rested: A, last: E | Unanswered) => G;
}

/**
 * Sends a change that may be taken though its answer is lost: after a lost answer it reads the
 * resource until it rests, answers what it read when that holds the change, and sends it again
 * otherwise, at most `triesAfterLoss` times in all, so a change the provider took is never sent
 * twice.
 */
export function sentUntilHeld<A, H extends A, S, E, F, G, R>(
  change: Change<A, S, E, F, G, R> & {
    readonly holds: (rested: A) => rested is H;
  }
): Effect.Effect<S | H, E | F | G, R>;
export function sentUntilHeld<A, S, E, F, G, R>(
  change: Change<A, S, E, F, G, R>
): Effect.Effect<S | A, E | F | G, R>;
export function sentUntilHeld<A, S, E, F, G, R>(
  change: Change<A, S, E, F, G, R>
): Effect.Effect<S | A, E | F | G, R> {
  const sent = (tries: number): Effect.Effect<S | A, E | F | G, R> => {
    const read = (last: E | Unanswered) =>
      Effect.filterOrElse(change.rested, change.holds, (found) =>
        tries > 1 ? sent(tries - 1) : Effect.fail(change.unheld(found, last))
      );

    return Effect.catchIf(
      change.send,
      (error): error is Unanswered => error instanceof Unanswered,
      read,
      (refused) =>
        change.lost?.(refused) === true ? read(refused) : Effect.fail(refused)
    );
  };

  return sent(triesAfterLoss);
}

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
