/**
 * The client library: a host list in placement order, routing by ID, list fan-out and
 * create placement. Nothing here retries: a mutation whose reply is lost is `Unavailable`,
 * and the caller reads the resource to see what happened.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Context, Effect, Layer, Match, Result, Schema } from "effect";
import type { HttpClient, HttpClientError } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Http } from "./api.ts";
import {
  type Access,
  Capacity,
  type ClankerboxError,
  Conflict,
  type HostError,
  Internal,
  Invalid,
  NotFound,
  Precondition,
  Unavailable,
} from "./errors.ts";
import { formatId, HostId, isId, Name, parseId } from "./ids.ts";
import { type Checkpoint, type Host, type Machine, MachineSpec } from "./resources.ts";

/** One host a client talks to. `id` is the host part of every ID it holds. */
export const HostEntry = Schema.Struct({ id: HostId, url: Schema.String });

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

const makeHostApi = (url: string) => HttpApiClient.make(Http.api, { baseUrl: url });

type HostApi = Effect.Success<ReturnType<typeof makeHostApi>>;

type CallError = HostError | HttpClientError.HttpClientError | Schema.SchemaError;

/** Which call met an error, for its message and for whether it is retryable. */
interface CallContext {
  readonly host: HostEntry;
  readonly access: Access;
  /** What the call does, such as `start linux_dev` or `list machines`. */
  readonly action: string;
  /** The ID to read when a mutation's reply is lost. */
  readonly target?: string | undefined;
}

const causeDetail = (error: HttpClientError.HttpClientError): string =>
  error.cause instanceof Error ? error.cause.message : error.message;

