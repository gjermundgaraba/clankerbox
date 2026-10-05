/**
 * boat's HTTP API v1, as the boat runtime calls it: Schemas for exactly the endpoints it uses,
 * boat's refusals mapped to the contract's errors, and the bounded retry of the calls that carry
 * an `Idempotency-Key`. Shapes follow `docs.boat.dev/openapi/boat-v1.yaml` (sha256 `79aa87e2…f210`)
 * and the trial account's spikes (evidence.md, boat claims).
 *
 * The API key travels only in the `Authorization` header, held `Redacted`. Errors are built from
 * the method, the path, the status and boat's own code and message, never from a request or a
 * whole body (a sandbox's `desktopUrl` carries a token), and whatever boat says is scrubbed of
 * the key before it reaches an error.
 */
import {
  Capacity,
  type HostError,
  Internal,
  NotFound,
  Precondition,
} from "@gjermundgaraba/clankerbox-sdk";
import { Array as Arr, Data, Duration, Effect, Option, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import type { MachineRef } from "./runtime.ts";

/** The API version the host is built for. */
export const baseUrl = "https://boat.dev/api/v1";

/**
 * The trial's longest auto-stop: it refuses longer, or none, with 400
 * `trial_auto_stop_required`, and a fork without one stops after an hour.
 */
export const ttlSeconds = 7200;

/**
 * What every create, fork, resume and restore sends: no account secrets, GitHub token or model
 * logins reach the guest, and the machine stops itself at the trial's limit at the latest.
 */
const activation = { noEnv: true, ttlSeconds } as const;

/** How long a call with an `Idempotency-Key` is repeated while its outcome is unclear. */
export const retryWindow = Duration.minutes(5);

/** The first pause between repeats, doubling up to `longestPause`. */
const firstPause = Duration.seconds(1);

const longestPause = Duration.seconds(30);

/**
 * How long one attempt may take before its outcome counts as unclear. A create answers in about
 * 0.2 s and a stop in well under a second; a hung connection must not hold an action forever.
 */
const attemptTimeout = Duration.minutes(2);

/** A command's own timeout is boat's to enforce; the attempt gets this much on top. */
const commandMargin = Duration.seconds(30);

/** boat's machine types, by the name its API takes. */
export type TypeName = "small" | "default";

export interface MachineType {
  readonly name: TypeName;
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
}

/**
 * The types the host asks for, smallest first. They are the trial's: it refuses `large` with 403
 * `trial_machine_class_not_allowed`, and `xlarge` needs the $100 plan, so the host never asks
 * for either (evidence.md, boat claims).
 */
const largest: MachineType = { name: "default", cpu: 4, ramMib: 8192, diskGib: 50 };

export const machineTypes: ReadonlyArray<MachineType> = [
  { name: "small", cpu: 2, ramMib: 4096, diskGib: 12 },
  largest,
];

/** The smallest type that covers the machine's sizes; none is `Precondition`, in step 3. */
export const machineType = (
  sizes: Pick<MachineRef, "cpu" | "ramMib" | "diskGib">,
): Effect.Effect<MachineType, Precondition> =>
  Option.match(
    Arr.findFirst(
      machineTypes,
      (type) =>
        type.cpu >= sizes.cpu && type.ramMib >= sizes.ramMib && type.diskGib >= sizes.diskGib,
    ),
    {
      onNone: () =>
        Effect.fail(
          new Precondition({
            message: `no boat machine type has ${sizes.cpu} vCPU, ${sizes.ramMib} MiB of RAM and ${sizes.diskGib} GiB of disk; the largest the host asks for, ${largest.name}, has ${largest.cpu} vCPU, ${largest.ramMib} MiB and ${largest.diskGib} GiB`,
          }),
        ),
      onSome: Effect.succeed,
    },
  );

/**
 * A named snapshot's name. Names are account-wide, so they carry the host ID and the row's
 * instance; a host ID of at most 32 characters keeps it within boat's 63.
 */
export const snapshotName = (host: string, instance: string): string =>
  `cbx-${host}-${instance.slice(0, 8)}`;

/**
 * The `Idempotency-Key` of the create, fork or restore that makes a row's sandbox: one per row,
 * so a repeat within boat's 24-hour window returns the sandbox the first call made.
 */
export const idempotencyKey = (host: string, instance: string): string =>
  `clankerbox-${host}-${instance}`;

const Nullable = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema));

/**
 * A sandbox, with only the fields the runtime reads. A `cancelled` one is reported once with
 * only `id`, `state` and `error`, so the rest is optional. `state` is any string: one the
 * runtime doesn't know reads as `stopped`.
 */
