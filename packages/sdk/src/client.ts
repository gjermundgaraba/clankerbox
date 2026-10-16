import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import {
  Context,
  Duration,
  Effect,
  Fiber,
  Layer,
  Match,
  Predicate,
  Record,
  Result,
  Schema,
} from "effect";
import { HttpClient, type HttpClientError, HttpClientRequest } from "effect/http";
import { actionsByName as actions, type Declared, Http, readTimeout } from "./api.ts";
import {
  ClankerboxError,
  Internal,
  Invalid,
  type NotFound,
  NotOffered,
  Unavailable,
} from "./errors.ts";
import { formatId, HostId, parseId, parseName } from "./ids.ts";
import { version, versionHeader } from "./release.ts";
import type { Checkpoint, Host, Machine, MachineSpec, Usage } from "./resources.ts";
import { describeIssues } from "./describe.ts";

/** `id` is the host part of every ID the host holds. */
export const HostEntry = Schema.Struct({
  id: HostId,
  url: Schema.String.check(
    Schema.makeFilter((url: string) => URL.canParse(url) || "a URL, such as http://linux:8484"),
  ),
});

export type HostEntry = typeof HostEntry.Type;

type Actions = typeof actions;

/** An action of the host API, by name. */
export type HostAction = keyof Actions;

/**
 * What a call of `N` fails with: an error the action declares, which always includes `Invalid`,
 * or no reply, or a reply the client couldn't use.
 */
export type ErrorOf<N extends HostAction> = Declared<N> | Unavailable | Internal;

type Success<N extends HostAction> = Actions[N]["success"]["Type"];

type Input<N extends HostAction> = Actions[N]["input"]["Type"];

export interface Unreachable {
  readonly host: string;
  readonly error: ClankerboxError;
}

/** A fan-out's result: a host that fails is named, and fails nothing else. */
export interface Gathered<A> {
  readonly answers: ReadonlyArray<A>;
  readonly unreachable: ReadonlyArray<Unreachable>;
}

export interface Options {
  /**
   * The wait for a mutation's reply, unbounded by default, as a create's setup can take hours.
   * It ends only the wait: a mutation that outlasts it fails like a lost reply.
   */
  readonly timeout?: Duration.Duration | undefined;
  /** The wait for a read's reply, `readTimeout` by default; a fan-out bounds each host's own. */
  readonly readTimeout?: Duration.Duration | undefined;
}

/** A delete of a resource that is already gone is `absent`: done either way. */
export type Deleted = "deleted" | "absent";

export interface CreateOptions {
  /** The host to create on, instead of the first that offers the base. */
  readonly host?: string | undefined;
}

/** The resource an input names, whose host the call goes to. */
type Subject =
  | { readonly id: string }
  | { readonly machine: string }
  | { readonly checkpoint: string };

/** The actions on one resource, which the client sends to its host. */
export type Routed = {
  readonly [N in HostAction]: Input<N> extends Subject ? N : never;
}[HostAction];

/**
 * One method per action on a resource, named and typed as in the contract, but for `create` and
 * the deletes. A create, fork, restore or capture's errors carry `made`, the resource it makes, so
 * a caller whose answer was lost can find what it left behind.
 */
export type Calls = {
  readonly [N in Exclude<Routed, "createMachine" | "deleteMachine" | "deleteCheckpoint">]: (
    input: Input<N>,
  ) => Effect.Effect<Success<N>, ErrorOf<N>>;
};

export interface Interface extends Calls {
  readonly hosts: Effect.Effect<Gathered<Host>>;
  readonly machines: Effect.Effect<Gathered<Machine>>;
  readonly checkpoints: Effect.Effect<Gathered<Checkpoint>>;
  /** A host whose runtime couldn't be read is among the unreachable. */
  readonly capacity: Effect.Effect<Gathered<Usage>>;
  /**
   * The host a create of `base` goes to, read even when `options.host` names it: the first in
   * list order that offers it. With none, it is `Unavailable` if a host gave no reply, and
   * `NotOffered` otherwise.
   */
  readonly place: (
    base: string,
    options?: CreateOptions,
  ) => Effect.Effect<Host, ErrorOf<"getHost"> | NotOffered>;
  /** `createMachine` on `options.host`, or else on the first host that offers the base. */
  readonly create: (
    name: string,
    spec: MachineSpec,
    options?: CreateOptions,
  ) => Effect.Effect<Machine, ErrorOf<"createMachine">>;
  /** A delete of a resource that is already gone is `absent`: done either way. */
  readonly deleteMachine: (
    input: Input<"deleteMachine">,
  ) => Effect.Effect<Deleted, Exclude<ErrorOf<"deleteMachine">, NotFound>>;
  /** A delete of a checkpoint that is already gone is `absent`: done either way. */
  readonly deleteCheckpoint: (
    input: Input<"deleteCheckpoint">,
  ) => Effect.Effect<Deleted, Exclude<ErrorOf<"deleteCheckpoint">, NotFound>>;
}

