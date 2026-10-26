import {
  type Capacity,
  Internal,
  type Kind,
  type Machine,
  Missing,
  type Reading,
  readTimeout,
  type Sizing,
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

export type Sizes = Pick<MachineRef, "cpu" | "ramMib" | "diskGib">;

export const changes = (from: Sizes, to: Sizes): Sizing => ({
  cpu: to.cpu === from.cpu ? undefined : to.cpu,
  ramMib: to.ramMib === from.ramMib ? undefined : to.ramMib,
  diskGib: to.diskGib === from.diskGib ? undefined : to.diskGib,
});

export interface CheckpointRef {
  readonly id: string;
  readonly name: string;
  /** Native names carry its first 8 characters. */
  readonly instance: string;
  /** A `ram` restore comes up on the source's port at capture. */
  readonly port: number;
  /** The source's vCPUs, at capture. */
  readonly cpu: number;
  /** The source's RAM, at capture. */
  readonly ramMib: number;
  /** The source's disk, at capture. */
  readonly diskGib: number;
}

export const stateReadWait = Duration.subtract(readTimeout, Duration.seconds(1));

export const timeoutFail =
  <E2>(duration: Duration.Input, error: () => E2) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | E2, R> =>
    Effect.timeoutOrElse(self, { duration, orElse: () => Effect.fail(error()) });

export interface Held {
  readonly machine: MachineRef;
  /**
   * Admitted to a create, start, fork, restore, a stop that resumes it, or a resize that grows its
   * RAM, still under way: its VM may not run yet, so admission counts it as running, at the sizes
   * it was admitted at. A fork's source is not booted by it.
   */
  readonly booting: boolean;
}

/**
 * The actions that may boot a machine, or grow a running one's RAM, as the runtime's refusals name
 * them. A stop boots only a paused machine, on a runtime whose `stopResumes` is true.
 */
export type Booting =
  | "createMachine"
  | "startMachine"
  | "stopMachine"
  | "resizeMachine"
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
  /** Root when it is left out. On linux, the command runs in the image's environment as this user. */
  readonly user?: string | undefined;
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
  /**
   * Whether a running machine grows live; where it doesn't, the core resizes only a stopped
   * machine. What of a live grow the runtime can't make, `sizable` refuses.
   */
  readonly growsLive: boolean;
  /**
   * Refuses, before anything native, sizes `to` the runtime can't give a machine at `from`:
   * `live` when a running VM is given them, as on a running machine's resize and, where
   * checkpoints are `ram`, a copy's. The core calls it before it admits a create, a copy or a
   * resize, so the calls after it fail only after they reach the runtime.
   */
  readonly sizable: (
    machine: Pick<MachineRef, "id">,
    from: Sizes,
    to: Sizes,
    live: boolean,
  ) => Effect.Effect<void, Unsizable>;
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
  /**
   * Returns once exec works, the machine up at `machine`'s sizes. A checkpoint deleted under it
   * fails it like any runtime failure. The core never gives the copy a smaller disk than the
   * checkpoint's, nor, from a `ram` checkpoint, smaller vCPUs or RAM.
   */
  readonly restore: (
    checkpoint: CheckpointRef,
    machine: MachineRef,
  ) => Effect.Effect<void, RoomError | Unsizable>;
  /**
   * Returns once exec works, the copy up at `machine`'s sizes. A source in a state the runtime
   * doesn't copy is `WrongState`. The core never gives the copy a smaller disk than the source's,
   * nor, where checkpoints are `ram`, smaller vCPUs or RAM.
   */
  readonly fork: (
    source: MachineRef,
    machine: MachineRef,
  ) => Effect.Effect<void, RoomError | StateError | Unsizable>;
  /**
   * Gives a made machine each size `to` names, also one `machine` holds already: a live grow that
   * failed part way may have recorded its size before the guest took it, and finishes when it is
   * asked for again. The core calls it on a stopped machine, or, where `growsLive`, on a running
   * one, as `running` says it read, after `sizable`, and never with a smaller disk, nor smaller
   * vCPUs or RAM for a running one. A size the runtime can't give is `Unsizable`; a failure may
   * leave part of `to` given, which `sizes` reads.
   */
  readonly resize: (
    machine: MachineRef,
    to: Sizing,
    running: boolean,
  ) => Effect.Effect<void, RuntimeError | Unsizable>;
  /**
   * The sizes the runtime holds for a machine it has, as a resize left them. One it can't read is
   * left out, for the core to keep what it knows.
   */
  readonly sizes: (machine: MachineRef) => Effect.Effect<Sizing, RuntimeError>;
  /** Removes everything native the checkpoint's row could have made. */
  readonly deleteCheckpoint: (checkpoint: CheckpointRef) => Effect.Effect<void, RuntimeError>;
  /** As the command's user, in a running guest. */
  readonly exec: (
    machine: MachineRef,
    command: Command,
  ) => Effect.Effect<Execution, RuntimeError, Scope.Scope>;
}

export class Runtime extends Context.Service<Runtime, Interface>()("@clankerbox/host/Runtime") {}
