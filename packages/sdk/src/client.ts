import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Context, Duration, Effect, Fiber, Layer, Match, Predicate, Result, Schema } from "effect";
import { HttpClient, type HttpClientError, HttpClientRequest } from "effect/http";
import { actionsByName as actions, Http, readTimeout } from "./api.ts";
import { ClankerboxError, Internal, Invalid, Precondition, Unavailable } from "./errors.ts";
import { formatId, HostId, parseId, parseName } from "./ids.ts";
import { version, versionHeader } from "./release.ts";
import type { Checkpoint, Host, Limit, Machine, MachineSpec } from "./resources.ts";
import { describeIssues } from "./text.ts";

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
export type ErrorOf<N extends HostAction> =
  | Actions[N]["error"][number]["Type"]
  | Unavailable
  | Internal;

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

export interface CreateOptions {
  /** The host to create on, instead of the first that offers the base. */
  readonly host?: string | undefined;
}

export interface Interface {
  readonly hosts: Effect.Effect<Gathered<Host>>;
  readonly machines: Effect.Effect<Gathered<Machine>>;
  readonly checkpoints: Effect.Effect<Gathered<Checkpoint>>;
  /** A host whose runtime couldn't be read is among the unreachable. */
  readonly capacity: Effect.Effect<Gathered<Limit>>;
  readonly machine: (id: string) => Effect.Effect<Machine, ErrorOf<"getMachine">>;
  readonly checkpoint: (id: string) => Effect.Effect<Checkpoint, ErrorOf<"getCheckpoint">>;
  /** The host a create of `base` goes to, read even when `options.host` names it. */
  readonly place: (
    base: string,
    options?: CreateOptions,
  ) => Effect.Effect<Host, ErrorOf<"getHost"> | Precondition>;
  readonly create: (
    name: string,
    spec: MachineSpec,
    options?: CreateOptions,
  ) => Effect.Effect<Machine, ErrorOf<"createMachine">>;
  readonly start: (id: string) => Effect.Effect<Machine, ErrorOf<"startMachine">>;
  readonly stop: (id: string) => Effect.Effect<Machine, ErrorOf<"stopMachine">>;
  readonly delete: (id: string) => Effect.Effect<void, ErrorOf<"deleteMachine">>;
  /** Copies a machine to a new name on its host. */
  readonly fork: (machine: string, name: string) => Effect.Effect<Machine, ErrorOf<"forkMachine">>;
  /** Creates a machine named `name` from a checkpoint, on the checkpoint's host. */
  readonly restore: (
    checkpoint: string,
    name: string,
  ) => Effect.Effect<Machine, ErrorOf<"restoreMachine">>;
  readonly capture: (
    machine: string,
    name: string,
  ) => Effect.Effect<Checkpoint, ErrorOf<"captureCheckpoint">>;
  readonly deleteCheckpoint: (id: string) => Effect.Effect<void, ErrorOf<"deleteCheckpoint">>;
}

/**
 * Nothing retries: a mutation whose reply is lost or times out is `Unavailable`, and the caller
 * reads the resource to see what happened.
 */
export class Client extends Context.Service<Client, Interface>()(
  "@gjermundgaraba/clankerbox-sdk/Client",
) {}

/**
 * Input that doesn't encode fails as `InvalidInput` before anything is sent, so a `SchemaError`
 * that reaches `settle` is a reply that didn't decode.
 */
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
            message: `${context.what}: the request doesn't match the action's input: ${error.message}`,
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

interface Where {
  readonly action: HostAction;
  readonly host?: string;
  readonly id?: string;
}

const encodeError = Schema.encodeSync(ClankerboxError);

const decodeError = Schema.decodeSync(ClankerboxError);

/** The error with the call's location set, and every other field it had. */
const locate =
  (where: Where) =>
  <E extends ClankerboxError>(error: E): E =>
    // SAFETY: decoding what the same union encoded rebuilds the error's own class.
    decodeError({ ...encodeError(error), ...where }) as E;

const checkHost = (entry: HostEntry, host: Host): Effect.Effect<Host, Invalid> =>
  host.id === entry.id
    ? Effect.succeed(host)
    : Effect.fail(
        new Invalid({
          message: `host ${entry.id} (${entry.url}) calls itself ${host.id}; its entry in the host list must use that ID`,
        }),
      );

