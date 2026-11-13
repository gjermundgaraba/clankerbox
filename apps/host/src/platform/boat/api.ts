import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import {
  Duration,
  Effect,
  FileSystem,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";

import { describe } from "../process.ts";

export const BoatType = Schema.Literals([
  "small",
  "default",
  "large",
  "xlarge",
]);

export type BoatType = typeof BoatType.Type;

const Labels = Schema.Record(Schema.String, Schema.String);

export const Sandbox = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  type: Schema.optionalKey(Schema.String),
  labels: Schema.optionalKey(Labels),
  dataExpiredAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export type Sandbox = typeof Sandbox.Type;

const Window = Schema.NullOr(
  Schema.Struct({ limit: Schema.Int, used: Schema.Int })
);

const Limits = Schema.Struct({
  activeSandboxes: Schema.Int,
  maxActiveSandboxes: Schema.Int,
  starts: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        minute: Schema.optionalKey(Window),
        hour: Schema.optionalKey(Window),
        day: Schema.optionalKey(Window),
      })
    )
  ),
  machineTypes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ type: Schema.String, available: Schema.Boolean })
    )
  ),
});

export const SshKey = Schema.Struct({
  machineIp: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sshEndpoint: Schema.optionalKey(Schema.NullOr(Schema.String)),
  hostKey: Schema.String,
});

export type SshKey = typeof SshKey.Type;

const SavedSnapshot = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  sourceSandboxId: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});

export type SavedSnapshot = typeof SavedSnapshot.Type;

const Created = Schema.Struct({ sandbox: Sandbox });

const Listed = Schema.Struct({
  sandboxes: Schema.Array(Sandbox),
  pageInfo: Schema.optionalKey(
    Schema.Struct({
      nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
    })
  ),
});

const SavedList = Schema.Struct({ snapshots: Schema.Array(SavedSnapshot) });

const SavedOne = Schema.Struct({ snapshot: SavedSnapshot });

const Envelope = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(
    Schema.Struct({
      code: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String),
    })
  ),
});

export class Refused extends Schema.TaggedError<
  Refused,
  { readonly brand: unique symbol }
>()("Refused", {
  status: Schema.Int,
  code: Schema.String,
  message: Schema.String,
}) {}

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
}) {}

export type ApiError = Refused | Unanswered | Busy;

const waitedOut = new Set([
  "IP_RATE_LIMIT_EXCEEDED",
  "idempotency_in_progress",
  "sandbox_starting",
  "sandbox_stopping",
  "ssh_host_key_unavailable",
]);

const longestWait = Duration.seconds(30);

const lostOrBusy: ReadonlySet<ApiError["_tag"]> = new Set([
  "Unanswered",
  "Busy",
]);

const busy: ReadonlySet<ApiError["_tag"]> = new Set(["Busy"]);

const triesPerCall = 6;

interface Answer<A> {
  readonly status: number;
  readonly body: A;
}

export interface Body {
  readonly type?: BoatType | undefined;
  readonly labels?: Readonly<Record<string, string>> | undefined;
  readonly from?: string | undefined;
  readonly name?: string | undefined;
}

const sealed = { noEnv: true, monitoring: false, ttlSeconds: null };

export interface Settings {
  readonly api: string;
  readonly apiKeyFile: string;
}

const refusal = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.flatMap(
    response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Envelope)),
      Effect.option
    ),
    (envelope) => {
      const body = Option.getOrUndefined(envelope);

      return Effect.succeed(
        new Refused({
          status: response.status,
          code: body?.error?.code ?? body?.code ?? `http_${response.status}`,
          message:
            body?.error?.message ??
            body?.message ??
            `boat answered HTTP ${response.status}`,
        })
      );
    }
  );

const retryAfter = (response: HttpClientResponse.HttpClientResponse) => {
  const seconds = Number(response.headers["retry-after"] ?? "1");

  return Duration.min(
    Duration.seconds(Number.isFinite(seconds) && seconds > 0 ? seconds : 1),
    longestWait
  );
};

const keyed = (path: string, body: Body, idempotencyKey: string) =>
  HttpClientRequest.post(path).pipe(
    HttpClientRequest.setHeader("Idempotency-Key", idempotencyKey),
    HttpClientRequest.bodyJsonUnsafe({ ...body, ...sealed })
  );

