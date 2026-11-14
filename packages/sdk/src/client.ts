import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import {
  Clock,
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

import {
  actionsByName as actions,
  Http,
  longestHold,
  replyTimeout,
} from "./api.ts";
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
import { isResting, isUndone } from "./resources.ts";
import type {
  Build,
  BuildRequest,
  CapacityReport,
  Checkpoint,
  Executed,
  Host,
  Labels,
  ListFilter,
  Machine,
  MachineSpec,
  Sizing,
  Template,
} from "./resources.ts";

const ServerUrl = Schema.String.check(
  Schema.makeFilter(
    (url: string) => URL.canParse(url) || "a URL, such as http://cbx:8484"
  )
);

type Actions = typeof actions;

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
   * How long a mutation may take, its reply and its wait for its machine, checkpoint or build to
   * rest together, unbounded by default, as a template's build can take hours. One that outlasts it
   * fails `Unavailable`: one whose reply hadn't come may have run, and one whose wait it cut is saved
   * and still acts on the server. A read made on its own, and an exec, which has its own, take the
   * reply timeout alone.
   */
  readonly timeout?: Duration.Duration | undefined;
  /** How long any call waits for the control plane's reply, `replyTimeout` by default. */
  readonly replyTimeout?: Duration.Duration | undefined;
  /** Answer a mutation as soon as the server has recorded it, instead of waiting for its rest. */
  readonly noWait?: boolean | undefined;
  /**
   * How long a wait sleeps between reads, 250 ms by default, but for a wait on a machine, whose reads
   * the control plane holds, which reads again as soon as one answers.
   */
  readonly pollEvery?: Duration.Duration | undefined;
}

/** A delete of a resource that is already gone is `absent`: done either way. */
export type Deleted = "deleted" | "absent";

export interface CreateOptions {
  readonly labels?: Labels | undefined;
}

/**
 * What `ensure` makes a machine from when none of its name exists: the `checkpoint` when one of
 * that name is ready, at `sizing` or the checkpoint's, else `spec`, as `create` would.
 */
export interface EnsureOptions extends CreateOptions {
  readonly spec: MachineSpec;
  readonly checkpoint?: string | undefined;
  readonly sizing?: Sizing | undefined;
}

type Reads = "getMachine" | "getCheckpoint" | "getTemplate";

type Lists = "listMachines" | "listCheckpoints";

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
  readonly [N in Lists]: (
    filter?: ListFilter
  ) => Effect.Effect<Success<N>, ErrorOf<N>>;
} & {
  readonly [N in Waits]: (
    input: Input<N>
  ) => Effect.Effect<Success<N>, WaitErrorOf<N>>;
};

/** What `ensure` fails with: what making the machine or starting it does. */
export type EnsureError =
  | WaitErrorOf<"createMachine">
  | WaitErrorOf<"restoreMachine">
  | WaitErrorOf<"startMachine">
  | WaitErrorOf<"deleteMachine">;