export const Sandbox = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  error: Nullable(Schema.String),
  type: Schema.optionalKey(Schema.String),
  /** IPv6 or IPv4. */
  ip: Nullable(Schema.String),
  /** A public IPv4 `host:port` relay to port 22, set only when the machine has no IPv4 of its own. */
  sshEndpoint: Nullable(Schema.String),
  lastSnapshotAttemptAt: Nullable(Schema.String),
  lastSnapshotStatus: Nullable(Schema.String),
  snapshotCompletedAt: Nullable(Schema.String),
});

export type Sandbox = typeof Sandbox.Type;

const SandboxList = Schema.Struct({
  sandboxes: Schema.Array(Sandbox),
  pageInfo: Schema.optionalKey(Schema.Struct({ hasMore: Schema.Boolean })),
});

const SandboxInfo = Schema.Struct({ sandbox: Sandbox });

/** A fork's answer: `id` is the new sandbox. */
const Forked = Schema.Struct({ id: Schema.String });

const Authorized = Schema.Struct({
  machineIp: Nullable(Schema.String),
  sshEndpoint: Nullable(Schema.String),
});

export type Authorized = typeof Authorized.Type;

const Finished = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Number),
  stdout: Schema.String,
  stderr: Schema.String,
  timedOut: Schema.Boolean,
});

export type Finished = typeof Finished.Type;

export const NamedSnapshot = Schema.Struct({
  name: Schema.String,
  /** `saving`, `ready` or `failed`. */
  status: Schema.String,
  error: Schema.optionalKey(Schema.String),
});

export type NamedSnapshot = typeof NamedSnapshot.Type;

const NamedSnapshotInfo = Schema.Struct({ snapshot: NamedSnapshot });

const NamedSnapshotList = Schema.Struct({ snapshots: Schema.Array(NamedSnapshot) });

/** A body the host ignores beyond its status. */
const Accepted = Schema.Struct({});

/** boat's error envelope. */
const Refused = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  requestId: Schema.optionalKey(Schema.String),
});

const decodeRefused = Schema.decodeUnknownEffect(Refused);

/**
 * boat's answers that leave nothing on boat and mean "no room now", by status and code: the
 * account's active or start limits, a type its plan doesn't include, and an 11th named
 * snapshot. A create or fork that ends `cancelled` is the runtime's to read.
 */
const capacityRefusals: ReadonlyArray<readonly [number, string]> = [
  [429, "limit_reached"],
  [429, "rate_limited"],
  [429, "daily_limit_reached"],
  [403, "trial_machine_class_not_allowed"],
  [403, "machine_class_plan_required"],
  [409, "named_snapshot_limit"],
];

/** A repeat that arrives while the first call is still making the sandbox: repeat it again. */
const inProgress = "idempotency_in_progress";

/** An attempt whose outcome isn't known: a dropped connection, a timeout or a 5xx. */
class Unclear extends Data.TaggedError("Unclear")<{ readonly message: string }> {}

/** What the host needs to call boat. */
export interface Settings {
  readonly apiKey: Redacted.Redacted<string>;
  /** `baseUrl` in production; tests point it at a fake. */
  readonly url: string;
}

/** One call: its method and path name it in errors. */
interface Call {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body?: Schema.Json | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly timeout?: Duration.Duration | undefined;
}

