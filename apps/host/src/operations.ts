import type {
  Adoption,
  ExecCommand,
  MachineRef,
  MachineState,
  Operation,
  Outcome,
  Ref,
  Report,
  Retired,
  Scope as Resource,
  Source,
  Step,
} from "@clankerbox/host-contract";
import { pinRefusal, resizeRefusal } from "@clankerbox/host-contract/traits";
import {
  Conflict,
  Internal,
  timedOutExitCode,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  Executed,
  HostError,
  Invalid,
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
  FileSystem,
  Fiber,
  Layer,
  Option,
  Path,
  References,
  Semaphore,
} from "effect";
import type { Scope } from "effect";
import { Hex } from "effect/encoding";

import { BuildStore, fetch, publish, unpublish } from "./builds.ts";
import {
  checkTailnet,
  identify,
  addMissingKeys,
  lastLines,
  leave,
  prepareBase,
  prepare,
  rememberDns,
  runCommand,
  runSetup,
  scrubNode,
} from "./guest.ts";
import type { Leaving, TailnetReport } from "./guest.ts";
import { Reaches } from "./reach.ts";
import {
  missing,
  missingCheckpoint,
  Runtime,
  sizedBy,
  stateIn,
  stateReadWait,
  timeoutFail,
} from "./runtime.ts";
import type {
  Booting,
  CheckpointFiles,
  Handle,
  Held,
  Identity,
  MarkedMachine,
  Observed,
  Origin,
  Sized,
  Target,
} from "./runtime.ts";
import type { HostSettings } from "./settings.ts";
import { Tailnet } from "./tailnet.ts";

export interface Interface {
  readonly boot: string;
  readonly run: (operation: Operation) => Effect.Effect<Report, Conflict>;
  readonly wait: (id: string) => Effect.Effect<Report>;
  readonly cancel: (id: string) => Effect.Effect<void>;
  readonly collect: (id: string) => Effect.Effect<void>;
  readonly read: (
    machines: readonly Ref[]
  ) => Effect.Effect<Observed, Internal>;
  readonly sizes: (
    machine: MachineRef
  ) => Effect.Effect<Sizing, Missing | Internal>;
  readonly capacity: (
    machines: readonly MachineRef[]
  ) => ReturnType<Runtime["Service"]["capacity"]>;
  readonly adopt: (machines: readonly MachineRef[]) => Effect.Effect<Adoption>;
  readonly sweep: (retired: Retired) => Effect.Effect<Retired, Internal>;
  readonly exec: (
    command: ExecCommand
  ) => Effect.Effect<Executed, Invalid | Missing | WrongState | Internal>;
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

  if (report.state === "missing") {
    return { state: "missing" };
  }

