/**
 * The machine actions: create, start, stop and delete, and fork and restore, which make a
 * machine from another machine or from a checkpoint. They run in the order `actions.ts`
 * describes.
 */
import {
  type ActionName,
  type CreateRequest,
  formatId,
  type HostError,
  type Machine,
  Precondition,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, DateTime, Effect, Layer, type Scope, Semaphore } from "effect";
import { checkpointRef, claimsOn, detacher, machineRef, rowsOn } from "./actions.ts";
import type { HostConfig } from "./config.ts";
import { idOn, nameOn, newInstance } from "./ids.ts";
import { prepare, runSetup } from "./guest.ts";
import { pickPort } from "./ports.ts";
import { observeConcurrency, type Refusal, Runtime } from "./runtime.ts";
import { type MachineRecord, type NewMachine, type Rows, Store, type Token } from "./store.ts";

export interface Interface {
  readonly list: Effect.Effect<ReadonlyArray<Machine>, HostError>;
  readonly get: (id: string) => Effect.Effect<Machine, HostError>;
  readonly create: (request: CreateRequest) => Effect.Effect<Machine, HostError>;
  /** Boots a stopped machine and prepares it; on a running machine, prepares it again. */
  readonly start: (id: string) => Effect.Effect<Machine, HostError>;
  /** Stops a running machine; on any other, does nothing. */
  readonly stop: (id: string) => Effect.Effect<Machine, HostError>;
  readonly delete: (id: string) => Effect.Effect<void, HostError>;
  /** Copies the machine `id` to a new machine named `name`, and prepares the copy. */
  readonly fork: (id: string, name: string) => Effect.Effect<Machine, HostError>;
  /** Makes a machine named `name` from the checkpoint `checkpoint`, and prepares it. */
  readonly restore: (checkpoint: string, name: string) => Effect.Effect<Machine, HostError>;
}

export class Machines extends Context.Service<Machines, Interface>()("@clankerbox/host/Machines") {}

/** What a new machine is made with: its base, label and sizes. */
interface Spec extends Pick<MachineRecord, "base" | "cpu" | "ramMib" | "diskGib"> {
  readonly profile?: string | undefined;
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
    const detached = yield* detacher;
    const admission = yield* Semaphore.make(1);

    yield* store.failInterrupted;
    yield* runtime.startup;

    const idOf = idOn(config.id);
    const nameOf = nameOn(config.id);
    const rows = rowsOn(store, config.id);
    const { claimAndCheck, native, done } = claimsOn(store);
    const ref = (record: NewMachine) => machineRef(config.id, record);

    /** Runs native work that may need the runtime, such as preparation. */
    const withRuntime = <A>(work: Effect.Effect<A, HostError | Refusal, Runtime>) =>
      Effect.provideService(work, Runtime, runtime);

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

    const read = (name: string) => Effect.flatMap(rows.machine(name), resource);

    /** A new row, with the lowest port that no row holds and nothing listens on. */
    const newRow = (name: string, spec: Spec) =>
      Effect.gen(function* () {
        const address = runtime.publishAddress;

        const row: NewMachine = {
          name,
          instance: newInstance(),
          native: undefined,
          createdAt: yield* DateTime.now,
          base: spec.base,
          profile: spec.profile,
          cpu: spec.cpu,
          ramMib: spec.ramMib,
          diskGib: spec.diskGib,
          port: address === undefined ? undefined : yield* pickPort(address, yield* store.ports),
          hostKey: undefined,
        };

        return row;
      });

    const inserting = (row: NewMachine): Rows => ({ insert: { table: "machines", record: row } });

    const holding = (name: string): Rows => ({ hold: [{ table: "machines", name }] });

    /**
     * Steps 2 and 3 for an action that boots a machine or allocates a port, one at a time. The
     * RAM budget counts every machine a booting action holds, so two such actions checked at
     * once would each count the other, and both could be refused although one fits. One at a
     * time, exactly one of two that fit only alone passes, and no two pick the same port.
     */
    const admitted = admission.withPermits(1);

    /** Step 3 for an action that boots a machine: the runtime's own checks, over every row. */
    const admit = (action: ActionName, machine: NewMachine, source?: MachineRecord) =>
      Effect.flatMap(store.list, (records) =>
        runtime.admit({
          action,
          machine: ref(machine),
          machines: records.map((held) => ({
            machine: ref(held),
            holder: held.action.status === "running" ? held.action.name : undefined,
          })),
          source: source === undefined ? undefined : ref(source),
        }),
      );

    /**
     * A fork or `ram` restore makes its VM on the source's port and moves it to its own before
     * the first boot, so one that failed between may sit on another machine's port, and a boot
     * would publish it there. Such a machine is only stopped or deleted.
     */
    const bootable = (token: Token) => {
      const replaced = token.held[0]?.before;

      return replaced?.status === "failed" &&
        (replaced.name === "fork" || replaced.name === "restore")
        ? Effect.fail(
            new Precondition({
              message: `machine ${idOf(token.held[0]?.name ?? "")}'s ${replaced.name} failed, which can leave it on another machine's port, so it doesn't start; delete it`,
            }),
          )
        : Effect.void;
    };

    const create = (request: CreateRequest) =>
      Effect.gen(function* () {
        const name = yield* nameOf(request.id);
        const image = config.bases.get(request.base);

        if (image === undefined) {
          return yield* new Precondition({
            message: `host ${config.id} doesn't offer base ${request.base}; it offers ${[...config.bases.keys()].join(", ") || "no bases"}`,
          });
        }

        const [token, row] = yield* admitted(
          Effect.flatMap(newRow(name, request), (row) =>
            claimAndCheck("create", inserting(row), () => Effect.as(admit("create", row), row)),
          ),
        );

        const machine = ref(row);

        const hostKey = yield* native(
          token,
          `create ${machine.id}`,
          withRuntime(
            Effect.gen(function* () {
              yield* runtime.create(machine, image);

              if (request.setup !== undefined) {
                yield* runSetup(machine, request.setup);
              }

              return yield* prepare(machine);
            }),
          ),
        );

        yield* done(token, hostKey);

        return yield* read(name);
      });

