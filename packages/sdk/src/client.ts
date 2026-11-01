import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import {
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Schedule,
  Schema,
} from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";

import { actionsByName as actions, Http, replyTimeout } from "./api.ts";
import type { Declared } from "./api.ts";
import { describeIssues } from "./describe.ts";
import {
  Internal,
  Invalid,
  Missing,
  Superseded,
  Unavailable,
} from "./errors.ts";
import type { ClankerboxError, HostError } from "./errors.ts";
import { version, versionHeader } from "./release.ts";
import { isResting } from "./resources.ts";
import type {
  Build,
  CapacityReport,
  Checkpoint,
  Host,
  Machine,
  MachineSpec,
  Setup,
} from "./resources.ts";

const ServerUrl = Schema.String.check(
  Schema.makeFilter(
    (url: string) => URL.canParse(url) || "a URL, such as http://cbx:8484"
  )
);

type Actions = typeof actions;

/** An action of the client contract, by name. */
export type ServerAction = keyof Actions;

type Success<N extends ServerAction> = Actions[N]["success"]["Type"];

type Input<N extends ServerAction> = Actions[N]["input"]["Type"];

/**
 * What a call of `N` fails with: an error the action declares, which always includes `Invalid`, or
 * no reply, or a reply the client couldn't use.
 */
export type ErrorOf<N extends ServerAction> =
  | Declared<N>
  | Invalid
  | Unavailable
  | Internal;

/**
 * What a request of `N` fails with once it waits: its own errors, `Superseded` by a later request,
 * and what its reads find, which is also any error a step leaves on the resource it waits on.
 */
export type WaitErrorOf<N extends ServerAction> =
  | ErrorOf<N>
  | Superseded
  | HostError;

export interface Options {
  /**
   * How long a mutation may wait for its machine or checkpoint to rest, unbounded by default, as a
   * create's setup can take hours. A wait that outlasts it fails like a lost reply, and the
   * request still acts on the server.
   */
  readonly timeout?: Duration.Duration | undefined;
  /** How long any call waits for the control plane's reply, `replyTimeout` by default. */
  readonly replyTimeout?: Duration.Duration | undefined;
  /** Answer a mutation as soon as the server has recorded it, instead of waiting for its rest. */
  readonly noWait?: boolean | undefined;
  /** How often a wait reads the resource. */
  readonly pollEvery?: Duration.Duration | undefined;
}

/** A delete of a resource that is already gone is `absent`: done either way. */
export type Deleted = "deleted" | "absent";

export interface CreateOptions {
  /** Run the setup even when a host holds a prebuild of the spec. */
  readonly fresh?: boolean | undefined;
}

type Reads = "getMachine" | "getCheckpoint" | "getPrebuild";

type Waits =
  | "startMachine"
  | "stopMachine"
  | "pauseMachine"
  | "resizeMachine"
  | "forkMachine"
  | "restoreMachine"
  | "captureCheckpoint";

/**
 * One method per read and per request on a resource, named and typed as in the contract. Each
 * request waits until its resource rests at what it asked, unless `noWait`.
 */
export type Calls = {
  readonly [N in Reads]: (
    input: Input<N>
  ) => Effect.Effect<Success<N>, ErrorOf<N>>;
} & {
  readonly [N in Waits]: (
    input: Input<N>
  ) => Effect.Effect<Success<N>, WaitErrorOf<N>>;
};

