/**
 * The one runtime a host process runs, behind the interface the host core needs. State,
 * claims, setup and preparation are the core's; each runtime is a module that implements this
 * service. The core allocates a machine's host port when it claims the row, for a runtime that
 * has a `publishAddress`; the RAM budget is a helper a runtime's `admit` calls when it needs one.
 * The interface froze when phase 5's live tests passed on the Mac; the plan records the changes
 * made before then, with their reasons.
 */
import {
  type ActionName,
  type Checkpoint,
  type HostError,
  Internal,
  type Machine,
  type Runtime as RuntimeName,
  type SshEndpoint,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, Data, Effect, type Scope, type Stream } from "effect";

/** A machine as the runtime sees it: what its native names and native calls need. */
export interface MachineRef {
  /** `<host>_<name>`. */
  readonly id: string;
  readonly name: string;
  /** The row's random hex value. Native names carry its first 8 characters. */
  readonly instance: string;
  /** The runtime's own column on the row, such as boat's sandbox ID. smolvm leaves it empty. */
  readonly native: string | undefined;
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
  /**
   * The host port that publishes guest port 22, when the runtime has a `publishAddress`. The
   * core picks it when the row is inserted, and it never changes.
   */
  readonly port: number | undefined;
}

export type MachineState = Machine["state"];

export type CheckpointKind = Checkpoint["kind"];

/** A checkpoint as the runtime sees it. */
export interface CheckpointRef {
  /** `<host>_<name>`. */
  readonly id: string;
  readonly name: string;
  /** The row's random hex value. Native names carry its first 8 characters. */
  readonly instance: string;
  readonly native: string | undefined;
  readonly kind: CheckpointKind;
  /** The source's host port at capture. A `ram` restore comes up on it. */
  readonly port: number | undefined;
}

/** What the runtime reports about a machine. Nothing here is stored. */
export interface Observed {
  readonly state: MachineState;
  /** Where guest port 22 is reached. */
  readonly ssh?: SshEndpoint | undefined;
}

/** One machine on the host, and whether an action is booting it. */
export interface Held {
  readonly machine: MachineRef;
  /**
   * Whether an admitted create, start, fork or restore that hasn't ended boots it, the target
   * included: its VM may not run yet, so step 3 counts it as running. A fork's source is held
   * by the fork but isn't booted by it.
   */
  readonly booting: boolean;
}

/** What step 3 checks before an action boots a machine. */
export interface Activation {
  readonly action: ActionName;
  /** The machine to boot, already claimed by the action. */
  readonly machine: MachineRef;
  /** Every machine on the host, the target included, and whether an action is booting each. */
  readonly machines: ReadonlyArray<Held>;
}

/** A command run as root in the guest. */
export interface Command {
  readonly argv: ReadonlyArray<string>;
  /**
   * Written whole, then closed, while the output is read: a script that reads stdin to its
   * end would otherwise wait forever, and a large input would fill the pipe.
   */
  readonly stdin?: Uint8Array | undefined;
}

/** A command running in the guest. Closing its scope ends it. */
export interface Execution {
  /** stdout and stderr together, as they arrive. */
  readonly output: Stream.Stream<Uint8Array, HostError>;
  readonly exitCode: Effect.Effect<number, HostError>;
}

/**
 * A runtime error that the runtime knows created nothing native (the refusal rule). The core
 * handles it like a failure before the runtime call: it releases the claim, removes a new
 * row, and replies with `error`. Each runtime lists the errors it classifies this way.
 */
export class Refusal extends Data.TaggedError("Refusal")<{ readonly error: HostError }> {}

