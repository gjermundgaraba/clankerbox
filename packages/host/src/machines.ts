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
  Internal,
  type Machine,
  Precondition,
} from "@gjermundgaraba/clankerbox-sdk";
import { Array as Arr, Context, DateTime, Effect, Layer, type Scope, Semaphore } from "effect";
import { checkpointRef, claimsOn, detacher, machineRef, madeOn, rowsOn } from "./actions.ts";
import type { HostConfig } from "./config.ts";
import { idOn, nameOn, newInstance } from "./ids.ts";
import { prepare, runSetup } from "./guest.ts";
import { pickPort } from "./ports.ts";
import { type MachineRef, type Observed, type Refusal, Runtime } from "./runtime.ts";
import { type MachineRecord, type NewMachine, type Holding, type NewRow, Store } from "./store.ts";

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

/** The native work that makes a new machine, before its preparation. */
type Work = Effect.Effect<void, HostError | Refusal, Runtime>;

/**
 * What a new machine is made from: a spec, or for a fork, the machine it copies, which the fork
 * holds and whose spec it takes. `work` makes it.
 */
type Making =
  | { readonly spec: Spec; readonly work: (machine: MachineRef) => Work }
  | {
      readonly source: string;
      readonly work: (machine: MachineRef, source: MachineRef) => Work;
    };

