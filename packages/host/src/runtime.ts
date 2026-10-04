/**
 * The one runtime a host process runs, behind the interface the host core needs. State,
 * claims, setup and preparation are the core's; each runtime is a module that implements this
 * service. The core allocates a machine's host port when it claims the row, for a runtime that
 * has a `publishAddress`; the RAM budget is a helper a runtime's `admit` calls when it needs one.
 * The interface is frozen only after Tart (phase 5).
 */
import type {
  ActionName,
  HostError,
  Machine,
  Runtime as RuntimeName,
  SshEndpoint,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, Data, type Effect, type Scope, type Stream } from "effect";

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

/**
 * How many machines' states the host reads at once, in a list or a RAM budget check. On smolvm
 * each read is a `machine status` process, so a host with many machines doesn't start them all
 * together.
 */
export const observeConcurrency = 8;

/** What the runtime reports about a machine. Nothing here is stored. */
export interface Observed {
  readonly state: MachineState;
  /** Where guest port 22 is reached. */
  readonly ssh?: SshEndpoint | undefined;
}

/** One machine on the host, and the action that holds its row, if one does. */
export interface Held {
  readonly machine: MachineRef;
  readonly holder: ActionName | undefined;
}

/** What step 3 checks before an action boots a machine. */
export interface Activation {
  readonly action: ActionName;
  /** The machine to boot, already claimed by the action. */
  readonly machine: MachineRef;
  /** Every machine on the host, the target included, with what holds each. */
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
   * The runtime's own cleanup at host startup, run after every interrupted action has been
   * marked failed and before the host serves.
   */
  readonly startup: Effect.Effect<void, HostError>;
  /** Reads a machine's state. A machine the runtime doesn't know is `missing`, not an error. */
  readonly observe: (machine: MachineRef) => Effect.Effect<Observed, HostError>;
  /**
   * Step 3 of an action that boots a machine: the runtime's own checks, such as the smolvm
   * host's RAM budget. A failure here writes nothing. Not called for `start` on a running
   * machine.
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
  /** Runs a command as root in a running guest. */
  readonly exec: (
    machine: MachineRef,
    command: Command,
  ) => Effect.Effect<Execution, HostError, Scope.Scope>;
}

export class Runtime extends Context.Service<Runtime, Interface>()("@clankerbox/host/Runtime") {}