/**
 * Nothing retries: a mutation whose reply is lost or times out is `Unavailable`, and the caller
 * reads the resource to see what happened.
 */
export class Client extends Context.Service<Client, Interface>()(
  "@gjermundgaraba/clankerbox-sdk/Client",
) {}

const hostApi = (entry: HostEntry) =>
  ActionHttp.client(Http, {
    baseUrl: entry.url,
    transformClient: HttpClient.mapRequest(HttpClientRequest.setHeader(versionHeader, version)),
  });

type HostApi = Effect.Success<ReturnType<typeof hostApi>>;

type CallError = ActionHttp.MethodError<Actions[HostAction]>;

/** `HostApi` as one call per name, which a generic name can index. */
type Methods = {
  readonly [N in HostAction]: (input: Input<N>) => Effect.Effect<Success<N>, CallError>;
};

interface Route {
  readonly entry: HostEntry;
  readonly api: HostApi;
}

interface CallContext {
  readonly host: HostEntry;
  readonly timeout: Duration.Duration | undefined;
  readonly readOnly: boolean;
  /** The action and the ID it was given, as messages name the call. */
  readonly what: string;
  /** What a lost mutation's reply tells the caller to read. */
  readonly target: string | undefined;
}

const causeDetail = (error: HttpClientError.HttpClientError): string =>
  error.cause instanceof Error ? error.cause.message : error.message;

const unanswered = (context: CallContext, detail: string): Unavailable =>
  context.readOnly
    ? new Unavailable({
        message: `host ${context.host.id} (${context.host.url}) didn't answer ${context.what}: ${detail}`,
        readOnly: true,
      })
    : new Unavailable({
        message: `no reply from host ${context.host.id} to ${context.what} (${detail}); the action may have run: read ${context.target ?? "the resource"} to see`,
        readOnly: false,
      });

const bounded = <A>(
  call: Effect.Effect<A, CallError>,
  context: CallContext,
): Effect.Effect<A, CallError | Unavailable> => {
  const { timeout } = context;

  return timeout === undefined
    ? call
    : Effect.timeoutOrElse(call, {
        duration: timeout,
        orElse: () =>
          Effect.fail(unanswered(context, `timed out after ${Duration.format(timeout)}`)),
      });
};

const unexpected = (context: CallContext, error: { readonly message: string }): Internal =>
  new Internal({
    message: `host ${context.host.id} answered ${context.what} unexpectedly: ${error.message}`,
  });

const settle = <A>(
  call: Effect.Effect<A, CallError>,
  context: CallContext,
): Effect.Effect<A, ClankerboxError> =>
  bounded(call, context).pipe(
    Effect.catchTags({
      HttpClientError: (error) =>
        Effect.fail(
          Match.value(error.reason).pipe(
            Match.tag("TransportError", () => unanswered(context, causeDetail(error))),
            Match.when(
              {
                _tag: "DecodeError",
                cause: (cause: unknown) => cause !== undefined && !(cause instanceof SyntaxError),
              },
              () => unanswered(context, causeDetail(error)),
            ),
            Match.orElse(() => unexpected(context, error)),
          ),
        ),
      InvalidInput: (error) =>
        Effect.fail(
          new Invalid({
            message: `${context.what}: the request doesn't match the action's input: ${error.message}`,
          }),
        ),
      SchemaError: (error) =>
        Effect.fail(
          new Internal({
            message: `host ${context.host.id}'s reply didn't decode: ${error.message}`,
          }),
        ),
      Unauthenticated: (error) => Effect.fail(unexpected(context, error)),
      Forbidden: (error) => Effect.fail(unexpected(context, error)),
    }),
  );

