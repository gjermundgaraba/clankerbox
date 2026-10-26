import {
  type CreateRequest,
  type Declared,
  type Desired,
  type Executed,
  type ExecRequest,
  formatGib,
  formatId,
  formatMib,
  type HostError,
  Internal,
  loginUser,
  type Machine,
  NotOffered,
  offered,
  offers,
  PinMismatch,
  type ResizeRequest,
  Superseded,
  type TailnetStatus,
  Unsizable,
  type Usage,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Array as Arr,
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Scope,
  Semaphore,
} from "effect";
import { foundOn, idOn, nameOn, newInstance, notFoundOn } from "./ids.ts";
import { checkTailnet, prepare, runCommand, runSetup, type TailnetReport } from "./guest.ts";
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
import { checkpointRef, machineRef, madeOn, pinnedOn } from "./refs.ts";
import {
  type Booting,
  type MachineRef,
  type MachineState,
  missing,
  Runtime,
  type RuntimeError,
  type Sizes,
  stateReadWait,
  timeoutFail,
} from "./runtime.ts";
import type { HostSettings } from "./settings.ts";
import { type Intent, Store } from "./store.ts";
import { Tailnet } from "./tailnet.ts";

export interface CreateOptions {
  /** A prebuild's builder, which a host that starts deletes. */
  readonly ephemeral?: boolean | undefined;
}

export interface Interface {
  readonly list: Effect.Effect<ReadonlyArray<Machine>, Internal>;
  readonly get: (id: string) => Effect.Effect<Machine, Declared<"getMachine">>;
  readonly create: (
    request: CreateRequest,
    options?: CreateOptions,
  ) => Effect.Effect<Machine, Declared<"createMachine">>;
  readonly start: (id: string) => Effect.Effect<Machine, Declared<"startMachine">>;
  readonly stop: (id: string) => Effect.Effect<Machine, Declared<"stopMachine">>;
  readonly pause: (id: string) => Effect.Effect<Machine, Declared<"pauseMachine">>;
  readonly resize: (request: ResizeRequest) => Effect.Effect<Machine, Declared<"resizeMachine">>;
  readonly delete: (id: string) => Effect.Effect<void, Declared<"deleteMachine">>;
  readonly fork: (id: string, name: string) => Effect.Effect<Machine, Declared<"forkMachine">>;
  readonly restore: (
    checkpoint: string,
    name: string,
  ) => Effect.Effect<Machine, Declared<"restoreMachine">>;
  readonly exec: (request: ExecRequest) => Effect.Effect<Executed, Declared<"execMachine">>;
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

const joinTimeout = Duration.minutes(3);

const statusOf = (report: TailnetReport | undefined): TailnetStatus => {
  if (report === undefined) {
    return { state: "failed", error: "the tailnet script reported nothing readable" };
  }

  if (report.missing) {
    return { state: "missing" };
  }

  if (report.backend !== "Running") {
    return { state: "failed", error: `tailscaled is ${report.backend}, not signed in` };
  }

  return report.name === undefined ? { state: "joined" } : { state: "joined", name: report.name };
};

const bornOf = (intent: Intent, making: Making | undefined, seen: MachineState): Born => ({
  name: intent.name,
  desired: intent.desired,
  generation: intent.generation,
  made: intent.made,
  making,
  seen,
});

export const make = (
  config: Pick<HostSettings, "id" | "kind" | "bases" | "machinePorts" | "recheck">,
): Effect.Effect<Interface, HostError, Store | Runtime | PortProbe | Leases | Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const runtime = yield* Runtime;
    const tailnet = yield* Effect.serviceOption(Tailnet);
    const probe = yield* PortProbe;
    const leases = yield* Leases;
    const hostScope = yield* Effect.scope;
    const admission = yield* Semaphore.make(1);
    const inserting = yield* Semaphore.make(1);

    const booting = new Map<string, MachineRef>();
    const entries = new Map<string, MachineActor>();

    const idOf = idOn(config.id);
    const nameOf = nameOn(config.id);
    const notFound = notFoundOn(config.id);
    const found = foundOn(config.id);
    const made = madeOn(config.id);
    const pinned = pinnedOn(config.id, runtime.pin);
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

    const observeAll = (
      intents: ReadonlyArray<Intent>,
    ): Effect.Effect<ReadonlyArray<MachineState>> =>
      intents.length === 0
        ? Effect.succeed([])
        : surviving(`the ${config.kind} runtime's read`, runtime.observe(intents.map(ref))).pipe(
            inTime(`the ${config.kind} runtime`),
            Effect.catch((error) =>
              Effect.as(
                Effect.logWarning(`couldn't read the machines' states: ${error.message}`),
                intents.map((): MachineState => "unknown"),
              ),
            ),
          );

