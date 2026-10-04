/**
 * The machine actions. Every mutation runs in this order:
 *
 * 1. Validate the input.
 * 2. Claim the rows in one transaction, inserting the new row.
 * 3. Check runtime state, including the runtime's own `admit`.
 * 4. Only then call the runtime.
 *
 * A failure in steps 1–3, or a runtime `Refusal`, releases the claim and writes nothing; any
 * later failure leaves the row's action `failed` with the error the call replies with. Each
 * mutation runs in a fiber of the host's own, so a dropped connection never interrupts it and
 * its outcome is recorded either way.
 */
import { randomBytes } from "node:crypto";
import {
  type ActionName,
  type CreateRequest,
  type HostError,
  Internal,
  Invalid,
  type Machine,
  NotFound,
  parseId,
  Precondition,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, DateTime, Effect, Fiber, FiberSet, Layer, Option, type Scope } from "effect";
import type { HostConfig } from "./config.ts";
import { prepare, runSetup } from "./guest.ts";
import { pickPort } from "./ports.ts";
import { type MachineRef, Refusal, Runtime } from "./runtime.ts";
import { type MachineRecord, type NewMachine, Store } from "./store.ts";

export interface Interface {
  readonly list: Effect.Effect<ReadonlyArray<Machine>, HostError>;
  readonly get: (id: string) => Effect.Effect<Machine, HostError>;
  readonly create: (request: CreateRequest) => Effect.Effect<Machine, HostError>;
  /** Boots a stopped machine and prepares it; on a running machine, prepares it again. */
  readonly start: (id: string) => Effect.Effect<Machine, HostError>;
  /** Stops a running machine; on any other, does nothing. */
  readonly stop: (id: string) => Effect.Effect<Machine, HostError>;
  readonly delete: (id: string) => Effect.Effect<void, HostError>;
}

export class Machines extends Context.Service<Machines, Interface>()("@clankerbox/host/Machines") {}

/** The bytes of a row's `instance`: 32 hex characters. */
const instanceBytes = 16;

/** An action's hold on a row, and how to give it back without writing anything. */
interface Claim {
  /** The row as the action holds it. */
  readonly record: MachineRecord;
  /** Removes the row the action inserted, or puts back the action it replaced. */
  readonly release: Effect.Effect<void, Internal>;
}

/**
 * Builds the actions. Before it returns, every action the last host process left running is
 * marked failed and the runtime runs its own startup cleanup, so nothing is served before.
 */