export const make = (settings: Settings) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const key = Redacted.value(settings.apiKey);

    /** Text from boat or the transport, without the key in it. */
    const scrub = (text: string) => (key === "" ? text : text.replaceAll(key, "<redacted>"));

    const named = ({ method, path }: Call) => `boat ${method} ${path}`;

    const request = (call: Call) =>
      HttpClientRequest.make(call.method)(`${settings.url}${call.path}`, {
        acceptJson: true,
        headers: call.headers,
      }).pipe(HttpClientRequest.bearerToken(settings.apiKey), (built) =>
        call.body === undefined ? built : HttpClientRequest.bodyJsonUnsafe(built, call.body),
      );

    /** boat's answer to a call that isn't a 2xx: one of the contract's errors. */
    const refusal = (
      call: Call,
      status: number,
      decoded: Option.Option<typeof Refused.Type>,
    ): HostError | Unclear => {
      if (Option.isNone(decoded)) {
        return new Internal({ message: `${named(call)} answered ${status} without boat's error` });
      }

      const { code, message, requestId } = decoded.value;
      const said = `${named(call)} answered ${status} ${code}: ${scrub(message)}${requestId === undefined ? "" : ` (${requestId})`}`;

      if (status === 409 && code === inProgress) {
        return new Unclear({ message: said });
      }

      if (capacityRefusals.some(([refused, known]) => refused === status && known === code)) {
        return new Capacity({ message: said });
      }

      return status === 404 ? new NotFound({ message: said }) : new Internal({ message: said });
    };

    /** Reads an answer: its body when it is a 2xx, else boat's refusal. */
    const answer = <A>(
      call: Call,
      schema: Schema.Decoder<A>,
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<A, HostError | Unclear> =>
      Effect.gen(function* () {
        const { status } = response;

        if (status >= 500) {
          return yield* new Unclear({ message: `${named(call)} answered ${status}` });
        }

        // A body cut off midway leaves the outcome unknown, as a dropped connection does.
        const json = yield* Effect.mapError(
          response.json,
          (error) =>
            new Unclear({
              message: `${named(call)} answered ${status}, and its body didn't arrive whole: ${error.reason._tag}`,
            }),
        );

        if (status < 200 || status >= 300) {
          return yield* Effect.fail(
            refusal(call, status, yield* Effect.option(decodeRefused(json))),
          );
        }

        return yield* Effect.mapError(
          Schema.decodeUnknownEffect(schema)(json),
          (error) =>
            new Internal({
              message: `${named(call)} answered ${status} with a body the host can't read: ${scrub(error.message)}`,
            }),
        );
      });

    /** One attempt. Its request is built once by the caller, so a repeat sends the same bytes. */
    const attempt = <A>(
      call: Call,
      built: HttpClientRequest.HttpClientRequest,
      schema: Schema.Decoder<A>,
    ): Effect.Effect<A, HostError | Unclear> =>
      http.execute(built).pipe(
        // No span and no trace headers: boat is a third party, and a span would record the call.
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.mapError(
          (error) =>
            new Unclear({
              message: `${named(call)}: ${error.reason._tag}${error.reason.description === undefined ? "" : `: ${scrub(error.reason.description)}`}`,
            }),
        ),
        Effect.flatMap((response) => answer(call, schema, response)),
        Effect.timeoutOrElse({
          duration: call.timeout ?? attemptTimeout,
          orElse: () =>
            Effect.fail(
              new Unclear({
                message: `${named(call)} had no answer within ${Duration.format(call.timeout ?? attemptTimeout)}`,
              }),
            ),
        }),
      );

    /** A call made once: an unclear outcome fails it. */
    const once = <A>(call: Call, schema: Schema.Decoder<A>): Effect.Effect<A, HostError> =>
      Effect.catchTag(attempt(call, request(call), schema), "Unclear", (unclear) =>
        Effect.fail(new Internal({ message: unclear.message })),
      );

    /**
     * A call that carries an `Idempotency-Key`: while its outcome is unclear it is repeated with
     * the same key and body, with backoff, for up to `retryWindow`, far inside boat's 24-hour key
     * window. Then it fails.
     */
    const idempotent = <A>(
      call: Call,
      key: string,
      schema: Schema.Decoder<A>,
    ): Effect.Effect<A, HostError> => {
      const keyed = { ...call, headers: { ...call.headers, "Idempotency-Key": key } };
      const built = request(keyed);

      return attempt(keyed, built, schema).pipe(
        Effect.retry({
          while: (error) => error instanceof Unclear,
          schedule: Schedule.max([
            Schedule.during(retryWindow),
            Schedule.min([Schedule.exponential(firstPause), Schedule.spaced(longestPause)]),
          ]),
        }),
        Effect.catchTag("Unclear", (unclear) =>
          Effect.fail(
            new Internal({
              message: `${unclear.message}, and repeats for ${Duration.format(retryWindow)} got no clearer answer`,
            }),
          ),
        ),
      );
    };

    /** A sandbox, or none once boat answers 404. */
    const sandbox = (id: string) =>
      once({ method: "GET", path: `/sandboxes/${id}` }, SandboxInfo).pipe(
        Effect.map(({ sandbox: found }) => Option.some(found)),
        Effect.catchTag("NotFound", () => Effect.succeedNone),
      );

    return {
      /**
       * The sandboxes among `ids`, from one `GET /sandboxes`: the account may also hold the
       * operator's own. One page holds up to 200; when boat has more and one of `ids` isn't on
       * it, the answer can't say it is gone, so it fails.
       */
      sandboxes: (ids: ReadonlyArray<string>) =>
        Effect.flatMap(
          once({ method: "GET", path: "/sandboxes?limit=200" }, SandboxList),
          ({ sandboxes, pageInfo }) => {
            const wanted = new Set(ids);

            const found = new Map(
              sandboxes
                .filter((listed) => wanted.has(listed.id))
                .map((listed) => [listed.id, listed]),
            );

            return pageInfo?.hasMore === true && found.size < wanted.size
              ? Effect.fail(
                  new Internal({
                    message: `boat lists more than ${sandboxes.length} sandboxes, so the host can't tell which of ${ids.join(", ")} are gone`,
                  }),
                )
              : Effect.succeed(found);
          },
        ),
      sandbox,
      /** Creates a sandbox of `type`, or from the named snapshot `from`; its ID. */
      create: (key: string, type: TypeName, from?: string) =>
        Effect.map(
          idempotent(
            {
              method: "POST",
              path: "/sandboxes",
              body: from === undefined ? { type, ...activation } : { type, from, ...activation },
            },
            key,
            SandboxInfo,
          ),
          ({ sandbox: created }) => created.id,
        ),
      /** Forks `source` into a new sandbox of `type`; its ID. */
      fork: (key: string, source: string, type: TypeName) =>
        Effect.map(
          idempotent(
            { method: "POST", path: `/sandboxes/${source}/fork`, body: { type, ...activation } },
            key,
            Forked,
          ),
          (forked) => forked.id,
        ),
      /** Resumes a stopped sandbox. boat takes no `Idempotency-Key` here. */
      resume: (id: string) =>
        Effect.asVoid(
          once({ method: "POST", path: `/sandboxes/${id}/resume`, body: activation }, Accepted),
        ),
      /**
       * Stops a sandbox after its final snapshot. Never with `force`, which drops everything
       * written since the last snapshot; a stop boat refuses is the error.
       */
      stop: (id: string) =>
        Effect.asVoid(once({ method: "POST", path: `/sandboxes/${id}/stop`, body: {} }, Accepted)),
      /** Deletes a sandbox; one boat no longer has is already gone. */
      delete: (id: string) =>
        once(
          {
            method: "DELETE",
            path: `/sandboxes/${id}`,
            headers: { "X-Ascii-Confirm-Delete": id },
          },
          Accepted,
        ).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        ),
      /** Sets the display name the operator sees on boat's dashboard. */
      rename: (id: string, name: string) =>
        Effect.asVoid(
          once({ method: "PATCH", path: `/sandboxes/${id}`, body: { name } }, SandboxInfo),
        ),
      /** Authorizes an OpenSSH public key for `user`. */
      authorize: (id: string, publicKey: string) =>
        once(
          { method: "POST", path: `/sandboxes/${id}/sshkey`, body: { key: publicKey } },
          Authorized,
        ),
      /**
       * Runs a bash command as `user` through boat's command API, which takes no stdin and caps
       * a call at 600 s. It reads the guest's host keys before the first SSH; it isn't the exec.
       */
      command: (id: string, command: string, timeoutSeconds: number) =>
        once(
          {
            method: "POST",
            path: `/sandboxes/${id}/commands`,
            body: { command, timeoutSeconds },
            timeout: Duration.sum(Duration.seconds(timeoutSeconds), commandMargin),
          },
          Finished,
        ),
      /** Saves the sandbox's disk under `name`; it is `saving` until `snapshot` reads it settled. */
      saveSnapshot: (sandboxId: string, name: string) =>
        Effect.map(
          once(
            { method: "POST", path: "/named-snapshots", body: { sandboxId, name } },
            NamedSnapshotInfo,
          ),
          (saved) => saved.snapshot,
        ),
      /** A named snapshot, or none once boat answers 404. */
      snapshot: (name: string) =>
        once({ method: "GET", path: `/named-snapshots/${name}` }, NamedSnapshotInfo).pipe(
          Effect.map((info) => Option.some(info.snapshot)),
          Effect.catchTag("NotFound", () => Effect.succeedNone),
        ),
      snapshots: Effect.map(
        once({ method: "GET", path: "/named-snapshots" }, NamedSnapshotList),
        (list) => list.snapshots,
      ),
      /** Deletes a named snapshot; one boat no longer has is already gone. */
      deleteSnapshot: (name: string) =>
        once({ method: "DELETE", path: `/named-snapshots/${name}` }, Accepted).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        ),
    };
  });

/** boat's API as the runtime calls it. */
export type Api = Effect.Success<ReturnType<typeof make>>;