    const start = (id: string) =>
      Effect.gen(function* () {
        const name = yield* nameOf(id);

        const [token, { record, running }] = yield* admitted(
          claimAndCheck("start", holding(name), (_join, claimed) =>
            Effect.gen(function* () {
              const record = yield* rows.machine(name);
              const { state } = yield* runtime.observe(ref(record));

              if (state === "missing") {
                return yield* new Precondition({
                  message: `machine ${id} is missing from the ${runtime.name} runtime; delete it`,
                });
              }

              if (state !== "running") {
                yield* bootable(claimed);
                yield* admit("start", record);
              }

              return { record, running: state === "running" };
            }),
          ),
        );

        const machine = ref(record);

        const hostKey = yield* native(
          token,
          `start ${id}`,
          withRuntime(
            Effect.andThen(running ? Effect.void : runtime.start(machine), prepare(machine)),
          ),
        );

        yield* done(token, hostKey);

        return yield* read(name);
      });

    const stop = (id: string) =>
      Effect.gen(function* () {
        const name = yield* nameOf(id);

        const [token, { record, state }] = yield* claimAndCheck("stop", holding(name), () =>
          Effect.flatMap(rows.machine(name), (record) =>
            Effect.map(runtime.observe(ref(record)), ({ state }) => ({ record, state })),
          ),
        );

        if (state === "running") {
          yield* native(token, `stop ${id}`, runtime.stop(ref(record)));
          yield* done(token);
        } else {
          yield* store.release(token);
        }

        return yield* read(name);
      });

    const remove = (id: string) =>
      Effect.gen(function* () {
        const name = yield* nameOf(id);

        const [token, record] = yield* claimAndCheck("delete", holding(name), () =>
          rows.machine(name),
        );

        yield* native(token, `delete ${id}`, runtime.delete(ref(record)));
        yield* store.remove({ table: "machines", name });
      });

    /**
     * Claims the source, then, under the permit, inserts the new row with the source's spec into
     * the same claim and admits it.
     */
    const fork = (sourceId: string, name: string) =>
      Effect.gen(function* () {
        const sourceName = yield* nameOf(sourceId);
        const id = yield* formatId(config.id, name);

        const [token, { row, source }] = yield* admitted(
          claimAndCheck("fork", holding(sourceName), (join) =>
            Effect.gen(function* () {
              const source = yield* rows.machine(sourceName);
              const row = yield* newRow(name, source);

              yield* join(inserting(row));
              yield* admit("fork", row, source);

              return { row, source };
            }),
          ),
        );

        const machine = ref(row);

        const hostKey = yield* native(
          token,
          `fork ${id}`,
          withRuntime(Effect.andThen(runtime.fork(ref(source), machine), prepare(machine))),
        );

        yield* done(token, hostKey);

        return yield* read(name);
      });

    /**
     * A restore reads its checkpoint without claiming it: a ready checkpoint never changes, so
     * restores of one checkpoint run in parallel. One deleted under the restore fails it like
     * any runtime failure.
     */
    const ready = (id: string) =>
      Effect.gen(function* () {
        const checkpoint = yield* rows.checkpoint(yield* nameOf(id));

        if (checkpoint.action.status !== "done") {
          return yield* new Precondition({
            message: `checkpoint ${id} isn't ready: its ${checkpoint.action.name} is ${checkpoint.action.status}`,
          });
        }

        if (checkpoint.kind === "ram" && checkpoint.pin !== runtime.pin) {
          return yield* new Precondition({
            message: `checkpoint ${id} holds RAM state saved under ${checkpoint.pin ?? "no pin"}, and this host runs ${runtime.pin ?? "no pin"}; it restores only under the same one`,
          });
        }

        return checkpoint;
      });

    const restore = (checkpointId: string, name: string) =>
      Effect.gen(function* () {
        const id = yield* formatId(config.id, name);
        const checkpoint = yield* ready(checkpointId);

        const [token, row] = yield* admitted(
          Effect.flatMap(newRow(name, checkpoint), (row) =>
            claimAndCheck("restore", inserting(row), () => Effect.as(admit("restore", row), row)),
          ),
        );

        const machine = ref(row);

        const hostKey = yield* native(
          token,
          `restore ${id}`,
          withRuntime(
            Effect.andThen(
              runtime.restore(checkpointRef(config.id, checkpoint), machine),
              prepare(machine),
            ),
          ),
        );

        yield* done(token, hostKey);

        return yield* read(name);
      });

    return {
      list: Effect.flatMap(store.list, (records) =>
        Effect.forEach(records, resource, { concurrency: observeConcurrency }),
      ),
      get: (id) => Effect.flatMap(nameOf(id), read),
      create: (request) => detached(`create ${request.id}`, create(request)),
      start: (id) => detached(`start ${id}`, start(id)),
      stop: (id) => detached(`stop ${id}`, stop(id)),
      delete: (id) => detached(`delete ${id}`, remove(id)),
      fork: (id, name) => detached(`fork ${id} to ${name}`, fork(id, name)),
      restore: (checkpoint, name) =>
        detached(`restore ${checkpoint} to ${name}`, restore(checkpoint, name)),
    } satisfies Interface;
  });

export const layer = (
  config: Pick<HostConfig, "id" | "bases">,
): Layer.Layer<Machines, HostError, Store | Runtime> => Layer.effect(Machines, make(config));
