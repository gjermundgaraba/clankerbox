/**
 * Tart passed its live tests against this interface and boat was written to it: a change
 * touches every runtime, so it needs a reason that holds for all three.
 */
import {
  type ActionName,
  type Capacity,
  type Checkpoint,
  type Host,
  Internal,
  type Machine,
  Precondition,
  type Reading,
  readTimeout,
  type Runtime as RuntimeName,
  type SshEndpoint,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, Data, Duration, Effect, type Scope, Semaphore, type Stream } from "effect";

/**
 * What a runtime fails with: what it can't do, or what broke. `NotFound`, `Conflict` and
 * `Invalid` are the core's, about its rows and the request; only the calls that take room add
 * `Capacity`.
 */
export type RuntimeError = Precondition | Internal;

export type RoomError = RuntimeError | Capacity;

export interface MachineRef {
  readonly id: string;
  readonly name: string;
  /** Native names carry its first 8 characters. */
  readonly instance: string;
  readonly native: string | undefined;
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
  /** Picked when the row is inserted, and never changes. */
  readonly port: number | undefined;
}

export type MachineState = Machine["state"];

export type CheckpointKind = Checkpoint["kind"];

export interface CheckpointRef {
  readonly id: string;
  readonly name: string;
  /** Native names carry its first 8 characters. */
  readonly instance: string;
  readonly kind: CheckpointKind;
  /** A `ram` restore comes up on the source's port at capture. */
  readonly port: number | undefined;
}

/**
 * Bounds each `observe` and `admit`, so a list answers within the client's `readTimeout`
 * however slow the runtime is: a second under it, for the request's way to the host and back.
 */
export const stateReadWait = Duration.subtract(readTimeout, Duration.seconds(1));

/**
 * A second under `stateReadWait`, so one hung read makes only its own machine `unknown`, and
 * 2 s over the 6 s smolvm's status of an unreachable machine can take (the bump-smolvm skill).
 */
export const machineReadWait = Duration.subtract(stateReadWait, Duration.seconds(1));

export const timeoutFail =
  <E2>(duration: Duration.Input, error: () => E2) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | E2, R> =>
    Effect.timeoutOrElse(self, { duration, orElse: () => Effect.fail(error()) });

export interface Observed {
  readonly state: MachineState;
  /** For a runtime without a `publishAddress`; the core reports it only for a running machine. */
  readonly ssh?: SshEndpoint | undefined;
}

/**
 * For a runtime that reads each machine on its own: one that fails, or takes over
 * `machineReadWait` including its wait for one of `concurrency` turns, reads `unknown`, and
 * `warn` logs why.
 */
export const observeEach = (
  machines: ReadonlyArray<MachineRef>,
  read: (machine: MachineRef) => Effect.Effect<Observed, RuntimeError>,
  options: {
    readonly concurrency?: number | undefined;
    readonly warn: (message: string) => Effect.Effect<void>;
  },
): Effect.Effect<ReadonlyArray<Observed>> =>
  Effect.flatMap(Semaphore.make(options.concurrency ?? Math.max(machines.length, 1)), (turns) =>
    Effect.forEach(
      machines,
      (machine) =>
        turns
          .withPermits(1)(read(machine))
          .pipe(
            timeoutFail(
              machineReadWait,
              () =>
                new Internal({ message: `no answer within ${Duration.format(machineReadWait)}` }),
            ),
            Effect.catch((error) =>
              Effect.as(options.warn(`couldn't read ${machine.id}'s state: ${error.message}`), {
                state: "unknown",
              } satisfies Observed),
            ),
          ),
      { concurrency: "unbounded" },
    ),
  );

export interface Held {
  readonly machine: MachineRef;
  /**
   * A running create, start or restore, or a fork that hasn't made it yet: its VM may not run
   * yet, so step 3 counts it as running. A fork's source is held but not booted by it.
   */
  readonly booting: boolean;
}

export interface Activation {
  readonly action: ActionName;
  /** Already claimed by the action. */
  readonly machine: MachineRef;
  /** The target included. */
  readonly machines: ReadonlyArray<Held>;
}

export interface Command {
  readonly argv: ReadonlyArray<string>;
  /**
   * Written whole, then closed, while the output is read: a script that reads stdin to its end
   * would otherwise wait forever, and a large input would fill the pipe.
   */
  readonly stdin?: Uint8Array | undefined;
}

/** Closing its scope ends the command. */
export interface Execution {
  /** stdout and stderr together, as they arrive. */
  readonly output: Stream.Stream<Uint8Array, RuntimeError>;
  readonly exitCode: Effect.Effect<number, RuntimeError>;
}