interface Where {
  readonly action: HostAction;
  readonly host?: string | undefined;
  readonly id?: string | undefined;
  readonly made?: string | undefined;
}

const encodeError = Schema.encodeSync(ClankerboxError);

const decodeError = Schema.decodeSync(ClankerboxError);

const locate =
  ({ action, host, id, made }: Where) =>
  <E extends ClankerboxError>(error: E): E =>
    // SAFETY: decoding what the same union encoded rebuilds the error's own class.
    decodeError({
      ...Record.filter({ action, host, id, made }, Predicate.isNotUndefined),
      ...encodeError(error),
    }) as E;

const checkHost = (entry: HostEntry, host: Host): Effect.Effect<Host, Invalid> =>
  host.id === entry.id
    ? Effect.succeed(host)
    : Effect.fail(
        new Invalid({
          message: `host ${entry.id} (${entry.url}) calls itself ${host.id}; its entry in the host list must use that ID`,
        }),
      );

const decodeHosts = Schema.decodeUnknownEffect(Schema.Array(HostEntry));

const subjectOf = (input: Subject): string =>
  "id" in input ? input.id : "machine" in input ? input.machine : input.checkpoint;

/**
 * A client over `hosts`, in placement order. It sends nothing until called. An empty list, a
 * malformed entry or a host ID that appears twice is Invalid.
 */