export interface Interface extends Calls {
  readonly hosts: Effect.Effect<readonly Host[], ErrorOf<"listHosts">>;
  readonly capacity: Effect.Effect<CapacityReport, ErrorOf<"getCapacity">>;
  readonly templates: Effect.Effect<
    readonly Template[],
    ErrorOf<"listTemplates">
  >;
  /** `createMachine`, then waits for the machine to rest. */
  readonly create: (
    name: string,
    spec: MachineSpec,
    options?: CreateOptions
  ) => Effect.Effect<Machine, WaitErrorOf<"createMachine">>;
  /**
   * A machine of `name` that runs: the one that exists, started, or resumed when paused; else one
   * restored from `checkpoint` when that is ready; else one created from `spec`. Each waits as the
   * request would. A failed create's row that still answers `Conflict`, as its VM is still going,
   * is deleted and the make tried once more, and a make whose reply or wait was cut reads the
   * machine and decides again, once. Every failure after that make names the machine it may have
   * made, and one whose second look sent nothing, as a spent timeout leaves it, answers as the cut
   * make did.
   */
  readonly ensure: (
    name: string,
    options: EnsureOptions
  ) => Effect.Effect<Machine, EnsureError>;
  /**
   * `execMachine`, waiting `timeoutSeconds` and the reply timeout for the answer, or for as long as
   * the command runs when there is none.
   */
  readonly execMachine: (
    input: Input<"execMachine">
  ) => Effect.Effect<Executed, ErrorOf<"execMachine">>;
  /** `buildTemplate`, then waits for the build to end, reading its template. */
  readonly buildTemplate: (
    input: BuildRequest
  ) => Effect.Effect<Build, WaitErrorOf<"buildTemplate">>;
  readonly deleteTemplate: (
    input: Input<"deleteTemplate">
  ) => Effect.Effect<Deleted, WaitErrorOf<"deleteTemplate">>;
  readonly deleteMachine: (
    input: Input<"deleteMachine">
  ) => Effect.Effect<Deleted, WaitErrorOf<"deleteMachine">>;
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
  readonly timedOut: string;
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

const cutByStopOrProxy: ReadonlySet<number> = new Set([502, 503, 504]);

const isUndeclared = (error: unknown): error is Undeclared =>
  HttpClientError.isHttpClientError(error) ||
  Schema.isSchemaError(error) ||
  Schema.is(Action.BuiltIn)(error);

const fromHttp = (
  failure: HttpClientError.HttpClientError,
  context: CallContext
): Unavailable | Internal => {
  const status = failure.response?.status;

  if (status !== undefined && cutByStopOrProxy.has(status)) {
    return unanswered(context, `HTTP ${status}`);
  }

  return Match.value(failure.reason).pipe(
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
  );
};

const fromUndeclared = (
  error: Undeclared,
  context: CallContext
): Invalid | Unavailable | Internal =>
  Match.valueTags(error, {
    HttpClientError: (failure) => fromHttp(failure, context),
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
      orElse: () => Effect.fail(unanswered(context, context.timedOut)),
    }),
    Effect.catchDefect((defect) =>
      HttpClientError.isHttpClientError(defect)
        ? Effect.fail(defect)
        : Effect.die(defect)
    ),
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

const mayHaveRun = (error: ClankerboxError): boolean =>
  error._tag === "Unavailable" && !error.readOnly;

const namingWhatMayExist = <
  A,
  B,
  E1 extends ClankerboxError,
  E2 extends ClankerboxError,
>(
  made: string,
  sent: Effect.Effect<A, E1>,
  waited: (recorded: A) => Effect.Effect<B, E2>
): Effect.Effect<B, ClankerboxError> =>
  Effect.flatMap(
    Effect.mapError(sent, (error) =>
      mayHaveRun(error) ? making(made)(error) : error
    ),
    (recorded) => Effect.mapError(waited(recorded), making(made))
  );

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
        message: `machine ${id} is missing from the ${machine.runtime} runtime; delete it`,
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

const builtAt =
  (id: string) =>
  (template: Template): Verdict<Build> => {
    const build = template.builds.find((each) => each.id === id);

    return build === undefined
      ? Option.some(
          Effect.fail(
            new Internal({
              message: `build ${id} is gone from template ${template.id}`,
            })
          )
        )
      : endedAt<Build>("ready", "build")(build);
  };

interface MutationDeadline {
  readonly atMillis: number;
  readonly timeout: Duration.Duration;
}

const mutationDeadline = Context.Reference<MutationDeadline | undefined>(
  "@gjermundgaraba/clankerbox-sdk/Client/mutationDeadline",
  { defaultValue: () => undefined }
);

const timeLeft = Effect.gen(function* () {
  const deadline = yield* mutationDeadline;

  if (deadline === undefined) {
    return undefined;
  }

  const now = yield* Clock.currentTimeMillis;

  return {
    left: Duration.millis(Math.max(0, deadline.atMillis - now)),
    timeout: deadline.timeout,
  };
});

const bounded = <A, E>(
  wait: Effect.Effect<A, E>,
  subject: string
): Effect.Effect<A, E | Unavailable> =>
  Effect.flatMap(timeLeft, (deadline) =>
    deadline === undefined
      ? wait
      : Effect.timeoutOrElse(wait, {
          duration: deadline.left,
          orElse: () =>
            Effect.fail(
              saved(
                subject,
                `${subject} didn't rest within ${Duration.format(deadline.timeout)}`
              )
            ),
        })
  );

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

    const reply = options?.replyTimeout ?? replyTimeout;