const settle = <A>(
  call: Effect.Effect<A, CallError>,
  context: CallContext,
): Effect.Effect<A, ClankerboxError> =>
  call.pipe(
    Effect.catchTag("HttpClientError", (error) =>
      Effect.fail(
        Match.value(error.reason).pipe(
          Match.tag("TransportError", () =>
            context.access === "read"
              ? new Unavailable({
                  message: `host ${context.host.id} (${context.host.url}) didn't answer ${context.action}: ${causeDetail(error)}`,
                  access: "read",
                })
              : new Unavailable({
                  message: `no reply from host ${context.host.id} to ${context.action} (${causeDetail(error)}); the action may have run: read ${context.target ?? "the resource"} to see`,
                  access: "write",
                }),
          ),
          Match.tag(
            "InvalidUrlError",
            () =>
              new Invalid({
                message: `host ${context.host.id}'s URL ${JSON.stringify(context.host.url)} is invalid`,
              }),
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
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        new Internal({
          message: `host ${context.host.id}'s answer to ${context.action} didn't decode: ${error.message}`,
        }),
      ),
    ),
  );

/** Adds a note to an error's message, keeping its tag and fields. */
const withNote = (error: ClankerboxError, note: string): ClankerboxError => {
  const message = `${error.message}; ${note}`;

  return Match.value(error).pipe(
    Match.tagsExhaustive({
      Invalid: () => new Invalid({ message }),
      NotFound: () => new NotFound({ message }),
      Conflict: ({ kind }) => new Conflict({ message, kind }),
      Precondition: () => new Precondition({ message }),
      Capacity: () => new Capacity({ message }),
      Unavailable: ({ access }) => new Unavailable({ message, access }),
      Internal: () => new Internal({ message }),
    }),
  );
};

const decodeSpec = Schema.decodeUnknownEffect(MachineSpec);

const decodeName = Schema.decodeUnknownEffect(Name);

/** Builds a client over `hosts`, in placement order. Making it sends nothing. */
export const make = (
  hosts: ReadonlyArray<HostEntry>,
): Effect.Effect<Interface, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const routes = new Map<string, { readonly entry: HostEntry; readonly api: HostApi }>();

    for (const entry of hosts) {
      routes.set(entry.id, { entry, api: yield* makeHostApi(entry.url) });
    }

    const route = (host: string) => {
      const found = routes.get(host);

      return found === undefined
        ? Effect.fail(new Invalid({ message: `host ${host} isn't in the host list` }))
        : Effect.succeed(found);
    };

    /**
     * Routes a call by the ID's host part: no network is needed to find the host. `made` is
     * the ID of the resource the call makes, if any, which is what to read after a lost reply.
     */
    const byId = <A>(
      id: string,
      access: Access,
      action: string,
      call: (api: HostApi) => Effect.Effect<A, CallError>,
      made?: string,
    ) =>
      Effect.gen(function* () {
        const { host } = yield* parseId(id);
        const { entry, api } = yield* route(host);

        return yield* settle(call(api), { host: entry, access, action, target: made ?? id });
      });

    /** Asks every host at once; a host that fails is named rather than failing the whole. */
    const gather = <A>(
      action: string,
      call: (api: HostApi) => Effect.Effect<ReadonlyArray<A>, CallError>,
    ): Effect.Effect<Gathered<A>> =>
      Effect.forEach(
        hosts,
        (entry) => {
          const api = routes.get(entry.id)?.api;

          return api === undefined
            ? Effect.succeed(Result.succeed<ReadonlyArray<A>>([]))
            : Effect.result(settle(call(api), { host: entry, access: "read", action }));
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((results) => {
          const answers: Array<A> = [];
          const unreachable: Array<Unreachable> = [];

          results.forEach((result, index) => {
            const host = hosts[index]?.id ?? "";

            if (Result.isSuccess(result)) {
              answers.push(...result.success);
            } else {
              unreachable.push({ host, error: result.failure });
            }
          });

          return { answers, unreachable };
        }),
      );

    const createOn = (host: string, name: string, spec: MachineSpec) =>
      Effect.gen(function* () {
        const id = yield* formatId(host, name);
        const { entry, api } = yield* route(host);

        return yield* settle(api.machine.create({ payload: { ...spec, name } }), {
          host: entry,
          access: "write",
          action: `create ${id}`,
          target: id,
        });
      });

    /** The first host in list order that offers `base`; a host that didn't answer is skipped. */
    const place = (base: string) =>
      Effect.gen(function* () {
        const { answers, unreachable } = yield* gather("get host", (api) =>
          api.host.get({ payload: {} }).pipe(Effect.map((host) => [host])),
        );

        const skipped = unreachable.map(({ host }) => host);
        const chosen = answers.find((host) => host.bases.includes(base));

        if (chosen !== undefined) {
          return { host: chosen.id, skipped };
        }

        if (unreachable.length > 0) {
          return yield* new Unavailable({
            message: `no reachable host offers base ${base}; hosts whose bases couldn't be read: ${unreachable
              .map(({ host, error }) => `${host} (${error.message})`)
              .join(", ")}`,
            access: "read",
          });
        }

        return yield* new Precondition({
          message: `no host offers base ${base}: ${answers
            .map(
              (host) =>
                `${host.id} offers ${host.bases.length > 0 ? host.bases.join(", ") : "no bases"}`,
            )
            .join("; ")}`,
        });
      });

    const create = (target: string, input: MachineSpec, options?: CreateOptions) =>
      Effect.gen(function* () {
        const spec = yield* decodeSpec(input, { onExcessProperty: "error" }).pipe(
          Effect.mapError((error) => new Invalid({ message: error.message })),
        );

        if (isId(target)) {
          const { host, name } = yield* parseId(target);

          return yield* createOn(host, name, spec);
        }

        const name = yield* decodeName(target).pipe(
          Effect.mapError(
            () =>
              new Invalid({
                message: `name ${JSON.stringify(target)} must start with a letter, then letters, digits, '_' and '-'`,
              }),
          ),
        );

        if (options?.host !== undefined) {
          return yield* createOn(options.host, name, spec);
        }

        const { host, skipped } = yield* place(spec.base);

        return yield* createOn(host, name, spec).pipe(
          Effect.mapError((error) =>
            skipped.length > 0
              ? withNote(
                  error,
                  `placement skipped hosts whose bases couldn't be read: ${skipped.join(", ")}`,
                )
              : error,
          ),
        );
      });

    /** The ID a call that makes a resource on `source`'s host gives it. */
    const sibling = (source: string, name: string) =>
      Effect.flatMap(parseId(source), ({ host }) => formatId(host, name));

    return {
      hosts: gather("get host", (api) =>
        api.host.get({ payload: {} }).pipe(Effect.map((host) => [host])),
      ),
      machines: gather("list machines", (api) => api.machine.list({ payload: {} })),
      checkpoints: gather("list checkpoints", (api) => api.checkpoint.list({ payload: {} })),
      machine: (id) => byId(id, "read", `get ${id}`, (api) => api.machine.get({ payload: { id } })),
      checkpoint: (id) =>
        byId(id, "read", `get ${id}`, (api) => api.checkpoint.get({ payload: { id } })),
      create,
      start: (id) =>
        byId(id, "write", `start ${id}`, (api) => api.machine.start({ payload: { id } })),
      stop: (id) => byId(id, "write", `stop ${id}`, (api) => api.machine.stop({ payload: { id } })),
      delete: (id) =>
        byId(id, "write", `delete ${id}`, (api) => api.machine.delete({ payload: { id } })),
      fork: (machine, name) =>
        Effect.flatMap(sibling(machine, name), (made) =>
          byId(
            machine,
            "write",
            `fork ${machine} to ${made}`,
            (api) => api.machine.fork({ payload: { machine, name } }),
            made,
          ),
        ),
      restore: (checkpoint, name) =>
        Effect.flatMap(sibling(checkpoint, name), (made) =>
          byId(
            checkpoint,
            "write",
            `restore ${checkpoint} to ${made}`,
            (api) => api.machine.restore({ payload: { checkpoint, name } }),
            made,
          ),
        ),
      capture: (machine, name) =>
        Effect.flatMap(sibling(machine, name), (made) =>
          byId(
            machine,
            "write",
            `capture ${machine} to ${made}`,
            (api) => api.checkpoint.capture({ payload: { machine, name } }),
            made,
          ),
        ),
      deleteCheckpoint: (id) =>
        byId(id, "write", `delete ${id}`, (api) => api.checkpoint.delete({ payload: { id } })),
    } satisfies Interface;
  });

/** The client over Node's `http` module, which sets no timeout: a mutation can run for hours. */
export const layer = (hosts: ReadonlyArray<HostEntry>): Layer.Layer<Client> =>
  Layer.effect(Client, make(hosts)).pipe(Layer.provide(NodeHttpClient.layerNodeHttp));
