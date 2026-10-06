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
  type Setup,
} from "@gjermundgaraba/clankerbox-sdk";
import { Array as Arr, Context, DateTime, Effect, Layer, type Scope, Semaphore } from "effect";
import { checkpointRef, claimsOn, detacher, machineRef, madeOn, rowsOn } from "./actions.ts";
import type { HostConfig } from "./config.ts";
import { idOn, nameOn, newInstance } from "./ids.ts";
import { prepare, runSetup } from "./guest.ts";
import { pickPort } from "./ports.ts";
import { type MachineRef, type Observed, type Refusal, Runtime } from "./runtime.ts";
import { type MachineRecord, type NewMachine, type NewRow, Store } from "./store.ts";

export interface Interface {
  readonly list: Effect.Effect<ReadonlyArray<Machine>, HostError>;
  readonly get: (id: string) => Effect.Effect<Machine, HostError>;
  readonly create: (request: CreateRequest) => Effect.Effect<Machine, HostError>;
  /**
   * Boots a stopped machine and prepares it; on a running machine, prepares it again. Every
   * start is admitted and calls the runtime's start, which refuses a missing machine.
   */
  readonly start: (id: string) => Effect.Effect<Machine, HostError>;
  /**
   * Stops the machine through the runtime's stop, made or not: a stop boots nothing, so it may
   * stop the VM a failed create, fork or restore left running. The runtime's stop does nothing
   * on a machine that doesn't run.
   */
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
 * holds and whose spec it takes. `work` makes it; a create's `setup` then runs in it.
 */
type Making =
  | {
      readonly spec: Spec;
      readonly work: (machine: MachineRef) => Work;
      readonly setup?: Setup | undefined;
    }
  | {
      readonly source: string;
      readonly work: (machine: MachineRef, source: MachineRef) => Work;
    };

/** Builds the actions, once the host's startup step has run (`index.ts`). */
export const make = (
  config: Pick<HostConfig, "id" | "bases" | "machinePorts">,
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

    /** Runs native work that may need the runtime, such as preparation. */
    const withRuntime = <A>(work: Effect.Effect<A, HostError | Refusal, Runtime>) =>
      Effect.provideService(work, Runtime, runtime);

    /**
     * Where a running machine's guest port 22 is reached: on its host port of the publish
     * address, for a runtime that has one, or where the runtime reports. A machine that doesn't
     * run has none.
     */
    const sshOf = (record: MachineRecord, observed: Observed) => {
      if (observed.state !== "running") {
        return undefined;
      }

      return runtime.publishAddress === undefined || record.port === undefined
        ? observed.ssh
        : { host: runtime.publishAddress, port: record.port };
    };

    /** The machine as the API reports it, with the state the runtime read. */
    const resource = (record: MachineRecord, observed: Observed) => {
      const ssh = sshOf(record, observed);

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

      if (ssh !== undefined) {
        machine = { ...machine, ssh };
      }

      if (record.hostKey !== undefined) {
        machine = { ...machine, hostKey: record.hostKey };
      }

      return machine;
    };

    /**
     * The machines' states, read from the runtime. A read that fails as a whole, as Tart's one
     * `tart list` can, reads every machine `unknown`: a state read never fails an action.
     */
    const observeAll = (records: ReadonlyArray<MachineRecord>) =>
      runtime.observe(records.map(ref)).pipe(
        Effect.catch((error) =>
          Effect.as(
            Effect.logWarning(`couldn't read the machines' states: ${error.message}`),
            records.map((): Observed => ({ state: "unknown" })),
          ),
        ),
      );

    const read = (name: string) =>
      Effect.flatMap(rows.machine(name), (record) =>
        Effect.map(observeAll([record]), ([observed]) => resource(record, observed)),
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
          port:
            address === undefined
              ? undefined
              : yield* pickPort(address, config.machinePorts, yield* store.ports),
          hostKey: undefined,
        };

        return row;
      });

    const inserting = (row: NewMachine): NewRow => ({ table: "machines", record: row });

    const holding = (action: ActionName, name: string) =>
      store.hold(action, { table: "machines", name });

    /**
     * Steps 2 and 3 for an action that boots a machine or allocates a port, one at a time. The
     * RAM budget counts every machine a booting action holds, so two such actions checked at
     * once would each count the other, and both could be refused although one fits. One at a
     * time, exactly one of two that fit only alone passes, and no two pick the same port.
     */
    const admitted = admission.withPermits(1);

    /**
     * Whether an action is booting the machine: a running create, restore or start, or a running
     * fork on the copy it hasn't made yet, not on its made source. A copy is made once its VM
     * runs, so in preparation it counts as running instead. Booting actions claim under the
     * admission permit, so any other such row is past its check, and the target's row is already
     * claimed. A start on a running machine boots nothing yet reads booting, which counts no
     * machine twice; a row whose release or end failed reads booting until the next host start.
     */
    const boots = ({ action, made }: MachineRecord) =>
      action.status === "running" &&
      (action.name === "create" ||
        action.name === "restore" ||
        action.name === "start" ||
        (action.name === "fork" && !made));

    /** Step 3 for an action that boots a machine: the runtime's own checks, over every row. */
    const admit = (action: ActionName, machine: NewMachine) =>
      Effect.flatMap(store.list, (records) =>
        runtime.admit({
          action,
          machine: ref(machine),
          machines: records.map((held) => ({ machine: ref(held), booting: boots(held) })),
        }),
      );

    /**
     * Create, fork and restore: under the admission permit, a create or restore claims its new
     * row, with the lowest free port; a fork claims its source, then joins the new row, with the
     * source's spec. The new row is admitted, the work makes the machine, a create's setup runs,
     * the machine is marked made, preparation runs, and the action ends done. The work may have
     * recorded the runtime's own ID on the row, so setup and preparation read the row again. A
     * failure in preparation leaves the machine made, so `start` prepares it again; one before,
     * or in the marking, leaves it unmade.
     */
    const makeMachine = (action: "create" | "fork" | "restore", name: string, making: Making) =>
      Effect.gen(function* () {
        const [token, { row, work }] = yield* admitted(
          "source" in making
            ? claimAndCheck(holding(action, making.source), (source, join) =>
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
                claimAndCheck(
                  Effect.map(store.insert(action, inserting(row)), (token) => ({
                    token,
                    held: row,
                  })),
                  () => Effect.as(admit(action, row), { row, work: making.work }),
                ),
              ),
        );

        const machine = ref(row);
        const setup = "setup" in making ? making.setup : undefined;

        const hostKey = yield* native(
          token,
          `${action} ${machine.id}`,
          withRuntime(
            Effect.gen(function* () {
              yield* work(machine);

              const current = ref(yield* rows.machine(name));

              if (setup !== undefined) {
                yield* runSetup(current, setup);
              }

              yield* store.markMade(token);

              return yield* prepare(current);
            }),
          ),
        );

        yield* done(token, { prepared: { name, hostKey } });

        return yield* read(name);
      });

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
          work: (machine: MachineRef) => runtime.create(machine, image),
          setup: request.setup,
        });
      });

    const start = (id: string) =>
      Effect.gen(function* () {
        const name = yield* nameOf(id);

        const [token, record] = yield* admitted(
          claimAndCheck(holding("start", name), (record) =>
            Effect.andThen(made(record), Effect.as(admit("start", record), record)),
          ),
        );

        const machine = ref(record);

        const hostKey = yield* native(
          token,
          `start ${id}`,
          withRuntime(Effect.andThen(runtime.start(machine), prepare(machine))),
        );

        yield* done(token, { prepared: { name, hostKey } });

        return yield* read(name);
      });

    const stop = (id: string) =>
      Effect.gen(function* () {
        const name = yield* nameOf(id);

        const [token, record] = yield* claimAndCheck(holding("stop", name), Effect.succeed);

        yield* native(token, `stop ${id}`, runtime.stop(ref(record)));
        yield* done(token);

        return yield* read(name);
      });

    const remove = (id: string) =>
      Effect.gen(function* () {
        const name = yield* nameOf(id);

        const [token, record] = yield* claimAndCheck(holding("delete", name), Effect.succeed);

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
        Effect.map(observeAll(records), (observed) => Arr.zipWith(records, observed, resource)),
      ).pipe(Effect.withSpan("Machines.list")),
      get: Effect.fn("Machines.get")((id) => Effect.flatMap(nameOf(id), read)),
      create: Effect.fn("Machines.create")((request) =>
        detached(`create ${request.id}`, create(request)),
      ),
      start: Effect.fn("Machines.start")((id) => detached(`start ${id}`, start(id))),
      stop: Effect.fn("Machines.stop")((id) => detached(`stop ${id}`, stop(id))),
      delete: Effect.fn("Machines.delete")((id) => detached(`delete ${id}`, remove(id))),
      fork: Effect.fn("Machines.fork")((id, name) =>
        detached(`fork ${id} to ${name}`, fork(id, name)),
      ),
      restore: Effect.fn("Machines.restore")((checkpoint, name) =>
        detached(`restore ${checkpoint} to ${name}`, restore(checkpoint, name)),
      ),
    } satisfies Interface;
  });

export const layer = (
  config: Pick<HostConfig, "id" | "bases" | "machinePorts">,
): Layer.Layer<Machines, HostError, Store | Runtime> => Layer.effect(Machines, make(config));
