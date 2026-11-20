import { Effect, Option, Schema } from "effect";
import type { Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";

import { sender, tooManyRequests, Unanswered } from "../provider-http.ts";
import type { ProviderError, Refusal } from "../provider-http.ts";

const Labels = Schema.Record(Schema.String, Schema.String);

const Meta = Schema.Struct({
  name: Schema.String,
  uid: Schema.String,
  labels: Schema.optionalKey(Labels),
  annotations: Schema.optionalKey(Labels),
  deletionTimestamp: Schema.optionalKey(Schema.String),
  generation: Schema.optionalKey(Schema.Int),
});

const Condition = Schema.Struct({
  type: Schema.String,
  status: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  observedGeneration: Schema.optionalKey(Schema.Int),
  lastTransitionTime: Schema.optionalKey(Schema.String),
});

export type Condition = typeof Condition.Type;

const Quantities = Schema.Record(Schema.String, Schema.String);

const Resources = Schema.Struct({
  requests: Schema.optionalKey(Quantities),
  limits: Schema.optionalKey(Quantities),
});

export const Sandbox = Schema.Struct({
  metadata: Meta,
  spec: Schema.Struct({
    operatingMode: Schema.optionalKey(Schema.String),
    podTemplate: Schema.Struct({
      spec: Schema.Struct({
        containers: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            resources: Schema.optionalKey(Resources),
          })
        ),
      }),
    }),
  }),
  status: Schema.optionalKey(
    Schema.Struct({ conditions: Schema.optionalKey(Schema.Array(Condition)) })
  ),
});

export type Sandbox = typeof Sandbox.Type;

export const Claim = Schema.Struct({
  metadata: Meta,
  spec: Schema.Struct({ resources: Schema.optionalKey(Resources) }),
  status: Schema.optionalKey(
    Schema.Struct({
      capacity: Schema.optionalKey(Quantities),
      allocatedResources: Schema.optionalKey(Quantities),
      allocatedResourceStatuses: Schema.optionalKey(
        Schema.Record(Schema.String, Schema.String)
      ),
    })
  ),
});

export type Claim = typeof Claim.Type;

/**
 * A snapshot of a claim's volume, which its CSI driver takes and a claim's `dataSource` restores:
 * https://kubernetes.io/docs/concepts/storage/volume-snapshots/
 */
export const Snapshot = Schema.Struct({
  metadata: Meta,
  status: Schema.optionalKey(
    Schema.Struct({
      readyToUse: Schema.optionalKey(Schema.Boolean),
      error: Schema.optionalKey(
        Schema.Struct({ message: Schema.optionalKey(Schema.String) })
      ),
    })
  ),
});

export type Snapshot = typeof Snapshot.Type;

const ContainerState = Schema.Struct({
  waiting: Schema.optionalKey(
    Schema.Struct({
      reason: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String),
    })
  ),
  terminated: Schema.optionalKey(
    Schema.Struct({
      exitCode: Schema.Int,
      reason: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String),
    })
  ),
});

export const Pod = Schema.Struct({
  metadata: Meta,
  status: Schema.optionalKey(
    Schema.Struct({
      phase: Schema.optionalKey(Schema.String),
      conditions: Schema.optionalKey(Schema.Array(Condition)),
      containerStatuses: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            state: Schema.optionalKey(ContainerState),
          })
        )
      ),
    })
  ),
});

export type Pod = typeof Pod.Type;

export const Quota = Schema.Struct({
  metadata: Meta,
  status: Schema.optionalKey(
    Schema.Struct({
      hard: Schema.optionalKey(Quantities),
      used: Schema.optionalKey(Quantities),
    })
  ),
});

export type Quota = typeof Quota.Type;

const Listed = <S extends Schema.Top & { readonly DecodingServices: never }>(
  item: S
) =>
  Schema.Struct({
    items: Schema.Array(item),
    metadata: Schema.optionalKey(
      Schema.Struct({ continue: Schema.optionalKey(Schema.String) })
    ),
  });

