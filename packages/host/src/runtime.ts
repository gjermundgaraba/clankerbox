import {
  type Capacity,
  Internal,
  type Kind,
  type Machine,
  Missing,
  type Reading,
  readTimeout,
  type Unsizable,
  type WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, Duration, Effect, type Scope, type Stream } from "effect";

/**
 * What any runtime call fails with: what broke. `NotFound`, `Conflict` and `Invalid` are the
 * core's, about its rows and the request; only the calls that take room add `Capacity`.
 */
export type RuntimeError = Internal;

export type RoomError = RuntimeError | Capacity;

/** A machine the runtime no longer has, or one in a state the call doesn't act from. */
export type StateError = Missing | WrongState;

export interface MachineRef {
  readonly id: string;
  readonly name: string;
  /** Native names carry its first 8 characters. */
  readonly instance: string;
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
  /** Picked when the row is inserted, and never changes. */
  readonly port: number;
}

export type MachineState = Machine["state"];

export interface CheckpointRef {
  readonly id: string;
  readonly name: string;
  /** Native names carry its first 8 characters. */
  readonly instance: string;
  /** A `ram` restore comes up on the source's port at capture. */
  readonly port: number;
}

export const stateReadWait = Duration.subtract(readTimeout, Duration.seconds(1));

export const timeoutFail =
  <E2>(duration: Duration.Input, error: () => E2) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | E2, R> =>
    Effect.timeoutOrElse(self, { duration, orElse: () => Effect.fail(error()) });

export interface Held {
  readonly machine: MachineRef;
  /**
   * Admitted to a create, start, fork, restore, or a stop that resumes it, still under way: its VM
   * may not run yet, so admission counts it as running. A fork's source is not booted by it.
   */
  readonly booting: boolean;
}

/**
 * The actions that may boot a machine, as the runtime's refusals name them. A stop boots only a
 * paused machine, on a runtime whose `stopResumes` is true.
 */
export type Booting =
  | "createMachine"
  | "startMachine"
  | "stopMachine"
  | "forkMachine"
  | "restoreMachine";

export interface Activation {
  readonly action: Booting;
  /** Owned by the step that boots it. */
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

export const missing = (kind: Kind, machine: Pick<MachineRef, "id">): Missing =>
  new Missing({
    message: `machine ${machine.id} is missing from the ${kind} runtime; delete it`,
    machine: machine.id,
  });

export interface Interface {
  /** Read when the runtime starts. */
  readonly version: string;
  /** One host port per machine is published here. */
  readonly publishAddress: string;
  /**
   * What a `ram` checkpoint must be restored under, and what the core records a machine's VM booted
   * under: RAM state restores only into the build that saved it, so the core pauses a machine only
   * when its VM booted under this pin, and stops it otherwise. `undefined` on mac, which has no
   * `ram` checkpoints and where a resume Tart can't make fails and keeps the saved state.
   */
  readonly pin: string | undefined;
  /**
   * Whether a stop of a paused machine resumes it to end its saved execution, so the core admits
   * it as a boot under the pin it booted under, rather than discarding that execution with no boot.
   */
  readonly stopResumes: boolean;
  /** Runs after the failed captures are cleared, before the host serves. */
  readonly startup: (machines: ReadonlyArray<MachineRef>) => Effect.Effect<void, RuntimeError>;
  /**
   * One state per machine, in their order: callers rely on it without checking. A machine the
   * runtime doesn't know is `missing`, and one whose read fails or doesn't answer in time is
   * `unknown`. Only a read of every machine at once may fail.
   */
  readonly observe: (
    machines: ReadonlyArray<MachineRef>,
  ) => Effect.Effect<ReadonlyArray<MachineState>, RuntimeError>;
  /**
   * The capacity checks before a machine boots. A failure writes nothing. A running target counts
   * once, as it already runs.
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
  /**
   * Returns once exec works. A create that fails is never called again: the core deletes it.
   */
  readonly create: (
    machine: MachineRef,
    image: string,
  ) => Effect.Effect<void, RoomError | Unsizable>;
  /**
   * Returns once exec works. The core calls it on every start, also of a machine `observe` reads
   * running, so it is where a runtime boots again one that runs but doesn't answer; one that
   * answers it leaves as it is. A paused machine, or one a pause left part way, resumes its saved
   * execution. A machine it no longer has is `missing`, before anything native.
   */
  readonly start: (machine: MachineRef) => Effect.Effect<void, RoomError | StateError>;
  /**
   * Does nothing on a machine that is stopped or that the runtime no longer has, as the core calls
   * it whatever it last read. A paused machine ends its saved execution and keeps its disk.
   */
  readonly stop: (machine: MachineRef) => Effect.Effect<void, RuntimeError>;
  /**
   * Saves a running machine's execution, RAM and disks, and stops its VM; a paused machine stays
   * as it is, and one it can't save, as a VM an older host booted, it stops. The core never pauses
   * a stopped one.
   */
  readonly pause: (machine: MachineRef) => Effect.Effect<void, RuntimeError | StateError>;
  /**
   * Removes everything native the row could have made, whatever an earlier failure left: a
   * running VM, a VM whose stop failed, or nothing, as after a crash before the first call.
   */
  readonly delete: (machine: MachineRef) => Effect.Effect<void, RuntimeError>;
  /**
   * Of the host's kind's checkpoint, in `checkpointKinds`. A machine in a state the runtime
   * doesn't capture is `WrongState`, read before anything native.
   */
  readonly capture: (
    machine: MachineRef,
    checkpoint: CheckpointRef,
  ) => Effect.Effect<void, RoomError | StateError>;
  /** Returns once exec works. A checkpoint deleted under it fails it like any runtime failure. */
  readonly restore: (
    checkpoint: CheckpointRef,
    machine: MachineRef,
  ) => Effect.Effect<void, RoomError | Unsizable>;
  /** Returns once exec works. A source in a state the runtime doesn't copy is `WrongState`. */
  readonly fork: (
    source: MachineRef,
    machine: MachineRef,
  ) => Effect.Effect<void, RoomError | StateError | Unsizable>;
  /** Removes everything native the checkpoint's row could have made. */
  readonly deleteCheckpoint: (checkpoint: CheckpointRef) => Effect.Effect<void, RuntimeError>;
  /** As root, in a running guest. */
  readonly exec: (
    machine: MachineRef,
    command: Command,
  ) => Effect.Effect<Execution, RuntimeError, Scope.Scope>;
}

export class Runtime extends Context.Service<Runtime, Interface>()("@clankerbox/host/Runtime") {}
