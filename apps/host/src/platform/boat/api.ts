import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import {
  Duration,
  Effect,
  FileSystem,
  Option,
  Redacted,
  Result,
  Schedule,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";

import { timeoutFail } from "../../runtime.ts";
import { answerWithin, describe } from "../process.ts";

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

const SavedList = Schema.Struct({ snapshots: Schema.Array(Schema.Unknown) });

const Named = Schema.Struct({ name: Schema.String });

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
  "sandbox_starting",
  "sandbox_stopping",
  "save_in_progress",
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

const refusalOf = (status: number, body: unknown) => {
  const envelope = Option.getOrUndefined(
    Schema.decodeUnknownOption(Envelope)(body)
  );

  return new Refused({
    status,
    code: envelope?.error?.code ?? envelope?.code ?? `http_${status}`,
    message:
      envelope?.error?.message ??
      envelope?.message ??
      `boat answered HTTP ${status}`,
  });
};

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

const resumed = ({ status }: { readonly status: number }) =>
  status === 200 ? "kept" : "started";

const resumeOf = (id: string, type: BoatType | undefined) =>
  HttpClientRequest.post(`/sandboxes/${id}/resume`).pipe(
    HttpClientRequest.bodyJsonUnsafe(
      type === undefined ? { ttlSeconds: null } : { ttlSeconds: null, type }
    )
  );

/**
 * boat's API, the routes the adapter uses. A call asks again after a refusal whose code says it
 * passes once waited out, and after a lost answer, but for a create, a fork, a resume onto another
 * type and a save, whose callers read what boat holds before they send one again. The saved-snapshot
 * list keeps each record it can read; one it can't fails the list only if `ours` claims its name,
 * and is skipped otherwise, logged the first time.
 */
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

    const exchange = (request: HttpClientRequest.HttpClientRequest) => {
      const what = `${request.method} ${request.url}`;
      const within = answerWithin[request.method === "GET" ? "read" : "change"];

      return http
        .execute(
          request.pipe(
            HttpClientRequest.prependUrl(settings.api),
            HttpClientRequest.bearerToken(key),
            HttpClientRequest.acceptJson
          )
        )
        .pipe(
          Effect.flatMap((response) =>
            Effect.map(Effect.result(response.json), (body) => ({
              response,
              body,
            }))
          ),
          Effect.mapError(
            (error) => new Unanswered({ message: `${what}: ${error.message}` })
          ),
          timeoutFail(
            within,
            () =>
              new Unanswered({
                message: `${what}: no answer within ${Duration.format(within)}`,
              })
          )
        );
    };

    const once = <A>(
      request: HttpClientRequest.HttpClientRequest,
      decode: Schema.Decoder<A>
    ): Effect.Effect<Answer<A>, ApiError> =>
      Effect.gen(function* () {
        const what = `${request.method} ${request.url}`;
        const { response, body } = yield* exchange(request);

        if (response.status >= 400) {
          const refused = refusalOf(
            response.status,
            Result.getOrUndefined(body)
          );

          if (waitedOut.has(refused.code)) {
            yield* Effect.sleep(retryAfter(response));

            return yield* new Busy({
              message: `${what}: ${refused.code}, waited out`,
            });
          }

          return yield* refused;
        }

        if (Result.isFailure(body)) {
          return yield* new Unanswered({
            message: `${what}: an answer it couldn't read: ${body.failure.message}`,
          });
        }

        return yield* Schema.decodeEffect(decode)(body.success).pipe(
          Effect.map((decoded) => ({ status: response.status, body: decoded })),
          Effect.mapError(
            (error) =>
              new Unanswered({
                message: `${what}: an answer it couldn't read: ${error.message}`,
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
      decode: Schema.Decoder<A>,
      askedAgain: ReadonlySet<ApiError["_tag"]> = lostOrBusy
    ) => Effect.map(call(request, decode, askedAgain), ({ body }) => body);

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

    const skipped = new Set<string>();

    const readSnapshot = (
      record: unknown,
      ours: (name: string) => boolean
    ): Effect.Effect<readonly SavedSnapshot[], Unanswered> => {
      const read = Schema.decodeUnknownOption(SavedSnapshot)(record);

      if (Option.isSome(read)) {
        return Effect.succeed([read.value]);
      }

      const name = Option.match(Schema.decodeUnknownOption(Named)(record), {
        onNone: () => JSON.stringify(record),
        onSome: (named) => named.name,
      });

      if (ours(name)) {
        return Effect.fail(
          new Unanswered({
            message: `GET /saved-snapshots answered snapshot ${name}, which carries this adapter's mark and couldn't be read`,
          })
        );
      }

      if (skipped.has(name)) {
        return Effect.succeed([]);
      }

      skipped.add(name);

      return Effect.as(
        Effect.logWarning(
          `boat's saved snapshot ${name} couldn't be read, and isn't this adapter's, so its lists skip it`
        ),
        []
      );
    };

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
          done(keyed("/sandboxes", body, idempotencyKey), Created, busy),
          ({ sandbox }) => sandbox
        ),
      fork: (source: string, body: Body, idempotencyKey: string) =>
        Effect.map(
          done(
            keyed(`/sandboxes/${source}/fork`, body, idempotencyKey),
            Created,
            busy
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
      resume: (id: string) =>
        Effect.map(call(resumeOf(id, undefined), Schema.Unknown), resumed),
      retype: (id: string, type: BoatType) =>
        Effect.map(call(resumeOf(id, type), Schema.Unknown, busy), resumed),
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
          done(
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
      savedSnapshots: (namePrefix: string, ours: (name: string) => boolean) =>
        Effect.flatMap(
          done(
            HttpClientRequest.get("/saved-snapshots").pipe(
              HttpClientRequest.setUrlParam("namePrefix", namePrefix)
            ),
            SavedList
          ),
          ({ snapshots }) =>
            Effect.map(
              Effect.forEach(snapshots, (record) => readSnapshot(record, ours)),
              (read) => read.flat()
            )
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
