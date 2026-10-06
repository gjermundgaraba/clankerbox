/**
 * boat's HTTP API v1, as the boat runtime calls it: Schemas for exactly the endpoints it uses,
 * boat's refusals mapped to the contract's errors, and the bounded retry of the calls that are safe
 * to repeat: every `GET` and `DELETE`, and every call that carries an `Idempotency-Key`. Shapes follow
 * `docs.boat.dev/openapi/boat-v1.yaml` (sha256
 * `79aa87e21849194635cf057293d6934638bab1aeee1c1d4857aa1920e34cf210`, fetched 2026-10-05) and what
 * the trial account showed; the bump-boat-api skill lists the claims they rest on.
 *
 * The API key travels only in the `Authorization` header, held `Redacted`. Errors are built from
 * the method, the path, the status and boat's own code and message, never from a request or a
 * whole body (a sandbox's `desktopUrl` carries a token). The runtime scrubs the key from them
 * where they leave it, as it does every other string boat sends.
 */
import {
  Capacity,
  type HostError,
  Internal,
  NotFound,
  Precondition,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Array as Arr,
  Clock,
  Data,
  Duration,
  Effect,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect";
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

/**
 * How long a call safe to repeat is repeated while its outcome is unclear, counted from the first
 * unclear answer; a caller with a deadline of its own cuts it short. That answer can take
 * `attemptTimeout`, and so can the last repeat, begun after a pause decided inside the window: a
 * call can take up to 9.5 minutes, after a throttled call's repeats (`throttledPause`).
 */
export const retryWindow = Duration.minutes(5);

/** The first pause between repeats, doubling up to `longestPause`. */
const firstPause = Duration.seconds(1);

const longestPause = Duration.seconds(30);

/**
 * The pause before repeating a call that boat throttled with a 429, which made nothing. A 429
 * to a create, fork or restore counts as a start against boat's rolling minute, hour and day
 * windows, so a repeat waits until the minute has rolled past, and there are at most
 * `throttledRepeats` of them: a throttle that outlasts them, as an hour's or a day's does, has
 * cost at most three starts.
 */
const throttledPause = Duration.seconds(65);

const throttledRepeats = 2;

/**
 * How long one attempt may take before its outcome counts as unclear. A create answers in about
 * 0.2 s and a stop in well under a second; a hung connection must not hold an action forever.
 */
const attemptTimeout = Duration.minutes(2);

/** A command's own timeout is boat's to enforce; the attempt gets this much on top. */
const commandMargin = Duration.seconds(30);

/** boat's machine types, by the name its API takes. */
export type TypeName = "small" | "default" | "large" | "xlarge";

export interface MachineType {
  readonly name: TypeName;
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
}

/**
 * boat's types, smallest first (the bump-boat-api skill). The host asks for any of them, and a
 * type the account's plan doesn't include is boat's to refuse: the trial refuses `large` and
 * `xlarge`, which needs the $100 plan.
 */
const largest: MachineType = { name: "xlarge", cpu: 16, ramMib: 32_768, diskGib: 251 };

const machineTypes: ReadonlyArray<MachineType> = [
  { name: "small", cpu: 2, ramMib: 4096, diskGib: 12 },
  { name: "default", cpu: 4, ramMib: 8192, diskGib: 50 },
  { name: "large", cpu: 8, ramMib: 16_384, diskGib: 125 },
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
            message: `no boat machine type has ${sizes.cpu} vCPU, ${sizes.ramMib} MiB of RAM and ${sizes.diskGib} GiB of disk; the largest, ${largest.name}, has ${largest.cpu} vCPU, ${largest.ramMib} MiB and ${largest.diskGib} GiB`,
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
  /** IPv6 or IPv4. */
  ip: Nullable(Schema.String),
  /** A public IPv4 `host:port` relay to port 22, set only when the machine has no IPv4 of its own. */
  sshEndpoint: Nullable(Schema.String),
  lastSnapshotAttemptAt: Nullable(Schema.String),
  lastSnapshotStatus: Nullable(Schema.String),
});

export type Sandbox = typeof Sandbox.Type;

const SandboxInfo = Schema.Struct({ sandbox: Sandbox });

/** A fork's answer: `id` is the new sandbox. */
const Forked = Schema.Struct({ id: Schema.String });

const Finished = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Number),
  stdout: Schema.String,
  stderr: Schema.String,
  timedOut: Schema.Boolean,
});