    const observeOne = (name: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* leases.share("machine", name);

          const [observed] = yield* observeAll([yield* held(name)]);

          return observed ?? "unknown";
        }),
      ).pipe(Effect.catch(() => Effect.succeed<MachineState>("unknown")));

    const heldMachines = Effect.map(store.machines, (intents) =>
      intents.map((intent) => {
        const admitted = booting.get(intent.name);

        return admitted === undefined
          ? { machine: ref(intent), booting: false }
          : { machine: admitted, booting: true };
      }),
    );

    const admitted = (action: Booting, machine: MachineRef) =>
      admission.withPermits(1)(
        Effect.gen(function* () {
          const machines = (yield* heldMachines).map((held) =>
            held.machine.name === machine.name ? { machine, booting: true } : held,
          );

          yield* runtime
            .admit({ action, machine, machines })
            .pipe(inTime(`${action} ${machine.id}: the ${config.kind} runtime's admission check`));

          yield* Effect.acquireRelease(
            Effect.sync(() => booting.set(machine.name, machine)),
            () => Effect.sync(() => booting.delete(machine.name)),
          );
        }),
      );

    const resumable = ({ name, pin }: Intent) =>
      pin === runtime.pin
        ? Effect.void
        : Effect.fail(
            new PinMismatch({
              message: `machine ${idOf(name)} was paused under ${pin ?? "no pin"}, and this host runs ${runtime.pin ?? "no pin"}; it resumes only under the same one: delete it, or resume it under that one`,
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

        if (checkpoint.pin !== runtime.pin) {
          return yield* new PinMismatch({
            message: `checkpoint ${idOf(name)} holds RAM state saved under ${checkpoint.pin ?? "no pin"}, and this host runs ${runtime.pin ?? "no pin"}; it restores only under the same one`,
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
        yield* pinned(from);

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
                admitted(booted[making.source.kind], ref(intent)),
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
            if (life.seen === "paused") {
              yield* resumable(intent);
            }

            if (life.seen === "stopped" && intent.pin !== runtime.pin) {
              yield* store.bootedUnder(intent.name, runtime.pin);
            }

            const started = runtime.start(ref(intent));

            yield* life.seen === "running"
              ? started
              : Effect.scoped(Effect.andThen(admitted("startMachine", ref(intent)), started));

            const hostKey = yield* prepare(runtime, ref(intent));

            if (hostKey !== undefined) {
              yield* store.hostKey(intent.name, hostKey);
            }
          }),
        ),
      join: (life) =>
        Option.match(tailnet, {
          onNone: () => Effect.succeed(undefined),
          onSome: ({ mint }) => {
            const id = idOf(life.name);
            const hostname = id.replaceAll("_", "-");

            return surviving(
              `tailnet join ${id}`,
              Effect.scoped(
                Effect.gen(function* () {
                  yield* leases.share("machine", life.name);

                  const intent = yield* held(life.name);

                  if (intent.ephemeral) {
                    return undefined;
                  }

                  const machine = ref(intent);
                  const report = yield* checkTailnet(runtime, machine, hostname);

                  return statusOf(
                    report?.missing === false && report.backend === "NeedsLogin"
                      ? yield* checkTailnet(runtime, machine, hostname, yield* mint)
                      : report,
                  );
                }),
              ),
            ).pipe(
              timeoutFail(
                joinTimeout,
                () =>
                  new Internal({
                    message: `the join didn't finish within ${Duration.format(joinTimeout)}`,
                  }),
              ),
              Effect.catch((error) =>
                Effect.succeed<TailnetStatus>({ state: "failed", error: error.message }),
              ),
              Effect.tap((status) =>
                status?.state === "failed"
                  ? Effect.logWarning(`tailnet join ${id} failed: ${status.error}`)
                  : Effect.void,
              ),
            );
          },
        }),
      stop: (life) =>
        owning("stop", life, (intent) =>
          Effect.gen(function* () {
            const stopped = runtime.stop(ref(intent));

            if (life.seen === "paused" && runtime.stopResumes) {
              yield* resumable(intent);
              yield* Effect.scoped(Effect.andThen(admitted("stopMachine", ref(intent)), stopped));
            } else {
              yield* stopped;
            }
          }),
        ),
      pause: (life) =>
        owning("pause", life, (intent) =>
          intent.pin === runtime.pin
            ? runtime.pause(ref(intent))
            : Effect.andThen(
                Effect.logWarning(
                  `pause ${idOf(intent.name)}: its VM booted under ${intent.pin ?? "an older host"}, and this host runs ${runtime.pin ?? "no pin"}, so it stops it instead`,
                ),
                runtime.stop(ref(intent)),
              ),
        ),
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

    const resource = (
      intent: Intent,
      life: Life,
      phase: Machine["phase"],
      observed: MachineState,
    ) => {
      let machine: Machine = {
        id: idOf(intent.name),
        kind: config.kind,
        createdAt: intent.createdAt,
        base: intent.base,
        cpu: intent.cpu,
        ramMib: intent.ramMib,
        diskGib: intent.diskGib,
        state: observed,
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

      if (observed === "running") {
        machine = {
          ...machine,
          ssh: {
            user: loginUser,
            host: runtime.publishAddress,
            port: intent.port,
          },
        };
      }

      if (intent.hostKey !== undefined) {
        machine = { ...machine, hostKey: intent.hostKey };
      }

      if (observed === "running" && life.tailnet.status !== undefined) {
        machine = { ...machine, tailnet: life.tailnet.status };
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
      desired: Exclude<Desired, "deleted">,
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
            message: `the ${config.kind} runtime couldn't read machine ${id}; the host reads it again at its next recheck`,
          });
        }

        if (phase === "failed") {
          return yield* (
            life.error ?? new Internal({ message: `machine ${id} failed, saying nothing` })
          );
        }

        if (phase === "lost") {
          return yield* missing(config.kind, { id });
        }

        return resource(yield* row(name), life, phase, life.seen);
      });

    const settledOn = (name: string, desired: Exclude<Desired, "deleted">) =>
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

    const born = (name: string, spec: Spec, ephemeral: boolean) =>
      Effect.gen(function* () {
        const intent: Intent = {
          name,
          instance: newInstance(),
          createdAt: yield* DateTime.now,
          base: spec.base,
          profile: spec.profile,
          cpu: spec.cpu,
          ramMib: spec.ramMib,
          diskGib: spec.diskGib,
          port: yield* pickPort(
            probe,
            runtime.publishAddress,
            config.machinePorts,
            yield* store.ports,
          ),
          desired: "running",
          generation: 1,
          ephemeral,
          made: false,
          hostKey: undefined,
          pin: runtime.pin,
        };

        yield* store.insertMachine(intent);

        return intent;
      });

    const making = (name: string, spec: Spec, making: Making, ephemeral: boolean) =>
      Effect.gen(function* () {
        const actor = yield* Effect.uninterruptible(
          Effect.flatMap(inserting.withPermits(1)(born(name, spec, ephemeral)), (intent) =>
            register(bornOf(intent, making, "unknown")),
          ),
        );

        return yield* answered(name, actor, "running", 1);
      });

    const create = (request_: CreateRequest, options?: CreateOptions) =>
      Effect.gen(function* () {
        const name = yield* nameOf(request_.id);
        const host = { kind: config.kind, bases: [...config.bases.keys()] };

        if (!offers(host, request_.base)) {
          return yield* new NotOffered({
            message: `host ${config.id} doesn't offer base ${request_.base}; it offers ${offered(host)}`,
            base: request_.base,
          });
        }

        const image = config.bases.get(request_.base) ?? request_.base;

        return yield* making(
          name,
          request_,
          { source: { kind: "base", image }, script: request_.setup },
          options?.ephemeral ?? false,
        );
      });

    const fork = (sourceId: string, name: string) =>
      Effect.gen(function* () {
        const source = yield* nameOf(sourceId);

        yield* formatId(config.id, name);

        const from = yield* row(source);

        yield* made(from);

        return yield* making(
          name,
          from,
          { source: { kind: "machine", from }, script: undefined },
          false,
        );
      });

    const restore = (checkpointId: string, name: string) =>
      Effect.gen(function* () {
        const source = yield* nameOf(checkpointId);

        yield* formatId(config.id, name);

        const record = yield* readyCheckpoint(source);

        return yield* making(
          name,
          record,
          { source: { kind: "checkpoint", record }, script: undefined },
          false,
        );
      });

    const exec = (request: ExecRequest) =>
      surviving(
        `exec in ${request.id}`,
        Effect.gen(function* () {
          const name = yield* nameOf(request.id);
          const id = idOf(name);

          const intent = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* leases.share("machine", name);

              const intent = yield* row(name);

              yield* made(intent);

              const [seen = "unknown"] = yield* runtime
                .observe([ref(intent)])
                .pipe(inTime(`the ${config.kind} runtime`));

              if (seen === "missing") {
                return yield* missing(config.kind, { id });
              }

              if (seen === "stopped" || seen === "paused") {
                return yield* new WrongState({
                  message: `machine ${id} is ${seen}, and a command runs only in a running machine: start it first`,
                  machine: id,
                  state: seen,
                });
              }

              return intent;
            }),
          );

          return yield* runCommand(runtime, ref(intent), request);
        }),
      );

    const sizedAfter = (machine: MachineRef, to: Sizes, resized: boolean) =>
      runtime.sizes(machine).pipe(
        inTime(`the ${config.kind} runtime's read of ${machine.id}'s sizes`),
        Effect.catch((error) =>
          Effect.as(
            Effect.logWarning(
              `resize ${machine.id}: couldn't read its sizes back, so the host keeps ${resized ? "those asked" : "those it had"}: ${error.message}`,
            ),
            resized ? to : machine,
          ),
        ),
      );

    const resized = (name: string, request: ResizeRequest) =>
      Effect.gen(function* () {
        yield* leases.own("machine", name);

        const intent = yield* row(name);
        const machine = ref(intent);
        const { id } = machine;

        yield* made(intent);

        const to: Sizes = {
          cpu: request.cpu ?? intent.cpu,
          ramMib: request.ramMib ?? intent.ramMib,
          diskGib: request.diskGib ?? intent.diskGib,
        };

        if (to.diskGib < intent.diskGib) {
          return yield* new Unsizable({
            message: `machine ${id}'s disk is ${formatGib(intent.diskGib)}, and a disk only grows`,
          });
        }

        const [seen = "unknown"] = yield* runtime
          .observe([machine])
          .pipe(inTime(`the ${config.kind} runtime`));

        if (seen === "missing") {
          return yield* missing(config.kind, { id });
        }

        if (seen === "unknown") {
          return yield* new Internal({
            message: `the ${config.kind} runtime couldn't read machine ${id}, so it isn't resized: try again`,
          });
        }

        const running = seen === "running";

        if (seen === "paused" || (running && !runtime.growsLive)) {
          return yield* new WrongState({
            message: `machine ${id} is ${seen}, and the ${config.kind} runtime resizes ${runtime.growsLive ? "a stopped or running machine" : "only a stopped machine"}: stop it first`,
            machine: id,
            state: seen,
          });
        }

        if (running && (to.cpu < intent.cpu || to.ramMib < intent.ramMib)) {
          return yield* new Unsizable({
            message: `a running machine's vCPUs and RAM only grow, and ${id} has ${intent.cpu} vCPUs and ${formatMib(intent.ramMib)}: stop it to shrink them`,
          });
        }

        if (running && to.ramMib > intent.ramMib) {
          yield* admitted("resizeMachine", { ...machine, ...to });
        }

        const outcome = yield* Effect.exit(runtime.resize(machine, to, running));

        yield* store.sized(name, yield* sizedAfter(machine, to, Exit.isSuccess(outcome)));
        yield* outcome;

        return yield* shown(name);
      });

    const resize = (request: ResizeRequest) =>
      Effect.gen(function* () {
        const name = yield* nameOf(request.id);
        const id = idOf(name);

        const work = surviving(`resize ${id}`, Effect.scoped(resized(name, request))).pipe(
          Effect.tapError((error) => Effect.logWarning(`resize ${id} failed: ${error.message}`)),
        );

        return yield* Effect.flatMap(Effect.forkIn(work, hostScope), Fiber.join);
      });

    const capacity = Effect.flatMap(heldMachines, (machines) =>
      runtime.capacity(machines).pipe(
        inTime(`the ${config.kind} runtime`),
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
      pause: Effect.fn("Machines.pause")((id) =>
        Effect.flatMap(nameOf(id), (name) => settledOn(name, "paused")),
      ),
      resize: Effect.fn("Machines.resize")(resize),
      delete: Effect.fn("Machines.delete")((id) => Effect.flatMap(nameOf(id), remove)),
      fork: Effect.fn("Machines.fork")(fork),
      restore: Effect.fn("Machines.restore")(restore),
      exec: Effect.fn("Machines.exec")(exec),
      capacity: capacity.pipe(Effect.withSpan("Machines.capacity")),
    } satisfies Interface;
  });

export const layer = (
  config: Pick<HostSettings, "id" | "kind" | "bases" | "machinePorts" | "recheck">,
): Layer.Layer<Machines, HostError, Store | Runtime | PortProbe | Leases> =>
  Layer.effect(Machines, make(config));
