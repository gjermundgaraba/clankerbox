// Source: docs.boat.dev/openapi/boat-v1.yaml sha256 79aa87e21849194635cf057293d6934638bab1aeee1c1d4857aa1920e34cf210, 2026-10-05
import {
  Capacity,
  formatGib,
  formatMib,
  Internal,
  NotFound,
  Refused,
  Unsizable,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Array as Arr,
  Clock,
  Data,
  Duration,
  Effect,
  Option,
  Redacted,
  Ref,
  Schedule,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import type { MachineRef, RoomError, RuntimeError } from "../../runtime.ts";

export const baseUrl = "https://boat.dev/api/v1";

export const ttlSeconds = 7200;

const activation = { noEnv: true, ttlSeconds } as const;

export const retryWindow = Duration.minutes(5);

const firstPause = Duration.seconds(1);

const longestPause = Duration.seconds(30);

const throttledPause = Duration.seconds(65);

const throttledRepeats = 2;

const attemptTimeout = Duration.minutes(2);

const commandMargin = Duration.seconds(30);

export type TypeName = "small" | "default" | "large" | "xlarge";

export interface MachineType {
  readonly name: TypeName;
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
}

const largest: MachineType = { name: "xlarge", cpu: 16, ramMib: 32_768, diskGib: 251 };

const machineTypes: ReadonlyArray<MachineType> = [
  { name: "small", cpu: 2, ramMib: 4096, diskGib: 12 },
  { name: "default", cpu: 4, ramMib: 8192, diskGib: 50 },
  { name: "large", cpu: 8, ramMib: 16_384, diskGib: 125 },
  largest,
];

type Sizes = Pick<MachineRef, "cpu" | "ramMib" | "diskGib">;

const sized = ({ cpu, ramMib, diskGib }: Sizes): string =>
  `${cpu} vCPU, ${formatMib(ramMib)} of RAM and ${formatGib(diskGib)} of disk`;

export const typeFor = (sizes: Sizes): Option.Option<MachineType> =>
  Arr.findFirst(
    machineTypes,
    (type) => type.cpu >= sizes.cpu && type.ramMib >= sizes.ramMib && type.diskGib >= sizes.diskGib,
  );

export const machineType = (sizes: Sizes): Effect.Effect<MachineType, Unsizable> =>
  Option.match(typeFor(sizes), {
    onNone: () =>
      Effect.fail(
        new Unsizable({
          message: `no boat machine type has ${sized(sizes)}; the largest, ${largest.name}, has ${sized(largest)}`,
        }),
      ),
    onSome: Effect.succeed,
  });

export const snapshotName = (host: string, instance: string): string =>
  `cbx-${host}-${instance.slice(0, 8)}`;

export const idempotencyKey = (host: string, instance: string): string =>
  `clankerbox-${host}-${instance}`;

const Nullable = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema));

export const Sandbox = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  error: Nullable(Schema.String),
  ip: Nullable(Schema.String),
  sshEndpoint: Nullable(Schema.String),
  lastSnapshotAttemptAt: Nullable(Schema.String),
  lastSnapshotStatus: Nullable(Schema.String),
});

export type Sandbox = typeof Sandbox.Type;

const SandboxInfo = Schema.Struct({ sandbox: Sandbox });

const Forked = Schema.Struct({ id: Schema.String });

const Finished = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Number),
  stdout: Schema.String,
  stderr: Schema.String,
  timedOut: Schema.Boolean,
});

const NamedSnapshot = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  error: Schema.optionalKey(Schema.String),
});

const NamedSnapshotInfo = Schema.Struct({ snapshot: NamedSnapshot });

const StartWindow = Schema.Struct({ limit: Schema.Int, used: Schema.Int });

const Limits = Schema.Struct({
  activeSandboxes: Schema.Int,
  maxActiveSandboxes: Schema.Int,
  starts: Nullable(
    Schema.Struct({
      minute: Nullable(StartWindow),
      hour: Nullable(StartWindow),
      day: Nullable(StartWindow),
    }),
  ),
});

const Accepted = Schema.Struct({});

const BoatError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  requestId: Schema.optionalKey(Schema.String),
});

const decodeBoatError = Schema.decodeUnknownEffect(Schema.fromJsonString(BoatError));

