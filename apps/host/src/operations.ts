import type {
  ExecCommand,
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
  Executed,
  HostError,
  Missing,
  Sizing,
  TailnetStatus,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Cause,
  Context,
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

import {
  checkTailnet,
  identify,
  prepare,
  runCommand,
  runSetup,
} from "./guest.ts";
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
import type { Booting, Held, Observed } from "./runtime.ts";
import type { HostSettings } from "./settings.ts";
import { Tailnet } from "./tailnet.ts";

export interface Interface {
  readonly boot: string;
  readonly run: (operation: Operation) => Effect.Effect<Report, Conflict>;
  readonly wait: (id: string) => Effect.Effect<Report>;
  readonly cancel: (id: string) => Effect.Effect<void>;
  readonly collect: (id: string) => Effect.Effect<void>;
  readonly read: (
    machines: readonly Native[]
  ) => Effect.Effect<Observed, Internal>;
  readonly capacity: (
    machines: readonly MachineRef[]
  ) => ReturnType<Runtime["Service"]["capacity"]>;
  readonly exec: (
    command: ExecCommand
  ) => Effect.Effect<Executed, Missing | WrongState | Internal>;
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

interface Progress {
  status: Report["status"];
  outcome: Outcome;
  error: HostError | undefined;
}

interface Entry {
  readonly scope: string;
  readonly fiber: Fiber.Fiber<void, HostError>;
  readonly progress: Progress;
}

const ended = (
  progress: Progress,
  name: string,
  exit: Exit.Exit<void, HostError>
) =>
  Effect.gen(function* () {
    if (Exit.isSuccess(exit)) {
      progress.status = "done";

      return;
    }

    if (Cause.hasInterruptsOnly(exit.cause)) {
      progress.status = "cancelled";

      return;
    }

    const error = Option.getOrElse(
      Cause.findErrorOption(exit.cause),
      () => new Internal({ message: `${name} died; the host log has why` })
    );

    progress.status = "failed";
    progress.error = error;

    yield* Cause.hasDies(exit.cause)
      ? Effect.logError(`${name} died:\n${Cause.pretty(exit.cause)}`)
      : Effect.logWarning(`${name} failed: ${error.message}`);
  });

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

    const stateNow = (machine: MachineRef, what: string) =>
      Effect.gen(function* () {
        const seen = stateIn(
          yield* runtime
            .observe([machine])
            .pipe(inTime(`the ${config.kind} runtime`)),
          machine
        );

        if (seen === "unknown") {
          return yield* new Internal({
            message: `the ${config.kind} runtime couldn't read machine ${machine.name}, so it isn't ${what}: try again`,
          });
        }

        return seen;
      });

    const withRoom = (
      action: Booting,
      machine: MachineRef,
      machines: readonly MachineRef[],
      act: Effect.Effect<void, HostError>
    ) =>
      Effect.scoped(Effect.andThen(admitted(action, machine, machines), act));

    const resized = (
      progress: Progress,
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

        const seen = yield* stateNow(machine, "resized");

        if (seen === "missing") {
          return yield* missing(config.kind, machine);
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

        progress.outcome = { ...progress.outcome, sizes };

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
      { machine, source, machines }: Make,
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

        if (source._tag === "base" && source.setup !== undefined) {
          yield* runSetup(runtime, ref, source.setup);
        }
      });

    const perform = (
      progress: Progress,
      step: Exclude<Step, Make>
    ): Effect.Effect<void, HostError> => {
      switch (step._tag) {
        case "start": {
          const { machine, pin, machines } = step;

          return Effect.gen(function* () {
            const seen = yield* stateNow(machine, "started");

            if (seen === "missing") {
              return yield* missing(config.kind, machine);
            }

            if (seen === "paused") {
              yield* resumable(machine.name, pin);
            }

            yield* seen === "running"
              ? runtime.start(machine)
              : withRoom(
                  "startMachine",
                  machine,
                  machines,
                  runtime.start(machine)
                );

            yield* identify(runtime, machine);

            if (Option.isSome(tailnet) && step.hostname !== undefined) {
              const status = yield* joined(
                tailnet.value,
                machine,
                step.hostname
              );

              progress.outcome = { ...progress.outcome, tailnet: status };
            }

            const hostKey = yield* prepare(runtime, machine);

            if (hostKey !== undefined) {
              progress.outcome = { ...progress.outcome, hostKey };
            }
          });
        }

        case "stop": {
          const { machine, pin, machines } = step;
          const stopped = runtime.stop(machine);

          return runtime.stopResumes
            ? Effect.gen(function* () {
                if ((yield* stateNow(machine, "stopped")) !== "paused") {
                  return yield* stopped;
                }

                yield* resumable(machine.name, pin);
                yield* withRoom("stopMachine", machine, machines, stopped);
              })
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
            resized(progress, step.machine, step.to, step.machines)
          );
        }

        case "capture": {
          const { machine, checkpoint, pin } = step;

          const cleared = Effect.sync(() => {
            progress.outcome = { ...progress.outcome, cleared: true };
          });

          return Effect.andThen(
            Effect.tapError(copyable(machine.name, pin), () => cleared),
            runtime
              .capture(machine, checkpoint)
              .pipe(
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit)
                    ? Effect.void
                    : runtime
                        .deleteCheckpoint(checkpoint)
                        .pipe(Effect.andThen(cleared), Effect.ignore)
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
                  progress.outcome = { ...progress.outcome, tailnet: status };
                }
              ),
          });
        }
      }
    };

    const reported = (id: string, progress: Progress | undefined): Report =>
      progress === undefined
        ? { id, boot, status: "absent", outcome: {} }
        : {
            id,
            boot,
            status: progress.status,
            outcome: progress.outcome,
            ...(progress.error === undefined ? {} : { error: progress.error }),
          };

    const heldPorts = () =>
      [...entries.values()].flatMap(({ progress: { status, outcome } }) =>
        (status === "running" || status === "done") &&
        outcome.port !== undefined
          ? [outcome.port]
          : []
      );

    const picking = (progress: Progress, step: Make) =>
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
            progress.outcome = { port };

            return made(step, port);
          },
        }
      );

    const forgetting = (id: string) =>
      Effect.suspend(() => {
        const before = entries.get(id);

        return before === undefined
          ? Effect.void
          : Effect.andThen(
              Fiber.interrupt(before.fiber),
              Effect.sync(() => entries.delete(id))
            );
      });

    const accept = (operation: Operation, before: string | undefined) =>
      Effect.gen(function* () {
        const { id, step, scope, sequence } = operation;
        const name = `${step._tag} ${scope}`;

        const progress: Progress = {
          status: "running",
          outcome: {},
          error: undefined,
        };

        const work =
          step._tag === "make"
            ? yield* picking(progress, step)
            : perform(progress, step);

        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkIn(
              Effect.onExit(
                before === undefined
                  ? work
                  : Effect.andThen(
                      Effect.uninterruptible(forgetting(before)),
                      work
                    ),
                (exit) => ended(progress, name, exit)
              ),
              hostScope
            );

            entries.set(id, { scope, fiber, progress });
            scopes.set(scope, { sequence, id });

            return reported(id, progress);
          })
        );
      });

    const run: Interface["run"] = (operation) =>
      accepting.withPermits(1)(
        Effect.gen(function* () {
          const same = entries.get(operation.id);

          if (same !== undefined) {
            return reported(operation.id, same.progress);
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

          return yield* accept(operation, at?.id);
        })
      );

    const wait: Interface["wait"] = (id) =>
      Effect.suspend(() => {
        const entry = entries.get(id);

        return entry === undefined
          ? Effect.succeed(reported(id, undefined))
          : Effect.map(
              Effect.timeoutOption(Fiber.await(entry.fiber), reportWait),
              () => reported(id, entry.progress)
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
        if (entries.get(id)?.progress.status !== "running") {
          entries.delete(id);
        }
      });

    const stepEnded = (machine: MachineRef) =>
      Effect.suspend(() => {
        const held = scopes.get(`machine ${machine.name}`);
        const entry = held === undefined ? undefined : entries.get(held.id);

        return entry === undefined || entry.progress.status !== "running"
          ? Effect.void
          : Effect.asVoid(Fiber.await(entry.fiber));
      });

    const exec: Interface["exec"] = (command) =>
      surviving(
        `exec in ${command.machine.name}`,
        Effect.gen(function* () {
          const { machine } = command;

          yield* stepEnded(machine);

          const seen = yield* stateNow(machine, "given the command");

          if (seen === "missing") {
            return yield* missing(config.kind, machine);
          }

          if (seen !== "running") {
            return yield* new WrongState({
              message: `machine ${machine.name} is ${seen}, and a command runs only in a running machine: start it first`,
              machine: machine.name,
              state: seen,
            });
          }

          return yield* runCommand(runtime, command);
        })
      );

    return {
      boot,
      run,
      wait,
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
      exec: Effect.fn("Operations.exec")(exec),
    } satisfies Interface;
  });

export const layer = (
  config: Settings
): Layer.Layer<Operations, never, Runtime | PortProbe> =>
  Layer.effect(Operations, make(config));
