import {
  type ActionName,
  Conflict,
  type CreateRequest,
  type Declared,
  formatId,
  type HostError,
  Internal,
  type Machine,
  NotOffered,
  NotReady,
  PinMismatch,
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
import { checkpointRef, claimsOn, detacher, machineRef, madeOn, rowsOn } from "./claims.ts";
import type { HostSettings } from "./settings.ts";
import { idOn, nameOn, newInstance } from "./ids.ts";
import { prepare, runSetup } from "./guest.ts";
import { pickPort, PortProbe } from "./machine-ports.ts";
import {
  type MachineRef,
  type Observed,
  type Refusal,
  Runtime,
  type RuntimeError,
  stateReadWait,
  timeoutFail,
} from "./runtime.ts";
import { type MachineRecord, type NewMachine, type NewRow, Store, type Token } from "./store.ts";

export interface Interface {
  readonly list: Effect.Effect<ReadonlyArray<Machine>, Internal>;
  readonly get: (id: string) => Effect.Effect<Machine, Declared<"getMachine">>;
  readonly create: (request: CreateRequest) => Effect.Effect<Machine, Declared<"createMachine">>;
  readonly start: (id: string) => Effect.Effect<Machine, Declared<"startMachine">>;
  /**
   * Made or not: a stop boots nothing, so it may stop the VM a failed create, fork or restore
   * left running.
   */
  readonly stop: (id: string) => Effect.Effect<Machine, Declared<"stopMachine">>;
  readonly delete: (id: string) => Effect.Effect<void, Declared<"deleteMachine">>;
  readonly fork: (id: string, name: string) => Effect.Effect<Machine, Declared<"forkMachine">>;
  readonly restore: (
    checkpoint: string,
    name: string,
  ) => Effect.Effect<Machine, Declared<"restoreMachine">>;
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

/** The runtime's work on the new machine, which fails with `E` or refuses with `R`. */
type Work<E extends HostError, R extends HostError> = Effect.Effect<void, E | Refusal<R>>;

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

    const shown = (record: MachineRecord) =>
      Effect.map(observeAll([record]), ([observed]) => resource(record, observed));

    const read = (name: string) => Effect.flatMap(rows.machine(name), shown);

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
      (action.name === "createMachine" ||
        action.name === "restoreMachine" ||
        action.name === "startMachine" ||
        (action.name === "forkMachine" && !made));

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

    /** A row this action holds that is gone under it is the host's failure, not the caller's. */
    const held = (name: string) =>
      Effect.catchTag(rows.machine(name), "NotFound", (gone) =>
        Effect.fail(new Internal({ message: `${gone.message}, though an action holds it` })),
      );

    /**
     * The work may have recorded the runtime's own ID on the row, so setup and preparation read
     * the row again. A failure in preparation leaves the machine made, so `start` prepares it
     * again; one before, or in the marking, leaves it unmade.
     */
    const finish = <E extends HostError, R extends HostError>(
      action: ActionName,
      token: Token,
      row: NewMachine,
      work: (machine: MachineRef) => Work<E, R>,
      setup?: Setup,
    ) =>
      Effect.gen(function* () {
        const machine = ref(row);

        const hostKey = yield* refusable(
          token,
          `${action} ${machine.id}`,
          Effect.gen(function* () {
            yield* work(machine);

            const current = ref(yield* held(row.name));

            if (setup !== undefined) {
              yield* runSetup(runtime, current, setup);
            }

            yield* store.markMade(token);

            return yield* prepare(runtime, current);
          }),
        );

        yield* done(token, { prepared: { name: row.name, hostKey } });

        return yield* shown(yield* held(row.name));
      });

    /** A create or restore inserts its own row, and holds nothing else. */
    const makeFresh = <E extends HostError, R extends HostError>(
      action: "createMachine" | "restoreMachine",
      name: string,
      spec: Spec,
      work: (machine: MachineRef) => Work<E, R>,
      setup?: Setup,
    ) =>
      Effect.flatMap(
        admitted(
          Effect.flatMap(newRow(name, spec), (row) =>
            claimAndCheck(
              Effect.map(store.insert(action, inserting(row)), (token) => ({ token, held: row })),
              () => Effect.as(admit(action, row), row),
            ),
          ),
        ),
        ([token, row]) => finish(action, token, row, work, setup),
      );

    /** A fork holds its source, which must be made, and joins its new row to the claim. */
    const makeFork = (source: string, name: string) =>
      Effect.flatMap(
        admitted(
          claimAndCheck(holding("forkMachine", source), (from, join) =>
            Effect.gen(function* () {
              yield* made(from);

              const row = yield* newRow(name, from);

              yield* join(inserting(row));
              yield* admit("forkMachine", row);

              return { row, from: ref(from) };
            }),
          ),
        ),
        ([token, { row, from }]) =>
          finish("forkMachine", token, row, (machine) => runtime.fork(from, machine)),
      );

    const create = (request: CreateRequest) =>
      Effect.gen(function* () {
        const name = yield* nameOf(request.id);
        const image = config.bases.get(request.base);

        if (image === undefined) {
          return yield* new NotOffered({
            message: `host ${config.id} doesn't offer base ${request.base}; it offers ${[...config.bases.keys()].join(", ") || "no bases"}`,
            base: request.base,
          });
        }

        return yield* makeFresh(
          "createMachine",
          name,
          request,
          (machine) => runtime.create(machine, image),
          request.setup,
        );
      });

    const start = (id: string) =>
      Effect.gen(function* () {
        const name = yield* nameOf(id);

        const [token, record] = yield* admitted(
          claimAndCheck(holding("startMachine", name), (record) =>
            Effect.andThen(made(record), Effect.as(admit("startMachine", record), record)),
          ),
        );

        const machine = ref(record);

        const hostKey = yield* refusable(
          token,
          `startMachine ${id}`,
          Effect.andThen(runtime.start(machine), prepare(runtime, machine)),
        );

        yield* done(token, { prepared: { name, hostKey } });

        return yield* read(name);
      });

    const stop = (id: string) =>
      Effect.gen(function* () {
        const name = yield* nameOf(id);

        const [token, record] = yield* claimAndCheck(holding("stopMachine", name), Effect.succeed);

        yield* native(token, `stopMachine ${id}`, runtime.stop(ref(record)));
        yield* done(token);

        return yield* read(name);
      });

    const remove = (id: string) =>
      Effect.gen(function* () {
        const name = yield* nameOf(id);

        const [token, record] = yield* claimAndCheck(
          holding("deleteMachine", name),
          Effect.succeed,
        );

        yield* native(token, `deleteMachine ${id}`, runtime.delete(ref(record)));
        yield* store.remove({ kind: "machine", name });
      });

    const fork = (sourceId: string, name: string) =>
      Effect.gen(function* () {
        const source = yield* nameOf(sourceId);

        yield* formatId(config.id, name);

        return yield* makeFork(source, name);
      });

    /**
     * A ready checkpoint never changes, so restores read it without a claim and run in parallel.
     */
    const ready = (id: string) =>
      Effect.gen(function* () {
        const checkpoint = yield* rows.checkpoint(yield* nameOf(id));

        const { action } = checkpoint;

        if (action.status === "running") {
          return yield* new Conflict({
            message: `checkpoint ${id} is busy: its ${action.name} is running`,
            kind: "busy",
            id,
          });
        }

        if (action.status === "failed") {
          return yield* new NotReady({
            message: `checkpoint ${id} isn't ready: its ${action.name} failed; delete it`,
            checkpoint: id,
          });
        }

        if (checkpoint.kind === "ram" && checkpoint.pin !== runtime.pin) {
          return yield* new PinMismatch({
            message: `checkpoint ${id} holds RAM state saved under ${checkpoint.pin ?? "no pin"}, and this host runs ${runtime.pin ?? "no pin"}; it restores only under the same one`,
            checkpoint: id,
          });
        }

        return checkpoint;
      });

    const restore = (checkpointId: string, name: string) =>
      Effect.gen(function* () {
        yield* formatId(config.id, name);

        const checkpoint = yield* ready(checkpointId);

        return yield* makeFresh("restoreMachine", name, checkpoint, (machine) =>
          runtime.restore(checkpointRef(config.id, checkpoint), machine),
        );
      });

    return {
      list: Effect.flatMap(store.list, (records) =>
        Effect.map(observeAll(records), (observed) => Arr.zipWith(records, observed, resource)),
      ).pipe(Effect.withSpan("Machines.list")),
      get: Effect.fn("Machines.get")((id) => Effect.flatMap(nameOf(id), read)),
      create: Effect.fn("Machines.create")((request) =>
        detached(`createMachine ${request.id}`, create(request)),
      ),
      start: Effect.fn("Machines.start")((id) => detached(`startMachine ${id}`, start(id))),
      stop: Effect.fn("Machines.stop")((id) => detached(`stopMachine ${id}`, stop(id))),
      delete: Effect.fn("Machines.delete")((id) => detached(`deleteMachine ${id}`, remove(id))),
      fork: Effect.fn("Machines.fork")((id, name) =>
        detached(`forkMachine ${id} to ${name}`, fork(id, name)),
      ),
      restore: Effect.fn("Machines.restore")((checkpoint, name) =>
        detached(`restoreMachine ${checkpoint} to ${name}`, restore(checkpoint, name)),
      ),
      capacity: capacity.pipe(Effect.withSpan("Machines.capacity")),
    } satisfies Interface;
  });

export const layer = (
  config: Pick<HostSettings, "id" | "bases" | "machinePorts">,
): Layer.Layer<Machines, HostError, Store | Runtime | PortProbe> =>
  Layer.effect(Machines, make(config));
