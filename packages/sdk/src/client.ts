/**
 * The client library: a host list in placement order, routing by ID, list fan-out and
 * create placement. Nothing here retries: a mutation whose reply is lost, or that outlasts
 * the client's mutation timeout, is `Unavailable`, and the caller reads the resource to see
 * what happened.
 */
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Context, Duration, Effect, Fiber, Match, Predicate, Result, Schema } from "effect";
import { HttpClient, type HttpClientError, HttpClientRequest } from "effect/http";
import { Http, readTimeout, versionHeader } from "./api.ts";
import { type ClankerboxError, Internal, Invalid, Precondition, Unavailable } from "./errors.ts";
import { formatId, HostId, parseId, parseName } from "./ids.ts";
import {
  type Checkpoint,
  type Host,
  type Limit,
  type Machine,
  type MachineSpec,
  version,
} from "./resources.ts";

/** One host a client talks to. `id` is the host part of every ID it holds. */
export const HostEntry = Schema.Struct({
  id: HostId,
  url: Schema.String.check(
    Schema.makeFilter((url: string) => URL.canParse(url) || "a URL, such as http://linux:8484"),
  ),
});

export type HostEntry = typeof HostEntry.Type;

/** A host that didn't answer a fan-out, and why. */
export interface Unreachable {
  readonly host: string;
  readonly error: ClankerboxError;
}

/** What a fan-out gathered: every reachable host's answers, and the hosts that didn't answer. */
export interface Gathered<A> {
  readonly answers: ReadonlyArray<A>;
  readonly unreachable: ReadonlyArray<Unreachable>;
}

export interface Options {
  /**
   * How long to wait for a mutation's reply, unbounded by default: a create with a long setup
   * runs for as long as it takes. It only stops the wait, and a mutation that outlasts it fails
   * like a lost reply.
   */
  readonly timeout?: Duration.Duration | undefined;
  /**
   * How long to wait for a read's reply, `readTimeout` (10 s) by default. A fan-out bounds each
   * host's request on its own, so a host that doesn't answer in time is named among the
   * unreachable.
   */
  readonly readTimeout?: Duration.Duration | undefined;
}

export interface CreateOptions {
  /** The host to create on instead of placing by base: a `--host` flag or a profile's `host`. */
  readonly host?: string | undefined;
}

export interface Interface {
  /** Every host, with its bases. */
  readonly hosts: Effect.Effect<Gathered<Host>>;
  readonly machines: Effect.Effect<Gathered<Machine>>;
  readonly checkpoints: Effect.Effect<Gathered<Checkpoint>>;
  /** Every host's limits; a host whose runtime couldn't be read is among the unreachable. */
  readonly capacity: Effect.Effect<Gathered<Limit>>;
  readonly machine: (id: string) => Effect.Effect<Machine, ClankerboxError>;
  readonly checkpoint: (id: string) => Effect.Effect<Checkpoint, ClankerboxError>;
  /**
   * Creates a machine named `name` on the options' host, or else on the first host in the
   * list that offers the spec's base.
   */
  readonly create: (
    name: string,
    spec: MachineSpec,
    options?: CreateOptions,
  ) => Effect.Effect<Machine, ClankerboxError>;
  readonly start: (id: string) => Effect.Effect<Machine, ClankerboxError>;
  readonly stop: (id: string) => Effect.Effect<Machine, ClankerboxError>;
  readonly delete: (id: string) => Effect.Effect<void, ClankerboxError>;
  /** Copies a machine to a new name on its host. */
  readonly fork: (machine: string, name: string) => Effect.Effect<Machine, ClankerboxError>;
  /** Creates a machine named `name` from a checkpoint, on the checkpoint's host. */
  readonly restore: (checkpoint: string, name: string) => Effect.Effect<Machine, ClankerboxError>;
  readonly capture: (machine: string, name: string) => Effect.Effect<Checkpoint, ClankerboxError>;
  readonly deleteCheckpoint: (id: string) => Effect.Effect<void, ClankerboxError>;
}

export class Client extends Context.Service<Client, Interface>()(
  "@gjermundgaraba/clankerbox-sdk/Client",
) {}

/**
 * A client for one host. Every request carries the SDK's version, which the host checks
 * against its own. Input that doesn't encode fails as `InvalidInput` before anything is
 * sent, so a `SchemaError` that reaches `settle` is a reply that didn't decode.
 */
const makeHostApi = (entry: HostEntry) =>
  ActionHttp.client(Http, {
    baseUrl: entry.url,
    transformClient: HttpClient.mapRequest(HttpClientRequest.setHeader(versionHeader, version)),
  });

type HostApi = Effect.Success<ReturnType<typeof makeHostApi>>;

/** A host list entry and the client that calls it. */
interface Route {
  readonly entry: HostEntry;
  readonly api: HostApi;
}

type CallError = ActionHttp.MethodError<(typeof Http.actions)[number]>;

/** Every action's contract, by name: a call's timeout and retry follow its `readOnly`. */
const actions = Action.byName(Http.actions);