export interface Interface extends Calls {
  readonly hosts: Effect.Effect<readonly Host[], ErrorOf<"listHosts">>;
  readonly machines: Effect.Effect<readonly Machine[], ErrorOf<"listMachines">>;
  readonly checkpoints: Effect.Effect<
    readonly Checkpoint[],
    ErrorOf<"listCheckpoints">
  >;
  readonly capacity: Effect.Effect<CapacityReport, ErrorOf<"getCapacity">>;
  /** `createMachine`, then waits for the machine to rest. */
  readonly create: (
    name: string,
    spec: MachineSpec,
    options?: CreateOptions
  ) => Effect.Effect<Machine, WaitErrorOf<"createMachine">>;
  /** Asks for the prebuild, then waits for it to end. */
  readonly prebuild: (
    spec: MachineSpec & { readonly setup: Setup }
  ) => Effect.Effect<Build, WaitErrorOf<"prebuildCheckpoint">>;
  /** A delete of a resource that is already gone is `absent`: done either way. */
  readonly deleteMachine: (
    input: Input<"deleteMachine">
  ) => Effect.Effect<Deleted, WaitErrorOf<"deleteMachine">>;
  /** A delete of a checkpoint that is already gone is `absent`: done either way. */
  readonly deleteCheckpoint: (
    input: Input<"deleteCheckpoint">
  ) => Effect.Effect<Deleted, WaitErrorOf<"deleteCheckpoint">>;
}

/**
 * The server answers a mutation once it has recorded it, and the client waits by reading. Nothing
 * retries a mutation: one whose reply is lost is `Unavailable`, and the caller reads the resource
 * to see what happened. Only a wait's reads go on through an outage, of the server or of a
 * machine's host, for two minutes, and then end `Unavailable`, the request saved. A wait follows
 * the machine it asked, by `createdAt`: one deleted and made again under its name is `Superseded`
 * by the delete. A delete, which answers nothing to compare, takes a row that doesn't want deleted
 * for one made again.
 */
export class Client extends Context.Service<Client, Interface>()(
  "@gjermundgaraba/clankerbox-sdk/Client"
) {}

const serverApi = (url: string) =>
  ActionHttp.client(Http, {
    baseUrl: url,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.setHeader(versionHeader, version)
    ),
  });

type ServerApi = Effect.Success<ReturnType<typeof serverApi>>;

type Undeclared = Exclude<
  ActionHttp.MethodError<Actions[ServerAction]>,
  ClankerboxError
>;

type Methods = {
  readonly [N in ServerAction]: (
    input: Input<N>
  ) => Effect.Effect<Success<N>, Declared<N> | Undeclared>;
};

interface CallContext {
  readonly url: string;
  readonly timeout: Duration.Duration;
  readonly readOnly: boolean;
  readonly what: string;
  readonly target: string | undefined;
}

const causeDetail = (error: HttpClientError.HttpClientError): string =>
  error.cause instanceof Error ? error.cause.message : error.message;

const unanswered = (context: CallContext, detail: string): Unavailable =>
  context.readOnly
    ? new Unavailable({
        message: `the control plane (${context.url}) didn't answer ${context.what}: ${detail}`,
        readOnly: true,
      })
    : new Unavailable({
        message: `no reply from the control plane to ${context.what} (${detail}); the action may have run: read ${context.target ?? "the resource"} to see`,
        readOnly: false,
      });

const unexpected = (
  context: CallContext,
  error: { readonly message: string }
): Internal =>
  new Internal({
    message: `the control plane answered ${context.what} unexpectedly: ${error.message}`,
  });

const isUndeclared = (error: unknown): error is Undeclared =>
  HttpClientError.isHttpClientError(error) ||
  Schema.isSchemaError(error) ||
  Schema.is(Action.BuiltIn)(error);

const fromUndeclared = (
  error: Undeclared,
  context: CallContext
): Invalid | Unavailable | Internal =>
  Match.valueTags(error, {
    HttpClientError: (failure) =>
      Match.value(failure.reason).pipe(
        Match.tag("TransportError", () =>
          unanswered(context, causeDetail(failure))
        ),
        Match.when(
          {
            _tag: "DecodeError",
            cause: (cause: unknown) =>
              cause !== undefined && !(cause instanceof SyntaxError),
          },
          () => unanswered(context, causeDetail(failure))
        ),
        Match.orElse(() => unexpected(context, failure))
      ),
    InvalidInput: ({ message }) =>
      new Invalid({
        message: `${context.what}: the request doesn't match the action's input: ${message}`,
      }),
    SchemaError: ({ message }) =>
      new Internal({
        message: `the control plane's reply didn't decode: ${message}`,
      }),
    Unauthenticated: (failure) => unexpected(context, failure),
    Forbidden: (failure) => unexpected(context, failure),
  });