export interface Interface {
  readonly name: RuntimeName;
  /** The runtime's version, read when the runtime starts; for boat, its API version. */
  readonly version: string;
  /**
   * Where guest port 22 is published, for a runtime that needs one host port per machine. The
   * core probes and allocates ports on this address; without one, machines get no port.
   */
  readonly publishAddress: string | undefined;
  /**
   * What a `ram` checkpoint records at capture, and must be restored under: RAM state restores
   * only into the build that saved it. `undefined` on a runtime with no `ram` checkpoints.
   */
  readonly pin: string | undefined;
  /** The kind of every checkpoint the runtime captures: `ram` on smolvm, `disk` on Tart and boat. */
  readonly checkpointKind: CheckpointKind;
  /**
   * The runtime's own work at host startup, over every machine the host has, run after every
   * interrupted action has been marked failed and before the host serves: smolvm's cleanup, or
   * the Tart forwarder's listeners for every machine.
   */
  readonly startup: (machines: ReadonlyArray<MachineRef>) => Effect.Effect<void, HostError>;
  /**
   * Reads the machines' states, one per machine, in their order, in as few native calls as the
   * runtime allows: one `tart list` on Tart, and one `GET /sandboxes` on boat; smolvm reads
   * each machine on its own, at its own bound. A machine the runtime doesn't know is
   * `missing`, not an error.
   */
  readonly observe: (
    machines: ReadonlyArray<MachineRef>,
  ) => Effect.Effect<ReadonlyArray<Observed>, HostError>;
  /**
   * Step 3 of an action that boots a machine: the runtime's capacity checks, such as the smolvm
   * host's RAM budget or Tart's two-VM count. A failure here writes nothing. Not called for
   * `start` on a running machine.
   */
  readonly admit: (activation: Activation) => Effect.Effect<void, HostError>;
  /** Makes the machine from `image` and boots it; it returns once exec works. */
  readonly create: (machine: MachineRef, image: string) => Effect.Effect<void, HostError | Refusal>;
  /** Boots a stopped machine; it returns once exec works. */
  readonly start: (machine: MachineRef) => Effect.Effect<void, HostError | Refusal>;
  /** Stops a running machine. */
  readonly stop: (machine: MachineRef) => Effect.Effect<void, HostError>;
  /**
   * Removes everything native the machine's row could have made, coping with whatever an
   * earlier failure left: a running VM, a VM whose stop failed, or nothing at all, as after a
   * crash between inserting the row and the first runtime call.
   */
  readonly delete: (machine: MachineRef) => Effect.Effect<void, HostError>;
  /**
   * Captures the machine into the checkpoint, of the runtime's `checkpointKind`. A machine in a
   * state the runtime doesn't capture is a `Refusal` with `Precondition`, read before anything
   * native: smolvm captures only a running machine, and Tart only a stopped one.
   */
  readonly capture: (
    machine: MachineRef,
    checkpoint: CheckpointRef,
  ) => Effect.Effect<void, HostError | Refusal>;
  /**
   * Makes the machine from a ready checkpoint and boots it; it returns once exec works. A
   * checkpoint deleted under it fails it like any runtime failure.
   */
  readonly restore: (
    checkpoint: CheckpointRef,
    machine: MachineRef,
  ) => Effect.Effect<void, HostError | Refusal>;
  /**
   * Makes `machine` a copy of `source` and boots it; it returns once exec works. A source in a
   * state the runtime doesn't copy is a `Refusal` with `Precondition`, as for `capture`.
   */
  readonly fork: (
    source: MachineRef,
    machine: MachineRef,
  ) => Effect.Effect<void, HostError | Refusal>;
  /** Removes everything native the checkpoint's row could have made. */
  readonly deleteCheckpoint: (checkpoint: CheckpointRef) => Effect.Effect<void, HostError>;
  /** Runs a command as root in a running guest. */
  readonly exec: (
    machine: MachineRef,
    command: Command,
  ) => Effect.Effect<Execution, HostError, Scope.Scope>;
}

export class Runtime extends Context.Service<Runtime, Interface>()("@clankerbox/host/Runtime") {}

/**
 * Reads the machines' states through a runtime's `observe`, held to its contract of one state per
 * machine, in their order. Any other answer is the runtime's bug, so it fails here rather than
 * reading a machine as `missing` or dropping it.
 */
export const observeAll = (
  observe: Interface["observe"],
  machines: ReadonlyArray<MachineRef>,
): Effect.Effect<ReadonlyArray<Observed>, HostError> =>
  Effect.flatMap(observe(machines), (states) =>
    states.length === machines.length
      ? Effect.succeed(states)
      : Effect.fail(
          new Internal({
            message: `observe read ${states.length} states for ${machines.length} machines: ${machines.map(({ id }) => id).join(", ")}`,
          }),
        ),
  );

/** One machine's state, through `observeAll`. */
export const observeOne = (
  observe: Interface["observe"],
  machine: MachineRef,
): Effect.Effect<Observed, HostError> =>
  Effect.flatMap(observeAll(observe, [machine]), ([state]) =>
    // `observeAll` checked there is one; this only narrows the type.
    state === undefined
      ? Effect.fail(new Internal({ message: `observe read no state for ${machine.id}` }))
      : Effect.succeed(state),
  );
