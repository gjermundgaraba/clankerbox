import { Duration, Effect, Option, Redacted, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { HttpClientError, HttpMethod } from "effect/http";

import { Handle, timeoutFail } from "../../runtime.ts";
import { answerWithin } from "../process.ts";
import type { Asked } from "../process.ts";

export const MachineRecord = Schema.Struct({
  id: Handle,
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  state: Schema.String,
  resources: Schema.Struct({
    cpus: Schema.Int,
    memoryMb: Schema.Int,
    diskGb: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  }),
});

export type MachineRecord = typeof MachineRecord.Type;

export const CheckpointRecord = Schema.Struct({
  id: Handle,
  machineId: Schema.String,
  status: Schema.String,
});

export type CheckpointRecord = typeof CheckpointRecord.Type;

const Account = Schema.Struct({
  plan: Schema.Struct({ allowAlwaysOn: Schema.Boolean }),
  effectiveMaxConcurrentMachines: Schema.Int,
  effectiveMaxMachines: Schema.Int,
  effectiveMaxCpus: Schema.Int,
  effectiveMaxMemoryMb: Schema.Int,
  effectiveMaxDiskGb: Schema.Int,
});

export type Account = typeof Account.Type;

const InUse = Schema.Struct({
  machines: Schema.Int,
  startedMachines: Schema.Int,
  startedMemoryMb: Schema.Int,
});

const Marks = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  machineId: Schema.optionalKey(Schema.String),
});

/** What a listed record carries that tells whose it is, read from any record that has it. */
export type Marks = typeof Marks.Type;

const Problem = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
});

const ExitFrame = Schema.fromJsonString(
  Schema.Struct({ exitCode: Schema.Int })
);

/** The provider answered `call` with a problem. */
export class Refused extends Schema.TaggedError<
  Refused,
  { readonly brand: unique symbol }
>()("Refused", {
  message: Schema.String,
  status: Schema.Int,
  code: Schema.String,
  detail: Schema.String,
  retryable: Schema.Boolean,
  retryAfterSeconds: Schema.Finite,
}) {}

/** No answer, or one that couldn't be read, so whether `call` happened is unknown. */
export class Unanswered extends Schema.TaggedError<
  Unanswered,
  { readonly brand: unique symbol }
>()("Unanswered", {
  message: Schema.String,
}) {}

export type ApiError = Refused | Unanswered;

export interface Sizes {
  readonly cpus?: number | undefined;
  readonly memoryMb?: number | undefined;
  readonly diskGb?: number | undefined;
}

export interface Creation {
  readonly autoStopSeconds: number;
  readonly name: string;
  readonly image: string;
  readonly sizes: Required<Sizes>;
  readonly ttlSeconds: number | undefined;
}

export interface ExecBody {
  readonly command: readonly string[];
  readonly user?: string | undefined;
  readonly stdin?: string | undefined;
}

export type Frame =
  | { readonly _tag: "output"; readonly data: string }
  | { readonly _tag: "exit"; readonly exitCode: number }
  | { readonly _tag: "error"; readonly data: string };

export type Verb = "start" | "stop" | "pause" | "resume";

const problemOf = Schema.decodeUnknownOption(Schema.fromJsonString(Problem));

const longestRetryAfter = 30;

const retryAfterOf = (response: HttpClientResponse.HttpClientResponse) => {
  const seconds = Number(response.headers["retry-after"] ?? "1");

  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds, longestRetryAfter)
    : 1;
};

const frameOf = ({ event, data }: Sse.Event): readonly Frame[] => {
  if (event === "stdout" || event === "stderr") {
    return [{ _tag: "output", data }];
  }

  if (event === "exit") {
    return [
      Option.match(Schema.decodeOption(ExitFrame)(data), {
        onNone: (): Frame => ({
          _tag: "error",
          data: `an unreadable exit: ${data}`,
        }),
        onSome: ({ exitCode }): Frame => ({ _tag: "exit", exitCode }),
      }),
    ];
  }

  return event === "error" ? [{ _tag: "error", data }] : [];
};