const capacityRefusals: ReadonlyArray<readonly [number, string]> = [
  [429, "limit_reached"],
  [429, "member_limit_reached"],
  [429, "daily_limit_reached"],
  [503, "out_of_capacity"],
  [503, "no_ready_machine"],
  [409, "named_snapshot_limit"],
];

const inProgress = "idempotency_in_progress";

const rateLimited = "rate_limited";

class Unclear extends Data.TaggedError("Unclear")<{ readonly message: string }> {}

class Throttled extends Data.TaggedError("Throttled")<{
  readonly message: string;
  readonly rateLimited: boolean;
}> {}

export interface Settings {
  readonly apiKey: Redacted.Redacted<string>;
  readonly url: string;
}

/** A 404 is boat's: its sandbox or snapshot is gone. Only the reads and deletes see it. */
type Failure = RuntimeError | NotFound;

const capacity = (message: string) => new Capacity({ message });

/** How a call that takes room is refused for it; one that takes none has no such refusal. */
type Room<E> = ((message: string) => E) | undefined;

interface Call {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body?: Schema.Json | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly timeout?: Duration.Duration | undefined;
  readonly key?: string | undefined;
  /**
   * For a read someone waits on, where boat's own answer says more than the wait for a clearer
   * one.
   */
  readonly unrepeated?: true | undefined;
}

/** Not found is no sandbox or snapshot, and a delete of what is gone is done. */
export interface Api {
  readonly sandbox: (id: string) => Effect.Effect<Option.Option<Sandbox>, RuntimeError>;
  /** The operator's own sandboxes included. */
  readonly limits: Effect.Effect<typeof Limits.Type, RuntimeError>;
  /** Create, fork and resume each count as a start, and repeat under their `key`. */
  readonly create: (key: string, type: TypeName, from?: string) => Effect.Effect<string, RoomError>;
  readonly fork: (key: string, source: string, type: TypeName) => Effect.Effect<string, RoomError>;
  /** boat takes no `Idempotency-Key` here. */
  readonly resume: (id: string) => Effect.Effect<void, RoomError>;
  /** Never with `force`, which drops everything written since the last snapshot. */
  readonly stop: (id: string) => Effect.Effect<void, RuntimeError>;
  readonly delete: (id: string) => Effect.Effect<void, RuntimeError>;
  readonly rename: (id: string, name: string) => Effect.Effect<void, RuntimeError>;
  /**
   * The answer's address and host key go unread: the state gives the endpoint, and the command
   * API the host keys.
   */
  readonly authorize: (id: string, publicKey: string) => Effect.Effect<void, RuntimeError>;
  /** boat's command API takes no stdin and caps a call at 600 s. */
  readonly command: (
    id: string,
    command: string,
    timeoutSeconds: number,
  ) => Effect.Effect<typeof Finished.Type, RuntimeError>;
  readonly saveSnapshot: (
    sandboxId: string,
    name: string,
  ) => Effect.Effect<typeof NamedSnapshot.Type, RoomError>;
  readonly snapshot: (
    name: string,
  ) => Effect.Effect<Option.Option<typeof NamedSnapshot.Type>, RuntimeError>;
  readonly deleteSnapshot: (name: string) => Effect.Effect<void, RuntimeError>;
}

