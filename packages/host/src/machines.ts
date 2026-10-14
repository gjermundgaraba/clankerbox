import {
  type ActionName,
  type CreateRequest,
  formatId,
  type HostError,
  Internal,
  isReady,
  type Machine,
  Precondition,
  type Setup,
  type Usage,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Array as Arr,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  type Scope,
  Semaphore,
} from "effect";
import {
  type ActionError,
  checkpointRef,
  claimsOn,
  detacher,
  machineRef,
  madeOn,
  type ReadError,
  rowsOn,
} from "./claims.ts";
import type { HostSettings } from "./settings.ts";
import { idOn, nameOn, newInstance } from "./ids.ts";
import { prepare, runSetup } from "./guest.ts";
import { pickPort, PortProbe } from "./machine-ports.ts";
import {
  type MachineRef,
  type Observed,
  type Refusal,
  type RoomError,
  Runtime,
  type RuntimeError,
  stateReadWait,
  timeoutFail,
} from "./runtime.ts";
import { type MachineRecord, type NewMachine, type NewRow, Store } from "./store.ts";

export interface Interface {
  readonly list: Effect.Effect<ReadonlyArray<Machine>, Internal>;
  readonly get: (id: string) => Effect.Effect<Machine, ReadError>;
  readonly create: (request: CreateRequest) => Effect.Effect<Machine, ActionError<RoomError>>;
  readonly start: (id: string) => Effect.Effect<Machine, ActionError<RoomError>>;
  /**
   * Made or not: a stop boots nothing, so it may stop the VM a failed create, fork or restore
   * left running.
   */
  readonly stop: (id: string) => Effect.Effect<Machine, ActionError<RuntimeError>>;
  readonly delete: (id: string) => Effect.Effect<void, ActionError<RuntimeError>>;
  readonly fork: (id: string, name: string) => Effect.Effect<Machine, ActionError<RoomError>>;
  readonly restore: (
    checkpoint: string,
    name: string,
  ) => Effect.Effect<Machine, ActionError<RoomError>>;
  /**
   * Unlike a machine's state, this is all the reply holds, so a runtime that can't be read fails
   * it; a machine it can't read makes only the rows that count it `unread`.
   */
  readonly capacity: Effect.Effect<ReadonlyArray<Usage>, RuntimeError>;
}

export class Machines extends Context.Service<Machines, Interface>()("@clankerbox/host/Machines") {}

interface Spec extends Pick<MachineRecord, "base" | "cpu" | "ramMib" | "diskGib"> {
  readonly profile?: string | undefined;
}

type Work = Effect.Effect<void, RoomError | Refusal>;

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

export const make = (
  config: Pick<HostSettings, "id" | "bases" | "machinePorts">,
): Effect.Effect<Interface, HostError, Store | Runtime | PortProbe | Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const runtime = yield* Runtime;
    const probe = yield* PortProbe;
    const detached = yield* detacher;
    const admission = yield* Semaphore.make(1);

    const idOf = idOn(config.id);
    const nameOf = nameOn(config.id);
    const rows = rowsOn(store, config.id);
    const made = madeOn(config.id);
    const { claimAndCheck, native, refusable, done } = claimsOn(store);
    const ref = (record: NewMachine) => machineRef(config.id, record);

    const sshOf = (record: MachineRecord, observed: Observed) => {
      if (observed.state !== "running") {
        return undefined;
      }

      const endpoint =
        runtime.publishAddress === undefined || record.port === undefined
          ? observed.ssh
          : { host: runtime.publishAddress, port: record.port };

      return endpoint === undefined ? undefined : { user: runtime.loginUser, ...endpoint };
    };

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
        made: record.made,
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

    const inTime = (what: string) =>
      timeoutFail(
        stateReadWait,
        () =>
          new Internal({
            message: `${what} didn't answer within ${Duration.format(stateReadWait)}`,
          }),
      );

    /**
     * A read that fails as a whole, or runs past `stateReadWait`, reads every machine `unknown`:
     * a state read never fails an action.
     */
    const observeAll = (records: ReadonlyArray<MachineRecord>) =>
      runtime.observe(records.map(ref)).pipe(
        inTime(`the ${runtime.name} runtime`),
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
              : yield* pickPort(probe, address, config.machinePorts, yield* store.ports),
          hostKey: undefined,
        };

        return row;
      });

    const inserting = (row: NewMachine): NewRow => ({ kind: "machine", record: row });

    const holding = (action: ActionName, name: string) =>
      store.hold(action, { kind: "machine", name });

    /**
     * The RAM budget counts every machine a booting action holds, so two such actions checked
     * at once would each count the other, and both could be refused although one fits. One at a
     * time, exactly one of two that fit only alone passes, and no two pick the same port.
     */
    const admitted = admission.withPermits(1);

    /**
     * Over-approximates on purpose. Booting actions claim under the admission permit, so any
     * other such row is past its check. A start on a running machine boots nothing yet reads
     * booting, which counts no machine twice; a row whose release or end failed reads booting
     * until the next host start.
     */
    const boots = ({ action, made }: MachineRecord) =>
      action.status === "running" &&
      (action.name === "create" ||
        action.name === "restore" ||
        action.name === "start" ||
        (action.name === "fork" && !made));

    const heldRows = Effect.map(store.list, (records) =>
      records.map((record) => ({ machine: ref(record), booting: boots(record) })),
    );

    const capacity = Effect.flatMap(heldRows, (machines) =>
      runtime.capacity(machines).pipe(
        inTime(`the ${runtime.name} runtime`),
        Effect.map((readings) =>
          readings.map((reading): Usage => ({ host: config.id, ...reading })),
        ),
      ),
    );

    /** Bounded by `stateReadWait`, so it never holds the admission permit longer. */
    const admit = (action: ActionName, machine: NewMachine) =>
      Effect.flatMap(heldRows, (machines) =>
        runtime
          .admit({ action, machine: ref(machine), machines })
          .pipe(
            inTime(
              `${action} ${idOf(machine.name)}: the ${runtime.name} runtime's admission check`,
            ),
          ),
      );

    /**
     * The work may have recorded the runtime's own ID on the row, so setup and preparation read
     * the row again. A failure in preparation leaves the machine made, so `start` prepares it
     * again; one before, or in the marking, leaves it unmade.
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

        const hostKey = yield* refusable(
          token,
          `${action} ${machine.id}`,
          Effect.gen(function* () {
            yield* work(machine);

            const current = ref(yield* rows.machine(name));

            if (setup !== undefined) {
              yield* runSetup(runtime, current, setup);
            }

            yield* store.markMade(token);

            return yield* prepare(runtime, current);
          }),
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

        const hostKey = yield* refusable(
          token,
          `start ${id}`,
          Effect.andThen(runtime.start(machine), prepare(runtime, machine)),
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
        yield* store.remove({ kind: "machine", name });
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
     * A ready checkpoint never changes, so restores read it without a claim and run in parallel.
     */
    const ready = (id: string) =>
      Effect.gen(function* () {
        const checkpoint = yield* rows.checkpoint(yield* nameOf(id));

        if (!isReady(checkpoint)) {
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
      capacity: capacity.pipe(Effect.withSpan("Machines.capacity")),
    } satisfies Interface;
  });

export const layer = (
  config: Pick<HostSettings, "id" | "bases" | "machinePorts">,
): Layer.Layer<Machines, HostError, Store | Runtime | PortProbe> =>
  Layer.effect(Machines, make(config));
