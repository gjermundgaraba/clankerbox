import { Context, type Duration, Effect, Fiber, Layer, Predicate, Result, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { actionsByName as actions, readTimeout } from "../api.ts";
import { type ClankerboxError, Invalid, Precondition, Unavailable } from "../errors.ts";
import { formatId, HostId, parseId, parseName } from "../ids.ts";
import type { Checkpoint, Host, Limit, Machine, MachineSpec } from "../resources.ts";
import { describeIssues } from "../text.ts";
import {
  type CallError,
  checkHost,
  type Contract,
  type HostApi,
  hostApi,
  settle,
} from "./host-api.ts";

/** `id` is the host part of every ID the host holds. */
export const HostEntry = Schema.Struct({
  id: HostId,
  url: Schema.String.check(
    Schema.makeFilter((url: string) => URL.canParse(url) || "a URL, such as http://linux:8484"),
  ),
});

export type HostEntry = typeof HostEntry.Type;

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
  readonly machine: (id: string) => Effect.Effect<Machine, ClankerboxError>;
  readonly checkpoint: (id: string) => Effect.Effect<Checkpoint, ClankerboxError>;
  /** The host a create of `base` goes to, read even when `options.host` names it. */
  readonly place: (base: string, options?: CreateOptions) => Effect.Effect<Host, ClankerboxError>;
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

/**
 * Nothing retries: a mutation whose reply is lost or times out is `Unavailable`, and the caller
 * reads the resource to see what happened.
 */
export class Client extends Context.Service<Client, Interface>()(
  "@gjermundgaraba/clankerbox-sdk/Client",
) {}

interface Route {
  readonly entry: HostEntry;
  readonly api: HostApi;
}

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

    const ask = <A>(
      { entry, api }: Route,
      contract: Contract,
      what: string,
      call: (api: HostApi) => Effect.Effect<A, CallError>,
      target?: string,
    ) =>
      settle(call(api), {
        host: entry,
        timeout: contract.readOnly ? (options?.readTimeout ?? readTimeout) : options?.timeout,
        contract,
        what,
        target,
      });

    const byId = <A>(
      id: string,
      contract: Contract,
      what: string,
      call: (api: HostApi) => Effect.Effect<A, CallError>,
      made?: string,
    ) =>
      Effect.gen(function* () {
        const { host } = yield* parseId(id);

        return yield* ask(yield* route(host), contract, what, call, made ?? id);
      });

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

    const place = (base: string, options?: CreateOptions) =>
      options?.host === undefined ? offering(base) : Effect.flatMap(route(options.host), readHost);

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
      place,
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

export const layer = (
  hosts: ReadonlyArray<HostEntry>,
  options?: Options,
): Layer.Layer<Client, Invalid, HttpClient.HttpClient> =>
  Layer.effect(Client, make(hosts, options));