const decodeHosts = Schema.decodeUnknownEffect(Schema.Array(HostEntry));

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

    /**
     * A call of `name` on one host, about `subject`. Its errors carry the host, the action and
     * `target`, the resource it reads, changes or makes.
     */
    const send = <N extends HostAction>(
      { entry, api }: Route,
      name: N,
      input: Input<N>,
      subject?: string,
      target: string | undefined = subject,
    ): Effect.Effect<Success<N>, ErrorOf<N>> => {
      const { readOnly } = actions[name];

      const methods: Methods = api;
      const method = methods[name];

      const settled = settle(method(input), {
        host: entry,
        timeout: readOnly ? (options?.readTimeout ?? readTimeout) : options?.timeout,
        readOnly,
        what: subject === undefined ? name : `${name} ${subject}`,
        target,
      }).pipe(
        Effect.mapError(
          locate(
            target === undefined
              ? { action: name, host: entry.id }
              : { action: name, host: entry.id, id: target },
          ),
        ),
      );

      // SAFETY: `settle` passes on the action's declared errors and adds only `Unavailable`,
      // `Internal` and `Invalid`, which every action declares.
      return settled as Effect.Effect<Success<N>, ErrorOf<N>>;
    };

    /**
     * A call of `name` on the host of `id`. A fork, restore or capture names the one it makes as
     * `made`, which its errors then carry, so a caller can find what a failure left behind.
     */
    const byId = <N extends HostAction>(name: N, id: string, input: Input<N>, made?: string) =>
      Effect.flatMap(
        Effect.flatMap(parseId(id), ({ host }) => route(host)),
        (found) => send(found, name, input, id, made ?? id),
      );

    /** An error raised before the call is sent names its action too. */
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

    const createOn = (host: string, name: string, spec: MachineSpec) =>
      Effect.gen(function* () {
        const id = yield* formatId(host, name);

        return yield* send(yield* route(host), "createMachine", { ...spec, id }, id);
      });

    /**
     * The first host in list order that offers `base`; the requests still out are interrupted,
     * so a silent host after it delays nothing. With no winner it is `Unavailable` only if a
     * host gave no reply: otherwise asking again changes nothing, and it is `Precondition`.
     */
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
          : new Precondition({ message });
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
    ): Effect.Effect<Host, ErrorOf<"getHost"> | Precondition> =>
      options?.host === undefined ? offering(base) : Effect.flatMap(route(options.host), readHost);

    const sibling = (source: string, name: string) =>
      Effect.flatMap(parseId(source), ({ host }) => formatId(host, name));

    return {
      hosts: gather((route) => Effect.map(readHost(route), (host) => [host])),
      machines: gather((route) => send(route, "listMachines", {})),
      checkpoints: gather((route) => send(route, "listCheckpoints", {})),
      capacity: gather((route) => send(route, "getCapacity", {})),
      machine: (id) => naming("getMachine")(byId("getMachine", id, { id })),
      checkpoint: (id) => naming("getCheckpoint")(byId("getCheckpoint", id, { id })),
      place: (base, options) => naming("getHost")(place(base, options)),
      create: (name, spec, options) => naming("createMachine")(create(name, spec, options)),
      start: (id) => naming("startMachine")(byId("startMachine", id, { id })),
      stop: (id) => naming("stopMachine")(byId("stopMachine", id, { id })),
      delete: (id) => naming("deleteMachine")(byId("deleteMachine", id, { id })),
      fork: (machine, name) =>
        naming("forkMachine")(
          Effect.flatMap(sibling(machine, name), (made) =>
            byId("forkMachine", machine, { machine, name }, made),
          ),
        ),
      restore: (checkpoint, name) =>
        naming("restoreMachine")(
          Effect.flatMap(sibling(checkpoint, name), (made) =>
            byId("restoreMachine", checkpoint, { checkpoint, name }, made),
          ),
        ),
      capture: (machine, name) =>
        naming("captureCheckpoint")(
          Effect.flatMap(sibling(machine, name), (made) =>
            byId("captureCheckpoint", machine, { machine, name }, made),
          ),
        ),
      deleteCheckpoint: (id) => naming("deleteCheckpoint")(byId("deleteCheckpoint", id, { id })),
    } satisfies Interface;
  });

export const layer = (
  hosts: ReadonlyArray<HostEntry>,
  options?: Options,
): Layer.Layer<Client, Invalid, HttpClient.HttpClient> =>
  Layer.effect(Client, make(hosts, options));