const Status = Schema.Struct({
  kind: Schema.Literal("Status"),
  message: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  details: Schema.optionalKey(
    Schema.Struct({
      causes: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({ field: Schema.optionalKey(Schema.String) })
        )
      ),
    })
  ),
});

class Refused extends Schema.TaggedError<
  Refused,
  { readonly brand: unique symbol }
>()("Refused", {
  status: Schema.Int,
  reason: Schema.String,
  message: Schema.String,
  fields: Schema.Array(Schema.String),
}) {}

export type ApiError = ProviderError<Refused>;

/**
 * Reads the API server's answer of HTTP 400 or more. Its own is a `Status`, but for one whose
 * `reason` is `Timeout`, which says the request may still be processed, so a lost answer:
 * https://github.com/kubernetes/apimachinery/blob/v0.37.0/pkg/apis/meta/v1/types.go#L921
 * `ServerTimeout` and `TooManyRequests` say it took nothing and asks to be waited out.
 */
const refusal = (
  response: HttpClientResponse.HttpClientResponse,
  _asked: unknown,
  call: string
): Effect.Effect<Refusal<Refused>> =>
  Effect.map(
    Effect.orElseSucceed(response.json, () => undefined),
    (body) => {
      const status = Option.getOrUndefined(
        Schema.decodeUnknownOption(Status)(body)
      );

      const reason = status?.reason ?? `HTTP ${response.status}`;

      return {
        own: status !== undefined && reason !== "Timeout",
        waits:
          response.status === tooManyRequests ||
          reason === "ServerTimeout" ||
          reason === "TooManyRequests"
            ? reason
            : undefined,
        refused: new Refused({
          status: response.status,
          reason,
          fields: (status?.details?.causes ?? []).flatMap(
            ({ field }) => field ?? []
          ),
          message: `${call} answered ${response.status} ${reason}: ${status?.message ?? ""}`,
        }),
      };
    }
  );

export const isGone = (error: ApiError): boolean =>
  error._tag === "Refused" && error.status === 404;

export const isTaken = (error: ApiError): boolean =>
  error._tag === "Refused" && error.reason === "AlreadyExists";

/**
 * A write bound to a UID that another object of the name now holds: a delete's precondition
 * answers 409, and a patch carrying `metadata.uid` 422, as the UID is immutable.
 */
export const isReplaced = (error: ApiError): boolean =>
  error._tag === "Refused" &&
  (error.status === 409 ||
    (error.status === 422 && error.fields.includes("metadata.uid")));

type Selector = Readonly<Record<string, string>>;

/**
 * The Kubernetes API at `url`, its requests carrying `token`, read afresh as the service account's
 * file rotates. Every call it makes does no more sent twice: a create sent again answers
 * `AlreadyExists`, which its caller reads, and a delete sent again 404, which is done. So each is
 * sent again after a lost answer, and the API server's `Timeout` is one.
 */