export const make = (settings: Settings) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const http = yield* HttpClient.HttpClient;

    const key = yield* fs.readFileString(settings.apiKeyFile).pipe(
      Effect.map((text) => Redacted.make(text.trim())),
      Effect.mapError(
        (error) =>
          new Internal({
            message: `couldn't read boat's API key from ${settings.apiKeyFile}: ${describe(error)}`,
          })
      )
    );

    const once = <A>(
      request: HttpClientRequest.HttpClientRequest,
      decode: Schema.Decoder<A>
    ): Effect.Effect<Answer<A>, ApiError> =>
      Effect.gen(function* () {
        const response = yield* http
          .execute(
            request.pipe(
              HttpClientRequest.prependUrl(settings.api),
              HttpClientRequest.bearerToken(key),
              HttpClientRequest.acceptJson
            )
          )
          .pipe(
            Effect.mapError(
              (error) =>
                new Unanswered({
                  message: `${request.method} ${request.url}: ${error.message}`,
                })
            )
          );

        if (response.status >= 400) {
          const refused = yield* refusal(response);

          if (waitedOut.has(refused.code)) {
            yield* Effect.sleep(retryAfter(response));

            return yield* new Busy({
              message: `${request.method} ${request.url}: ${refused.code}, waited out`,
            });
          }

          return yield* refused;
        }

        return yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(decode)),
          Effect.map((body) => ({ status: response.status, body })),
          Effect.mapError(
            (error) =>
              new Unanswered({
                message: `${request.method} ${request.url}: an answer it couldn't read: ${error.message}`,
              })
          )
        );
      });

    const call = <A>(
      request: HttpClientRequest.HttpClientRequest,
      decode: Schema.Decoder<A>,
      askedAgain: ReadonlySet<ApiError["_tag"]> = lostOrBusy
    ) =>
      once(request, decode).pipe(
        Effect.retry({
          while: (error) => askedAgain.has(error._tag),
          schedule: Schedule.exponential(Duration.millis(250)),
          times: triesPerCall - 1,
        })
      );

    const done = <A>(
      request: HttpClientRequest.HttpClientRequest,
      decode: Schema.Decoder<A>
    ) => Effect.map(call(request, decode), ({ body }) => body);

    const found = <A>(
      request: HttpClientRequest.HttpClientRequest,
      decode: Schema.Decoder<A>
    ): Effect.Effect<A | undefined, ApiError> =>
      done(request, decode).pipe(
        Effect.catchIf(
          (error) => error._tag === "Refused" && error.status === 404,
          () => Effect.undefined
        )
      );

    const list = (labels: Readonly<Record<string, string>>) =>
      Effect.gen(function* () {
        const sandboxes: Sandbox[] = [];
        let cursor: string | undefined;

        do {
          const page = yield* done(
            HttpClientRequest.get("/sandboxes").pipe(
              HttpClientRequest.setUrlParams([
                ...Object.entries(labels).map(
                  ([name, value]) => ["label", `${name}=${value}`] as const
                ),
                ["limit", "200"],
                ...(cursor === undefined ? [] : [["cursor", cursor] as const]),
              ])
            ),
            Listed
          );

          sandboxes.push(...page.sandboxes);
          cursor = page.pageInfo?.nextCursor ?? undefined;
        } while (cursor !== undefined);

        return sandboxes;
      });

    return {
      limits: done(HttpClientRequest.get("/limits"), Limits),
      create: (body: Body, idempotencyKey: string) =>
        Effect.map(
          done(keyed("/sandboxes", body, idempotencyKey), Created),
          ({ sandbox }) => sandbox
        ),
      fork: (source: string, body: Body, idempotencyKey: string) =>
        Effect.map(
          done(
            keyed(`/sandboxes/${source}/fork`, body, idempotencyKey),
            Created
          ),
          ({ sandbox }) => sandbox
        ),
      sandbox: (id: string) =>
        Effect.map(
          found(HttpClientRequest.get(`/sandboxes/${id}`), Created),
          (answer) =>
            answer?.sandbox.state === "cancelled" ? undefined : answer?.sandbox
        ),
      sandboxes: list,
      resume: (id: string, type?: BoatType) =>
        Effect.map(
          call(
            HttpClientRequest.post(`/sandboxes/${id}/resume`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                ttlSeconds: null,
                ...(type === undefined ? {} : { type }),
              })
            ),
            Schema.Unknown
          ),
          ({ status }) => (status === 200 ? "kept" : "started")
        ),
      stop: (id: string) =>
        Effect.asVoid(
          done(
            HttpClientRequest.post(`/sandboxes/${id}/stop`).pipe(
              HttpClientRequest.bodyJsonUnsafe({})
            ),
            Schema.Unknown
          )
        ),
      remove: (id: string) =>
        Effect.asVoid(
          found(
            HttpClientRequest.make("DELETE")(`/sandboxes/${id}`).pipe(
              HttpClientRequest.setHeader("X-Ascii-Confirm-Delete", id)
            ),
            Schema.Unknown
          )
        ),
      sshKey: (id: string, publicKey: string) =>
        done(
          HttpClientRequest.post(`/sandboxes/${id}/sshkey`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ key: publicKey })
          ),
          SshKey
        ),
      save: (id: string, name: string) =>
        Effect.asVoid(
          call(
            HttpClientRequest.post("/saved-snapshots").pipe(
              HttpClientRequest.bodyJsonUnsafe({ sandboxId: id, name })
            ),
            Schema.Unknown,
            busy
          )
        ),
      saved: (name: string) =>
        Effect.map(
          found(HttpClientRequest.get(`/saved-snapshots/${name}`), SavedOne),
          (answer) => answer?.snapshot
        ),
      savedSnapshots: Effect.map(
        done(HttpClientRequest.get("/saved-snapshots"), SavedList),
        ({ snapshots }) => snapshots
      ),
      unsave: (name: string) =>
        Effect.asVoid(
          found(
            HttpClientRequest.make("DELETE")(`/saved-snapshots/${name}`),
            Schema.Unknown
          )
        ),
    };
  });

export type Api = Effect.Success<ReturnType<typeof make>>;
