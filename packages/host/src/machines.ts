import {
  type CreateRequest,
  type Declared,
  type Desired,
  formatId,
  type HostError,
  Internal,
  type Machine,
  NotOffered,
  PinMismatch,
  Superseded,
  type Usage,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Array as Arr,
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Scope,
  Semaphore,
} from "effect";
import { foundOn, idOn, nameOn, newInstance, notFoundOn } from "./ids.ts";
import { prepare, runSetup } from "./guest.ts";
import { Leases } from "./leases.ts";
import {
  answer,
  ask,
  type Born,
  isResting,
  type Life,
  lifecycle,
  type MachineActor,
  type Making,
  phaseOf,
  removal,
  type Source,
  spawn,
  type Steps,
  tell,
} from "./lifecycle.ts";
import { pickPort, PortProbe } from "./machine-ports.ts";
import { checkpointRef, machineRef, madeOn } from "./refs.ts";
import {
  type Booting,
  type MachineRef,
  missing,
  type Observed,
  Runtime,
  type RuntimeError,
  stateReadWait,
  timeoutFail,
} from "./runtime.ts";
import type { HostSettings } from "./settings.ts";
import { type Intent, Store } from "./store.ts";

export interface Interface {
  readonly list: Effect.Effect<ReadonlyArray<Machine>, Internal>;
  readonly get: (id: string) => Effect.Effect<Machine, Declared<"getMachine">>;
  readonly create: (request: CreateRequest) => Effect.Effect<Machine, Declared<"createMachine">>;
  readonly start: (id: string) => Effect.Effect<Machine, Declared<"startMachine">>;
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

const booted = {
  base: "createMachine",
  checkpoint: "restoreMachine",
  machine: "forkMachine",
} satisfies Record<Source["kind"], Booting>;

const unknown: Observed = { state: "unknown" };

const bornOf = (intent: Intent, making: Making | undefined, seen: Observed): Born => ({
  name: intent.name,
  desired: intent.desired,
  generation: intent.generation,
  made: intent.made,
  making,
  seen,
});

export const make = (
  config: Pick<HostSettings, "id" | "bases" | "machinePorts" | "recheck">,
): Effect.Effect<Interface, HostError, Store | Runtime | PortProbe | Leases | Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const runtime = yield* Runtime;
    const probe = yield* PortProbe;
    const leases = yield* Leases;
    const hostScope = yield* Effect.scope;
    const admission = yield* Semaphore.make(1);
    const inserting = yield* Semaphore.make(1);

    const booting = new Set<string>();
    const entries = new Map<string, MachineActor>();

    const idOf = idOn(config.id);
    const nameOf = nameOn(config.id);
    const notFound = notFoundOn(config.id);
    const found = foundOn(config.id);
    const made = madeOn(config.id);
    const ref = (intent: Intent) => machineRef(config.id, intent);

    const inTime = (what: string) =>
      timeoutFail(
        stateReadWait,
        () =>
          new Internal({
            message: `${what} didn't answer within ${Duration.format(stateReadWait)}`,
          }),
      );

    const row = (name: string) => found("machine", name, store.findMachine(name));

    const held = (name: string) =>
      Effect.catchTag(row(name), "NotFound", (gone) =>
        Effect.fail(new Internal({ message: `${gone.message}, though its actor runs` })),
      );

    const surviving = <A, E>(what: string, work: Effect.Effect<A, E>) =>
      Effect.catchCauseFilter(work, Cause.findDefect, (_defect, cause) =>
        Effect.andThen(
          Effect.logError(`${what} died:\n${Cause.pretty(cause)}`),
          Effect.fail(new Internal({ message: `${what} died; the host log has why` })),
        ),
      );

    const observeAll = (intents: ReadonlyArray<Intent>): Effect.Effect<ReadonlyArray<Observed>> =>
      intents.length === 0
        ? Effect.succeed([])
        : surviving(`the ${runtime.name} runtime's read`, runtime.observe(intents.map(ref))).pipe(
            inTime(`the ${runtime.name} runtime`),
            Effect.catch((error) =>
              Effect.as(
                Effect.logWarning(`couldn't read the machines' states: ${error.message}`),
                intents.map(() => unknown),
              ),
            ),
          );