const NamedSnapshot = Schema.Struct({
  name: Schema.String,
  /** `saving`, `ready` or `failed`. */
  status: Schema.String,
  error: Schema.optionalKey(Schema.String),
});

const NamedSnapshotInfo = Schema.Struct({ snapshot: NamedSnapshot });

/** A body the host ignores beyond its status: it reads none of its fields. */
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
 * account's, or an organization member's, active limit, its daily start limit, no machine to
 * run it on, and an 11th named snapshot. They count only for a call that takes room
 * (`Call.takesRoom`). A create or fork that ends `cancelled` is the runtime's to read.
 */
const capacityRefusals: ReadonlyArray<readonly [number, string]> = [
  [429, "limit_reached"],
  [429, "member_limit_reached"],
  [429, "daily_limit_reached"],
  [503, "out_of_capacity"],
  [503, "no_ready_machine"],
  [409, "named_snapshot_limit"],
];

/**
 * boat's answers for a type the account's plan doesn't include. They leave nothing on boat
 * either, but waiting won't help: the plan doesn't allow it.
 */
const planRefusals: ReadonlyArray<string> = [
  "trial_machine_class_not_allowed",
  "machine_class_plan_required",
];

/** A repeat that arrives while the first call is still making the sandbox: repeat it again. */
const inProgress = "idempotency_in_progress";

/** boat's start limit of a rolling window, which names the window it hit. */
const rateLimited = "rate_limited";

/**
 * An attempt whose outcome isn't known, or that may go through later: a dropped connection, a
 * timeout, a 5xx boat doesn't call a refusal, a repeat still in progress, a 2xx whose body
 * didn't arrive whole, or a 429 to a call that takes no room.
 */
class Unclear extends Data.TaggedError("Unclear")<{ readonly message: string }> {}

/**
 * A 429 to a create, fork or restore that isn't one of `capacityRefusals`: boat made nothing, and
 * the call carries its key, so it is repeated (`throttledPause`). One that outlasts its repeats
 * is `Capacity` when boat said `rate_limited`, and `Internal` for a code the host doesn't know.
 */
class Throttled extends Data.TaggedError("Throttled")<{
  readonly message: string;
  readonly rateLimited: boolean;
}> {}

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
  /** An `Idempotency-Key`, which makes the call safe to repeat. */
  readonly key?: string | undefined;
  /**
   * Whether the call starts a machine or saves a named snapshot: create, fork, resume, restore
   * and a snapshot's save. Only then is a 429 or 503 refusal in `capacityRefusals` `Capacity`.
   */
  readonly takesRoom?: true | undefined;
}