export const make = (
  url: string,
  token: Effect.Effect<Redacted.Redacted, Unanswered>
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const sent = sender(http, url, token, refusal);

    const call = <S extends Schema.Top & { readonly DecodingServices: never }>(
      request: HttpClientRequest.HttpClientRequest,
      schema: S
    ): Effect.Effect<S["Type"], ApiError> =>
      sent(
        request,
        request.method === "GET" ? "read" : "change",
        "idempotent",
        (response) =>
          response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(schema)),
            Effect.mapError(
              (error) =>
                new Unanswered({
                  message: `${request.method} ${request.url}: an answer it couldn't read: ${error.message}`,
                })
            )
          )
      );

    const resource = <
      S extends Schema.Top & { readonly DecodingServices: never },
    >(
      path: string,
      schema: S
    ) => {
      const list = Listed(schema);

      return {
        get: (name: string): Effect.Effect<S["Type"] | undefined, ApiError> =>
          call(HttpClientRequest.get(`${path}/${name}`), schema).pipe(
            Effect.catchIf(isGone, () => Effect.undefined)
          ),
        list: (selector: Selector): Effect.Effect<Array<S["Type"]>, ApiError> =>
          Effect.gen(function* () {
            const items: Array<S["Type"]> = [];
            let next: string | undefined;

            do {
              const page = yield* call(
                HttpClientRequest.get(path).pipe(
                  HttpClientRequest.setUrlParams([
                    [
                      "labelSelector",
                      Object.entries(selector)
                        .map(([key, value]) => `${key}=${value}`)
                        .join(","),
                    ],
                    ...(next === undefined
                      ? []
                      : [["continue", next] as const]),
                  ])
                ),
                list
              );

              items.push(...page.items);
              next =
                page.metadata?.continue === ""
                  ? undefined
                  : page.metadata?.continue;
            } while (next !== undefined);

            return items;
          }),
        create: (body: unknown): Effect.Effect<S["Type"], ApiError> =>
          call(
            HttpClientRequest.post(path).pipe(
              HttpClientRequest.bodyJsonUnsafe(body)
            ),
            schema
          ),
        patch: (
          name: string,
          uid: string,
          body: { readonly metadata?: object; readonly spec?: object }
        ): Effect.Effect<void, ApiError> =>
          Effect.asVoid(
            call(
              HttpClientRequest.patch(`${path}/${name}`).pipe(
                HttpClientRequest.bodyText(
                  JSON.stringify({
                    ...body,
                    metadata: { ...body.metadata, uid },
                  }),
                  "application/merge-patch+json"
                )
              ),
              Schema.Unknown
            )
          ),
        remove: (name: string, uid?: string): Effect.Effect<void, ApiError> =>
          call(
            HttpClientRequest.delete(`${path}/${name}`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                propagationPolicy: "Background",
                ...(uid === undefined ? {} : { preconditions: { uid } }),
              })
            ),
            Schema.Unknown
          ).pipe(
            Effect.asVoid,
            Effect.catchIf(isGone, () => Effect.void)
          ),
      };
    };

    return {
      served: call(
        HttpClientRequest.get("/apis/agents.x-k8s.io/v1beta1"),
        Schema.Unknown
      ),
      resource,
    };
  });

export const paths = (namespace: string) => ({
  sandboxes: `/apis/agents.x-k8s.io/v1beta1/namespaces/${namespace}/sandboxes`,
  claims: `/api/v1/namespaces/${namespace}/persistentvolumeclaims`,
  snapshots: `/apis/snapshot.storage.k8s.io/v1/namespaces/${namespace}/volumesnapshots`,
  pods: `/api/v1/namespaces/${namespace}/pods`,
  quotas: `/api/v1/namespaces/${namespace}/resourcequotas`,
});

const multipliers = new Map([
  ["Ki", 2 ** 10],
  ["Mi", 2 ** 20],
  ["Gi", 2 ** 30],
  ["Ti", 2 ** 40],
  ["Pi", 2 ** 50],
  ["Ei", 2 ** 60],
  ["n", 1e-9],
  ["u", 1e-6],
  ["m", 1e-3],
  ["", 1],
  ["k", 1e3],
  ["M", 1e6],
  ["G", 1e9],
  ["T", 1e12],
  ["P", 1e15],
  ["E", 1e18],
]);

const quantityPattern =
  /^(?<number>[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(?<suffix>[KMGTPE]i|[numkMGTPE]?)$/u;

/**
 * A Kubernetes quantity, such as `500m`, `2` or `4Gi`, in its base unit:
 * https://github.com/kubernetes/apimachinery/blob/v0.37.0/pkg/api/resource/quantity.go#L35-L76
 */
export const quantity = (text: string): number | undefined => {
  const groups = quantityPattern.exec(text)?.groups;
  const multiplier = multipliers.get(groups?.["suffix"] ?? "");

  return groups === undefined || multiplier === undefined
    ? undefined
    : Number(groups["number"]) * multiplier;
};