/**
 * A runtime error that the runtime knows created nothing native. The core releases the claim,
 * removes a new row, and replies with `error`.
 */
export class Refusal extends Data.TaggedError("Refusal")<{ readonly error: RoomError }> {}

export const missing = (runtime: RuntimeName, machine: Pick<MachineRef, "id">): Refusal =>
  new Refusal({
    error: new Precondition({
      message: `machine ${machine.id} is missing from the ${runtime} runtime; delete it`,
    }),
  });

export interface Interface {
  readonly name: RuntimeName;
  /** Read when the runtime starts; for boat, its API version. */
  readonly version: string;
  /** One host port per machine is published here; without it, machines get no port. */
  readonly publishAddress: string | undefined;
  /**
   * What a `ram` checkpoint must be restored under: RAM state restores only into the build that
   * saved it. `undefined` on a runtime with no `ram` checkpoints.
   */
  readonly pin: string | undefined;
  readonly checkpointKind: CheckpointKind;
  /** The state `capture` needs its machine in. */
  readonly captureFrom: Host["captureFrom"];
  /**
   * The user a setup authorizes the operator's key for: root on Linux, as setup runs as root;
   * Tart's bases ship `admin`, and macOS has no root login.
   */
  readonly loginUser: string;
  /** Runs after every interrupted action is marked failed and before the host serves. */
  readonly startup: (machines: ReadonlyArray<MachineRef>) => Effect.Effect<void, RuntimeError>;
  /**
   * One state per machine, in their order: callers rely on it without checking. A machine the
   * runtime doesn't know is `missing`, and one whose read fails or takes over `machineReadWait`
   * is `unknown`. Only a read of every machine at once may fail.
   */
  readonly observe: (
    machines: ReadonlyArray<MachineRef>,
  ) => Effect.Effect<ReadonlyArray<Observed>, RuntimeError>;
  /**
   * Step 3's capacity checks. A failure writes nothing. Called for every `start`, whatever the
   * machine's state: a running target counts once, as it already runs.
   */
  readonly admit: (activation: Activation) => Effect.Effect<void, RoomError>;
  /**
   * The limits `admit` and the runtime's `Capacity` refusals come from, and their use, counted
   * as they count it; then the `cpu` and `ramMib` its running machines were given, whether or
   * not they are limits. Reads state as `observe` does and writes nothing.
   */
  readonly capacity: (
    machines: ReadonlyArray<Held>,
  ) => Effect.Effect<ReadonlyArray<Reading>, RuntimeError>;
  /** Returns once exec works. */
  readonly create: (machine: MachineRef, image: string) => Effect.Effect<void, RoomError | Refusal>;
  /**
   * Leaves a running machine as it is; returns once exec works. The core reads no state first,
   * so the runtime refuses a machine it no longer has (`missing`) before anything native.
   */
  readonly start: (machine: MachineRef) => Effect.Effect<void, RoomError | Refusal>;
  /**
   * The core reads no state first, so the runtime does nothing on a machine that doesn't run or
   * that it no longer has.
   */
  readonly stop: (machine: MachineRef) => Effect.Effect<void, RuntimeError>;
  /**
   * Removes everything native the row could have made, whatever an earlier failure left: a
   * running VM, a VM whose stop failed, or nothing, as after a crash before the first call.
   */
  readonly delete: (machine: MachineRef) => Effect.Effect<void, RuntimeError>;
  /**
   * Of the runtime's `checkpointKind`. A machine in a state the runtime doesn't capture is a
   * `Refusal` with `Precondition`, read before anything native.
   */
  readonly capture: (
    machine: MachineRef,
    checkpoint: CheckpointRef,
  ) => Effect.Effect<void, RoomError | Refusal>;
  /** Returns once exec works. A checkpoint deleted under it fails it like any runtime failure. */
  readonly restore: (
    checkpoint: CheckpointRef,
    machine: MachineRef,
  ) => Effect.Effect<void, RoomError | Refusal>;
  /**
   * Returns once exec works. A source in a state the runtime doesn't copy is a `Refusal` with
   * `Precondition`.
   */
  readonly fork: (
    source: MachineRef,
    machine: MachineRef,
  ) => Effect.Effect<void, RoomError | Refusal>;
  /** Removes everything native the checkpoint's row could have made. */
  readonly deleteCheckpoint: (checkpoint: CheckpointRef) => Effect.Effect<void, RuntimeError>;
  /** As root, in a running guest. */
  readonly exec: (
    machine: MachineRef,
    command: Command,
  ) => Effect.Effect<Execution, RuntimeError, Scope.Scope>;
}

export class Runtime extends Context.Service<Runtime, Interface>()("@clankerbox/host/Runtime") {}