const settle = <A, E>(
  call: Effect.Effect<A, E | Undeclared>,
  context: CallContext
): Effect.Effect<A, E | Invalid | Unavailable | Internal> =>
  call.pipe(
    Effect.timeoutOrElse({
      duration: context.timeout,
      orElse: () =>
        Effect.fail(
          unanswered(
            context,
            `timed out after ${Duration.format(context.timeout)}`
          )
        ),
    }),
    Effect.catchIf(isUndeclared, (error) =>
      Effect.fail(fromUndeclared(error, context))
    )
  );

const deleting = (removal: Effect.Effect<void, ClankerboxError>) =>
  removal.pipe(
    Effect.as<Deleted>("deleted"),
    Effect.catchTag("NotFound", () => Effect.succeed<Deleted>("absent"))
  );

const making =
  (name: string) =>
  (error: ClankerboxError): ClankerboxError =>
    error.located({ made: name });

const unlessGone = <A>(read: Effect.Effect<A, ClankerboxError>) =>
  read.pipe(
    Effect.asSome,
    Effect.catchTag("NotFound", () => Effect.succeed(Option.none<A>()))
  );

const decodeUrl = Schema.decodeUnknownEffect(ServerUrl);

const defaultPoll = Duration.millis(250);

const outageLimit = Duration.minutes(2);

const saved = (subject: string, why: string): Unavailable =>
  new Unavailable({
    message: `${why}; the request is saved, and acts on the server: read ${subject} to see`,
    readOnly: false,
  });

type Verdict<A> = Option.Option<Effect.Effect<A, ClankerboxError>>;

/** What a wait on a machine waits for: a wish, or a resize, which any wish but a delete lets run first. */
export type Asked = Machine["desired"] | "resize";

const awaited = (asked: Asked): string =>
  asked === "resize" ? "its resize rested" : `it got to ${asked}`;

/** What a machine's rest says of a request. */
export const answerOf = (
  machine: Machine,
  asked: Asked
): Effect.Effect<Machine, ClankerboxError> => {
  const { id, desired, phase, error } = machine;
  const kept = asked === "resize" ? desired !== "deleted" : desired === asked;

  if (!kept) {
    return Effect.fail(
      new Superseded({
        message: `a later request asked machine ${id} to be ${desired} before ${awaited(asked)}`,
        by: desired,
      })
    );
  }

  if (phase === "failed") {
    return Effect.fail(
      error ?? new Internal({ message: `machine ${id} failed, saying nothing` })
    );
  }

  if (phase === "lost") {
    return Effect.fail(
      new Missing({
        message: `machine ${id} is missing from the ${machine.kind} runtime; delete it`,
        machine: id,
      })
    );
  }

  return Effect.succeed(machine);
};

const heard = (machine: Machine): Effect.Effect<Machine, Unavailable> =>
  machine.phase === "waiting"
    ? Effect.fail(
        new Unavailable({
          message: `machine ${machine.id}'s host can't be reached`,
          readOnly: true,
        })
      )
    : Effect.succeed(machine);

const machineGone = (machine: Machine): Verdict<void> => {
  if (machine.desired !== "deleted") {
    return Option.some(Effect.void);
  }

  return machine.phase === "failed"
    ? Option.some(
        Effect.fail(
          machine.error ??
            new Internal({
              message: `machine ${machine.id}'s delete failed, saying nothing`,
            })
        )
      )
    : Option.none();
};

const checkpointGone = (checkpoint: Checkpoint): Verdict<void> => {
  const capturedAgain = checkpoint.phase !== "deleting";

  if (capturedAgain) {
    return Option.some(Effect.void);
  }

  return checkpoint.error === undefined
    ? Option.none()
    : Option.some(Effect.fail(checkpoint.error));
};

const endedAt =
  <R extends Checkpoint | Build>(end: R["phase"], what: string) =>
  (row: R): Verdict<R> => {
    if (row.phase === end) {
      return Option.some(Effect.succeed(row));
    }

    return row.phase === "failed"
      ? Option.some(
          Effect.fail(
            row.error ??
              new Internal({
                message: `${what} ${row.id} failed, saying nothing`,
              })
          )
        )
      : Option.none();
  };

