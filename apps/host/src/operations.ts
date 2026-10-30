import type {
  MachineRef,
  Native,
  Operation,
  Outcome,
  Report,
  Source,
  Step,
} from "@clankerbox/host-contract";
import {
  checkpointKinds,
  Conflict,
  formatGib,
  formatMib,
  Internal,
  PinMismatch,
  Unsizable,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  HostError,
  Sizing,
  TailnetStatus,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Semaphore,
} from "effect";
import type { Scope } from "effect";
import { Hex } from "effect/encoding";

import { checkTailnet, prepare, runSetup } from "./guest.ts";
import type { TailnetReport } from "./guest.ts";
import { pickPort, PortProbe } from "./machine-ports.ts";
import {
  missing,
  Runtime,
  sizedBy,
  stateIn,
  stateReadWait,
  timeoutFail,
} from "./runtime.ts";
import type { Booting, Held, MachineState, Observed } from "./runtime.ts";
import type { HostSettings } from "./settings.ts";
import { Tailnet } from "./tailnet.ts";

export interface Interface {
  readonly boot: string;
  readonly run: (operation: Operation) => Effect.Effect<Report, Conflict>;
  /** Reports an operation, once it ends or after `reportWait`. */
  readonly wait: (id: string) => Effect.Effect<Report>;
  readonly list: Effect.Effect<readonly Report[]>;
  readonly cancel: (id: string) => Effect.Effect<void>;
  readonly collect: (id: string) => Effect.Effect<void>;
  readonly read: (
    machines: readonly Native[]
  ) => Effect.Effect<Observed, Internal>;
  readonly capacity: (
    machines: readonly MachineRef[]
  ) => ReturnType<Runtime["Service"]["capacity"]>;
}

export class Operations extends Context.Service<Operations, Interface>()(
  "@clankerbox/host/Operations"
) {}

const reportWait = Duration.seconds(5);

const joinTimeout = Duration.minutes(3);

const booted = {
  base: "createMachine",
  checkpoint: "restoreMachine",
  machine: "forkMachine",
} satisfies Record<Source["_tag"], Booting>;

const statusOf = (report: TailnetReport | undefined): TailnetStatus => {
  if (report === undefined) {
    return {
      state: "failed",
      error: "the tailnet script reported nothing readable",
    };
  }

  if (report.missing) {
    return { state: "missing" };
  }

  if (report.backend !== "Running") {
    return {
      state: "failed",
      error: `tailscaled is ${report.backend}, not signed in`,
    };
  }

  return report.name === undefined
    ? { state: "joined" }
    : { state: "joined", name: report.name };
};

const sourceSizes = (source: Exclude<Source, { _tag: "base" }>) =>
  source._tag === "checkpoint" ? source.checkpoint : source.machine;

const inTime = (what: string) =>
  timeoutFail(
    stateReadWait,
    () =>
      new Internal({
        message: `${what} didn't answer within ${Duration.format(stateReadWait)}`,
      })
  );

const surviving = <A, E>(what: string, work: Effect.Effect<A, E>) =>
  Effect.catchCauseFilter(work, Cause.findDefect, (_defect, cause) =>
    Effect.andThen(
      Effect.logError(`${what} died:\n${Cause.pretty(cause)}`),
      Effect.fail(
        new Internal({ message: `${what} died; the host log has why` })
      )
    )
  );

interface Entry {
  readonly operation: Operation;
  readonly ended: Deferred.Deferred<undefined>;
  fiber: Fiber.Fiber<void, HostError> | undefined;
  status: Report["status"];
  outcome: Outcome;
  error: HostError | undefined;
}

type Make = Extract<Step, { readonly _tag: "make" }>;

type Settings = Pick<HostSettings, "id" | "kind" | "bases" | "machinePorts">;