/** What a call reads of its action's contract. */
type Contract = Pick<Action.Any, "readOnly">;

/** Which call met an error, for its message and for whether it is retryable. */
interface CallContext {
  readonly host: HostEntry;
  readonly timeout: Duration.Duration | undefined;
  readonly readOnly: boolean;
  /** What the call does, such as `start linux_dev` or `list machines`. */
  readonly action: string;
  /** The ID to read when a mutation's reply is lost. */
  readonly target?: string | undefined;
}

const causeDetail = (error: HttpClientError.HttpClientError): string =>
  error.cause instanceof Error ? error.cause.message : error.message;

/**
 * No reply came: the connection failed or dropped, or the timeout passed. A mutation's
 * request may or may not have reached its host, so it may have run.
 */
const unanswered = (context: CallContext, detail: string): Unavailable =>
  context.readOnly
    ? new Unavailable({
        message: `host ${context.host.id} (${context.host.url}) didn't answer ${context.action}: ${detail}`,
        readOnly: context.readOnly,
      })
    : new Unavailable({
        message: `no reply from host ${context.host.id} to ${context.action} (${detail}); the action may have run: read ${context.target ?? "the resource"} to see`,
        readOnly: context.readOnly,
      });

/** Bounds the wait for the reply; the clock starts when the request is sent. */
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

/** The host answered with something the call doesn't expect. */
const unexpected = (context: CallContext, error: { readonly message: string }): Internal =>
  new Internal({
    message: `host ${context.host.id} answered ${context.action} unexpectedly: ${error.message}`,
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
            // The connection closed while the body was read. A body that arrived and doesn't
            // parse fails as a SyntaxError or a SchemaError, and a wrong status or content
            // type carries no cause.
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
      // Schema issues never carry the rejected values, so a setup script never reaches the message.
      InvalidInput: (error) =>
        Effect.fail(
          new Invalid({
            message: `${context.action}: the request doesn't match the action's input: ${error.message}`,
          }),
        ),
      SchemaError: (error) =>
        Effect.fail(
          new Internal({
            message: `host ${context.host.id}'s reply didn't decode: ${error.message}`,
          }),
        ),
      // Every action is public, so a host never refuses a caller.
      Unauthenticated: (error) => Effect.fail(unexpected(context, error)),
      Forbidden: (error) => Effect.fail(unexpected(context, error)),
    }),
  );

/** A host this client can use: it calls itself by its entry's ID. */
const checkHost = (entry: HostEntry, host: Host): Effect.Effect<Host, Invalid> =>
  host.id === entry.id
    ? Effect.succeed(host)
    : Effect.fail(
        new Invalid({
          message: `host ${entry.id} (${entry.url}) calls itself ${host.id}; its entry in the host list must use that ID`,
        }),
      );

/** Every entry is checked here, so a call never meets a malformed URL. */
const decodeHosts = Schema.decodeUnknownEffect(Schema.Array(HostEntry));

/**
 * Builds a client over `hosts`, in placement order. Making it sends nothing. An empty list
 * is Invalid, and so is a malformed entry or a host ID that appears twice: IDs route by it.
 */