    const observeOne = (name: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* leases.share("machine", name);

          const [observed] = yield* observeAll([yield* held(name)]);

          return observed ?? unknown;
        }),
      ).pipe(Effect.catch(() => Effect.succeed(unknown)));

    const heldMachines = Effect.map(store.machines, (intents) =>
      intents.map((intent) => ({ machine: ref(intent), booting: booting.has(intent.name) })),
    );

    const admitted = (action: Booting, intent: Intent) =>
      admission.withPermits(1)(
        Effect.gen(function* () {
          const machines = (yield* heldMachines).map((held) =>
            held.machine.name === intent.name ? { ...held, booting: true } : held,
          );

          yield* runtime
            .admit({ action, machine: ref(intent), machines })
            .pipe(
              inTime(
                `${action} ${idOf(intent.name)}: the ${runtime.name} runtime's admission check`,
              ),
            );

          yield* Effect.acquireRelease(
            Effect.sync(() => booting.add(intent.name)),
            () => Effect.sync(() => booting.delete(intent.name)),
          );
        }),
      );

    const owning = <A, E extends { readonly message: string }>(
      what: string,
      life: Life,
      work: (intent: Intent) => Effect.Effect<A, E, Scope.Scope>,
    ) =>
      surviving(
        `${what} ${idOf(life.name)}`,
        Effect.scoped(
          Effect.gen(function* () {
            yield* leases.own("machine", life.name);

            return yield* work(yield* held(life.name));
          }),
        ),
      ).pipe(
        Effect.tapError((error) =>
          Effect.logWarning(`${what} ${idOf(life.name)} failed: ${error.message}`),
        ),
      );

    const readyCheckpoint = (name: string) =>
      Effect.gen(function* () {
        const checkpoint = yield* found("checkpoint", name, store.findCheckpoint(name));

        if (checkpoint.kind === "ram" && checkpoint.pin !== runtime.pin) {
          return yield* new PinMismatch({
            message: `checkpoint ${idOf(name)} holds RAM state saved under ${checkpoint.pin ?? "no pin"}, and this host runs ${runtime.pin ?? "no pin"}; it restores only under the same one`,
            checkpoint: idOf(name),
          });
        }

        return checkpoint;
      });

    const copied = (source: Source, machine: MachineRef) =>
      Effect.gen(function* () {
        if (source.kind === "base") {
          return yield* runtime.create(machine, source.image);
        }

        if (source.kind === "checkpoint") {
          const { name, instance } = source.record;

          yield* leases.share("checkpoint", name);

          const record = yield* readyCheckpoint(name);

          if (record.instance !== instance) {
            return yield* notFound("checkpoint", name);
          }

          return yield* runtime.restore(checkpointRef(config.id, record), machine);
        }

        const { name, instance } = source.from;

        yield* leases.share("machine", name);

        const from = yield* row(name);

        if (from.instance !== instance) {
          return yield* notFound("machine", name);
        }

        yield* made(from);

        return yield* runtime.fork(ref(from), machine);
      });

    const steps: Steps = {
      observe: (life) => observeOne(life.name),
      make: (life) =>
        owning("create", life, (intent) =>
          Effect.gen(function* () {
            const { making } = life;

            if (making === undefined) {
              return yield* Effect.die(
                `machine ${idOf(intent.name)} is to be made, but only a deleted one lacks its making`,
              );
            }

            yield* Effect.scoped(
              Effect.andThen(
                admitted(booted[making.source.kind], intent),
                copied(making.source, ref(intent)),
              ),
            );

            const copy = yield* held(intent.name);

            if (making.script !== undefined) {
              yield* runSetup(runtime, ref(copy), making.script);
            }

            yield* store.made(intent.name);
          }),
        ),
      start: (life) =>
        owning("start", life, (intent) =>
          Effect.gen(function* () {
            const started = runtime.start(ref(intent));

            yield* life.seen.state === "running"
              ? started
              : Effect.scoped(Effect.andThen(admitted("startMachine", intent), started));

            const hostKey = yield* prepare(runtime, ref(intent));

            if (hostKey !== undefined) {
              yield* store.hostKey(intent.name, hostKey);
            }
          }),
        ),
      stop: (life) => owning("stop", life, (intent) => runtime.stop(ref(intent))),
      remove: (life) =>
        owning("delete", life, (intent) =>
          Effect.andThen(runtime.delete(ref(intent)), store.removeMachine(intent.name)),
        ),
    };

    const logic = lifecycle(steps);

    const died = (name: string) =>
      new Internal({
        message: `machine ${idOf(name)}'s lifecycle died; the host log has why, and a restart of the host acts on it again`,
      });

    const register = (born: Born): Effect.Effect<MachineActor> =>
      Effect.gen(function* () {
        const { name } = born;
        const scope = yield* Scope.fork(hostScope);
        const actor = yield* Scope.provide(spawn(logic, born), scope);

        entries.set(name, actor);

        const ended = Effect.gen(function* () {
          yield* removal(actor);

          const snapshot = actor.getSnapshot();

          if (snapshot.status === "error") {
            return yield* Effect.logError(
              `machine ${idOf(name)}'s lifecycle died, and the host acts on it again only once it starts again: ${String(snapshot.error)}`,
            );
          }

          if (entries.get(name) === actor) {
            entries.delete(name);
          }

          yield* Scope.close(scope, Exit.void);
        });

        yield* Effect.forkIn(ended, hostScope);

        return actor;
      });

    const actorOf = (name: string) =>
      Effect.suspend(() => {
        const found = entries.get(name);

        return found === undefined ? Effect.fail(notFound("machine", name)) : Effect.succeed(found);
      });

    const resource = (intent: Intent, life: Life, phase: Machine["phase"], observed: Observed) => {
      const endpoint =
        observed.state !== "running"
          ? undefined
          : runtime.publishAddress === undefined || intent.port === undefined
            ? observed.ssh
            : { host: runtime.publishAddress, port: intent.port };

      let machine: Machine = {
        id: idOf(intent.name),
        runtime: runtime.name,
        createdAt: intent.createdAt,
        base: intent.base,
        cpu: intent.cpu,
        ramMib: intent.ramMib,
        diskGib: intent.diskGib,
        state: observed.state,
        desired: life.desired,
        phase,
      };

      if (intent.profile !== undefined) {
        machine = { ...machine, profile: intent.profile };
      }

      const error = life.error ?? life.undone;

      if (error !== undefined) {
        machine = { ...machine, error };
      }

      if (endpoint !== undefined) {
        machine = { ...machine, ssh: { user: runtime.loginUser, ...endpoint } };
      }

      if (intent.hostKey !== undefined) {
        machine = { ...machine, hostKey: intent.hostKey };
      }

      return machine;
    };

    const shownAll = (intents: ReadonlyArray<Intent>) =>
      Effect.gen(function* () {
        const live = intents.flatMap((intent) => {
          const actor = entries.get(intent.name);

          return actor === undefined ? [] : [{ intent, snapshot: actor.getSnapshot() }];
        });

        const observed = yield* observeAll(live.map(({ intent }) => intent));

        return Arr.zipWith(live, observed, ({ intent, snapshot }, seen) =>
          resource(intent, snapshot.context, phaseOf(snapshot), seen),
        );
      });

    const shown = (name: string) =>
      Effect.flatMap(row(name), (intent) =>
        Effect.flatMap(shownAll([intent]), ([machine]) =>
          machine === undefined ? Effect.fail(notFound("machine", name)) : Effect.succeed(machine),
        ),
      );

    const sent = (name: string, actor: MachineActor, desired: Desired) =>
      Effect.uninterruptible(
        Effect.flatMap(store.desire(name, desired), (desire) =>
          Option.match(desire, {
            onNone: () => Effect.fail(notFound("machine", name)),
            onSome: (recorded) => Effect.as(ask(actor, recorded), recorded.generation),
          }),
        ),
      );

    const answered = (
      name: string,
      actor: MachineActor,
      desired: "running" | "stopped",
      generation: number,
    ) =>
      Effect.gen(function* () {
        const snapshot = yield* answer(actor, generation);
        const id = idOf(name);

        if (snapshot.status === "error") {
          return yield* died(name);
        }

        const life = snapshot.context;

        if (life.undone !== undefined) {
          return yield* life.undone;
        }

        if (snapshot.status !== "active") {
          return yield* new Superseded({
            message: `machine ${id} was deleted before it got to ${desired}`,
            by: "deleted",
          });
        }

        if (life.desired !== desired) {
          return yield* new Superseded({
            message: `a later request asked machine ${id} to be ${life.desired} before it got to ${desired}`,
            by: life.desired,
          });
        }

        const phase = phaseOf(snapshot);

        if (phase === "waiting") {
          return yield* new Internal({
            message: `the ${runtime.name} runtime couldn't read machine ${id}; the host reads it again at its next recheck`,
          });
        }

        if (phase === "failed") {
          return yield* (
            life.error ?? new Internal({ message: `machine ${id} failed, saying nothing` })
          );
        }

        if (phase === "lost") {
          return yield* missing(runtime.name, { id });
        }

        return resource(yield* row(name), life, phase, life.seen);
      });

    const settledOn = (name: string, desired: "running" | "stopped") =>
      Effect.gen(function* () {
        const actor = yield* actorOf(name);

        if (actor.getSnapshot().context.desired === "deleted") {
          return yield* new Superseded({
            message: `machine ${idOf(name)} is being deleted`,
            by: "deleted",
          });
        }

        return yield* answered(name, actor, desired, yield* sent(name, actor, desired));
      });

    const remove = (name: string) =>
      Effect.gen(function* () {
        const actor = yield* actorOf(name);
        const snapshot = yield* answer(actor, yield* sent(name, actor, "deleted"));

        if (snapshot.status === "error") {
          return yield* died(name);
        }

        const { error } = snapshot.context;

        if (snapshot.status === "active" && error !== undefined) {
          return yield* error;
        }
      });

    interface Spec {
      readonly base: string;
      readonly profile?: string | undefined;
      readonly cpu: number;
      readonly ramMib: number;
      readonly diskGib: number;
    }

    const born = (name: string, spec: Spec) =>
      Effect.gen(function* () {
        const address = runtime.publishAddress;

        const intent: Intent = {
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
          desired: "running",
          generation: 1,
          made: false,
          hostKey: undefined,
        };

        yield* store.insertMachine(intent);

        return intent;
      });

    const making = (name: string, spec: Spec, making: Making) =>
      Effect.gen(function* () {
        const actor = yield* Effect.uninterruptible(
          Effect.flatMap(inserting.withPermits(1)(born(name, spec)), (intent) =>
            register(bornOf(intent, making, unknown)),
          ),
        );

        return yield* answered(name, actor, "running", 1);
      });

    const create = (request_: CreateRequest) =>
      Effect.gen(function* () {
        const name = yield* nameOf(request_.id);
        const image = config.bases.get(request_.base);

        if (image === undefined) {
          return yield* new NotOffered({
            message: `host ${config.id} doesn't offer base ${request_.base}; it offers ${[...config.bases.keys()].join(", ") || "no bases"}`,
            base: request_.base,
          });
        }

        return yield* making(name, request_, {
          source: { kind: "base", image },
          script: request_.setup,
        });
      });

    const fork = (sourceId: string, name: string) =>
      Effect.gen(function* () {
        const source = yield* nameOf(sourceId);

        yield* formatId(config.id, name);

        const from = yield* row(source);

        yield* made(from);

        return yield* making(name, from, { source: { kind: "machine", from }, script: undefined });
      });

    const restore = (checkpointId: string, name: string) =>
      Effect.gen(function* () {
        const source = yield* nameOf(checkpointId);

        yield* formatId(config.id, name);

        const record = yield* readyCheckpoint(source);

        return yield* making(name, record, {
          source: { kind: "checkpoint", record },
          script: undefined,
        });
      });

    const capacity = Effect.flatMap(heldMachines, (machines) =>
      runtime.capacity(machines).pipe(
        inTime(`the ${runtime.name} runtime`),
        Effect.map((readings) =>
          readings.map((reading): Usage => ({ host: config.id, ...reading })),
        ),
      ),
    );

    const recheck = Effect.gen(function* () {
      const resting = new Map(
        [...entries].flatMap(([name, actor]) => {
          const snapshot = actor.getSnapshot();

          return snapshot.status === "active" && isResting(snapshot)
            ? [[name, { actor, life: snapshot.context }] as const]
            : [];
        }),
      );

      const intents = (yield* store.machines).filter((intent) => resting.has(intent.name));
      const observed = yield* observeAll(intents);

      yield* Effect.forEach(
        Arr.zip(intents, observed),
        ([intent, seen]) => {
          const at = resting.get(intent.name);

          return at === undefined || at.actor.getSnapshot().context !== at.life
            ? Effect.void
            : tell(at.actor, seen);
        },
        { discard: true },
      );
    }).pipe(
      Effect.catch((error) => Effect.logWarning(`couldn't recheck the machines: ${error.message}`)),
    );

    const intents = yield* store.machines;
    const observed = yield* observeAll(intents);

    for (const [intent, seen] of Arr.zip(intents, observed)) {
      yield* register(bornOf(intent, undefined, seen));
    }

    yield* Effect.forkIn(
      Effect.forever(Effect.andThen(Effect.sleep(config.recheck), recheck)),
      hostScope,
    );

    return {
      list: Effect.flatMap(store.machines, shownAll).pipe(Effect.withSpan("Machines.list")),
      get: Effect.fn("Machines.get")((id) => Effect.flatMap(nameOf(id), shown)),
      create: Effect.fn("Machines.create")(create),
      start: Effect.fn("Machines.start")((id) =>
        Effect.flatMap(nameOf(id), (name) => settledOn(name, "running")),
      ),
      stop: Effect.fn("Machines.stop")((id) =>
        Effect.flatMap(nameOf(id), (name) => settledOn(name, "stopped")),
      ),
      delete: Effect.fn("Machines.delete")((id) => Effect.flatMap(nameOf(id), remove)),
      fork: Effect.fn("Machines.fork")(fork),
      restore: Effect.fn("Machines.restore")(restore),
      capacity: capacity.pipe(Effect.withSpan("Machines.capacity")),
    } satisfies Interface;
  });

export const layer = (
  config: Pick<HostSettings, "id" | "bases" | "machinePorts" | "recheck">,
): Layer.Layer<Machines, HostError, Store | Runtime | PortProbe | Leases> =>
  Layer.effect(Machines, make(config));
