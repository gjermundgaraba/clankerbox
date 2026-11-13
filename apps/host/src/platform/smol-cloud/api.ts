import { Effect, Option, Redacted, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { HttpClientError, HttpMethod } from "effect/http";

import { Handle } from "../../runtime.ts";

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
  effectiveMaxCpus: Schema.Int,
});

export type Account = typeof Account.Type;

const InUse = Schema.Struct({
  startedMachines: Schema.Int,
  startedMemoryMb: Schema.Int,
});

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

const open = { mode: "open" };

/**
 * smol cloud's API, the routes the adapter uses. Requests are encoded exactly; answers are read
 * leniently, keeping only the fields the adapter reads, and `state` and `status` stay open strings.
 */
export const make = (url: string, key: Redacted.Redacted) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;

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
        );

    const done = (method: HttpMethod.HttpMethod, route: string) =>
      Effect.asVoid(send(method, route));

    const machine = json(MachineRecord);
    const checkpoint = json(CheckpointRecord);

    return {
      account: json(Account)("GET", "/v1/account"),
      inUse: json(InUse)("GET", "/v1/capacity"),
      machines: json(Schema.Array(MachineRecord))("GET", "/v1/machines"),
      machine: (id: Handle) => machine("GET", `/v1/machines/${id}`),
      create: (creation: Creation) =>
        machine("POST", "/v1/machines", {
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
        machine("POST", `/v1/checkpoints/${from}/restore`, {
          name,
          network: open,
          autoStopSeconds,
        }),
      branch: (from: Handle, name: string) =>
        machine("POST", `/v1/machines/${from}/branches`, { name }),
      act: (id: Handle, verb: Verb) =>
        done("POST", `/v1/machines/${id}/${verb}`),
      resize: (id: Handle, sizes: Sizes) =>
        Effect.asVoid(send("POST", `/v1/machines/${id}/resize`, sizes)),
      deleteMachine: (id: Handle) => done("DELETE", `/v1/machines/${id}`),
      checkpoints: json(Schema.Array(CheckpointRecord))(
        "GET",
        "/v1/checkpoints"
      ),
      checkpoint: (id: Handle) => checkpoint("GET", `/v1/checkpoints/${id}`),
      capture: (id: Handle) =>
        checkpoint("POST", `/v1/machines/${id}/checkpoints?wait=true`),
      deleteCheckpoint: (id: Handle) => done("DELETE", `/v1/checkpoints/${id}`),
      exec: (
        id: Handle,
        body: ExecBody
      ): Effect.Effect<Stream.Stream<Frame, Unanswered>, ApiError> =>
        Effect.map(
          send("POST", `/v1/machines/${id}/exec/stream`, body),
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
