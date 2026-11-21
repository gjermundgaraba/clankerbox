import { Effect, Option, Schema } from "effect";
import type { Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";

import {
  recordReader,
  sender,
  tooManyRequests,
  Unanswered,
} from "../provider-http.ts";
import type { ProviderError, Refusal, Repeats } from "../provider-http.ts";

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
  hydrated: Schema.optionalKey(Schema.Boolean),
  updatedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export type Sandbox = typeof Sandbox.Type;

/**
 * A sandbox as `GET /sandboxes/{id}` answers it, with `lastReboot`, which
 * https://docs.boat.dev/openapi/boat-v1.yaml's `Sandbox` holds, but which its list,
 * `GET /sandboxes`, answers null for every sandbox, rebooted or not, as a live account showed on
 * 2026-11-21. So `Sandbox`, which a list decodes to, has no `lastReboot`, and only this has one.
 * That is worth reporting to boat, as it contradicts boat's own OpenAPI: a list that answered it
 * would let the host read each mark from the list, and the own-record reads `updatedAt` decides,
 * with their owed re-reads, would go (see docs/design/machine-charts-decisions.tsv, 2026-11-21).
 */
export const OwnSandbox = Schema.Struct({
  ...Sandbox.fields,
  lastReboot: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ at: Schema.String }))
  ),
});

export type OwnSandbox = typeof OwnSandbox.Type;

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
  snapshotId: Schema.optionalKey(Schema.String),
});

export type SavedSnapshot = typeof SavedSnapshot.Type;

/**
 * One of a sandbox's own snapshots. `contentSizeBytes` is the user's data it restores, without the
 * base image's, which is what a type's disk figure bounds: https://docs.boat.dev/openapi/boat-v1.yaml
 * (`SnapshotSummary`).
 */
const SnapshotSummary = Schema.Struct({
  id: Schema.String,
  contentSizeBytes: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
});

export type SnapshotSummary = typeof SnapshotSummary.Type;

const Summaries = Schema.Struct({ snapshots: Schema.Array(Schema.Unknown) });

const ListedSnapshot = Schema.Struct({
  name: Schema.String,
  sourceSandboxId: Schema.optionalKey(Schema.String),
});

export type ListedSnapshot = typeof ListedSnapshot.Type;

const Created = Schema.Struct({ sandbox: Sandbox });

const Own = Schema.Struct({ sandbox: OwnSandbox });

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

const nameOf = (record: unknown): Option.Option<string> =>
  Option.map(Schema.decodeUnknownOption(Named)(record), ({ name }) => name);

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

export type ApiError = ProviderError<Refused>;

/**
 * The codes that mean the account takes no such request now, which moves a create to the next
 * host: it has no room, or its plan no longer offers the machine type the host read at its start.
 */
export const noRoom: ReadonlySet<string> = new Set([
  "limit_reached",
  "machine_class_plan_required",
  "rate_limited",
  "out_of_capacity",
  "no_ready_machine",
]);

const asksToWait = new Set([
  "IP_RATE_LIMIT_EXCEEDED",
  "sandbox_starting",
  "sandbox_stopping",
  "save_in_progress",
  "ssh_host_key_unavailable",
]);

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

const refusal = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<Refusal<Refused>> =>
  Effect.map(
    Effect.orElseSucceed(response.json, () => undefined),
    (body) => {
      const refused = refusalOf(response.status, body);

      return {
        own: refused.code !== `http_${response.status}`,
        waits:
          asksToWait.has(refused.code) ||
          (response.status === tooManyRequests && !noRoom.has(refused.code))
            ? refused.code
            : undefined,
        refused,
      };
    }
  );

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
 * passes once waited out, and after a lost answer, but for a create, a fork, a resume and a save,
 * whose callers read what boat holds before they send one again. The saved-snapshot
 * list reads of each snapshot only its name and the sandbox it was saved from, and fails on one it
 * can't read only when `ours` claims its name: that snapshot may be held by a sandbox being
 * deleted, and a delete that went on past it would leave it billed with nothing to find it again.
 */