/** Builds the actions, once the host's startup step has run (`index.ts`). */
export const make = (
  config: Pick<HostConfig, "id" | "bases">,
): Effect.Effect<Interface, HostError, Store | Runtime | Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const runtime = yield* Runtime;
    const detached = yield* detacher;
    const admission = yield* Semaphore.make(1);

    const idOf = idOn(config.id);
    const nameOf = nameOn(config.id);
    const rows = rowsOn(store, config.id);
    const made = madeOn(config.id);
    const { claimAndCheck, native, done } = claimsOn(store);
    const ref = (record: NewMachine) => machineRef(config.id, record);

    /**
     * The machines that admitted actions are booting, one entry per action until it ends. The
     * rows can't tell: a fork holds its source, which it doesn't boot, under the same action as
     * the copy it does.
     */
    const booting = new Set<{ readonly name: string }>();

    /** Runs native work that may need the runtime, such as preparation. */
    const withRuntime = <A>(work: Effect.Effect<A, HostError | Refusal, Runtime>) =>
      Effect.provideService(work, Runtime, runtime);

    /** The machine as the API reports it, with the state the runtime read. */
    const resource = (record: MachineRecord, observed: Observed) => {
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
    };

    /** One machine's state, read from the runtime. */
    const observe = (record: MachineRecord) =>
      Effect.flatMap(runtime.observe([ref(record)]), ([observed]) =>
        observed === undefined
          ? Effect.fail(
              new Internal({
                message: `the ${runtime.name} runtime read no state for ${idOf(record.name)}`,
              }),
            )
          : Effect.succeed(observed),
      );

    const read = (name: string) =>
      Effect.flatMap(rows.machine(name), (record) =>
        Effect.map(observe(record), (observed) => resource(record, observed)),
      );

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

    const inserting = (row: NewMachine): NewRow => ({ table: "machines", record: row });

    const holding = (name: string): Holding<"machines"> => ({
      hold: { table: "machines", name },
    });

    /**
     * Steps 2 and 3 for an action that boots a machine or allocates a port, one at a time. The
     * RAM budget counts every machine a booting action holds, so two such actions checked at
     * once would each count the other, and both could be refused although one fits. One at a
     * time, exactly one of two that fit only alone passes, and no two pick the same port.
     */
    const admitted = admission.withPermits(1);

    /**
     * Step 3 for an action that boots a machine: the runtime's own checks, over every row. Once
     * admitted, the machine counts as booting until the action's scope closes, after its end:
     * an entry removed before the end could let another action past its check while this one
     * still boots.
     */
    const admit = (action: ActionName, machine: NewMachine) =>
      Effect.gen(function* () {
        const records = yield* store.list;
        const boots = new Set([machine.name, ...Array.from(booting, ({ name }) => name)]);

        yield* runtime.admit({
          action,
          machine: ref(machine),
          machines: records.map((held) => ({ machine: ref(held), booting: boots.has(held.name) })),
        });

        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const entry = { name: machine.name };

            booting.add(entry);

            return entry;
          }),
          (entry) => Effect.sync(() => booting.delete(entry)),
        );
      });

    /**
     * Create, fork and restore: under the admission permit, a create or restore claims its new
     * row, with the lowest free port; a fork claims its source, then joins the new row, with the
     * source's spec. The new row is admitted, the work makes the machine, preparation runs, and
     * the action ends done.
     */
    const makeMachine = (action: "create" | "fork" | "restore", name: string, making: Making) =>
      Effect.scoped(
        Effect.gen(function* () {
          const [token, { row, work }] = yield* admitted(
            "source" in making
              ? claimAndCheck(store.claim(action, holding(making.source)), (source, join) =>
                  Effect.gen(function* () {
                    yield* made(source);

                    const row = yield* newRow(name, source);

                    yield* join(inserting(row));
                    yield* admit(action, row);

                    return {
                      row,
                      work: (machine: MachineRef) => making.work(machine, ref(source)),
                    };
                  }),
                )
              : Effect.flatMap(newRow(name, making.spec), (row) =>
                  claimAndCheck(store.claim(action, { insert: inserting(row) }), () =>
                    Effect.as(admit(action, row), { row, work: making.work }),
                  ),
                ),
          );

          const machine = ref(row);

          const hostKey = yield* native(
            token,
            `${action} ${machine.id}`,
            withRuntime(Effect.andThen(work(machine), prepare(machine))),
          );

          yield* done(token, { prepared: { name, hostKey }, made: name });

          return yield* read(name);
        }),
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

        return yield* makeMachine("create", name, {
          spec: request,
          work: (machine: MachineRef) =>
            Effect.andThen(
              runtime.create(machine, image),
              request.setup === undefined ? Effect.void : runSetup(machine, request.setup),
            ),
        });
      });

    const start = (id: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const name = yield* nameOf(id);

          const [token, { record, running }] = yield* admitted(
            claimAndCheck(store.claim("start", holding(name)), (record) =>
              Effect.gen(function* () {
                yield* made(record);

                const { state } = yield* observe(record);

                if (state === "missing") {
                  return yield* new Precondition({
                    message: `machine ${id} is missing from the ${runtime.name} runtime; delete it`,
                  });
                }

                if (state !== "running") {
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

          yield* done(token, { prepared: { name, hostKey } });

          return yield* read(name);
        }),
      );

    const stop = (id: string) =>
      Effect.gen(function* () {
        const name = yield* nameOf(id);

        const [token, { record, state }] = yield* claimAndCheck(
          store.claim("stop", holding(name)),
          (record) =>
            Effect.andThen(
              made(record),
              Effect.map(observe(record), ({ state }) => ({ record, state })),
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

        const [token, record] = yield* claimAndCheck(
          store.claim("delete", holding(name)),
          Effect.succeed,
        );

        yield* native(token, `delete ${id}`, runtime.delete(ref(record)));
        yield* store.remove({ table: "machines", name });
      });

    const fork = (sourceId: string, name: string) =>
      Effect.gen(function* () {
        const source = yield* nameOf(sourceId);

        yield* formatId(config.id, name);

        return yield* makeMachine("fork", name, {
          source,
          work: (machine, from) => runtime.fork(from, machine),
        });
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
        yield* formatId(config.id, name);

        const checkpoint = yield* ready(checkpointId);

        return yield* makeMachine("restore", name, {
          spec: checkpoint,
          work: (machine: MachineRef) =>
            runtime.restore(checkpointRef(config.id, checkpoint), machine),
        });
      });

    return {
      list: Effect.flatMap(store.list, (records) =>
        Effect.map(runtime.observe(records.map(ref)), (observed) =>
          Arr.zipWith(records, observed, resource),
        ),
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
