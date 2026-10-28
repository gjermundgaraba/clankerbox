import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import {
  Context,
  Duration,
  Effect,
  Fiber,
  Layer,
  Match,
  Predicate,
  Result,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientError } from "effect/http";

import { actionsByName as actions, Http, readTimeout } from "./api.ts";
import type { Declared } from "./api.ts";
import { describeIssues } from "./describe.ts";
import { Internal, Invalid, NotOffered, Unavailable } from "./errors.ts";
import type { ClankerboxError, NotFound } from "./errors.ts";
import { formatId, HostId, parseId, parseName } from "./ids.ts";
import { version, versionHeader } from "./release.ts";
import { offered, offers } from "./resources.ts";
import type {
  Checkpoint,
  Host,
  Machine,
  MachineSpec,
  Usage,
} from "./resources.ts";

/** `id` is the host part of every ID the host holds. */
export const HostEntry = Schema.Struct({
  id: HostId,
  url: Schema.String.check(
    Schema.makeFilter(
      (url: string) => URL.canParse(url) || "a URL, such as http://linux:8484"
    )
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
  | Declared<N>
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
  readonly answers: readonly A[];
  readonly unreachable: readonly Unreachable[];
}

export interface Options {
  /**
   * The wait for a mutation's reply, unbounded by default, as a create's setup can take hours. A
   * mutation that outlasts it fails like a lost reply and still finishes on the host, except
   * `execMachine`, whose command ends with the wait.
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
  readonly [
    N in Exclude<Routed, "createMachine" | "deleteMachine" | "deleteCheckpoint">
  ]: (input: Input<N>) => Effect.Effect<Success<N>, ErrorOf<N>>;
};

export interface Interface extends Calls {
  readonly hosts: Effect.Effect<Gathered<Host>>;
  readonly machines: Effect.Effect<Gathered<Machine>>;
  readonly checkpoints: Effect.Effect<Gathered<Checkpoint>>;
  /** A host whose runtime couldn't be read is among the unreachable. */
  readonly capacity: Effect.Effect<Gathered<Usage>>;
  /**
   * The host a create of `base` goes to, read even when `options.host` names it: the first in
   * list order that offers it, a base it names or, on linux, an image reference. With none, it is `Unavailable` if a host gave no reply, and
   * `NotOffered` otherwise.
   */
  readonly place: (
    base: string,
    options?: CreateOptions
  ) => Effect.Effect<Host, ErrorOf<"getHost"> | NotOffered>;
  /** `createMachine` on `options.host`, or else on the first host that offers the base. */
  readonly create: (
    name: string,
    spec: MachineSpec,
    options?: CreateOptions
  ) => Effect.Effect<Machine, ErrorOf<"createMachine">>;
  /** A delete of a resource that is already gone is `absent`: done either way. */
  readonly deleteMachine: (
    input: Input<"deleteMachine">
  ) => Effect.Effect<Deleted, Exclude<ErrorOf<"deleteMachine">, NotFound>>;
  /** A delete of a checkpoint that is already gone is `absent`: done either way. */
  readonly deleteCheckpoint: (
    input: Input<"deleteCheckpoint">
  ) => Effect.Effect<Deleted, Exclude<ErrorOf<"deleteCheckpoint">, NotFound>>;
}

/**
 * Nothing retries: a mutation whose reply is lost or times out is `Unavailable`, and the caller
 * reads the resource to see what happened.
 */
export class Client extends Context.Service<Client, Interface>()(
  "@gjermundgaraba/clankerbox-sdk/Client"
) {}

const hostApi = (entry: HostEntry) =>
  ActionHttp.client(Http, {
    baseUrl: entry.url,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.setHeader(versionHeader, version)
    ),
  });

type HostApi = Effect.Success<ReturnType<typeof hostApi>>;

type CallError = ActionHttp.MethodError<Actions[HostAction]>;

type Methods = {
  readonly [N in HostAction]: (
    input: Input<N>
  ) => Effect.Effect<Success<N>, CallError>;
};

interface Route {
  readonly entry: HostEntry;
  readonly api: HostApi;
}

interface CallContext {
  readonly host: HostEntry;
  readonly timeout: Duration.Duration | undefined;
  readonly readOnly: boolean;
  readonly what: string;
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
  context: CallContext
): Effect.Effect<A, CallError | Unavailable> => {
  const { timeout } = context;

  return timeout === undefined
    ? call
    : Effect.timeoutOrElse(call, {
        duration: timeout,
        orElse: () =>
          Effect.fail(
            unanswered(context, `timed out after ${Duration.format(timeout)}`)
          ),
      });
};

const unexpected = (
  context: CallContext,
  error: { readonly message: string }
): Internal =>
  new Internal({
    message: `host ${context.host.id} answered ${context.what} unexpectedly: ${error.message}`,
  });

const settle = <A>(
  call: Effect.Effect<A, CallError>,
  context: CallContext
): Effect.Effect<A, ClankerboxError> =>
  bounded(call, context).pipe(
    Effect.catchTags({
      HttpClientError: (error) =>
        Effect.fail(
          Match.value(error.reason).pipe(
            Match.tag("TransportError", () =>
              unanswered(context, causeDetail(error))
            ),
            Match.when(
              {
                _tag: "DecodeError",
                cause: (cause: unknown) =>
                  cause !== undefined && !(cause instanceof SyntaxError),
              },
              () => unanswered(context, causeDetail(error))
            ),
            Match.orElse(() => unexpected(context, error))
          )
        ),
      InvalidInput: (error) =>
        Effect.fail(
          new Invalid({
            message: `${context.what}: the request doesn't match the action's input: ${error.message}`,
          })
        ),
      SchemaError: (error) =>
        Effect.fail(
          new Internal({
            message: `host ${context.host.id}'s reply didn't decode: ${error.message}`,
          })
        ),
      Unauthenticated: (error) => Effect.fail(unexpected(context, error)),
      Forbidden: (error) => Effect.fail(unexpected(context, error)),
    })
  );

const naming = (action: HostAction) => (error: Invalid) =>
  error.located({ action });

const deleting = <E extends { readonly _tag: string }>(
  removal: Effect.Effect<void, E | NotFound>
) =>
  removal.pipe(
    Effect.as<Deleted>("deleted"),
    Effect.catchTag("NotFound", () => Effect.succeed<Deleted>("absent"))
  );

const checkHost = (
  entry: HostEntry,
  host: Host
): Effect.Effect<Host, Invalid> =>
  host.id === entry.id
    ? Effect.succeed(host)
    : Effect.fail(
        new Invalid({
          message: `host ${entry.id} (${entry.url}) calls itself ${host.id}; its entry in the host list must use that ID`,
          host: entry.id,
          action: "getHost",
        })
      );

const decodeHosts = Schema.decodeUnknownEffect(Schema.Array(HostEntry));

const subjectOf = (input: Subject): string => {
  if ("id" in input) {
    return input.id;
  }

  return "machine" in input ? input.machine : input.checkpoint;
};

/**
 * A client over `hosts`, in placement order. It sends nothing until called. An empty list, a
 * malformed entry or a host ID that appears twice is Invalid.
 */
export const make = (
  hosts: readonly HostEntry[],
  options?: Options
): Effect.Effect<Interface, Invalid, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (hosts.length === 0) {
      return yield* new Invalid({
        message: "the host list is empty: a client needs a host",
      });
    }

    yield* decodeHosts(hosts, { errors: "all" }).pipe(
      Effect.mapError(
        (error) =>
          new Invalid({ message: `host list: ${describeIssues(error)}` })
      )
    );

    const twice = hosts.find(
      ({ id }, index) => hosts.findIndex((other) => other.id === id) < index
    );

    if (twice !== undefined) {
      return yield* new Invalid({
        message: `host ${twice.id} appears twice in the host list`,
      });
    }

    const routed: readonly Route[] = yield* Effect.forEach(hosts, (entry) =>
      Effect.map(hostApi(entry), (api) => ({ entry, api }))
    );

    const routes = new Map(routed.map((route) => [route.entry.id, route]));

    const routeTo = (host: string) => {
      const found = routes.get(host);

      return found === undefined
        ? Effect.fail(
            new Invalid({ message: `host ${host} isn't in the host list` })
          )
        : Effect.succeed(found);
    };

    const send = <N extends HostAction>(
      { entry, api }: Route,
      name: N,
      input: Input<N>,
      subject?: string,
      made?: string
    ): Effect.Effect<Success<N>, ErrorOf<N>> => {
      const { readOnly } = actions[name];

      const methods: Methods = api;
      const method = methods[name];

      return settle(method(input), {
        host: entry,
        timeout: readOnly
          ? (options?.readTimeout ?? readTimeout)
          : options?.timeout,
        readOnly,
        what: subject === undefined ? name : `${name} ${subject}`,
        target: made ?? subject,
      }).pipe(
        Effect.mapError((error) =>
          error.located({ action: name, host: entry.id, id: subject, made })
        )
      );
    };

    const gather = <A>(
      call: (route: Route) => Effect.Effect<readonly A[], ClankerboxError>
    ): Effect.Effect<Gathered<A>> =>
      Effect.forEach(
        routed,
        (route) =>
          Effect.map(Effect.result(call(route)), (result) => ({
            host: route.entry.id,
            result,
          })),
        { concurrency: "unbounded" }
      ).pipe(
        Effect.map((results) => {
          const answers: A[] = [];
          const unreachable: Unreachable[] = [];

          for (const { host, result } of results) {
            if (Result.isSuccess(result)) {
              answers.push(...result.success);
            } else {
              unreachable.push({ host, error: result.failure });
            }
          }

          return { answers, unreachable };
        })
      );

    const readHost = (route: Route) =>
      Effect.flatMap(send(route, "getHost", {}), (host) =>
        checkHost(route.entry, host)
      );

    const onResource = <N extends Routed>(
      name: N,
      input: Input<N>,
      makes?: string
    ) => {
      const subject = subjectOf(input);

      return Effect.gen(function* () {
        const { host } = yield* parseId(subject);

        const made =
          makes === undefined ? undefined : yield* formatId(host, makes);

        return { route: yield* routeTo(host), made };
      }).pipe(
        Effect.mapError(naming(name)),
        Effect.flatMap(({ route, made }) =>
          send(route, name, input, subject, made)
        )
      );
    };

    const offering = (base: string, action: HostAction) =>
      Effect.gen(function* () {
        const asked = yield* Effect.forEach(routed, (route) =>
          Effect.map(
            Effect.forkScoped(Effect.result(readHost(route))),
            (fiber) => ({
              host: route.entry.id,
              fiber,
            })
          )
        );

        const misses: string[] = [];
        let noReply = false;

        for (const { host, fiber } of asked) {
          const result = yield* Fiber.join(fiber);

          if (Result.isFailure(result)) {
            noReply ||= Predicate.isTagged(result.failure, "Unavailable");
            misses.push(`${host} failed: ${result.failure.message}`);
          } else if (offers(result.success, base)) {
            return result.success;
          } else {
            misses.push(`${host} offers ${offered(result.success)}`);
          }
        }

        const message = `no host offers base ${base}: ${misses.join("; ")}`;

        return yield* noReply
          ? new Unavailable({ message, readOnly: true, action })
          : new NotOffered({ message, base, action });
      }).pipe(Effect.scoped);

    const create = (
      name: string,
      spec: MachineSpec,
      placement?: CreateOptions
    ) =>
      Effect.gen(function* () {
        yield* Effect.mapError(parseName(name), naming("createMachine"));

        const host =
          placement?.host ?? (yield* offering(spec.base, "createMachine")).id;

        const id = yield* Effect.mapError(
          formatId(host, name),
          naming("createMachine")
        );

        return yield* onResource("createMachine", { ...spec, id }, name);
      });

    const place = (
      base: string,
      placement?: CreateOptions
    ): Effect.Effect<Host, ErrorOf<"getHost"> | NotOffered> =>
      placement?.host === undefined
        ? offering(base, "getHost")
        : Effect.flatMap(
            Effect.mapError(routeTo(placement.host), naming("getHost")),
            readHost
          );

    return {
      hosts: gather((route) => Effect.map(readHost(route), (host) => [host])),
      machines: gather((route) => send(route, "listMachines", {})),
      checkpoints: gather((route) => send(route, "listCheckpoints", {})),
      capacity: gather((route) => send(route, "getCapacity", {})),
      place,
      create,
      getMachine: (input) => onResource("getMachine", input),
      startMachine: (input) => onResource("startMachine", input),
      stopMachine: (input) => onResource("stopMachine", input),
      pauseMachine: (input) => onResource("pauseMachine", input),
      resizeMachine: (input) => onResource("resizeMachine", input),
      deleteMachine: (input) => deleting(onResource("deleteMachine", input)),
      forkMachine: (input) => onResource("forkMachine", input, input.name),
      restoreMachine: (input) =>
        onResource("restoreMachine", input, input.name),
      execMachine: (input) => onResource("execMachine", input),
      getCheckpoint: (input) => onResource("getCheckpoint", input),
      captureCheckpoint: (input) =>
        onResource("captureCheckpoint", input, input.name),
      deleteCheckpoint: (input) =>
        deleting(onResource("deleteCheckpoint", input)),
      prebuildCheckpoint: (input) => onResource("prebuildCheckpoint", input),
    } satisfies Interface;
  });

export const layer = (
  hosts: readonly HostEntry[],
  options?: Options
): Layer.Layer<Client, Invalid, HttpClient.HttpClient> =>
  Layer.effect(Client, make(hosts, options));