export const make = (url: string, key: Redacted.Redacted) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;

    const sent = sender(http, url, Effect.succeed(key), refusal);

    const call = <A>(
      request: HttpClientRequest.HttpClientRequest,
      decode: Schema.Decoder<A>,
      repeats: Repeats = "idempotent"
    ): Effect.Effect<Answer<A>, ApiError> =>
      sent(
        request,
        request.method === "GET" ? "read" : "change",
        repeats,
        (response) =>
          response.json.pipe(
            Effect.flatMap(Schema.decodeEffect(decode)),
            Effect.map((body) => ({ status: response.status, body })),
            Effect.mapError(
              (error) =>
                new Unanswered({
                  message: `${request.method} ${request.url}: an answer it couldn't read: ${error.message}`,
                })
            )
          )
      );

    const done = <A>(
      request: HttpClientRequest.HttpClientRequest,
      decode: Schema.Decoder<A>,
      repeats: Repeats = "idempotent"
    ) => Effect.map(call(request, decode, repeats), ({ body }) => body);

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

    const readRecords = recordReader();

    const list = (labels: Readonly<Record<string, string>>) =>
      Effect.gen(function* () {
        const sandboxes: Sandbox[] = [];
        const seen = new Set<string>();
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
          const next = page.pageInfo?.nextCursor ?? "";

          cursor = next === "" ? undefined : next;

          if (cursor !== undefined && seen.has(cursor)) {
            return yield* new Unanswered({
              message: `GET /sandboxes answered the page cursor ${cursor} twice, so its list has no end`,
            });
          }

          if (cursor !== undefined) {
            seen.add(cursor);
          }
        } while (cursor !== undefined);

        return sandboxes;
      });

    return {
      limits: done(HttpClientRequest.get("/limits"), Limits),
      create: (body: Body, idempotencyKey: string) =>
        Effect.map(
          done(keyed("/sandboxes", body, idempotencyKey), Created, "once"),
          ({ sandbox }) => sandbox
        ),
      fork: (source: string, body: Body, idempotencyKey: string) =>
        Effect.map(
          done(
            keyed(`/sandboxes/${source}/fork`, body, idempotencyKey),
            Created,
            "once"
          ),
          ({ sandbox }) => sandbox
        ),
      sandbox: (id: string) =>
        Effect.map(
          found(HttpClientRequest.get(`/sandboxes/${id}`), Own),
          (answer) => answer?.sandbox
        ),
      sandboxes: list,
      resume: (id: string) =>
        Effect.map(
          call(resumeOf(id, undefined), Schema.Unknown, "once"),
          resumed
        ),
      retype: (id: string, type: BoatType) =>
        Effect.map(call(resumeOf(id, type), Schema.Unknown, "once"), resumed),
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
            "once"
          )
        ),
      saved: (name: string) =>
        Effect.map(
          found(HttpClientRequest.get(`/saved-snapshots/${name}`), SavedOne),
          (answer) => answer?.snapshot
        ),
      snapshotsOf: (id: string) =>
        Effect.map(
          done(
            HttpClientRequest.get(`/sandboxes/${id}/snapshots`).pipe(
              HttpClientRequest.setUrlParam("limit", "20")
            ),
            Summaries
          ),
          ({ snapshots }) =>
            snapshots.flatMap((record) =>
              Option.toArray(
                Schema.decodeUnknownOption(SnapshotSummary)(record)
              )
            )
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
            readRecords(snapshots, {
              call: "GET /saved-snapshots",
              what: "saved snapshot",
              read: Schema.decodeUnknownOption(ListedSnapshot),
              ours: (record) => Option.exists(nameOf(record), ours),
              label: (record) =>
                Option.getOrElse(nameOf(record), () => "a record with no name"),
            })
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