export const make = (
  config: Settings
): Effect.Effect<Interface, never, Runtime | PortProbe | Scope.Scope> =>
  Effect.gen(function* () {
    const runtime = yield* Runtime;
    const tailnet = yield* Effect.serviceOption(Tailnet);
    const probe = yield* PortProbe;
    const hostScope = yield* Effect.scope;
    const admission = yield* Semaphore.make(1);
    const accepting = yield* Semaphore.make(1);

    const boot = Hex.encode(
      globalThis.crypto.getRandomValues(new Uint8Array(8))
    );

    const entries = new Map<string, Entry>();
    const scopes = new Map<string, { sequence: number; id: string }>();
    const booting = new Map<string, MachineRef>();

    const heldBy = (machines: readonly MachineRef[]): readonly Held[] => [
      ...machines.map((machine) => {
        const boots = booting.get(machine.name);

        return boots === undefined
          ? { machine, booting: false }
          : { machine: boots, booting: true };
      }),
      ...booting
        .values()
        .filter(({ name }) => !machines.some((known) => known.name === name))
        .map((machine) => ({ machine, booting: true })),
    ];

    const admitted = (
      action: Booting,
      machine: MachineRef,
      machines: readonly MachineRef[]
    ) =>
      admission.withPermits(1)(
        Effect.gen(function* () {
          yield* runtime
            .admit({
              action,
              machine,
              machines: [
                ...heldBy(machines).filter(
                  (held) => held.machine.name !== machine.name
                ),
                { machine, booting: true },
              ],
            })
            .pipe(
              inTime(
                `${action} ${machine.name}: the ${config.kind} runtime's admission check`
              )
            );

          yield* Effect.acquireRelease(
            Effect.sync(() => booting.set(machine.name, machine)),
            () => Effect.sync(() => booting.delete(machine.name))
          );
        })
      );

    const resumable = (name: string, pin: string | undefined) =>
      pin === runtime.pin
        ? Effect.void
        : Effect.fail(
            new PinMismatch({
              message: `machine ${name} was paused under ${pin ?? "no pin"}, and this host runs ${runtime.pin ?? "no pin"}; it resumes only under the same one: delete it, or resume it under that one`,
            })
          );

    const copyable = (name: string, pin: string | undefined) =>
      pin === runtime.pin
        ? Effect.void
        : Effect.fail(
            new PinMismatch({
              message: `machine ${name}'s VM booted under ${pin ?? "an older host"}, and this host runs ${runtime.pin ?? "no pin"}, so a copy of its RAM would restore under the wrong one: stop it and start it again first`,
            })
          );

    const restorable = (name: string, pin: string | undefined) =>
      pin === runtime.pin
        ? Effect.void
        : Effect.fail(
            new PinMismatch({
              message: `checkpoint ${name} holds RAM state saved under ${pin ?? "no pin"}, and this host runs ${runtime.pin ?? "no pin"}; it restores only under the same one`,
            })
          );

    const copied = (source: Source, machine: MachineRef) =>
      Effect.gen(function* () {
        if (source._tag === "base") {
          return yield* runtime.create(
            machine,
            config.bases.get(source.base) ?? source.base
          );
        }

        if (source._tag === "checkpoint") {
          yield* restorable(source.checkpoint.name, source.pin);

          return yield* runtime.restore(source.checkpoint, machine);
        }

        yield* copyable(source.machine.name, source.pin);

        return yield* runtime.fork(source.machine, machine);
      });

    const running = (
      machine: MachineRef,
      seen: MachineState,
      machines: readonly MachineRef[],
      started: Effect.Effect<void, HostError>
    ) =>
      seen === "running"
        ? started
        : Effect.scoped(
            Effect.andThen(admitted("startMachine", machine, machines), started)
          );

    const resized = (
      entry: Entry,
      machine: MachineRef,
      request: Sizing,
      machines: readonly MachineRef[]
    ) =>
      Effect.gen(function* () {
        const { name } = machine;
        const to = sizedBy(machine, request);

        if (to.diskGib < machine.diskGib) {
          return yield* new Unsizable({
            message: `machine ${name}'s disk is ${formatGib(machine.diskGib)}, and a disk only grows`,
          });
        }

        const seen = stateIn(
          yield* runtime
            .observe([machine])
            .pipe(inTime(`the ${config.kind} runtime`)),
          machine
        );

        if (seen === "missing") {
          return yield* missing(config.kind, machine);
        }

        if (seen === "unknown") {
          return yield* new Internal({
            message: `the ${config.kind} runtime couldn't read machine ${name}, so it isn't resized: try again`,
          });
        }

        const live = seen === "running";

        if (seen === "paused" || (live && !runtime.growsLive)) {
          return yield* new WrongState({
            message: `machine ${name} is ${seen}, and the ${config.kind} runtime resizes ${runtime.growsLive ? "a stopped or running machine" : "only a stopped machine"}: stop it first`,
            machine: name,
            state: seen,
          });
        }

        if (live && (to.cpu < machine.cpu || to.ramMib < machine.ramMib)) {
          return yield* new Unsizable({
            message: `a running machine's vCPUs and RAM only grow, and ${name} has ${machine.cpu} vCPUs and ${formatMib(machine.ramMib)}: stop it to shrink them`,
          });
        }

        yield* runtime.sizable(machine, machine, to, live);

        if (live && to.ramMib > machine.ramMib) {
          yield* admitted("resizeMachine", { ...machine, ...to }, machines);
        }

        const result = yield* Effect.exit(
          runtime.resize(machine, request, live)
        );

        const given = Exit.isSuccess(result);
        const known = given ? to : machine;

        const sizes = yield* runtime.sizes(machine).pipe(
          inTime(`the ${config.kind} runtime's read of ${name}'s sizes`),
          Effect.map((read) => sizedBy(known, read)),
          Effect.catch((error) =>
            Effect.as(
              Effect.logWarning(
                `resize ${name}: couldn't read its sizes back, so the host keeps ${given ? "those asked" : "those it had"}: ${error.message}`
              ),
              { cpu: known.cpu, ramMib: known.ramMib, diskGib: known.diskGib }
            )
          )
        );

        entry.outcome = { ...entry.outcome, sizes };

        yield* result;
      });

    const joined = (
      { mint }: Tailnet["Service"],
      machine: MachineRef,
      hostname: string
    ) =>
      surviving(
        `tailnet join ${machine.name}`,
        Effect.gen(function* () {
          const report = yield* checkTailnet(runtime, machine, hostname);

          return statusOf(
            report?.missing === false && report.backend === "NeedsLogin"
              ? yield* checkTailnet(runtime, machine, hostname, yield* mint)
              : report
          );
        })
      ).pipe(
        timeoutFail(
          joinTimeout,
          () =>
            new Internal({
              message: `the join didn't finish within ${Duration.format(joinTimeout)}`,
            })
        ),
        Effect.catch((error) =>
          Effect.succeed<TailnetStatus>({
            state: "failed",
            error: error.message,
          })
        ),
        Effect.tap((status) =>
          status.state === "failed"
            ? Effect.logWarning(
                `tailnet join ${machine.name} failed: ${status.error}`
              )
            : Effect.void
        )
      );

    const made = (
      { machine, source, setup, machines }: Make,
      port: number
    ): Effect.Effect<void, HostError> =>
      Effect.gen(function* () {
        const ref: MachineRef = { ...machine, port };

        yield* source._tag === "base"
          ? runtime.sizable(ref, machine, machine, false)
          : runtime.sizable(
              ref,
              sourceSizes(source),
              machine,
              checkpointKinds[config.kind] === "ram"
            );

        yield* Effect.scoped(
          Effect.andThen(
            admitted(booted[source._tag], ref, machines),
            copied(source, ref)
          )
        );

        if (setup !== undefined) {
          yield* runSetup(runtime, ref, setup);
        }
      });

    const perform = (
      entry: Entry,
      step: Exclude<Step, Make>
    ): Effect.Effect<void, HostError> => {
      switch (step._tag) {
        case "start": {
          const { machine, seen, pin, machines } = step;

          return Effect.gen(function* () {
            if (seen === "paused") {
              yield* resumable(machine.name, pin);
            }

            yield* running(machine, seen, machines, runtime.start(machine));

            const hostKey = yield* prepare(runtime, machine);

            if (hostKey !== undefined) {
              entry.outcome = { ...entry.outcome, hostKey };
            }
          });
        }

        case "stop": {
          const { machine, seen, pin, machines } = step;
          const stopped = runtime.stop(machine);

          return seen === "paused" && runtime.stopResumes
            ? Effect.andThen(
                resumable(machine.name, pin),
                Effect.scoped(
                  Effect.andThen(
                    admitted("stopMachine", machine, machines),
                    stopped
                  )
                )
              )
            : stopped;
        }

        case "pause": {
          const { machine, pin } = step;

          return pin === runtime.pin
            ? runtime.pause(machine)
            : Effect.andThen(
                Effect.logWarning(
                  `pause ${machine.name}: its VM booted under ${pin ?? "an older host"}, and this host runs ${runtime.pin ?? "no pin"}, so it stops it instead`
                ),
                runtime.stop(machine)
              );
        }

        case "remove": {
          return runtime.delete(step.machine);
        }

        case "resize": {
          return Effect.scoped(
            resized(entry, step.machine, step.to, step.machines)
          );
        }

        case "capture": {
          const { machine, checkpoint, pin } = step;

          return Effect.andThen(
            copyable(machine.name, pin),
            runtime
              .capture(machine, checkpoint)
              .pipe(
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit)
                    ? Effect.void
                    : Effect.ignore(runtime.deleteCheckpoint(checkpoint))
                )
              )
          );
        }

        case "deleteCheckpoint": {
          return runtime.deleteCheckpoint(step.checkpoint);
        }

        case "join": {
          return Option.match(tailnet, {
            onNone: () => Effect.void,
            onSome: (joining) =>
              Effect.map(
                joined(joining, step.machine, step.hostname),
                (status) => {
                  entry.outcome = { ...entry.outcome, tailnet: status };
                }
              ),
          });
        }
      }
    };

    const reported = (id: string, entry: Entry | undefined): Report =>
      entry === undefined
        ? { id, boot, status: "absent", outcome: {} }
        : {
            id,
            boot,
            status: entry.status,
            outcome: entry.outcome,
            ...(entry.error === undefined ? {} : { error: entry.error }),
          };

    const ended = (entry: Entry, exit: Exit.Exit<void, HostError>) =>
      Effect.gen(function* () {
        if (Exit.isSuccess(exit)) {
          entry.status = "done";
        } else if (Cause.hasInterruptsOnly(exit.cause)) {
          entry.status = "cancelled";
        } else {
          const { step, scope } = entry.operation;
          const name = `${step._tag} ${scope}`;

          entry.status = "failed";
          entry.error = Option.getOrElse(
            Cause.findErrorOption(exit.cause),
            () =>
              new Internal({ message: `${name} died; the host log has why` })
          );

          yield* Cause.hasDies(exit.cause)
            ? Effect.logError(`${name} died:\n${Cause.pretty(exit.cause)}`)
            : Effect.logWarning(`${name} failed: ${entry.error.message}`);
        }

        yield* Deferred.succeed(entry.ended, undefined);
      });

    const heldPorts = () =>
      [...entries.values()].flatMap(({ status, outcome }) =>
        (status === "running" || status === "done") &&
        outcome.port !== undefined
          ? [outcome.port]
          : []
      );

    const picking = (entry: Entry, step: Make) =>
      Effect.match(
        pickPort(
          probe,
          runtime.publishAddress,
          config.machinePorts,
          new Set([...step.ports, ...heldPorts()])
        ),
        {
          onFailure: (error): Effect.Effect<void, HostError> =>
            Effect.fail(error),
          onSuccess: (port) => {
            entry.outcome = { port };

            return made(step, port);
          },
        }
      );

    const accept = (operation: Operation, before: Entry | undefined) =>
      Effect.gen(function* () {
        const { step } = operation;

        const entry: Entry = {
          operation,
          ended: yield* Deferred.make<undefined>(),
          fiber: undefined,
          status: "running",
          outcome: {},
          error: undefined,
        };

        const work =
          step._tag === "make"
            ? yield* picking(entry, step)
            : perform(entry, step);

        const cutShort =
          before?.fiber === undefined
            ? Effect.void
            : Effect.uninterruptible(Fiber.interrupt(before.fiber));

        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            entries.set(operation.id, entry);
            scopes.set(operation.scope, {
              sequence: operation.sequence,
              id: operation.id,
            });

            entry.fiber = yield* Effect.forkIn(
              Effect.onExit(Effect.andThen(cutShort, work), (exit) =>
                ended(entry, exit)
              ),
              hostScope
            );

            return reported(operation.id, entry);
          })
        );
      });

    const run: Interface["run"] = (operation) =>
      accepting.withPermits(1)(
        Effect.gen(function* () {
          const same = entries.get(operation.id);

          if (same !== undefined) {
            return reported(operation.id, same);
          }

          if (operation.boot !== boot) {
            return yield* new Conflict({
              message: `operation ${operation.id} is for boot ${operation.boot}, and this host is ${boot}`,
            });
          }

          const at = scopes.get(operation.scope);

          if (at !== undefined && operation.sequence <= at.sequence) {
            return yield* new Conflict({
              message: `operation ${operation.id} is number ${operation.sequence} on ${operation.scope}, and this host has seen ${at.sequence}`,
            });
          }

          const before = at === undefined ? undefined : entries.get(at.id);

          return yield* accept(
            operation,
            before?.status === "running" ? before : undefined
          );
        })
      );

    const wait: Interface["wait"] = (id) =>
      Effect.suspend(() => {
        const entry = entries.get(id);

        return entry === undefined
          ? Effect.succeed(reported(id, undefined))
          : Effect.map(
              Effect.timeoutOption(Deferred.await(entry.ended), reportWait),
              () => reported(id, entry)
            );
      });

    const cancel: Interface["cancel"] = (id) =>
      Effect.suspend(() => {
        const fiber = entries.get(id)?.fiber;

        return fiber === undefined
          ? Effect.void
          : Effect.asVoid(Effect.forkIn(Fiber.interrupt(fiber), hostScope));
      });

    const collect: Interface["collect"] = (id) =>
      Effect.sync(() => {
        if (entries.get(id)?.status !== "running") {
          entries.delete(id);
        }
      });

    return {
      boot,
      run,
      wait,
      list: Effect.sync(() =>
        [...entries].map(([id, entry]) => reported(id, entry))
      ),
      cancel,
      collect,
      read: (machines) =>
        machines.length === 0
          ? Effect.succeed(new Map())
          : surviving(
              `the ${config.kind} runtime's read`,
              runtime.observe(machines)
            ).pipe(inTime(`the ${config.kind} runtime`)),
      capacity: (machines) =>
        runtime
          .capacity(heldBy(machines))
          .pipe(inTime(`the ${config.kind} runtime`)),
    } satisfies Interface;
  });

export const layer = (
  config: Settings
): Layer.Layer<Operations, never, Runtime | PortProbe> =>
  Layer.effect(Operations, make(config));
