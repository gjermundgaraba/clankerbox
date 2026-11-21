import { Duration, Effect, Option, Redacted, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { HttpMethod } from "effect/http";

import { Handle } from "../../runtime.ts";
import {
  recordReader,
  retryAfter,
  sender,
  tooManyRequests,
  Unanswered,
} from "../provider-http.ts";
import type {
  Asked,
  ProviderError,
  Refusal,
  Repeats,
} from "../provider-http.ts";

export const MachineRecord = Schema.Struct({
  id: Handle,
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  state: Schema.String,
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  parentMachineId: Schema.optionalKey(Schema.NullOr(Schema.String)),
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

/** What a listed record carries that tells whose it is, each read from any record that has it. */
export interface Marks {
  readonly id?: string | undefined;
  readonly name?: string | null | undefined;
  readonly machineId?: string | undefined;
}

const Identified = Schema.Struct({ id: Schema.String });

const Named = Schema.Struct({ name: Schema.String });

const OfMachine = Schema.Struct({ machineId: Schema.String });

const Problem = Schema.Struct({
  code: Schema.String,
  status: Schema.Int,
  detail: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
});

const ExitFrame = Schema.fromJsonString(
  Schema.Struct({ exitCode: Schema.Int })
);

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

export type ApiError = ProviderError<Refused>;

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

export type Verb = "start" | "stop" | "resume";

const problemOf = Schema.decodeUnknownOption(Schema.fromJsonString(Problem));

const frameOf = ({ event, data }: Sse.Event): readonly Frame[] => {
  if (event === "stdout" || event === "stderr") {
    return [{ _tag: "output", data }];
  }

  if (event === "exit") {
    return [
      Option.match(Schema.decodeOption(ExitFrame)(data), {
        onNone: (): Frame => ({
          _tag: "error",
          data: "an exit event it couldn't read",
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

const marksOf = (record: unknown): Marks => ({
  ...Option.getOrElse(
    Schema.decodeUnknownOption(Identified)(record),
    () => ({})
  ),
  ...Option.getOrElse(Schema.decodeUnknownOption(Named)(record), () => ({})),
  ...Option.getOrElse(
    Schema.decodeUnknownOption(OfMachine)(record),
    () => ({})
  ),
});

const open = { mode: "open" };

const refusal = (
  response: HttpClientResponse.HttpClientResponse,
  asked: Asked,
  call: string
): Effect.Effect<Refusal<Refused>> =>
  Effect.gen(function* () {
    const text = yield* Effect.orElseSucceed(response.text, () => "");
    const wait = yield* retryAfter(response);

    const problem = Option.getOrUndefined(
      Option.filter(problemOf(text), ({ status }) => status === response.status)
    );

    const code = problem?.code ?? "unknown";
    const detail = problem?.detail ?? "";

    const waits = (): string | undefined => {
      if (response.status === tooManyRequests) {
        return `HTTP 429 ${problem?.code ?? ""}`.trim();
      }

      return asked === "read" && problem?.retryable === true
        ? `${response.status} ${problem.code}`
        : undefined;
    };

    return {
      own: problem !== undefined,
      waits: waits(),
      refused: new Refused({
        message: `${call} answered ${response.status} ${code}: ${detail}`,
        status: response.status,
        code,
        detail,
        retryable: problem?.retryable ?? false,
        retryAfterSeconds: Duration.toSeconds(wait),
      }),
    };
  });

/**
 * smol cloud's API, the routes the adapter uses. Requests are encoded exactly; answers are read
 * leniently, keeping only the fields the adapter reads, and `state` and `status` stay open strings.
 * A read is asked again after a lost answer and after a refusal smol cloud marks retryable, as a
 * 429 is, and so is a checkpoint's delete, which does no more sent twice; any other change is sent
 * again only after a 429, its caller reading the provider first otherwise.
 * A list fails on a record it can't read only if `ours` claims it by its marks.
 */
export const make = (url: string, key: Redacted.Redacted) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const readRecords = recordReader();

    const sent = sender(http, url, Effect.succeed(key), refusal);

    const send = <A>(
      method: HttpMethod.HttpMethod,
      route: string,
      asked: Asked,
      body: unknown,
      answered: (
        response: HttpClientResponse.HttpClientResponse
      ) => Effect.Effect<A, Unanswered>,
      repeats: Repeats = asked === "read" ? "idempotent" : "once"
    ): Effect.Effect<A, ApiError> =>
      sent(
        HttpClientRequest.make(method)(route).pipe(
          body === undefined
            ? (unchanged) => unchanged
            : HttpClientRequest.bodyJsonUnsafe(body)
        ),
        asked,
        repeats,
        answered
      );

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
        send(method, route, asked, body, (response) =>
          HttpClientResponse.schemaBodyJson(schema)(response).pipe(
            Effect.mapError(
              (error) =>
                new Unanswered({
                  message: `${method} ${route} answered what couldn't be read: ${error.message}`,
                })
            )
          )
        );

    const done = (
      method: HttpMethod.HttpMethod,
      route: string,
      asked: Asked,
      body?: unknown,
      repeats?: Repeats
    ) => send(method, route, asked, body, () => Effect.void, repeats);

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
            readRecords(records, {
              call: `GET ${route}`,
              what,
              read: Schema.decodeUnknownOption(schema),
              ours: (record) => ours(marksOf(record)),
              label: (record) => {
                const marks = marksOf(record);

                return marks.name ?? marks.id ?? "a record with no name or ID";
              },
            })
        );

    const machine = json(MachineRecord);
    const checkpoint = json(CheckpointRecord);

    return {
      account: json(Account)("GET", "/v1/account", "read"),
      inUse: json(InUse)("GET", "/v1/capacity", "read"),
      machines: listed(MachineRecord, "machine", "/v1/machines"),
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
        done("POST", `/v1/machines/${id}/resize`, "settle", sizes),
      deleteMachine: (id: Handle) =>
        done("DELETE", `/v1/machines/${id}`, "change"),
      checkpoints: listed(CheckpointRecord, "checkpoint", "/v1/checkpoints"),
      checkpoint: (id: Handle) =>
        checkpoint("GET", `/v1/checkpoints/${id}`, "read"),
      capture: (id: Handle) =>
        checkpoint(
          "POST",
          `/v1/machines/${id}/checkpoints?wait=true`,
          "settle"
        ),
      deleteCheckpoint: (id: Handle) =>
        done(
          "DELETE",
          `/v1/checkpoints/${id}`,
          "change",
          undefined,
          "idempotent"
        ),
      exec: (
        id: Handle,
        body: ExecBody
      ): Effect.Effect<Stream.Stream<Frame, Unanswered>, ApiError> =>
        Effect.map(
          send(
            "POST",
            `/v1/machines/${id}/exec/stream`,
            "settle",
            body,
            Effect.succeed
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