const frames = <E>(
  body: Stream.Stream<Uint8Array, E>
): Stream.Stream<Frame, E | Sse.Retry | Sse.SseError> =>
  body.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.map(frameOf),
    Stream.flattenIterable
  );

const unanswered = (call: string) => (error: HttpClientError.HttpClientError) =>
  new Unanswered({ message: `${call}: ${error.message}` });

const within =
  (asked: Asked, call: string) =>
  <A, E>(answer: Effect.Effect<A, E>) =>
    answer.pipe(
      timeoutFail(
        answerWithin[asked],
        () =>
          new Unanswered({
            message: `${call}: no answer within ${Duration.format(answerWithin[asked])}`,
          })
      )
    );

const marksOf = (record: unknown): Marks =>
  Option.getOrElse(Schema.decodeUnknownOption(Marks)(record), () => ({}));

const open = { mode: "open" };

/**
 * smol cloud's API, the routes the adapter uses. Requests are encoded exactly; answers are read
 * leniently, keeping only the fields the adapter reads, and `state` and `status` stay open strings.
 * A list keeps each record it can read; one it can't is this host's business only if `ours` says
 * so by its marks, which fails the list, and is skipped otherwise, logged the first time.
 */
export const make = (url: string, key: Redacted.Redacted) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const skipped = new Set<string>();

    const send = (
      method: HttpMethod.HttpMethod,
      route: string,
      body?: unknown
    ): Effect.Effect<HttpClientResponse.HttpClientResponse, ApiError> => {
      const call = `${method} ${route}`;

      return http
        .execute(
          HttpClientRequest.make(method)(`${url}${route}`).pipe(
            HttpClientRequest.bearerToken(Redacted.value(key)),
            HttpClientRequest.acceptJson,
            body === undefined
              ? (unchanged) => unchanged
              : HttpClientRequest.bodyJsonUnsafe(body)
          )
        )
        .pipe(
          Effect.mapError(unanswered(call)),
          Effect.filterOrElse(
            (response) => response.status < 400,
            (response) =>
              Effect.flatMap(
                Effect.orElseSucceed(response.text, () => ""),
                (text) => {
                  const problem = Option.getOrUndefined(problemOf(text));
                  const code = problem?.code ?? "unknown";
                  const detail = problem?.detail ?? "";

                  return Effect.fail(
                    new Refused({
                      message: `${call} answered ${response.status} ${code}: ${detail}`,
                      status: response.status,
                      code,
                      detail,
                      retryable: problem?.retryable ?? false,
                      retryAfterSeconds: retryAfterOf(response),
                    })
                  );
                }
              )
          )
        );
    };

    const json =
      <S extends Schema.Top & { readonly DecodingServices: never }>(
        schema: S
      ) =>
      (
        method: HttpMethod.HttpMethod,
        route: string,
        asked: Asked,
        body?: unknown
      ): Effect.Effect<S["Type"], ApiError> =>
        Effect.flatMap(send(method, route, body), (response) =>
          HttpClientResponse.schemaBodyJson(schema)(response).pipe(
            Effect.mapError(
              (error) =>
                new Unanswered({
                  message: `${method} ${route} answered what couldn't be read: ${error.message}`,
                })
            )
          )
        ).pipe(within(asked, `${method} ${route}`));

    const done = (method: HttpMethod.HttpMethod, route: string, asked: Asked) =>
      Effect.asVoid(send(method, route)).pipe(
        within(asked, `${method} ${route}`)
      );

    const listed =
      <S extends Schema.Top & { readonly DecodingServices: never }>(
        schema: S,
        what: string,
        route: string
      ) =>
      (ours: (marks: Marks) => boolean) =>
        Effect.flatMap(
          json(Schema.Array(Schema.Unknown))("GET", route, "read"),
          (records) =>
            Effect.forEach(records, (record) => {
              const read = Schema.decodeUnknownOption(schema)(record);

              if (Option.isSome(read)) {
                return Effect.succeed([read.value]);
              }

              const marks = marksOf(record);

              if (ours(marks)) {
                return Effect.fail(
                  new Unanswered({
                    message: `GET ${route} answered ${what} ${marks.name ?? marks.id ?? "with no id"} of this host's, which couldn't be read`,
                  })
                );
              }

              const seen = marks.id ?? JSON.stringify(record);

              return skipped.has(seen)
                ? Effect.succeed([])
                : Effect.as(
                    Effect.andThen(
                      Effect.sync(() => skipped.add(seen)),
                      Effect.logWarning(
                        `smol cloud listed ${what} ${marks.name ?? marks.id ?? "with no id"} that this host can't read and isn't its own, so it skips it`
                      )
                    ),
                    []
                  );
            }).pipe(Effect.map((kept) => kept.flat()))
        );

    const machine = json(MachineRecord);
    const checkpoint = json(CheckpointRecord);

    return {
      account: json(Account)("GET", "/v1/account", "read"),
      inUse: json(InUse)("GET", "/v1/capacity", "read"),
      machines: listed(MachineRecord, "a machine", "/v1/machines"),
      machine: (id: Handle) => machine("GET", `/v1/machines/${id}`, "read"),
      create: (creation: Creation) =>
        machine("POST", "/v1/machines", "change", {
          name: creation.name,
          source: { type: "image", reference: creation.image },
          resources: creation.sizes,
          branchable: true,
          ports: [{ port: 22 }],
          network: open,
          autoStopSeconds: creation.autoStopSeconds,
          ...(creation.ttlSeconds === undefined
            ? {}
            : { ttlSeconds: creation.ttlSeconds }),
        }),
      restore: (from: Handle, name: string, autoStopSeconds: number) =>
        machine("POST", `/v1/checkpoints/${from}/restore`, "change", {
          name,
          network: open,
          autoStopSeconds,
        }),
      branch: (from: Handle, name: string) =>
        machine("POST", `/v1/machines/${from}/branches`, "settle", { name }),
      act: (id: Handle, verb: Verb) =>
        done("POST", `/v1/machines/${id}/${verb}`, "settle"),
      resize: (id: Handle, sizes: Sizes) =>
        Effect.asVoid(send("POST", `/v1/machines/${id}/resize`, sizes)).pipe(
          within("settle", `POST /v1/machines/${id}/resize`)
        ),
      deleteMachine: (id: Handle) =>
        done("DELETE", `/v1/machines/${id}`, "change"),
      checkpoints: listed(CheckpointRecord, "a checkpoint", "/v1/checkpoints"),
      checkpoint: (id: Handle) =>
        checkpoint("GET", `/v1/checkpoints/${id}`, "read"),
      capture: (id: Handle) =>
        checkpoint(
          "POST",
          `/v1/machines/${id}/checkpoints?wait=true`,
          "settle"
        ),
      deleteCheckpoint: (id: Handle) =>
        done("DELETE", `/v1/checkpoints/${id}`, "change"),
      exec: (
        id: Handle,
        body: ExecBody
      ): Effect.Effect<Stream.Stream<Frame, Unanswered>, ApiError> =>
        Effect.map(
          send("POST", `/v1/machines/${id}/exec/stream`, body).pipe(
            within("settle", `POST /v1/machines/${id}/exec/stream`)
          ),
          (response) =>
            Stream.mapError(
              frames(response.stream),
              (error) =>
                new Unanswered({
                  message: `the output of an exec in ${id}: ${error._tag === "Retry" ? "the stream asked for a reconnect" : error.message}`,
                })
            )
        ),
      tunnel: (id: Handle) => ({
        url: `${url.replace(/^http/u, "ws")}/v1/machines/${id}/tunnel/22`,
        headers: { authorization: `Bearer ${Redacted.value(key)}` },
      }),
    };
  });

export type Api = Effect.Success<ReturnType<typeof make>>;