export const make = (
  config: Pick<HostConfig, "id" | "bases">,
): Effect.Effect<Interface, HostError, Store | Runtime | Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const runtime = yield* Runtime;
    const actions = yield* FiberSet.make<unknown>();

    yield* store.failInterrupted;
    yield* runtime.startup;

    const idOf = (name: string) => `${config.id}_${name}`;

    const ref = (record: MachineRecord): MachineRef => ({
      id: idOf(record.name),
      name: record.name,
      instance: record.instance,
      native: record.native,
      cpu: record.cpu,
      ramMib: record.ramMib,
      diskGib: record.diskGib,
      port: record.port,
    });

    /** The machine as the API reports it, its state read from the runtime. */
    const resource = (record: MachineRecord) =>
      Effect.map(runtime.observe(ref(record)), (observed) => {
        let machine: Machine = {
          id: idOf(record.name),
          runtime: runtime.name,
          createdAt: record.createdAt,
          base: record.base,
          cpu: record.cpu,
          ramMib: record.ramMib,
          diskGib: record.diskGib,
          state: observed.state,
          action: record.action,
        };

        if (record.profile !== undefined) {
          machine = { ...machine, profile: record.profile };
        }

        if (observed.ssh !== undefined) {
          machine = { ...machine, ssh: observed.ssh };
        }

        if (record.hostKey !== undefined) {
          machine = { ...machine, hostKey: record.hostKey };
        }

        return machine;
      });

    /**
     * The name an ID gives on this host: the whole ID is checked, and an ID for another host is
     * the caller's mistake. A new machine's ID goes through here too, so the ID a row's machine
     * reports always fits clankercreds' pattern.
     */
    const nameOf = (id: string) =>
      Effect.flatMap(parseId(id), ({ host, name }) =>
        host === config.id
          ? Effect.succeed(name)
          : Effect.fail(
              new Invalid({ message: `${id} names host ${host}, and this is host ${config.id}` }),
            ),
      );

    const find = (name: string) =>
      Effect.flatMap(
        store.find(name),
        Option.match({
          onNone: () => Effect.fail(new NotFound({ message: `no machine ${idOf(name)}` })),
          onSome: Effect.succeed,
        }),
      );

    const read = (name: string) => Effect.flatMap(find(name), resource);

    /** Inserts the new row with a port no row holds and nothing listens on, picking again on a collision. */
    const claimNew = (name: string, request: CreateRequest): Effect.Effect<Claim, HostError> =>
      Effect.gen(function* () {
        const createdAt = yield* DateTime.now;
        const instance = randomBytes(instanceBytes).toString("hex");
        const address = runtime.publishAddress;

        for (;;) {
          const port =
            address === undefined ? undefined : yield* pickPort(address, yield* store.ports);

          const row: NewMachine = {
            name,
            instance,
            native: undefined,
            createdAt,
            base: request.base,
            profile: request.profile,
            cpu: request.cpu,
            ramMib: request.ramMib,
            diskGib: request.diskGib,
            port,
            hostKey: undefined,
            action: "create",
          };

          const inserted = yield* store.insert(row).pipe(
            Effect.as(true),
            Effect.catchTag("PortTaken", () => Effect.succeed(false)),
          );

          if (inserted) {
            return {
              record: { ...row, action: { name: row.action, status: "running" } },
              release: store.remove(row.name),
            };
          }
        }
      });

    const claimExisting = (name: string, action: ActionName): Effect.Effect<Claim, HostError> =>
      Effect.map(store.claim(name, action), (before) => ({
        record: { ...before, action: { name: action, status: "running" } },
        release: store.record(name, { action: before.action }),
      }));

    /**
     * Steps 2 and 3: claims, then checks. A check that fails, or is interrupted, releases the
     * claim, so nothing is written.
     */
    const claimAndCheck = <B>(
      claim: Effect.Effect<Claim, HostError>,
      check: (record: MachineRecord) => Effect.Effect<B, HostError>,
    ): Effect.Effect<readonly [Claim, B], HostError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.flatMap(claim, (claimed) =>
          restore(check(claimed.record)).pipe(
            Effect.onError(() => Effect.ignore(claimed.release)),
            Effect.map((checked) => [claimed, checked] as const),
          ),
        ),
      );

    /**
     * Step 4 on. A runtime `Refusal` releases the claim like a failed check; any other failure
     * leaves the row failed with the error the call replies with. A defect is recorded as
     * `Internal`, so the row stays deletable.
     */
    const native = <A>(
      claimed: Claim,
      work: Effect.Effect<A, HostError | Refusal, Runtime>,
    ): Effect.Effect<A, HostError> => {
      const { name, action } = claimed.record;

      return work.pipe(
        Effect.provideService(Runtime, runtime),
        Effect.catchDefect((defect) =>
          Effect.fail(
            new Internal({ message: `${action.name} ${idOf(name)} died: ${String(defect)}` }),
          ),
        ),
        Effect.catch((error) =>
          error instanceof Refusal
            ? Effect.andThen(claimed.release, Effect.fail(error.error))
            : Effect.andThen(
                store.record(name, {
                  action: {
                    name: action.name,
                    status: "failed",
                    error: { tag: error._tag, message: error.message },
                  },
                }),
                Effect.fail(error),
              ),
        ),
      );
    };

    const done = (claimed: Claim, hostKey?: string) =>
      store.record(claimed.record.name, {
        action: { name: claimed.record.action.name, status: "done" },
        hostKey,
      });

    /** Step 3 for an action that boots a machine: the runtime's own checks, over every row. */
    const admit = (action: ActionName, record: MachineRecord) =>
      Effect.flatMap(store.list, (records) =>
        runtime.admit({
          action,
          machine: ref(record),
          machines: records.map((held) => ({
            machine: ref(held),
            holder: held.action.status === "running" ? held.action.name : undefined,
          })),
        }),
      );

    /** Runs a mutation in the host's own fiber set; the caller only waits for it. */
    const detached = <A>(action: Effect.Effect<A, HostError>): Effect.Effect<A, HostError> =>
      Effect.flatMap(FiberSet.run(actions, Effect.result(action)), (fiber) =>
        Effect.flatMap(Fiber.join(fiber), Effect.fromResult),
      );

    const logged = <A>(what: string, action: Effect.Effect<A, HostError>) =>
      Effect.tapError(action, (error) =>
        Effect.logWarning(`${what} failed: ${error._tag}: ${error.message}`),
      );

    const create = (request: CreateRequest) =>
      Effect.gen(function* () {
        const name = yield* nameOf(request.id);
        const image = config.bases.get(request.base);

        if (image === undefined) {
          return yield* new Precondition({
            message: `host ${config.id} doesn't offer base ${request.base}; it offers ${[...config.bases.keys()].join(", ") || "no bases"}`,
          });
        }

        const [claimed] = yield* claimAndCheck(claimNew(name, request), (record) =>
          admit("create", record),
        );

        const machine = ref(claimed.record);

        const hostKey = yield* native(
          claimed,
          Effect.gen(function* () {
            yield* runtime.create(machine, image);

            if (request.setup !== undefined) {
              yield* runSetup(machine, request.setup);
            }

            return yield* prepare(machine);
          }),
        );

        yield* done(claimed, hostKey);

        return yield* read(name);
      });

    const start = (id: string) =>
      Effect.gen(function* () {
        const name = yield* nameOf(id);

        const [claimed, running] = yield* claimAndCheck(claimExisting(name, "start"), (record) =>
          Effect.flatMap(runtime.observe(ref(record)), ({ state }) => {
            if (state === "missing") {
              return Effect.fail(
                new Precondition({
                  message: `machine ${id} is missing from the ${runtime.name} runtime; delete it`,
                }),
              );
            }

            return state === "running"
              ? Effect.succeed(true)
              : Effect.as(admit("start", record), false);
          }),
        );

        const machine = ref(claimed.record);

        const hostKey = yield* native(
          claimed,
          Effect.andThen(running ? Effect.void : runtime.start(machine), prepare(machine)),
        );

        yield* done(claimed, hostKey);

        return yield* read(name);
      });

    const stop = (id: string) =>
      Effect.gen(function* () {
        const name = yield* nameOf(id);

        const [claimed, { state }] = yield* claimAndCheck(claimExisting(name, "stop"), (record) =>
          runtime.observe(ref(record)),
        );

        if (state === "running") {
          yield* native(claimed, runtime.stop(ref(claimed.record)));
          yield* done(claimed);
        } else {
          yield* claimed.release;
        }

        return yield* read(name);
      });

    const remove = (id: string) =>
      Effect.gen(function* () {
        const name = yield* nameOf(id);
        const [claimed] = yield* claimAndCheck(claimExisting(name, "delete"), () => Effect.void);

        yield* native(claimed, runtime.delete(ref(claimed.record)));
        yield* store.remove(name);
      });

    return {
      list: Effect.flatMap(store.list, (records) =>
        Effect.forEach(records, resource, { concurrency: "unbounded" }),
      ),
      get: (id) => Effect.flatMap(nameOf(id), read),
      create: (request) => detached(logged(`create ${request.id}`, create(request))),
      start: (id) => detached(logged(`start ${id}`, start(id))),
      stop: (id) => detached(logged(`stop ${id}`, stop(id))),
      delete: (id) => detached(logged(`delete ${id}`, remove(id))),
    } satisfies Interface;
  });

export const layer = (
  config: Pick<HostConfig, "id" | "bases">,
): Layer.Layer<Machines, HostError, Store | Runtime> => Layer.effect(Machines, make(config));
