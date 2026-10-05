/**
 * The client library: a host list in placement order, routing by ID, list fan-out and
 * create placement. Nothing here retries: a mutation whose reply is lost, or that outlasts
 * the client's mutation timeout, is `Unavailable`, and the caller reads the resource to see
 * what happened.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import type * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionGroup from "@gjermundgaraba/effect-actions/ActionGroup";
import { Context, Duration, Effect, Fiber, Layer, Match, Predicate, Result, Schema } from "effect";
import type { HttpClient, HttpClientError } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { CheckpointGroup, HostGroup, Http, MachineGroup } from "./api.ts";
import {
  type ClankerboxError,
  type HostError,
  Internal,
  Invalid,
  Precondition,
  Unavailable,
} from "./errors.ts";
import { formatId, HostId, isId, parseId, parseName } from "./ids.ts";
import type { Checkpoint, Host, Machine, MachineSpec } from "./resources.ts";

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
   * How long to wait for a read's reply, 10 s by default. A fan-out bounds each host's request
   * on its own, so a host that doesn't answer in time is named among the unreachable.
   */
  readonly readTimeout?: Duration.Duration | undefined;
}

const defaultReadTimeout = Duration.seconds(10);

export interface CreateOptions {
  /** The host to create on, normally a profile's `host`. A full ID in `target` wins over it. */
  readonly host?: string | undefined;
}