export const make = (
  hosts: ReadonlyArray<HostEntry>,
  options?: Options,
): Effect.Effect<Interface, Invalid, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (hosts.length === 0) {
      return yield* new Invalid({ message: "the host list is empty: a client needs a host" });
    }

    yield* decodeHosts(hosts, { errors: "all" }).pipe(
      Effect.mapError((error) => new Invalid({ message: `host list: ${describeIssues(error)}` })),
    );

    const twice = hosts.find(
      ({ id }, index) => hosts.findIndex((other) => other.id === id) < index,
    );

    if (twice !== undefined) {
      return yield* new Invalid({ message: `host ${twice.id} appears twice in the host list` });
    }

    const routed: ReadonlyArray<Route> = yield* Effect.forEach(hosts, (entry) =>
      Effect.map(hostApi(entry), (api) => ({ entry, api })),
    );

    const routes = new Map(routed.map((route) => [route.entry.id, route]));

    const route = (host: string) => {
      const found = routes.get(host);

      return found === undefined
        ? Effect.fail(new Invalid({ message: `host ${host} isn't in the host list` }))
        : Effect.succeed(found);
    };

    const send = <N extends HostAction>(
      { entry, api }: Route,
      name: N,
      input: Input<N>,
      subject?: string,
      made?: string,
    ): Effect.Effect<Success<N>, ErrorOf<N>> => {
      const { readOnly } = actions[name];

      const methods: Methods = api;
      const method = methods[name];

      const settled = settle(method(input), {
        host: entry,
        timeout: readOnly ? (options?.readTimeout ?? readTimeout) : options?.timeout,
        readOnly,
        what: subject === undefined ? name : `${name} ${subject}`,
        target: made ?? subject,
      }).pipe(Effect.mapError(locate({ action: name, host: entry.id, id: subject, made })));

      // SAFETY: `settle` adds only `Unavailable`, `Internal` and `Invalid`, which every action declares.
      return settled as Effect.Effect<Success<N>, ErrorOf<N>>;
    };

    const naming =
      <N extends HostAction>(name: N) =>
      <A, E extends ClankerboxError>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
        Effect.mapError(effect, (error) =>
          error.action === undefined ? locate({ action: name })(error) : error,
        );

    const gather = <A>(
      call: (route: Route) => Effect.Effect<ReadonlyArray<A>, ClankerboxError>,
    ): Effect.Effect<Gathered<A>> =>
      Effect.forEach(
        routed,
        (route) =>
          Effect.map(Effect.result(call(route)), (result) => ({ host: route.entry.id, result })),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((results) => {
          const answers: Array<A> = [];
          const unreachable: Array<Unreachable> = [];

          for (const { host, result } of results) {
            if (Result.isSuccess(result)) {
              answers.push(...result.success);
            } else {
              unreachable.push({ host, error: result.failure });
            }
          }

          return { answers, unreachable };
        }),
      );

    const readHost = (route: Route) =>
      Effect.flatMap(send(route, "getHost", {}), (host) => checkHost(route.entry, host)).pipe(
        Effect.mapError(locate({ action: "getHost", host: route.entry.id })),
      );

    const onResource = <N extends Routed>(name: N, input: Input<N>, makes?: string) =>
      naming(name)(
        Effect.gen(function* () {
          const subject = subjectOf(input);
          const { host } = yield* parseId(subject);
          const made = makes === undefined ? undefined : yield* formatId(host, makes);

          return yield* send(yield* route(host), name, input, subject, made);
        }),
      );

    const createOn = (host: string, name: string, spec: MachineSpec) =>
      Effect.flatMap(formatId(host, name), (id) =>
        onResource("createMachine", { ...spec, id }, name),
      );

    const offering = (base: string) =>
      Effect.gen(function* () {
        const asked = yield* Effect.forEach(routed, (route) =>
          Effect.map(Effect.forkScoped(Effect.result(readHost(route))), (fiber) => ({
            host: route.entry.id,
            fiber,
          })),
        );

        const misses: Array<string> = [];
        let noReply = false;

        for (const { host, fiber } of asked) {
          const result = yield* Fiber.join(fiber);

          if (Result.isFailure(result)) {
            noReply ||= Predicate.isTagged(result.failure, "Unavailable");
            misses.push(`${host} failed: ${result.failure.message}`);
          } else if (result.success.bases.includes(base)) {
            return result.success;
          } else {
            const { bases } = result.success;

            misses.push(`${host} offers ${bases.length > 0 ? bases.join(", ") : "no bases"}`);
          }
        }

        const message = `no host offers base ${base}: ${misses.join("; ")}`;

        return yield* noReply
          ? new Unavailable({ message, readOnly: true })
          : new NotOffered({ message, base });
      }).pipe(Effect.scoped);

    const create = (name: string, spec: MachineSpec, options?: CreateOptions) =>
      Effect.gen(function* () {
        yield* parseName(name);

        if (options?.host !== undefined) {
          return yield* createOn(options.host, name, spec);
        }

        return yield* createOn((yield* offering(spec.base)).id, name, spec);
      });

    const place = (
      base: string,
      options?: CreateOptions,
    ): Effect.Effect<Host, ErrorOf<"getHost"> | NotOffered> =>
      options?.host === undefined ? offering(base) : Effect.flatMap(route(options.host), readHost);

    const deleting = <E extends { readonly _tag: string }>(
      removal: Effect.Effect<void, E | NotFound>,
    ) =>
      removal.pipe(
        Effect.as<Deleted>("deleted"),
        Effect.catchTag("NotFound", () => Effect.succeed<Deleted>("absent")),
      );

    return {
      hosts: gather((route) => Effect.map(readHost(route), (host) => [host])),
      machines: gather((route) => send(route, "listMachines", {})),
      checkpoints: gather((route) => send(route, "listCheckpoints", {})),
      capacity: gather((route) => send(route, "getCapacity", {})),
      place: (base, options) => naming("getHost")(place(base, options)),
      create: (name, spec, options) => naming("createMachine")(create(name, spec, options)),
      getMachine: (input) => onResource("getMachine", input),
      startMachine: (input) => onResource("startMachine", input),
      stopMachine: (input) => onResource("stopMachine", input),
      deleteMachine: (input) => deleting(onResource("deleteMachine", input)),
      forkMachine: (input) => onResource("forkMachine", input, input.name),
      restoreMachine: (input) => onResource("restoreMachine", input, input.name),
      getCheckpoint: (input) => onResource("getCheckpoint", input),
      captureCheckpoint: (input) => onResource("captureCheckpoint", input, input.name),
      deleteCheckpoint: (input) => deleting(onResource("deleteCheckpoint", input)),
    } satisfies Interface;
  });

export const layer = (
  hosts: ReadonlyArray<HostEntry>,
  options?: Options,
): Layer.Layer<Client, Invalid, HttpClient.HttpClient> =>
  Layer.effect(Client, make(hosts, options));