  if (report.state === "lost") {
    return {
      state: "failed",
      error: "control no longer has the guest's node",
    };
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

const keyOf = ({ resource, name }: Resource) => `${resource} ${name}`;

const heldAs = (machine: Ref, handle: Handle | undefined): string => {
  if (machine.handle !== undefined) {
    return `reached by its row's handle ${machine.handle}`;
  }

  return handle === undefined
    ? "the runtime holds no machine of its instance"
    : `the runtime found it as ${handle}`;
};

const targetOf = ({ name, instance }: Identity, handle: Handle): Target => ({
  name,
  instance,
  handle,
});

const sizedOf = (machine: MachineRef, handle: Handle): Sized => ({
  ...targetOf(machine, handle),
  cpu: machine.cpu,
  ramMib: machine.ramMib,
  diskGib: machine.diskGib,
});

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
  readonly scope: Resource;
  readonly names: readonly Ref[];
  readonly fiber: Fiber.Fiber<void, HostError>;
  readonly progress: Progress;
}

const oneLine = ({ message }: HostError): string => {
  const [first = "", ...rest] = message.split("\n");

  return rest.length === 0
    ? first
    : `${first} (${rest.length} more lines in the operation's report)`;
};

const ended = (
  progress: Progress,
  id: string,
  name: string,
  exit: Exit.Exit<void, HostError>
) =>
  Effect.gen(function* () {
    if (Exit.isSuccess(exit)) {
      progress.status = "done";

      return yield* Effect.logInfo(`${name} done, operation ${id}`);
    }

    if (Cause.hasInterruptsOnly(exit.cause)) {
      progress.status = "cancelled";

      return yield* Effect.logInfo(`${name} cancelled, operation ${id}`);
    }

    const error = Option.getOrElse(
      Cause.findErrorOption(exit.cause),
      () => new Internal({ message: `${name} died; the host log has why` })
    );

    progress.status = "failed";
    progress.error = error;

    yield* Cause.hasDies(exit.cause)
      ? Effect.logError(`${name} died, operation ${id}`, exit.cause)
      : Effect.logInfo(`${name} failed, operation ${id}: ${oneLine(error)}`);
  });

const apartFromItsRequest = <E>(
  { id, step, scope }: Operation,
  effect: Effect.Effect<void, E>
): Effect.Effect<void, E> =>
  effect.pipe(
    Effect.provideService(References.CurrentLogAnnotations, {
      operation: id,
      step: step._tag,
      [scope.resource]: scope.name,
    })
  );

type Make = Extract<Step, { readonly _tag: "make" }>;

interface Accepted {
  readonly sequence: number;
  readonly id: string;
  readonly leavesInstance: string | undefined;
}

const instanceLeftBy = (step: Step): string | undefined => {
  switch (step._tag) {
    case "make":
    case "start":
    case "stop":
    case "pause":
    case "resize":
    case "join": {
      return step.machine.instance;
    }

    case "remove":
    case "capture":
    case "deleteCheckpoint":
    case "publish":
    case "fetch": {
      return undefined;
    }
  }
};

const namedBy = (step: Step): readonly Ref[] => {
  switch (step._tag) {
    case "make": {
      const { source } = step;

      return source._tag === "base"
        ? [step.machine]
        : [step.machine, sourceSizes(source)];
    }

    case "capture": {
      return [step.machine, step.checkpoint];
    }

    case "deleteCheckpoint":
    case "publish":
    case "fetch": {
      return [step.checkpoint];
    }

    case "start":
    case "stop":
    case "pause":
    case "remove":
    case "resize":
    case "join": {
      return [step.machine];
    }
  }
};

type Settings = Pick<HostSettings, "id" | "bases">;

export const make = (
  config: Settings
): Effect.Effect<
  Interface,
  never,
  Runtime | Reaches | FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const runtime = yield* Runtime;
    const { traits } = runtime;
    const tailnet = yield* Effect.serviceOption(Tailnet);

    const pauseOrStop = (machine: Target, pin: string | undefined) => {
      if (traits.pause === "stops") {
        return runtime.stop(machine);
      }

      if (pin === runtime.pin) {
        return runtime.pause(machine);
      }

      return Effect.andThen(
        Effect.logWarning(
          `pause ${machine.name}: its VM booted under ${pin ?? "an older host"}, and this host runs ${runtime.pin ?? "no pin"}, so it stops it instead`
        ),
        runtime.stop(machine)
      );
    };

    const builds = yield* Effect.serviceOption(BuildStore);

    const copying = Option.flatMap(builds, (store) =>
      Option.map(Option.fromNullishOr(runtime.files), (local) => ({
        store,
        local,
      }))
    );

    const files = Context.make(
      FileSystem.FileSystem,
      yield* FileSystem.FileSystem
    ).pipe(Context.add(Path.Path, yield* Path.Path));

    const reaches = yield* Reaches;
    const hostScope = yield* Effect.scope;
    const admitting = yield* Semaphore.make(1);
    const accepting = yield* Semaphore.make(1);

    const boot = Hex.encode(
      globalThis.crypto.getRandomValues(new Uint8Array(8))
    );

    const entries = new Map<string, Entry>();
    const scopes = new Map<string, Accepted>();
    const booting = new Map<string, MachineRef>();

    const found = (machine: Ref) =>
      machine.handle === undefined
        ? runtime
            .find(machine)
            .pipe(
              inTime(
                `the ${traits.runtime} runtime's search for machine ${machine.name}`
              )
            )
        : Effect.succeed(machine.handle);

    const checkpointHandle = (checkpoint: Ref) =>
      checkpoint.handle ?? runtime.checkpointHandle(checkpoint);

    const machineTarget = (machine: MachineRef) =>
      Effect.flatMap(found(machine), (handle) =>
        handle === undefined
          ? Effect.fail(missing(traits.runtime, machine))
          : Effect.succeed(sizedOf(machine, handle))
      );