/** A client of the control plane at `url`. It sends nothing until called. */
export const make = (
  url: string,
  options?: Options
): Effect.Effect<Interface, Invalid, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    yield* decodeUrl(url).pipe(
      Effect.mapError(
        (error) =>
          new Invalid({ message: `the server URL: ${describeIssues(error)}` })
      )
    );

    const api: ServerApi = yield* serverApi(url);
    const methods: Methods = api;
    const pollEvery = options?.pollEvery ?? defaultPoll;
    const noWait = options?.noWait === true;

    const call = <N extends ServerAction>(
      name: N,
      input: Input<N>,
      subject?: string,
      made?: string
    ): Effect.Effect<Success<N>, ErrorOf<N>> =>
      settle(methods[name](input), {
        url,
        timeout: options?.replyTimeout ?? replyTimeout,
        readOnly: actions[name].readOnly,
        what: subject === undefined ? name : `${name} ${subject}`,
        target: made ?? subject,
      });

    const send = <N extends ServerAction>(
      name: N,
      input: Input<N>,
      subject?: string,
      made?: string
    ): Effect.Effect<Success<N>, ErrorOf<N>> =>
      call(name, input, subject, made).pipe(
        Effect.mapError((error) =>
          error.located({ action: name, id: subject, made })
        )
      );

    const bounded = <A, E>(
      wait: Effect.Effect<A, E>,
      subject: string
    ): Effect.Effect<A, E | Unavailable> => {
      const { timeout } = options ?? {};

      return timeout === undefined
        ? wait
        : Effect.timeoutOrElse(wait, {
            duration: timeout,
            orElse: () =>
              Effect.fail(
                saved(
                  subject,
                  `${subject} didn't rest within ${Duration.format(timeout)}`
                )
              ),
          });
    };

    const polled = <A, B>(
      read: Effect.Effect<A, ClankerboxError>,
      verdict: (value: A) => Verdict<B>,
      action: ServerAction,
      subject: string
    ): Effect.Effect<B, ClankerboxError> => {
      const looked: Effect.Effect<B, ClankerboxError> = read.pipe(
        Effect.retry({
          while: ({ _tag }) => _tag === "Unavailable",
          schedule: Schedule.spaced(pollEvery).pipe(
            Schedule.while(
              ({ elapsed }) => elapsed < Duration.toMillis(outageLimit)
            )
          ),
        }),
        Effect.catchTag("Unavailable", ({ message }) =>
          Effect.fail(saved(subject, message))
        ),
        Effect.flatMap((value) =>
          Option.getOrElse(verdict(value), () =>
            Effect.andThen(Effect.sleep(pollEvery), looked)
          )
        )
      );

      return bounded(looked, subject).pipe(
        Effect.mapError((error) => error.located({ action, id: subject }))
      );
    };

    const unlessNoWait = <A>(
      recorded: A,
      wait: Effect.Effect<A, ClankerboxError>
    ): Effect.Effect<A, ClankerboxError> =>
      noWait ? Effect.succeed(recorded) : wait;

    const machineRest = (
      recorded: Machine,
      asked: Asked,
      action: ServerAction
    ): Effect.Effect<Machine, ClankerboxError> => {
      const { id, createdAt } = recorded;

      if (recorded.desired === "deleted") {
        return answerOf(recorded, asked);
      }

      return unlessNoWait(
        recorded,
        polled(
          call("getMachine", { id }, id).pipe(
            Effect.catchTag("NotFound", () =>
              Effect.fail(
                new Superseded({
                  message: `machine ${id} was deleted before ${awaited(asked)}`,
                  by: "deleted",
                })
              )
            ),
            Effect.filterOrFail(
              (machine) => DateTime.Equivalence(machine.createdAt, createdAt),
              () =>
                new Superseded({
                  message: `machine ${id} was deleted and made again before ${awaited(asked)}`,
                  by: "deleted",
                })
            ),
            Effect.flatMap(heard)
          ),
          (machine) =>
            isResting(machine.phase)
              ? Option.some(answerOf(machine, asked))
              : Option.none(),
          action,
          id
        )
      );
    };

    const asking =
      (
        name: "startMachine" | "stopMachine" | "pauseMachine",
        desired: Machine["desired"]
      ) =>
      (input: Input<"startMachine">) =>
        Effect.flatMap(send(name, input, input.id), (recorded) =>
          machineRest(recorded, desired, name)
        );

    const create: Interface["create"] = (name, spec, placement) =>
      send(
        "createMachine",
        {
          ...spec,
          id: name,
          ...(placement?.fresh === true ? { fresh: true } : {}),
        },
        name,
        name
      ).pipe(
        Effect.flatMap((recorded) =>
          machineRest(recorded, "running", "createMachine")
        ),
        Effect.mapError(making(name))
      );

    return {
      hosts: send("listHosts", {}),
      machines: send("listMachines", {}),
      checkpoints: send("listCheckpoints", {}),
      capacity: send("getCapacity", {}),
      getMachine: (input) => send("getMachine", input, input.id),
      getCheckpoint: (input) => send("getCheckpoint", input, input.id),
      getPrebuild: (input) => send("getPrebuild", input, input.id),
      create,
      startMachine: asking("startMachine", "running"),
      stopMachine: asking("stopMachine", "stopped"),
      pauseMachine: asking("pauseMachine", "paused"),
      resizeMachine: (input) =>
        Effect.flatMap(send("resizeMachine", input, input.id), (recorded) =>
          machineRest(recorded, "resize", "resizeMachine")
        ),
      forkMachine: (input) =>
        Effect.flatMap(
          send("forkMachine", input, input.machine, input.name),
          (recorded) => machineRest(recorded, "running", "forkMachine")
        ).pipe(Effect.mapError(making(input.name))),
      restoreMachine: (input) =>
        Effect.flatMap(
          send("restoreMachine", input, input.checkpoint, input.name),
          (recorded) => machineRest(recorded, "running", "restoreMachine")
        ).pipe(Effect.mapError(making(input.name))),
      captureCheckpoint: (input) =>
        Effect.flatMap(
          send("captureCheckpoint", input, input.machine, input.name),
          (recorded) =>
            unlessNoWait(
              recorded,
              polled(
                call("getCheckpoint", { id: recorded.id }, recorded.id),
                endedAt<Checkpoint>("ready", "checkpoint"),
                "captureCheckpoint",
                recorded.id
              )
            )
        ).pipe(Effect.mapError(making(input.name))),
      prebuild: (spec) =>
        Effect.flatMap(send("prebuildCheckpoint", spec), (recorded) =>
          unlessNoWait(
            recorded,
            polled(
              call("getPrebuild", { id: recorded.id }, recorded.id),
              endedAt<Build>("built", "prebuild"),
              "prebuildCheckpoint",
              recorded.id
            )
          )
        ),
      deleteMachine: ({ id }) =>
        deleting(
          Effect.andThen(
            send("deleteMachine", { id }, id),
            unlessNoWait(
              undefined,
              polled(
                unlessGone(
                  call("getMachine", { id }, id).pipe(
                    Effect.filterOrElse(
                      (machine) => machine.desired !== "deleted",
                      heard
                    )
                  )
                ),
                Option.match({
                  onNone: () => Option.some(Effect.void),
                  onSome: machineGone,
                }),
                "deleteMachine",
                id
              )
            )
          )
        ),
      deleteCheckpoint: ({ id }) =>
        deleting(
          Effect.andThen(
            send("deleteCheckpoint", { id }, id),
            unlessNoWait(
              undefined,
              polled(
                unlessGone(call("getCheckpoint", { id }, id)),
                Option.match({
                  onNone: () => Option.some(Effect.void),
                  onSome: checkpointGone,
                }),
                "deleteCheckpoint",
                id
              )
            )
          )
        ),
    } satisfies Interface;
  });

export const layer = (
  url: string,
  options?: Options
): Layer.Layer<Client, Invalid, HttpClient.HttpClient> =>
  Layer.effect(Client, make(url, options));