export interface Interface {
  /** Every host, with its bases. */
  readonly hosts: Effect.Effect<Gathered<Host>>;
  readonly machines: Effect.Effect<Gathered<Machine>>;
  readonly checkpoints: Effect.Effect<Gathered<Checkpoint>>;
  readonly machine: (id: string) => Effect.Effect<Machine, ClankerboxError>;
  readonly checkpoint: (id: string) => Effect.Effect<Checkpoint, ClankerboxError>;
  /**
   * Creates a machine. `target` is a full ID, which names its host, or a name: then the
   * options' host, or else the first host in the list that offers the spec's base.
   */
  readonly create: (
    target: string,
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
 * A client for one host. Its reply decoding is the only step `transformResponse` wraps, so a
 * reply that doesn't decode is `Internal` here, and a `SchemaError` that reaches `settle` came
 * from encoding the request.
 */
const makeHostApi = (entry: HostEntry) =>
  HttpApiClient.make(Http.api, {
    baseUrl: entry.url,
    transformResponse: (reply) =>
      Effect.mapError(reply, (error) =>
        Schema.isSchemaError(error)
          ? new Internal({ message: `host ${entry.id}'s reply didn't decode: ${error.message}` })
          : error,
      ),
  });

type HostApi = Effect.Success<ReturnType<typeof makeHostApi>>;

/** A host list entry and the client that calls it. */
interface Route {
  readonly entry: HostEntry;
  readonly api: HostApi;
}

type CallError = HostError | HttpClientError.HttpClientError | Schema.SchemaError;

/** Every action's contract, keyed `<group>.<action>`: a call reads its access from its action. */
const actions = ActionGroup.contracts(MachineGroup, CheckpointGroup, HostGroup);

/** Which call met an error, for its message and for whether it is retryable. */
interface CallContext {
  readonly host: HostEntry;
  readonly timeout: Duration.Duration | undefined;
  readonly access: Action.Access;
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
  context.access === "read"
    ? new Unavailable({
        message: `host ${context.host.id} (${context.host.url}) didn't answer ${context.action}: ${detail}`,
        access: "read",
      })
    : new Unavailable({
        message: `no reply from host ${context.host.id} to ${context.action} (${detail}); the action may have run: read ${context.target ?? "the resource"} to see`,
        access: "write",
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

const settle = <A>(
  call: Effect.Effect<A, CallError>,
  context: CallContext,
): Effect.Effect<A, ClankerboxError> =>
  bounded(call, context).pipe(
    Effect.catchTag("HttpClientError", (error) =>
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
          Match.orElse(
            () =>
              new Internal({
                message: `host ${context.host.id} answered ${context.action} unexpectedly: ${error.message}`,
              }),
          ),
        ),
      ),
    ),
    // Schema issues never carry the rejected values, so a setup script never reaches the message.
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        new Invalid({
          message: `${context.action}: the request doesn't match the action's input: ${error.message}`,
        }),
      ),
    ),
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

    /** How long a call waits for its reply, by its action's access. */
    const bounds = {
      read: options?.readTimeout ?? defaultReadTimeout,
      write: options?.timeout,
    } satisfies Record<Action.Access, Duration.Duration | undefined>;

    const route = (host: string) => {
      const found = routes.get(host);

      return found === undefined
        ? Effect.fail(new Invalid({ message: `host ${host} isn't in the host list` }))
        : Effect.succeed(found);
    };

    /**
     * Sends one call to one host, bounded by its action's access. `target` is the ID to read
     * when a mutation's reply is lost.
     */
    const ask = <A>(
      { entry, api }: Route,
      contract: { readonly access: Action.Access },
      action: string,
      call: (api: HostApi) => Effect.Effect<A, CallError>,
      target?: string,
    ) =>
      settle(call(api), {
        host: entry,
        timeout: bounds[contract.access],
        access: contract.access,
        action,
        target,
      });

    /**
     * Routes a call by the ID's host part: no network is needed to find the host. `made` is
     * the ID of the resource the call makes, if any, which is what to read after a lost reply.
     */
    const byId = <A>(
      id: string,
      contract: { readonly access: Action.Access },
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
      ask(route, actions["host.get"], "get host", (api) =>
        api.host.get({ payload: {} }).pipe(
          Effect.flatMap((host) =>
            host.id === route.entry.id
              ? Effect.succeed(host)
              : Effect.fail(
                  new Invalid({
                    message: `host ${route.entry.id} (${route.entry.url}) calls itself ${host.id}; its entry in the host list must use that ID`,
                  }),
                ),
          ),
        ),
      );

    const createOn = (host: string, name: string, spec: MachineSpec) =>
      Effect.gen(function* () {
        const id = yield* formatId(host, name);

        return yield* ask(
          yield* route(host),
          actions["machine.create"],
          `create ${id}`,
          (api) => api.machine.create({ payload: { ...spec, id } }),
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
        let unanswered = false;

        for (const { host, fiber } of asked) {
          const result = yield* Fiber.join(fiber);

          if (Result.isFailure(result)) {
            unanswered ||= Predicate.isTagged(result.failure, "Unavailable");
            misses.push(`${host} failed: ${result.failure._tag}: ${result.failure.message}`);
          } else if (result.success.bases.includes(base)) {
            return host;
          } else {
            const { bases } = result.success;

            misses.push(`${host} offers ${bases.length > 0 ? bases.join(", ") : "no bases"}`);
          }
        }

        const message = `no host offers base ${base}: ${misses.join("; ")}`;

        return yield* unanswered
          ? new Unavailable({ message, access: "read" })
          : new Precondition({ message });
      }).pipe(Effect.scoped);

    const create = (target: string, spec: MachineSpec, options?: CreateOptions) =>
      Effect.gen(function* () {
        if (isId(target)) {
          const { host, name } = yield* parseId(target);

          return yield* createOn(host, name, spec);
        }

        const name = yield* parseName(target);

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
        ask(route, actions["machine.list"], "list machines", (api) =>
          api.machine.list({ payload: {} }),
        ),
      ),
      checkpoints: gather((route) =>
        ask(route, actions["checkpoint.list"], "list checkpoints", (api) =>
          api.checkpoint.list({ payload: {} }),
        ),
      ),
      machine: (id) =>
        byId(id, actions["machine.get"], `get ${id}`, (api) =>
          api.machine.get({ payload: { id } }),
        ),
      checkpoint: (id) =>
        byId(id, actions["checkpoint.get"], `get ${id}`, (api) =>
          api.checkpoint.get({ payload: { id } }),
        ),
      create,
      start: (id) =>
        byId(id, actions["machine.start"], `start ${id}`, (api) =>
          api.machine.start({ payload: { id } }),
        ),
      stop: (id) =>
        byId(id, actions["machine.stop"], `stop ${id}`, (api) =>
          api.machine.stop({ payload: { id } }),
        ),
      delete: (id) =>
        byId(id, actions["machine.delete"], `delete ${id}`, (api) =>
          api.machine.delete({ payload: { id } }),
        ),
      fork: (machine, name) =>
        Effect.flatMap(sibling(machine, name), (made) =>
          byId(
            machine,
            actions["machine.fork"],
            `fork ${machine} to ${made}`,
            (api) => api.machine.fork({ payload: { machine, name } }),
            made,
          ),
        ),
      restore: (checkpoint, name) =>
        Effect.flatMap(sibling(checkpoint, name), (made) =>
          byId(
            checkpoint,
            actions["machine.restore"],
            `restore ${checkpoint} to ${made}`,
            (api) => api.machine.restore({ payload: { checkpoint, name } }),
            made,
          ),
        ),
      capture: (machine, name) =>
        Effect.flatMap(sibling(machine, name), (made) =>
          byId(
            machine,
            actions["checkpoint.capture"],
            `capture ${machine} to ${made}`,
            (api) => api.checkpoint.capture({ payload: { machine, name } }),
            made,
          ),
        ),
      deleteCheckpoint: (id) =>
        byId(id, actions["checkpoint.delete"], `delete ${id}`, (api) =>
          api.checkpoint.delete({ payload: { id } }),
        ),
    } satisfies Interface;
  });

/**
 * The client over Node's `http` module, which sets no timeout of its own: a mutation can run
 * for hours.
 */
export const layer = (
  hosts: ReadonlyArray<HostEntry>,
  options?: Options,
): Layer.Layer<Client, Invalid> =>
  Layer.effect(Client, make(hosts, options)).pipe(Layer.provide(NodeHttpClient.layerNodeHttp));