    const checkpointTarget = (checkpoint: Ref) => {
      const handle = checkpointHandle(checkpoint);

      return handle === undefined
        ? Effect.fail(missingCheckpoint(traits.runtime, checkpoint))
        : Effect.succeed(targetOf(checkpoint, handle));
    };

    const checkpointDeleted = (checkpoint: Ref) => {
      const handle = checkpointHandle(checkpoint);

      return handle === undefined
        ? Effect.void
        : runtime.deleteCheckpoint(targetOf(checkpoint, handle));
    };

    const heldOf = (machine: MachineRef) =>
      found(machine).pipe(
        Effect.map((handle): Held[] =>
          handle === undefined
            ? []
            : [{ _tag: "found", machine: sizedOf(machine, handle) }]
        ),
        Effect.orElseSucceed((): Held[] => [{ _tag: "unread", machine }])
      );

    const heldBy = (machines: readonly MachineRef[]) =>
      Effect.suspend(() => {
        const boots = new Map(booting);

        return Effect.map(
          Effect.forEach(
            machines.filter(({ name }) => !boots.has(name)),
            heldOf,
            { concurrency: "unbounded" }
          ),
          (held): readonly Held[] => [
            ...held.flat(),
            ...boots
              .values()
              .map((machine): Held => ({ _tag: "booting", machine })),
          ]
        );
      });

    const admitted = (
      action: Booting,
      machine: MachineRef,
      machines: readonly MachineRef[]
    ) =>
      admitting.withPermits(1)(
        Effect.gen(function* () {
          const { admission } = runtime;

          if (admission !== undefined) {
            yield* Effect.flatMap(
              heldBy(machines.filter(({ name }) => name !== machine.name)),
              (held) =>
                admission.admit({
                  action,
                  machine,
                  machines: [
                    ...held.filter(
                      (other) => other.machine.name !== machine.name
                    ),
                    { _tag: "booting", machine },
                  ],
                })
            ).pipe(
              inTime(
                `${action} ${machine.name}: the ${traits.runtime} runtime's admission check`
              )
            );
          }

          yield* Effect.acquireRelease(
            Effect.sync(() => booting.set(machine.name, machine)),
            () => Effect.sync(() => booting.delete(machine.name))
          );
        })
      );

    const pinned = (
      of: Parameters<typeof pinRefusal>[0],
      pin: string | undefined
    ) => {
      const refusal = pinRefusal(of, pin, runtime.pin);

      return refusal === undefined ? Effect.void : Effect.fail(refusal);
    };

    const originOf = (source: Source): Effect.Effect<Origin, HostError> =>
      Effect.gen(function* () {
        if (source._tag === "base") {
          return {
            _tag: "image",
            image: config.bases.get(source.base) ?? source.base,
          } as const;
        }

        if (source._tag === "checkpoint") {
          const { checkpoint, pin } = source;

          yield* pinned({ restore: checkpoint.name }, pin);

          const { handle } = yield* checkpointTarget(checkpoint);

          return {
            _tag: "checkpoint",
            checkpoint: sizedOf(checkpoint, handle),
          } as const;
        }

        yield* pinned({ copy: source.machine.name }, source.pin);

        return {
          _tag: "machine",
          machine: yield* machineTarget(source.machine),
        } as const;
      });