    const call = <N extends ServerAction>(
      name: N,
      input: Input<N>,
      subject?: string,
      made?: string,
      timeout: Duration.Duration = reply
    ): Effect.Effect<Success<N>, ErrorOf<N>> =>
      Effect.flatMap(timeLeft, (deadline) => {
        const cut =
          deadline !== undefined && Duration.isLessThan(deadline.left, timeout);

        return settle(methods[name](input), {
          url,
          timeout: cut ? deadline.left : timeout,
          timedOut: cut
            ? `its timeout of ${Duration.format(deadline.timeout)} ran out`
            : `timed out after ${Duration.format(timeout)}`,
          readOnly: actions[name].readOnly,
          what: subject === undefined ? name : `${name} ${subject}`,
          target: made ?? subject,
        });
      });

    const send = <N extends ServerAction>(
      name: N,
      input: Input<N>,
      subject?: string,
      made?: string,
      timeout?: Duration.Duration
    ): Effect.Effect<Success<N>, ErrorOf<N>> =>
      call(name, input, subject, made, timeout).pipe(
        Effect.mapError((error) => error.located({ action: name, id: subject }))
      );

    const deadlined = <A, E>(
      mutation: Effect.Effect<A, E>
    ): Effect.Effect<A, E> => {
      const timeout = options?.timeout;

      return timeout === undefined
        ? mutation
        : Effect.flatMap(mutationDeadline, (set) =>
            set === undefined
              ? Effect.flatMap(Clock.currentTimeMillis, (now) =>
                  Effect.provideService(mutation, mutationDeadline, {
                    atMillis: now + Duration.toMillis(timeout),
                    timeout,
                  })
                )
              : mutation
          );
    };

    const bounding =
      <Args extends readonly unknown[], A, E>(
        mutation: (...args: Args) => Effect.Effect<A, E>
      ) =>
      (...args: Args): Effect.Effect<A, E> =>
        deadlined(mutation(...args));

