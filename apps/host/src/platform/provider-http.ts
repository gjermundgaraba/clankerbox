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

export type Asked = "read" | "change" | "settle";

const answerWithin: Readonly<Record<Asked, Duration.Duration>> = {
  read: Duration.seconds(30),
  change: Duration.minutes(1),
  settle: Duration.minutes(5),
};

export const stepWithin = Duration.minutes(10);

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

export class Unanswered extends Schema.TaggedError<
  Unanswered,
  { readonly brand: unique symbol }
>()("Unanswered", {
  message: Schema.String,
}) {}

export class Busy extends Schema.TaggedError<
  Busy,
  { readonly brand: unique symbol }
>()("Busy", {
  message: Schema.String,
  wait: Schema.Duration,
}) {}

export class Unreadable extends Schema.TaggedError<
  Unreadable,
  { readonly brand: unique symbol }
>()("Unreadable", {
  message: Schema.String,
}) {}

export const providerErrors = [Unanswered, Busy, Unreadable] as const;

export type ProviderError<Refused> =
  | Refused
  | InstanceType<(typeof providerErrors)[number]>;

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
  key: Effect.Effect<Redacted.Redacted, Unanswered>,
  request: HttpClientRequest.HttpClientRequest,
  asked: Asked,
  read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>
): Effect.Effect<A, E | Unanswered> => {
  const call = `${request.method} ${request.url}`;

  return Effect.flatMap(key, (bearer) =>
    http.execute(
      request.pipe(
        HttpClientRequest.prependUrl(url),
        HttpClientRequest.bearerToken(bearer),
        HttpClientRequest.acceptJson
      )
    )
  ).pipe(
    Effect.mapError(lost(call)),
    Effect.flatMap(read),
    within(asked, call)
  );
};

const triesPerCall = 6;

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

export interface Refusal<Refused> {
  readonly own: boolean;
  readonly waits: string | undefined;
  readonly refused: Refused;
}

export const sender =
  <Refused>(
    http: HttpClient.HttpClient,
    url: string,
    key: Effect.Effect<Redacted.Redacted, Unanswered>,
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
  readonly lost?: ((error: E) => boolean) | undefined;
  readonly rested: Effect.Effect<A, F, R>;
  readonly holds: (rested: A) => boolean;
  readonly unheld: (rested: A, last: E | Unanswered) => G;
}

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
  readonly ours: (record: unknown) => boolean;
  readonly label: (record: unknown) => string;
}

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