    const stateNow = (machine: Target, what: string) =>
      Effect.gen(function* () {
        const seen = stateIn(
          yield* runtime
            .observe([machine])
            .pipe(inTime(`the ${traits.runtime} runtime`)),
          machine
        );

        if (seen === "unknown") {
          return yield* new Internal({
            message: `the ${traits.runtime} runtime couldn't read machine ${machine.name}, so it isn't ${what}: try again`,
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
      ref: MachineRef,
      request: Sizing,
      machines: readonly MachineRef[]
    ) =>
      Effect.gen(function* () {
        const { name } = ref;
        const to = sizedBy(ref, request);
        const unsized = resizeRefusal(traits, name, undefined, ref, to);

        if (unsized !== undefined) {
          return yield* unsized;
        }

        const machine = yield* machineTarget(ref);
        const seen = yield* stateNow(machine, "resized");

        if (seen === "missing") {
          return yield* missing(traits.runtime, machine);
        }

        const live = seen === "running";
        const refusal = resizeRefusal(traits, name, seen, machine, to);

        if (refusal !== undefined) {
          return yield* refusal;
        }

        yield* runtime.sizable(machine, machine, to, live);

        if (live && to.ramMib > machine.ramMib) {
          yield* admitted("resizeMachine", { ...ref, ...to }, machines);
        }

        const result = yield* Effect.exit(
          runtime.resize(machine, request, live)
        );

        const given = Exit.isSuccess(result);
        const known = given ? to : machine;

        const sizes = yield* runtime.sizes(machine).pipe(
          inTime(`the ${traits.runtime} runtime's read of ${name}'s sizes`),
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
      mint: Tailnet["Service"]["mint"],
      machine: Target,
      hostname: string
    ) =>
      surviving(
        `tailnet join ${machine.name}`,
        Effect.gen(function* () {
          const report = yield* checkTailnet(runtime, machine, hostname);

          const lost = report?.state === "lost";

          return statusOf(
            lost ||
              (report?.state === "reported" && report.backend === "NeedsLogin")
              ? yield* checkTailnet(runtime, machine, hostname, {
                  key: yield* mint,
                  rejoin: lost,
                })
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

    const readied = (progress: Progress, machine: Target) =>
      Effect.gen(function* () {
        yield* identify(runtime, machine);

        const hostKey = yield* prepare(runtime, machine);

        progress.outcome = {
          ...progress.outcome,
          ...(hostKey === undefined ? {} : { hostKey }),
        };
      });

    const beforeLeaving = (
      machine: Target,
      leaving: Leaving,
      hook: { readonly timeoutSeconds: number } | undefined,
      seen: Effect.Effect<MachineState, HostError>
    ) =>
      hook === undefined
        ? Effect.void
        : surviving(
            `the ${leaving} hook of ${machine.name}`,
            Effect.gen(function* () {
              if ((yield* seen) !== "running") {
                return;
              }

              yield* Effect.logInfo(
                `${leaving} ${machine.name}: running its ${leaving} hook, if its guest has one and has taken its identity, for at most ${hook.timeoutSeconds}s`
              );

              const { exitCode, output } = yield* leave(
                runtime,
                machine,
                leaving,
                hook.timeoutSeconds
              );

              if (exitCode !== 0) {
                const past =
                  exitCode === timedOutExitCode
                    ? `, past its ${hook.timeoutSeconds}s limit or by a timeout of its own`
                    : "";

                yield* Effect.logWarning(
                  `${leaving} ${machine.name} goes on: its ${leaving} hook exited ${exitCode}${past}; its last output:\n${lastLines(output)}`
                );
              }
            })
          ).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `${leaving} ${machine.name} goes on: ${error.message}`
              )
            )
          );

    const scrubbed = (machine: Target) =>
      Effect.flatMap(scrubNode(runtime, machine), (notes) =>
        Effect.forEach(
          notes,
          (note) => Effect.logWarning(`tailnet scrub ${machine.name}: ${note}`),
          { discard: true }
        )
      );

    const onTailnet = (
      machine: Target,
      join: Make["join"],
      setup: Effect.Effect<void, HostError>
    ): Effect.Effect<void, HostError> => {
      if (join === undefined) {
        return setup;
      }

      return Option.match(tailnet, {
        onNone: () =>
          Effect.andThen(
            Effect.logWarning(
              `make ${machine.name}: its step asks for a tailnet join, and host ${config.id} has no tailnet setting, so its setup runs off the tailnet`
            ),
            setup
          ),
        onSome: ({ mintBuild }) =>
          Effect.gen(function* () {
            yield* rememberDns(runtime, machine);

            const status = yield* joined(mintBuild, machine, join.hostname);

            if (status.state !== "joined") {
              return yield* new Internal({
                message: `builder ${machine.name} didn't join the tailnet for its setup: ${status.state === "failed" ? status.error : "its guest has no tailscaled"}`,
              });
            }

            yield* setup;
          }).pipe(
            Effect.onError(() =>
              scrubbed(machine).pipe(
                Effect.catch((error) =>
                  Effect.logWarning(
                    `tailnet scrub ${machine.name} failed: ${error.message}`
                  )
                )
              )
            ),
            Effect.andThen(scrubbed(machine))
          ),
      });
    };

    const made = (
      progress: Progress,
      step: Make,
      port: number
    ): Effect.Effect<void, HostError> =>
      Effect.gen(function* () {
        const { machine, source, machines, authorizedKeys, join } = step;

        yield* source._tag === "base"
          ? runtime.sizable(machine, machine, machine, false)
          : runtime.sizable(
              machine,
              sourceSizes(source),
              machine,
              traits.checkpoint === "ram"
            );

        const origin = yield* originOf(source);

        const { handle, sizes } = yield* Effect.scoped(
          Effect.andThen(
            admitted(booted[source._tag], machine, machines),
            runtime.make(machine, origin, port)
          )
        );

        const ref = targetOf(machine, handle);

        progress.outcome = { ...progress.outcome, handle, sizes };

        yield* reaches.open(ref, port);

        if (
          source._tag === "base" &&
          (source.setup !== undefined || runtime.prepares === "always")
        ) {
          yield* prepareBase(runtime, ref, Option.isSome(tailnet));
        }

        if (source._tag === "base" && source.setup !== undefined) {
          yield* onTailnet(
            ref,
            join,
            runSetup(runtime, ref, source.setup, authorizedKeys)
          );
        } else if (authorizedKeys !== undefined) {
          yield* addMissingKeys(runtime, ref, authorizedKeys);
        }

        if (source._tag !== "base") {
          yield* readied(progress, ref);
          progress.outcome = { ...progress.outcome, prepared: true };
        }
      });

    const withBuilds = <A>(
      what: string,
      work: (
        store: BuildStore["Service"],
        local: CheckpointFiles
      ) => Effect.Effect<A, HostError, FileSystem.FileSystem | Path.Path>
    ) =>
      Option.match(copying, {
        onNone: () =>
          Effect.fail(
            new Internal({
              message: `host ${config.id} copies no build through a bucket, so it can't ${what}`,
            })
          ),
        onSome: ({ store, local }) =>
          Effect.provideContext(work(store, local), files),
      });

    const perform = (
      progress: Progress,
      step: Exclude<Step, Make>
    ): Effect.Effect<void, HostError> => {
      const cleared = Effect.sync(() => {
        progress.outcome = { ...progress.outcome, cleared: true };
      });

      switch (step._tag) {
        case "start": {
          const { pin, machines } = step;
          const keep = new Set(step.keep);

          return Effect.gen(function* () {
            const machine = yield* machineTarget(step.machine);
            const seen = yield* stateNow(machine, "started");

            if (seen === "missing") {
              return yield* missing(traits.runtime, machine);
            }

            if (seen === "paused") {
              yield* pinned({ resume: machine.name }, pin);
            }

            const { port } = step.machine;

            const started = Effect.andThen(
              port === undefined ? Effect.void : reaches.open(machine, port),
              runtime.start(machine, keep)
            );

            yield* seen === "running"
              ? started
              : withRoom(
                  "startMachine",
                  { ...step.machine, handle: machine.handle },
                  machines,
                  started
                );

            yield* readied(progress, machine);
          });
        }

        case "stop": {
          const { pin, machines, hook } = step;

          return Effect.gen(function* () {
            const machine = yield* machineTarget(step.machine);
            const stopped = runtime.stop(machine);

            if (traits.stop === "discards") {
              yield* beforeLeaving(
                machine,
                "stop",
                hook,
                stateNow(machine, "given its stop hook")
              );

              return yield* stopped;
            }

            const seen = yield* stateNow(machine, "stopped");

            if (seen === "paused") {
              yield* pinned({ resume: machine.name }, pin);

              return yield* withRoom(
                "stopMachine",
                { ...step.machine, handle: machine.handle },
                machines,
                stopped
              );
            }

            yield* beforeLeaving(machine, "stop", hook, Effect.succeed(seen));
            yield* stopped;
          });
        }

        case "pause": {
          const { pin, hook } = step;

          return Effect.gen(function* () {
            const machine = yield* machineTarget(step.machine);

            yield* beforeLeaving(
              machine,
              "pause",
              hook,
              stateNow(machine, "given its pause hook")
            );
            yield* pauseOrStop(machine, pin);
          });
        }

        case "remove": {
          const { hook } = step;
          const keep = new Set(step.keep);

          return Effect.andThen(
            Effect.flatMap(found(step.machine), (handle) => {
              if (handle === undefined) {
                return Effect.void;
              }

              const machine = targetOf(step.machine, handle);

              return Effect.andThen(
                beforeLeaving(
                  machine,
                  "delete",
                  hook,
                  stateNow(machine, "given its delete hook")
                ),
                runtime.delete(machine, keep)
              );
            }),
            reaches.close(step.machine)
          );
        }

        case "resize": {
          return Effect.scoped(
            resized(progress, step.machine, step.to, step.machines)
          );
        }

        case "capture": {
          const { checkpoint, pin } = step;

          const discarded = Effect.andThen(
            checkpointDeleted(checkpoint),
            cleared
          ).pipe(Effect.ignore);

          return Effect.gen(function* () {
            const machine = yield* Effect.tapError(
              Effect.andThen(
                pinned({ copy: step.machine.name }, pin),
                machineTarget(step.machine)
              ),
              () => cleared
            );

            const handle = yield* runtime
              .capture(machine, checkpoint)
              .pipe(
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit) ? Effect.void : discarded
                )
              );

            progress.outcome = { ...progress.outcome, handle };
          });
        }

        case "deleteCheckpoint": {
          const { checkpoint } = step;

          const unpublished =
            step.unpublish === true
              ? Option.match(builds, {
                  onNone: () =>
                    Effect.logWarning(
                      `delete ${checkpoint.name}: host ${config.id} has no builds setting, so what it published stays in the build store`
                    ),
                  onSome: (store) => unpublish(store, checkpoint.name),
                })
              : Effect.void;

          return Effect.andThen(unpublished, checkpointDeleted(checkpoint));
        }

        case "join": {
          return Option.match(tailnet, {
            onNone: () => Effect.void,
            onSome: (joining) =>
              Effect.gen(function* () {
                const machine = yield* machineTarget(step.machine);

                progress.outcome = {
                  ...progress.outcome,
                  tailnet: yield* joined(joining.mint, machine, step.hostname),
                };
              }),
          });
        }

        case "publish": {
          return withBuilds(`publish ${step.checkpoint.name}`, (store, local) =>
            Effect.flatMap(checkpointTarget(step.checkpoint), (checkpoint) =>
              publish(store, local, checkpoint)
            )
          );
        }

        case "fetch": {
          const { checkpoint, from, build } = step;

          return Effect.tapError(
            withBuilds(`fetch build ${build}`, (store, local) =>
              Effect.map(
                fetch(store, local, checkpoint, from, build),
                (handle) => {
                  progress.outcome = { ...progress.outcome, handle };
                }
              )
            ),
            () => cleared
          );
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
        outcome.endpoint !== undefined
          ? [outcome.endpoint.port]
          : []
      );

    const claimed = (progress: Progress, step: Make) =>
      Effect.match(
        reaches.claim(step.machine, new Set([...step.taken, ...heldPorts()])),
        {
          onFailure: (error) => ({
            work: Effect.fail<HostError>(error),
            release: Effect.void,
          }),
          onSuccess: ({ port, release }) => {
            progress.outcome = { endpoint: reaches.endpoint(port) };

            return { work: made(progress, step, port), release };
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
        const name = `${step._tag} ${keyOf(scope)}`;

        const progress: Progress = {
          status: "running",
          outcome: {},
          error: undefined,
        };

        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const { work, release } =
              step._tag === "make"
                ? yield* claimed(progress, step)
                : { work: perform(progress, step), release: Effect.void };

            const fiber = yield* Effect.forkIn(
              apartFromItsRequest(
                operation,
                Effect.onExit(
                  before === undefined
                    ? work
                    : Effect.andThen(
                        Effect.uninterruptible(forgetting(before)),
                        work
                      ),
                  (exit) =>
                    Effect.andThen(
                      Exit.isSuccess(exit) ? Effect.void : release,
                      ended(progress, id, name, exit)
                    )
                )
              ),
              hostScope
            );

            entries.set(id, {
              scope,
              names: namedBy(step),
              fiber,
              progress,
            });
            scopes.set(keyOf(scope), {
              sequence,
              id,
              leavesInstance: instanceLeftBy(step),
            });

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

          const at = scopes.get(keyOf(operation.scope));

          if (at !== undefined && operation.sequence <= at.sequence) {
            return yield* new Conflict({
              message: `operation ${operation.id} is number ${operation.sequence} on ${keyOf(operation.scope)}, and this host has seen ${at.sequence}`,
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

    const stepEnded = ({ name }: MachineRef) =>
      Effect.suspend(() => {
        const held = scopes.get(keyOf({ resource: "machine", name }));
        const entry = held === undefined ? undefined : entries.get(held.id);

        return entry === undefined || entry.progress.status !== "running"
          ? Effect.void
          : Effect.asVoid(Fiber.await(entry.fiber));
      });

    const exec: Interface["exec"] = (command) =>
      surviving(
        `exec in ${command.machine.name}`,
        Effect.gen(function* () {
          yield* stepEnded(command.machine);

          const machine = yield* machineTarget(command.machine);
          const seen = yield* stateNow(machine, "given the command");

          if (seen === "missing") {
            return yield* missing(traits.runtime, machine);
          }

          if (seen !== "running") {
            return yield* new WrongState({
              message: `machine ${machine.name} is ${seen}, and a command runs only in a running machine: start it first`,
              machine: machine.name,
              state: seen,
            });
          }

          return yield* runCommand(runtime, { ...command, machine });
        })
      );

    const observed = (targets: readonly Target[]) =>
      targets.length === 0
        ? Effect.succeed<Observed>(new Map())
        : runtime
            .observe(targets)
            .pipe(inTime(`the ${traits.runtime} runtime`));

    const readAlone = (machine: Ref) =>
      Effect.flatMap(found(machine), (handle) =>
        handle === undefined
          ? Effect.succeed<MachineState>("missing")
          : Effect.map(observed([targetOf(machine, handle)]), (seen) =>
              stateIn(seen, machine)
            )
      ).pipe(
        inTime(`the ${traits.runtime} runtime's read of ${machine.name}`),
        Effect.catch((error) =>
          Effect.as(
            Effect.logWarning(`read ${machine.name}: ${error.message}`),
            "unknown" as const
          )
        ),
        Effect.map((state) => [machine.name, state] as const)
      );

    const reading: Interface["read"] = (machines) =>
      surviving(
        `the ${traits.runtime} runtime's read`,
        Effect.gen(function* () {
          const [seen, alone] = yield* Effect.all(
            [
              observed(
                machines.flatMap((machine) =>
                  machine.handle === undefined
                    ? []
                    : [targetOf(machine, machine.handle)]
                )
              ),
              Effect.forEach(
                machines.filter(({ handle }) => handle === undefined),
                readAlone,
                { concurrency: "unbounded" }
              ),
            ],
            { concurrency: "unbounded" }
          );

          const resolved = new Map(alone);

          return new Map(
            machines.map(({ name }) => [
              name,
              resolved.get(name) ?? stateIn(seen, { name }),
            ])
          );
        })
      );

    const reachable = ({ name, instance }: MachineRef) => {
      const last = scopes.get(keyOf({ resource: "machine", name }));

      return last === undefined || last.leavesInstance === instance;
    };

    const adopt: Interface["adopt"] = (machines) =>
      Effect.gen(function* () {
        const [adopted, unresolved] = yield* Effect.partition(
          machines,
          (machine) =>
            found(machine).pipe(
              Effect.tap((handle) =>
                Effect.logInfo(
                  `adopt ${machine.name}: ${heldAs(machine, handle)}`
                )
              ),
              Effect.map((handle) => ({ machine, handle })),
              Effect.mapError((error) => ({ machine, error }))
            ),
          { concurrency: "unbounded" }
        );

        yield* Effect.forEach(
          unresolved,
          ({ machine, error }) =>
            Effect.logWarning(
              `adopt ${machine.name}: couldn't find it, so the next adopt tries again: ${error.message}`
            ),
          { discard: true }
        );

        const reached = yield* accepting.withPermits(1)(
          Effect.suspend(() =>
            reaches.adopt(
              adopted.flatMap(({ machine, handle }) =>
                handle === undefined ||
                machine.port === undefined ||
                !reachable(machine)
                  ? []
                  : [{ machine: targetOf(machine, handle), port: machine.port }]
              )
            )
          )
        );

        return {
          adopted: adopted.map(({ machine, handle }) => ({
            name: machine.name,
            instance: machine.instance,
            ...(handle === undefined ? {} : { handle }),
            ...(machine.port === undefined
              ? {}
              : {
                  endpoint: reaches.endpoint(
                    reached.get(machine.name) ?? machine.port
                  ),
                }),
          })),
          unresolved: unresolved.map(({ machine }) => machine.name),
        };
      });

    const namedBySteps = () => {
      const named = new Set<string>();

      for (const { names, progress } of entries.values()) {
        for (const { instance, handle } of names) {
          named.add(instance);

          if (handle !== undefined) {
            named.add(handle);
          }
        }

        if (progress.outcome.handle !== undefined) {
          named.add(progress.outcome.handle);
        }
      }

      return ({ instance, handle }: MarkedMachine) =>
        named.has(instance) || named.has(handle);
    };

    const sweeping = yield* Semaphore.make(1);
    const undeleted = new Set<string>();

    const swept = (machine: MarkedMachine): Effect.Effect<boolean> =>
      Effect.suspend(() => {
        const { instance } = machine;
        const what = `machine ${instance} (${machine.handle})`;
        const again = undeleted.has(instance);

        return Effect.andThen(
          again
            ? Effect.logDebug(`sweep: deleting ${what} again`)
            : Effect.logInfo(
                `sweep: deleting ${what}, which the control plane retired`
              ),
          runtime
            .delete(
              targetOf({ name: instance, instance }, machine.handle),
              new Set(machine.checkpoints)
            )
            .pipe(
              Effect.tap(() =>
                Effect.andThen(
                  Effect.sync(() => undeleted.delete(instance)),
                  again
                    ? Effect.logInfo(
                        `sweep: deleted ${what}, which an earlier sweep couldn't`
                      )
                    : Effect.void
                )
              ),
              Effect.as(true),
              Effect.catch((error) =>
                Effect.as(
                  Effect.andThen(
                    Effect.sync(() => undeleted.add(instance)),
                    again
                      ? Effect.logDebug(
                          `sweep: still couldn't delete ${what} on host ${config.id}: ${error.message}`
                        )
                      : Effect.logWarning(
                          `sweep: couldn't delete ${what}, which stays at its provider until a sweep deletes it, so each sweep of host ${config.id} tries again: ${error.message}`
                        )
                  ),
                  false
                )
              )
            )
        );
      });

    const sweep: Interface["sweep"] = (retired) => {
      const { owned } = runtime;

      if (owned === undefined || retired.machines.length === 0) {
        return Effect.succeed({ machines: [] });
      }

      return sweeping.withPermits(1)(
        Effect.gen(function* () {
          const wanted = new Set(retired.machines);

          for (const instance of undeleted) {
            if (!wanted.has(instance)) {
              undeleted.delete(instance);
            }
          }

          const machines = yield* owned.machines.pipe(
            inTime(`the ${traits.runtime} runtime's list of what it marked`)
          );

          const named = namedBySteps();

          const left = yield* Effect.forEach(
            machines.filter(({ instance }) => wanted.has(instance)),
            (machine) =>
              named(machine)
                ? Effect.succeed([machine.instance])
                : Effect.map(swept(machine), (deleted) =>
                    deleted ? [] : [machine.instance]
                  )
          );

          return { machines: left.flat() };
        })
      );
    };

    return {
      boot,
      run,
      wait,
      cancel,
      collect,
      read: reading,
      sizes: (machine) =>
        Effect.flatMap(machineTarget(machine), (target) =>
          runtime.sizes(target).pipe(
            inTime(
              `the ${traits.runtime} runtime's read of ${machine.name}'s sizes`
            ),
            Effect.map((read) => sizedBy(machine, read))
          )
        ),
      capacity: (machines) =>
        Effect.flatMap(heldBy(machines), runtime.capacity).pipe(
          inTime(`the ${traits.runtime} runtime`)
        ),
      adopt,
      sweep,
      exec: Effect.fn("Operations.exec")(exec),
    } satisfies Interface;
  });

export const layer = (
  config: Settings
): Layer.Layer<
  Operations,
  never,
  Runtime | Reaches | FileSystem.FileSystem | Path.Path
> => Layer.effect(Operations, make(config));
