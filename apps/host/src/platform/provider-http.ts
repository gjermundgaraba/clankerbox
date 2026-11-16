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

const loopback = /^(?:localhost|\[::1\]|127(?:\.\d{1,3}){3})$/u;

/** A provider's API URL, which its key rides on with every request: `https`, or `http` only to a loopback address. */
export const KeyedApiUrl = Schema.String.check(
  Schema.makeFilter((text: string) => {
    const url = URL.parse(text);

    return (
      url?.protocol === "https:" ||
      (url?.protocol === "http:" && loopback.test(url.hostname)) ||
      "an https URL, or an http one to a loopback address, as the key rides on every request"
    );
  })
);

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

/** How a call to a provider's API fails, with the provider's own `Refused`. */
export type ProviderError<Refused> = Refused | Unanswered | Busy | Unreadable;

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

const fromGateway = (
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

const askedToWait = (
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

const exchanged = <A, E>(
  http: HttpClient.HttpClient,
  url: string,
  key: Redacted.Redacted,
  request: HttpClientRequest.HttpClientRequest,
  asked: Asked,
  read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>
): Effect.Effect<A, E | Unanswered> => {
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

/** What an adapter reads of its provider's answer of HTTP 400 or more. */
export interface Refusal<Refused> {
  /** Whether the body is the provider's own answer, which a gateway's 5xx isn't. */
  readonly own: boolean;
  /** Why the provider asks to be waited out, if it does. */
  readonly waits: string | undefined;
  readonly refused: Refused;
}

/**
 * The calls to a provider's API at `url` with the account's `key`. A call sends its request asking
 * JSON, within the bound of what it `asked`, and answers what `answered` reads of a response under
 * 400; no answer, or one that couldn't be received, is a lost answer. Of any other response,
 * `refusal` reads the provider's own answer: a 5xx whose body is none is a gateway's, whatever that
 * body holds, and a lost answer; else one that asks to be waited out fails `Busy`; else the call
 * fails with the provider's refusal. It is sent again as `askedAgain` says.
 */
export const sender =
  <Refused>(
    http: HttpClient.HttpClient,
    url: string,
    key: Redacted.Redacted,
    refusal: (
      response: HttpClientResponse.HttpClientResponse,
      asked: Asked,
      call: string
    ) => Effect.Effect<Refusal<Refused>>
  ) =>
  <A>(
    request: HttpClientRequest.HttpClientRequest,
    asked: Asked,
    repeats: Repeats,
    answered: (
      response: HttpClientResponse.HttpClientResponse
    ) => Effect.Effect<A, Unanswered>
  ): Effect.Effect<A, Refused | Unanswered | Busy> => {
    const call = `${request.method} ${request.url}`;

    const refused = (
      response: HttpClientResponse.HttpClientResponse,
      read: Refusal<Refused>
    ): Effect.Effect<never, Refused | Unanswered | Busy> => {
      const gateway = fromGateway(call, response.status, read.own);

      if (gateway !== undefined) {
        return Effect.fail(gateway);
      }

      return read.waits === undefined
        ? Effect.fail(read.refused)
        : askedToWait(call, response, read.waits);
    };

    return askedAgain(repeats)(
      exchanged(http, url, key, request, asked, (response) =>
        response.status < 400
          ? answered(response)
          : Effect.flatMap(refusal(response, asked, call), (read) =>
              refused(response, read)
            )
      )
    );
  };

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
 * Sends a change that may be taken though its answer is lost, reading the resource after a lost
 * answer before sending it again, so a change the provider took is never sent twice.
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