export const make = (settings: Settings) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const named = ({ method, path }: Call) => `boat ${method} ${path}`;

    const request = (call: Call) =>
      HttpClientRequest.make(call.method)(`${settings.url}${call.path}`, {
        acceptJson: true,
        headers:
          call.key === undefined ? call.headers : { ...call.headers, "Idempotency-Key": call.key },
      }).pipe(HttpClientRequest.bearerToken(settings.apiKey), (built) =>
        call.body === undefined ? built : HttpClientRequest.bodyJsonUnsafe(built, call.body),
      );

    /**
     * boat's answer to a call that isn't a 2xx, decided by its status; boat's code, when the body
     * holds one, refines it. A 4xx is definite whatever its body: a proxy's HTML 403 is
     * `Internal`, and a 404 without a body is `NotFound`. A 429 to a call that takes no room is
     * boat's rate limit on reads and the like, which passes; one to a call that takes room, but
     * isn't one of `capacityRefusals`, is a start limit that may pass (`Throttled`).
     */
    const refusal = (
      call: Call,
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<never, HostError | Unclear | Throttled> =>
      Effect.gen(function* () {
        const { status } = response;
        const decoded = yield* Effect.option(Effect.flatMap(response.json, decodeRefused));

        const said = Option.match(decoded, {
          onNone: () => `${named(call)} answered ${status} without boat's error`,
          onSome: ({ code, message, requestId }) =>
            `${named(call)} answered ${status} ${code}: ${message}${requestId === undefined ? "" : ` (${requestId})`}`,
        });

        const code = Option.map(decoded, (refused) => refused.code);
        const coded = (known: string) => Option.contains(code, known);

        if (
          call.takesRoom === true &&
          capacityRefusals.some(([refused, known]) => refused === status && coded(known))
        ) {
          return yield* new Capacity({ message: said });
        }

        if (status === 403 && planRefusals.some(coded)) {
          return yield* new Precondition({ message: said });
        }

        if (status === 429 && call.takesRoom === true) {
          if (call.key !== undefined) {
            return yield* new Throttled({ message: said, rateLimited: coded(rateLimited) });
          }

          return yield* coded(rateLimited)
            ? new Capacity({ message: said })
            : new Internal({ message: said });
        }

        if (status >= 500 || status === 429 || (status === 409 && coded(inProgress))) {
          return yield* new Unclear({ message: said });
        }

        return yield* status === 404
          ? new NotFound({ message: said })
          : new Internal({ message: said });
      });

    /** Reads an answer: its body when it is a 2xx, else boat's refusal. */
    const answer = <A>(
      call: Call,
      schema: Schema.Decoder<A>,
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<A, HostError | Unclear | Throttled> =>
      Effect.gen(function* () {
        const { status } = response;

        if (status < 200 || status >= 300) {
          return yield* refusal(call, response);
        }

        // A body cut off midway leaves the outcome unknown, as a dropped connection does; one that
        // arrived whole but isn't the answer is boat's, or a proxy's, definite word.
        const text = yield* Effect.mapError(
          response.text,
          (error) =>
            new Unclear({
              message: `${named(call)} answered ${status}, and its body didn't arrive whole: ${error.reason._tag}`,
            }),
        );

        return yield* Effect.mapError(
          Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text),
          (error) =>
            new Internal({
              message: `${named(call)} answered ${status} with a body the host can't read: ${error.message}`,
            }),
        );
      });

    /** One attempt. Its request is built once by the caller, so a repeat sends the same bytes. */
    const attempt = <A>(
      call: Call,
      built: HttpClientRequest.HttpClientRequest,
      schema: Schema.Decoder<A>,
    ): Effect.Effect<A, HostError | Unclear | Throttled> =>
      http.execute(built).pipe(
        // No span and no trace headers: boat is a third party, and a span would record the call.
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.mapError(
          (error) =>
            new Unclear({
              message: `${named(call)}: ${error.reason._tag}${error.reason.description === undefined ? "" : `: ${error.reason.description}`}`,
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

    /**
     * A call, answered. One safe to repeat, a `GET`, a `DELETE` (a 404 counts as done) or one
     * with an `Idempotency-Key`, is repeated while its outcome is unclear, with the same request
     * and backoff, for `retryWindow` from its first unclear answer, far inside boat's 24-hour key
     * window; then it fails. Any other call is made once, and an unclear outcome fails it. A keyed
     * call boat throttled is repeated too, `throttledPause` apart. After an unclear attempt no
     * refusal is trusted as one: that attempt may have made a sandbox, which the refusal may be
     * counting.
     */
    const send = <A>(call: Call, schema: Schema.Decoder<A>): Effect.Effect<A, HostError> => {
      const once = attempt(call, request(call), schema);

      const distrusted = (refused: Capacity | Precondition | Throttled) =>
        Effect.fail(
          new Internal({
            message: `${refused.message}, after an attempt whose outcome is unknown, so a sandbox may exist`,
          }),
        );

      /** The repeats after a 429 that made nothing, whose refusals are trusted. */
      const paced = Effect.retry(once, {
        while: (error) => error instanceof Throttled,
        schedule: Schedule.spaced(throttledPause).pipe(
          Schedule.upTo({ times: throttledRepeats - 1 }),
        ),
      }).pipe(
        Effect.delay(throttledPause),
        Effect.catchTag("Throttled", (last) => {
          const message = `${last.message}, and ${throttledRepeats} repeats ${Duration.format(throttledPause)} apart met the same`;

          return Effect.fail(
            last.rateLimited ? new Capacity({ message }) : new Internal({ message }),
          );
        }),
      );

      /**
       * The repeats after an unclear answer at `since`: the first `firstPause` later, then with
       * the pause doubling, or `throttledPause` after a 429, while `retryWindow` hasn't passed
       * since.
       */
      const repeats = (since: number) =>
        Effect.retry(once, {
          while: (error) => error instanceof Unclear || error instanceof Throttled,
          schedule: Schedule.min([
            Schedule.exponential(Duration.times(firstPause, 2)),
            Schedule.spaced(longestPause),
          ]).pipe(
            Schedule.modifyDelay(({ input, duration }) =>
              Effect.succeed(
                input instanceof Throttled ? Duration.max(duration, throttledPause) : duration,
              ),
            ),
            Schedule.while(({ now }) => now - since < Duration.toMillis(retryWindow)),
          ),
        }).pipe(
          Effect.delay(firstPause),
          Effect.catchTags({
            Unclear: (last) =>
              Effect.fail(
                new Internal({
                  message: `${last.message}, and repeats for ${Duration.format(retryWindow)} got no clearer answer`,
                }),
              ),
            Throttled: distrusted,
            Capacity: distrusted,
            Precondition: distrusted,
          }),
        );

      const repeatable =
        call.method === "GET" || call.method === "DELETE" || call.key !== undefined;

      return once.pipe(
        Effect.catchTag("Throttled", () => paced),
        Effect.catchTag("Unclear", (first) =>
          repeatable
            ? Effect.flatMap(Clock.currentTimeMillis, repeats)
            : Effect.fail(new Internal({ message: first.message })),
        ),
      );
    };

    /** A sandbox, or none once boat answers 404. */
    const sandbox = (id: string) =>
      send({ method: "GET", path: `/sandboxes/${id}` }, SandboxInfo).pipe(
        Effect.map(({ sandbox: found }) => Option.some(found)),
        Effect.catchTag("NotFound", () => Effect.succeedNone),
      );

    return {
      sandbox,
      /** Creates a sandbox of `type`, or from the named snapshot `from`; its ID. */
      create: (key: string, type: TypeName, from?: string) =>
        Effect.map(
          send(
            {
              method: "POST",
              path: "/sandboxes",
              body: from === undefined ? { type, ...activation } : { type, from, ...activation },
              key,
              takesRoom: true,
            },
            SandboxInfo,
          ),
          ({ sandbox: created }) => created.id,
        ),
      /** Forks `source` into a new sandbox of `type`; its ID. */
      fork: (key: string, source: string, type: TypeName) =>
        Effect.map(
          send(
            {
              method: "POST",
              path: `/sandboxes/${source}/fork`,
              body: { type, ...activation },
              key,
              takesRoom: true,
            },
            Forked,
          ),
          (forked) => forked.id,
        ),
      /** Resumes a stopped sandbox. boat takes no `Idempotency-Key` here. */
      resume: (id: string) =>
        Effect.asVoid(
          send(
            { method: "POST", path: `/sandboxes/${id}/resume`, body: activation, takesRoom: true },
            Accepted,
          ),
        ),
      /**
       * Stops a sandbox after its final snapshot. Never with `force`, which drops everything
       * written since the last snapshot; a stop boat refuses is the error.
       */
      stop: (id: string) =>
        Effect.asVoid(send({ method: "POST", path: `/sandboxes/${id}/stop`, body: {} }, Accepted)),
      /** Deletes a sandbox; one boat no longer has is already gone. */
      delete: (id: string) =>
        send(
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
          send({ method: "PATCH", path: `/sandboxes/${id}`, body: { name } }, Accepted),
        ),
      /**
       * Authorizes an OpenSSH public key for `user`. The answer's address and host key go unread:
       * the state gives the endpoint, and the command API the host keys.
       */
      authorize: (id: string, publicKey: string) =>
        Effect.asVoid(
          send(
            { method: "POST", path: `/sandboxes/${id}/sshkey`, body: { key: publicKey } },
            Accepted,
          ),
        ),
      /**
       * Runs a bash command as `user` through boat's command API, which takes no stdin and caps
       * a call at 600 s. It reads the guest's host keys before the first SSH; it isn't the exec.
       */
      command: (id: string, command: string, timeoutSeconds: number) =>
        send(
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
          send(
            {
              method: "POST",
              path: "/named-snapshots",
              body: { sandboxId, name },
              takesRoom: true,
            },
            NamedSnapshotInfo,
          ),
          (saved) => saved.snapshot,
        ),
      /** A named snapshot, or none once boat answers 404. */
      snapshot: (name: string) =>
        send({ method: "GET", path: `/named-snapshots/${name}` }, NamedSnapshotInfo).pipe(
          Effect.map((info) => Option.some(info.snapshot)),
          Effect.catchTag("NotFound", () => Effect.succeedNone),
        ),
      /** Deletes a named snapshot; one boat no longer has is already gone. */
      deleteSnapshot: (name: string) =>
        send({ method: "DELETE", path: `/named-snapshots/${name}` }, Accepted).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        ),
    };
  });

/** boat's API as the runtime calls it. */
export type Api = Effect.Success<ReturnType<typeof make>>;