export const make = (settings: Settings): Effect.Effect<Api, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const named = ({ method, path }: Call) => `boat ${method} ${path}`;
    const secret = Redacted.value(settings.apiKey);

    const scrub = (text: string) => (secret === "" ? text : text.replaceAll(secret, "<redacted>"));

    const request = (call: Call) =>
      HttpClientRequest.make(call.method)(`${settings.url}${call.path}`, {
        acceptJson: true,
        headers:
          call.key === undefined ? call.headers : { ...call.headers, "Idempotency-Key": call.key },
      }).pipe(HttpClientRequest.bearerToken(settings.apiKey), (built) =>
        call.body === undefined ? built : HttpClientRequest.bodyJsonUnsafe(built, call.body),
      );

    const refusal = <E>(
      call: Call,
      room: Room<E>,
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<never, Failure | E | Unclear | Throttled> =>
      Effect.gen(function* () {
        const { status } = response;

        const decoded = yield* Effect.option(
          Effect.flatMap(response.text, (text) => decodeBoatError(scrub(text))),
        );

        const said = Option.match(decoded, {
          onNone: () => `${named(call)} answered ${status} without boat's error`,
          onSome: ({ code, message, requestId }) =>
            `${named(call)} answered ${status} ${code}: ${message}${requestId === undefined ? "" : ` (${requestId})`}`,
        });

        const code = Option.map(decoded, (refused) => refused.code);
        const coded = (known: string) => Option.contains(code, known);

        if (
          room !== undefined &&
          capacityRefusals.some(([refused, known]) => refused === status && coded(known))
        ) {
          return yield* Effect.fail(room(said));
        }

        if (status === 403 && Option.isSome(code)) {
          return yield* new Refused({ message: said });
        }

        if (status === 429 && room !== undefined) {
          if (call.key !== undefined) {
            return yield* new Throttled({ message: said, rateLimited: coded(rateLimited) });
          }

          if (coded(rateLimited)) {
            return yield* Effect.fail(room(said));
          }

          return yield* new Internal({ message: said });
        }

        if (status >= 500 || status === 429 || (status === 409 && coded(inProgress))) {
          return yield* new Unclear({ message: said });
        }

        return yield* status === 404
          ? new NotFound({ message: said })
          : new Internal({ message: said });
      });

    const answer = <A, E>(
      call: Call,
      room: Room<E>,
      schema: Schema.Decoder<A>,
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<A, Failure | E | Unclear | Throttled> =>
      Effect.gen(function* () {
        const { status } = response;

        if (status < 200 || status >= 300) {
          return yield* refusal(call, room, response);
        }

        const text = yield* Effect.mapError(
          response.text,
          (error) =>
            new Unclear({
              message: `${named(call)} answered ${status}, and its body didn't arrive whole: ${error.reason._tag}`,
            }),
        );

        return yield* Effect.mapError(
          Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(scrub(text)),
          (error) =>
            new Internal({
              message: `${named(call)} answered ${status} with a body the host can't read: ${error.message}`,
            }),
        );
      });

    const attempt = <A, E>(
      call: Call,
      room: Room<E>,
      built: HttpClientRequest.HttpClientRequest,
      schema: Schema.Decoder<A>,
    ): Effect.Effect<A, Failure | E | Unclear | Throttled> =>
      http.execute(built).pipe(
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.mapError(
          (error) =>
            new Unclear({
              message: scrub(
                `${named(call)}: ${error.reason._tag}${error.reason.description === undefined ? "" : `: ${error.reason.description}`}`,
              ),
            }),
        ),
        Effect.flatMap((response) => answer(call, room, schema, response)),
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

    const sendWith =
      <E extends Capacity>(room: Room<E>) =>
      <A>(call: Call, schema: Schema.Decoder<A>): Effect.Effect<A, Failure | E> => {
        const once = attempt(call, room, request(call), schema);

        const distrusted = (refused: E | Refused | Throttled) =>
          Effect.fail(
            new Internal({
              message: `${refused.message}, after an attempt whose outcome is unknown, so a sandbox may exist`,
            }),
          );

        const paced = Effect.retry(once, {
          while: (error) => error instanceof Throttled,
          schedule: Schedule.spaced(throttledPause).pipe(
            Schedule.upTo({ times: throttledRepeats - 1 }),
          ),
        }).pipe(
          Effect.delay(throttledPause),
          Effect.catch((last) => {
            if (!(last instanceof Throttled)) {
              return Effect.fail(last);
            }

            const message = `${last.message}, and ${throttledRepeats} repeats ${Duration.format(throttledPause)} apart met the same`;

            return last.rateLimited && room !== undefined
              ? Effect.fail(room(message))
              : Effect.fail(new Internal({ message }));
          }),
        );

        const repeats = (since: number) =>
          Effect.flatMap(Ref.make(0), (throttles) =>
            Effect.retry(once, {
              while: (error) =>
                error instanceof Throttled
                  ? Ref.modify(throttles, (seen) => [seen + 1 < throttledRepeats, seen + 1])
                  : error instanceof Unclear,
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
            }),
          ).pipe(
            Effect.delay(firstPause),
            Effect.catch((last) => {
              if (last instanceof Unclear) {
                return Effect.fail(
                  new Internal({
                    message: `${last.message}, and repeats for ${Duration.format(retryWindow)} got no clearer answer`,
                  }),
                );
              }

              return last instanceof NotFound || last instanceof Internal
                ? Effect.fail(last)
                : distrusted(last);
            }),
          );

        const repeatable =
          call.unrepeated !== true &&
          (call.method === "GET" || call.method === "DELETE" || call.key !== undefined);

        return once.pipe(
          Effect.catch((error) => (error instanceof Throttled ? paced : Effect.fail(error))),
          Effect.catch((error) => {
            if (!(error instanceof Unclear)) {
              return Effect.fail(error);
            }

            return repeatable
              ? Effect.flatMap(Clock.currentTimeMillis, repeats)
              : Effect.fail(new Internal({ message: error.message }));
          }),
        );
      };

    const sendOrAbsent = sendWith<never>(undefined);

    const present = <A, E extends RoomError>(
      call: Effect.Effect<A, E | NotFound>,
    ): Effect.Effect<A, E | Internal> =>
      Effect.mapError(call, (error) =>
        error instanceof NotFound ? new Internal({ message: error.message }) : error,
      );

    const send = <A>(call: Call, schema: Schema.Decoder<A>) => present(sendOrAbsent(call, schema));

    const sendTakingRoom = <A>(call: Call, schema: Schema.Decoder<A>) =>
      present(sendWith(capacity)(call, schema));

    const sandbox = (id: string) =>
      sendOrAbsent({ method: "GET", path: `/sandboxes/${id}` }, SandboxInfo).pipe(
        Effect.map(({ sandbox: found }) => Option.some(found)),
        Effect.catchTag("NotFound", () => Effect.succeedNone),
      );

    return {
      sandbox,
      limits: send({ method: "GET", path: "/limits", unrepeated: true }, Limits),
      create: (key: string, type: TypeName, from?: string) =>
        Effect.map(
          sendTakingRoom(
            {
              method: "POST",
              path: "/sandboxes",
              body: from === undefined ? { type, ...activation } : { type, from, ...activation },
              key,
            },
            SandboxInfo,
          ),
          ({ sandbox: created }) => created.id,
        ),
      fork: (key: string, source: string, type: TypeName) =>
        Effect.map(
          sendTakingRoom(
            {
              method: "POST",
              path: `/sandboxes/${source}/fork`,
              body: { type, ...activation },
              key,
            },
            Forked,
          ),
          (forked) => forked.id,
        ),
      resume: (id: string) =>
        Effect.asVoid(
          sendTakingRoom(
            { method: "POST", path: `/sandboxes/${id}/resume`, body: activation },
            Accepted,
          ),
        ),
      stop: (id: string) =>
        Effect.asVoid(send({ method: "POST", path: `/sandboxes/${id}/stop`, body: {} }, Accepted)),
      delete: (id: string) =>
        sendOrAbsent(
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
      rename: (id: string, name: string) =>
        Effect.asVoid(
          send({ method: "PATCH", path: `/sandboxes/${id}`, body: { name } }, Accepted),
        ),
      authorize: (id: string, publicKey: string) =>
        Effect.asVoid(
          send(
            { method: "POST", path: `/sandboxes/${id}/sshkey`, body: { key: publicKey } },
            Accepted,
          ),
        ),
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
      saveSnapshot: (sandboxId: string, name: string) =>
        Effect.map(
          sendTakingRoom(
            {
              method: "POST",
              path: "/named-snapshots",
              body: { sandboxId, name },
            },
            NamedSnapshotInfo,
          ),
          (saved) => saved.snapshot,
        ),
      snapshot: (name: string) =>
        sendOrAbsent({ method: "GET", path: `/named-snapshots/${name}` }, NamedSnapshotInfo).pipe(
          Effect.map((info) => Option.some(info.snapshot)),
          Effect.catchTag("NotFound", () => Effect.succeedNone),
        ),
      deleteSnapshot: (name: string) =>
        sendOrAbsent({ method: "DELETE", path: `/named-snapshots/${name}` }, Accepted).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        ),
    };
  });