export const make = (
  hosts: ReadonlyArray<HostEntry>,
  options?: Options,
): Effect.Effect<Interface, Invalid, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (hosts.length === 0) {
      return yield* new Invalid({ message: "the host list is empty: a client needs a host" });
    }

    yield* decodeHosts(hosts).pipe(
      Effect.mapError((error) => new Invalid({ message: `host list: ${error.message}` })),
    );

    const twice = hosts.find(
      ({ id }, index) => hosts.findIndex((other) => other.id === id) < index,
    );

    if (twice !== undefined) {
      return yield* new Invalid({ message: `host ${twice.id} appears twice in the host list` });
    }

    const routed: ReadonlyArray<Route> = yield* Effect.forEach(hosts, (entry) =>
      Effect.map(makeHostApi(entry), (api) => ({ entry, api })),
    );

    const routes = new Map(routed.map((route) => [route.entry.id, route]));

    const route = (host: string) => {
      const found = routes.get(host);

      return found === undefined
        ? Effect.fail(new Invalid({ message: `host ${host} isn't in the host list` }))
        : Effect.succeed(found);
    };

    /**
     * Sends one call to one host, bounded by the read or the mutation timeout. `target` is the
     * ID to read when a mutation's reply is lost.
     */
    const ask = <A>(
      { entry, api }: Route,
      { readOnly }: Contract,
      action: string,
      call: (api: HostApi) => Effect.Effect<A, CallError>,
      target?: string,
    ) =>
      settle(call(api), {
        host: entry,
        timeout: readOnly ? (options?.readTimeout ?? readTimeout) : options?.timeout,
        readOnly,
        action,
        target,
      });

    /**
     * Routes a call by the ID's host part: no network is needed to find the host. `made` is
     * the ID of the resource the call makes, if any, which is what to read after a lost reply.
     */
    const byId = <A>(
      id: string,
      contract: Contract,
      action: string,
      call: (api: HostApi) => Effect.Effect<A, CallError>,
      made?: string,
    ) =>
      Effect.gen(function* () {
        const { host } = yield* parseId(id);

        return yield* ask(yield* route(host), contract, action, call, made ?? id);
      });

    /** Asks every host at once; a host that fails is named rather than failing the whole. */
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

    /**
     * Reads a host. IDs route by its entry's ID, so a host that calls itself something else
     * fails rather than being placed on.
     */
    const readHost = (route: Route) =>
      ask(route, actions.getHost, "get host", (api) =>
        Effect.flatMap(api.getHost(), (host) => checkHost(route.entry, host)),
      );

    const createOn = (host: string, name: string, spec: MachineSpec) =>
      Effect.gen(function* () {
        const id = yield* formatId(host, name);

        return yield* ask(
          yield* route(host),
          actions.createMachine,
          `create ${id}`,
          (api) => api.createMachine({ ...spec, id }),
          id,
        );
      });

    /**
     * Asks every host at once and goes through the answers in list order: the first host
     * that answers and offers `base` wins, and the requests still out are interrupted, so a
     * silent host after it delays nothing. With no winner the create is `Unavailable` only if
     * a host gave no reply; otherwise asking again changes nothing, and it is `Precondition`.
     */
    const place = (base: string) =>
      Effect.gen(function* () {
        const asked = yield* Effect.forEach(routed, (route) =>
          Effect.map(Effect.forkScoped(Effect.result(readHost(route))), (fiber) => ({
            host: route.entry.id,
            fiber,
          })),
        );

        /** What each host answered, in list order. */
        const misses: Array<string> = [];
        let noReply = false;

        for (const { host, fiber } of asked) {
          const result = yield* Fiber.join(fiber);

          if (Result.isFailure(result)) {
            noReply ||= Predicate.isTagged(result.failure, "Unavailable");
            misses.push(`${host} failed: ${result.failure._tag}: ${result.failure.message}`);
          } else if (result.success.bases.includes(base)) {
            return host;
          } else {
            const { bases } = result.success;

            misses.push(`${host} offers ${bases.length > 0 ? bases.join(", ") : "no bases"}`);
          }
        }

        const message = `no host offers base ${base}: ${misses.join("; ")}`;

        return yield* noReply
          ? new Unavailable({ message, readOnly: true })
          : new Precondition({ message });
      }).pipe(Effect.scoped);

    const create = (name: string, spec: MachineSpec, options?: CreateOptions) =>
      Effect.gen(function* () {
        yield* parseName(name);

        if (options?.host !== undefined) {
          return yield* createOn(options.host, name, spec);
        }

        return yield* createOn(yield* place(spec.base), name, spec);
      });

    /** The ID a call that makes a resource on `source`'s host gives it. */
    const sibling = (source: string, name: string) =>
      Effect.flatMap(parseId(source), ({ host }) => formatId(host, name));

    return {
      hosts: gather((route) => Effect.map(readHost(route), (host) => [host])),
      machines: gather((route) =>
        ask(route, actions.listMachines, "list machines", (api) => api.listMachines()),
      ),
      checkpoints: gather((route) =>
        ask(route, actions.listCheckpoints, "list checkpoints", (api) => api.listCheckpoints()),
      ),
      capacity: gather((route) =>
        ask(route, actions.getCapacity, "get capacity", (api) => api.getCapacity()),
      ),
      machine: (id) => byId(id, actions.getMachine, `get ${id}`, (api) => api.getMachine({ id })),
      checkpoint: (id) =>
        byId(id, actions.getCheckpoint, `get ${id}`, (api) => api.getCheckpoint({ id })),
      create,
      start: (id) =>
        byId(id, actions.startMachine, `start ${id}`, (api) => api.startMachine({ id })),
      stop: (id) => byId(id, actions.stopMachine, `stop ${id}`, (api) => api.stopMachine({ id })),
      delete: (id) =>
        byId(id, actions.deleteMachine, `delete ${id}`, (api) => api.deleteMachine({ id })),
      fork: (machine, name) =>
        Effect.flatMap(sibling(machine, name), (made) =>
          byId(
            machine,
            actions.forkMachine,
            `fork ${machine} to ${made}`,
            (api) => api.forkMachine({ machine, name }),
            made,
          ),
        ),
      restore: (checkpoint, name) =>
        Effect.flatMap(sibling(checkpoint, name), (made) =>
          byId(
            checkpoint,
            actions.restoreMachine,
            `restore ${checkpoint} to ${made}`,
            (api) => api.restoreMachine({ checkpoint, name }),
            made,
          ),
        ),
      capture: (machine, name) =>
        Effect.flatMap(sibling(machine, name), (made) =>
          byId(
            machine,
            actions.captureCheckpoint,
            `capture ${machine} to ${made}`,
            (api) => api.captureCheckpoint({ machine, name }),
            made,
          ),
        ),
      deleteCheckpoint: (id) =>
        byId(id, actions.deleteCheckpoint, `delete ${id}`, (api) => api.deleteCheckpoint({ id })),
    } satisfies Interface;
  });