    const polled = <A, B>(
      read: Effect.Effect<A, ClankerboxError>,
      verdict: (value: A) => Verdict<B>,
      action: ServerAction,
      subject: string,
      between: Effect.Effect<void> = Effect.sleep(pollEvery)
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
            Effect.andThen(between, looked)
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

    const machineRead = (id: string) =>
      call(
        "getMachine",
        { id, holdSeconds: Duration.toSeconds(longestHold) },
        id,
        undefined,
        Duration.sum(longestHold, reply)
      );

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
          machineRead(id).pipe(
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
          id,
          Effect.void
        )
      );
    };

    const asking =
      <N extends "startMachine" | "stopMachine" | "pauseMachine">(
        name: N,
        desired: Machine["desired"]
      ) =>
      (input: Input<N>) =>
        Effect.flatMap(send(name, input, input.id), (recorded) =>
          machineRest(recorded, desired, name)
        );

    const create: Interface["create"] = (name, spec, { labels } = {}) =>
      namingWhatMayExist(
        name,
        send(
          "createMachine",
          {
            ...spec,
            id: name,
            ...(labels === undefined ? {} : { labels }),
          },
          name,
          name
        ),
        (recorded) => machineRest(recorded, "running", "createMachine")
      );

    const startMachine = asking("startMachine", "running");

    const restoreMachine: Interface["restoreMachine"] = (input) =>
      namingWhatMayExist(
        input.name,
        send("restoreMachine", input, input.checkpoint, input.name),
        (recorded) => machineRest(recorded, "running", "restoreMachine")
      );

    const deleteMachine: Interface["deleteMachine"] = ({ id }) =>
      deleting(
        Effect.andThen(
          send("deleteMachine", { id }, id),
          unlessNoWait(
            undefined,
            polled(
              unlessGone(
                machineRead(id).pipe(
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
              id,
              Effect.void
            )
          )
        )
      );

    const madeFrom = (
      name: string,
      { checkpoint, spec, sizing, labels }: EnsureOptions
    ): Effect.Effect<Machine, EnsureError> =>
      Effect.gen(function* () {
        const ready =
          checkpoint === undefined
            ? false
            : yield* call("getCheckpoint", { id: checkpoint }, checkpoint).pipe(
                Effect.map(({ phase }) => phase === "ready"),
                Effect.catchTag("NotFound", () => Effect.succeed(false))
              );

        return ready && checkpoint !== undefined
          ? yield* restoreMachine({
              checkpoint,
              name,
              ...sizing,
              ...(labels === undefined ? {} : { labels }),
            })
          : yield* create(name, spec, { labels });
      });

    const ensuring = (
      name: string,
      from: EnsureOptions,
      again: boolean
    ): Effect.Effect<Machine, EnsureError> =>
      Effect.gen(function* () {
        const found = yield* call("getMachine", { id: name }, name).pipe(
          Effect.asSome,
          Effect.catchTag("NotFound", () => Effect.succeedNone)
        );

        if (Option.isSome(found) && !isUndone(found.value)) {
          return yield* startMachine({ id: name });
        }

        return yield* madeFrom(name, from).pipe(
          Effect.catchTags({
            Conflict: (conflict) =>
              again
                ? Effect.andThen(
                    deleteMachine({ id: name }),
                    ensuring(name, from, false)
                  )
                : Effect.fail(conflict),
            Unavailable: (unavailable) =>
              again && !unavailable.readOnly
                ? ensuring(name, from, false).pipe(
                    Effect.catchIf(
                      (error) => error._tag === "Unavailable" && error.readOnly,
                      () => Effect.fail(unavailable)
                    ),
                    Effect.mapError(making(name))
                  )
                : Effect.fail(unavailable),
          })
        );
      });

    const pauseMachine: Interface["pauseMachine"] = (input) => {
      const { capture } = input;

      return capture === undefined
        ? asking("pauseMachine", "paused")(input)
        : namingWhatMayExist(
            capture.name,
            send("pauseMachine", input, input.id),
            (recorded) =>
              Effect.flatMap(
                machineRest(recorded, "paused", "pauseMachine"),
                (machine) =>
                  unlessNoWait(
                    machine,
                    Effect.as(
                      polled(
                        call(
                          "getCheckpoint",
                          { id: capture.name },
                          capture.name
                        ),
                        endedAt<Checkpoint>("ready", "checkpoint"),
                        "pauseMachine",
                        capture.name
                      ),
                      machine
                    )
                  )
              )
          );
    };

    const execMachine: Interface["execMachine"] = (input) =>
      send(
        "execMachine",
        input,
        input.id,
        undefined,
        input.timeoutSeconds === undefined
          ? Duration.infinity
          : Duration.sum(Duration.seconds(input.timeoutSeconds), reply)
      );

    return {
      hosts: send("listHosts", {}),
      listMachines: (filter) => send("listMachines", filter ?? {}),
      listCheckpoints: (filter) => send("listCheckpoints", filter ?? {}),
      capacity: send("getCapacity", {}),
      templates: send("listTemplates", {}),
      getMachine: (input) => send("getMachine", input, input.id),
      getCheckpoint: (input) => send("getCheckpoint", input, input.id),
      getTemplate: (input) => send("getTemplate", input, input.id),
      execMachine,
      create: bounding(create),
      ensure: bounding((name, from) => ensuring(name, from, true)),
      startMachine: bounding(startMachine),
      stopMachine: bounding(asking("stopMachine", "stopped")),
      pauseMachine: bounding(pauseMachine),
      resizeMachine: bounding((input) =>
        Effect.flatMap(send("resizeMachine", input, input.id), (recorded) =>
          machineRest(recorded, "resize", "resizeMachine")
        )
      ),
      forkMachine: bounding((input) =>
        namingWhatMayExist(
          input.name,
          send("forkMachine", input, input.machine, input.name),
          (recorded) => machineRest(recorded, "running", "forkMachine")
        )
      ),
      restoreMachine: bounding(restoreMachine),
      captureCheckpoint: bounding((input) =>
        namingWhatMayExist(
          input.name,
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
        )
      ),
      buildTemplate: bounding((input) =>
        Effect.flatMap(
          send("buildTemplate", input, input.template),
          (recorded) =>
            unlessNoWait(
              recorded,
              polled(
                call("getTemplate", { id: input.template }, input.template),
                builtAt(recorded.id),
                "buildTemplate",
                recorded.id
              )
            )
        )
      ),
      deleteTemplate: bounding(({ id }) =>
        deleting(send("deleteTemplate", { id }, id))
      ),
      deleteMachine: bounding(deleteMachine),
      deleteCheckpoint: bounding(({ id }) =>
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
        )
      ),
    } satisfies Interface;
  });

export const layer = (
  url: string,
  options?: Options
): Layer.Layer<Client, Invalid, HttpClient.HttpClient> =>
  Layer.effect(Client, make(url, options));
