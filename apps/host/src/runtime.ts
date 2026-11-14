import type {
  Handle,
  MachineRef,
  MachineState,
  Ref,
  Scope as Resource,
} from "@clankerbox/host-contract";
import { Missing, readTimeout } from "@gjermundgaraba/clankerbox-sdk";
import type {
  Capacity,
  Conflict,
  Internal,
  Invalid,
  Reading,
  RuntimeName,
  RuntimeTraits,
  Sizing,
  Unsizable,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, Duration, Effect, Schema } from "effect";
import type { Scope, Stream } from "effect";

export { Handle } from "@clankerbox/host-contract";

export type { MachineRef, MachineState } from "@clankerbox/host-contract";

export class CannotStart extends Schema.TaggedError<
  CannotStart,
  { readonly brand: unique symbol }
>()("CannotStart", {
  message: Schema.String,
}) {}

/** Whether a runtime's reported `major.minor.patch` release is `floor` or later. */
export const atLeast =
  (floor: string) =>
  (reported: string): boolean =>
    /^\d+\.\d+\.\d+$/u.test(reported) &&
    reported.localeCompare(floor, "en", { numeric: true }) >= 0;

export type RuntimeError = Internal;

export type RoomError = RuntimeError | Capacity;

export type StateError = Missing | WrongState;

export type Observed = ReadonlyMap<string, MachineState>;

export const stateIn = (
  observed: Observed,
  machine: Pick<MachineRef, "name">
): MachineState => observed.get(machine.name) ?? "unknown";

export type Sizes = Pick<MachineRef, "cpu" | "ramMib" | "diskGib">;

export type Identity = Pick<Ref, "name" | "instance">;

export const sizedBy = (from: Sizes, sizing: Sizing | undefined): Sizes => ({
  cpu: sizing?.cpu ?? from.cpu,
  ramMib: sizing?.ramMib ?? from.ramMib,
  diskGib: sizing?.diskGib ?? from.diskGib,
});

export const changes = (from: Sizes, to: Sizes): Sizing => ({
  cpu: to.cpu === from.cpu ? undefined : to.cpu,
  ramMib: to.ramMib === from.ramMib ? undefined : to.ramMib,
  diskGib: to.diskGib === from.diskGib ? undefined : to.diskGib,
});

export const stateReadWait = Duration.subtract(
  readTimeout,
  Duration.seconds(1)
);

export const timeoutFail =
  <E2>(duration: Duration.Input, error: () => E2) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | E2, R> =>
    Effect.timeoutOrElse(self, {
      duration,
      orElse: () => Effect.fail(error()),
    });

export interface Target {
  readonly name: string;
  readonly instance: string;
  readonly handle: Handle;
}

export type Sized = Target & Sizes;

/** A machine as admission and capacity count it: found, unread because its search failed, or booting on this host. */
export type Held =
  | { readonly _tag: "found"; readonly machine: Sized }
  | { readonly _tag: "unread"; readonly machine: MachineRef }
  | { readonly _tag: "booting"; readonly machine: MachineRef };

export type Origin =
  | { readonly _tag: "image"; readonly image: string }
  | { readonly _tag: "checkpoint"; readonly checkpoint: Sized }
  | { readonly _tag: "machine"; readonly machine: Sized };

export type Bind =
  | { readonly _tag: "forward"; readonly port: number }
  | { readonly _tag: "none" };

export interface Made {
  readonly handle: Handle;
  readonly sizes: Sizes;
}

export type Booting =
  | "createMachine"
  | "startMachine"
  | "stopMachine"
  | "resizeMachine"
  | "forkMachine"
  | "restoreMachine";

export interface Activation {
  readonly action: Booting;
  readonly machine: MachineRef;
  readonly machines: readonly Held[];
}

/**
 * A command in a guest, as `guest.ts` alone makes one: `argv` is the same `/bin/sh` launcher on
 * every call, and what it runs, with its environment, rides at the head of `stdin`, which is text.
 * An adapter hands both on as they are, so no value a caller gave shows in a process's arguments.
 */
export interface Command {
  readonly argv: readonly string[];
  readonly user?: string | undefined;
  readonly stdin?: string | undefined;
}

export interface Execution {
  readonly output: Stream.Stream<Uint8Array, RuntimeError>;
  readonly exitCode: Effect.Effect<number, RuntimeError>;
}

export const missing = (
  runtime: RuntimeName,
  machine: Pick<MachineRef, "name">
): Missing =>
  new Missing({
    message: `machine ${machine.name} is missing from the ${runtime} runtime; delete it`,
    machine: machine.name,
  });

/**
 * A file of a checkpoint, as a build store copies it: `path` within the checkpoint, and `file` where
 * it lies on this host. A runtime that names a file by its content gives that name as `key`, which
 * `held` finds again on any host that holds it; any other file is copied in pieces.
 */
export interface CheckpointFile {
  readonly path: string;
  readonly file: string;
  readonly key?: string | undefined;
}

export type Dial = (
  input: Stream.Stream<Uint8Array>
) => Stream.Stream<Uint8Array, RuntimeError>;

export type Reach =
  | { readonly _tag: "published"; readonly address: string }
  | {
      readonly _tag: "relayed";
      readonly address: string;
      readonly dial: (machine: Target) => Dial;
    };

export interface Admission {
  readonly admit: (activation: Activation) => Effect.Effect<void, RoomError>;
  readonly stopBoots: boolean;
}

export interface CheckpointFiles {
  readonly checkpointFiles: (
    checkpoint: Target
  ) => Effect.Effect<readonly CheckpointFile[], RuntimeError>;
  /** Where a file of `key` lies on this host, in any of its checkpoints, if one does. */
  readonly held: (key: string) => Effect.Effect<string | undefined>;
  /** Where a copy of `checkpoint` is put together, on the filesystem it will lie on. */
  readonly staging: (checkpoint: Identity) => string;
  /** Makes `checkpoint` of the files put together in `staged`, which it takes. */
  readonly install: (
    checkpoint: Identity,
    staged: string
  ) => Effect.Effect<Handle, RuntimeError>;
}

/** A resource carrying this host's mark, and the instance the mark names. */
export interface Marked {
  readonly instance: string;
  readonly handle: Handle;
}

/** A marked machine, and the handle of each checkpoint the provider holds through it, unmarked. */
export interface MarkedMachine extends Marked {
  readonly checkpoints: readonly Handle[];
}

/**
 * What carries this host's mark at its provider. The mark is this host's ID and the resource's
 * instance, which the adapter sets on each machine and checkpoint it makes, so a provider account
 * that several hosts or other users share lists each resource under one host alone. `machines` and
 * `checkpoints` list only what carries this host's mark, and nothing without it, whoever made it. A
 * sweep deletes those whose instance the control plane retired. A checkpoint the provider holds
 * through its machine carries no mark of its own, and a row claims it by its handle alone: only a
 * start and a remove of its machine, inside a step that owns the machine, delete it, when `keep`
 * lacks its handle.
 */
export interface Owned {
  readonly machines: Effect.Effect<readonly MarkedMachine[], RuntimeError>;
  readonly checkpoints: Effect.Effect<readonly Marked[], RuntimeError>;
}

/**
 * A runtime, as every host drives it. Each adapter keeps two rules. A provider call that can't be
 * cut short runs masked and is polled to its end, so a step cut short ends only once its call has.
 * An answer that leaves the outcome unknown, such as a dropped connection, never ends a step: the
 * adapter reads the resource by its instance before it answers. `prepares` is `always` where the
 * runtime's images lack the login user, so every machine made from a base is prepared, and
 * `with-setup` where only a machine with a setup is.
 */
export interface Interface {
  readonly traits: RuntimeTraits;
  readonly guest: "debian" | "macos";
  readonly version: string;
  readonly pin: string | undefined;
  readonly reach: Reach;
  readonly prepares: "with-setup" | "always";
  readonly admission: Admission | undefined;
  readonly files: CheckpointFiles | undefined;
  readonly owned: Owned | undefined;
  readonly sizable: (
    machine: Pick<MachineRef, "name">,
    from: Sizes,
    to: Sizes,
    live: boolean
  ) => Effect.Effect<void, Unsizable>;
  readonly startup: Effect.Effect<void, RuntimeError>;
  readonly find: (
    what: Resource["resource"],
    ref: Identity
  ) => Effect.Effect<Handle | undefined, RuntimeError>;
  readonly observe: (
    machines: readonly Target[]
  ) => Effect.Effect<Observed, RuntimeError>;
  readonly capacity: (
    machines: readonly Held[]
  ) => Effect.Effect<readonly Reading[], RuntimeError>;
  /** Makes the machine, from an image or a copy. A name the runtime can't give a VM is `Invalid`. */
  readonly make: (
    machine: Identity & Sizes,
    origin: Origin,
    bind: Bind
  ) => Effect.Effect<Made, RoomError | StateError | Unsizable | Invalid>;
  /**
   * Starts a stopped machine, or resumes a paused one. A runtime that holds checkpoints through its
   * machine deletes, once the machine runs, each of them whose handle `keep` lacks, so a pause's own
   * checkpoint goes only after the resume that read it.
   */
  readonly start: (
    machine: Target,
    keep: ReadonlySet<Handle>
  ) => Effect.Effect<void, RoomError | StateError>;
  readonly stop: (machine: Target) => Effect.Effect<void, RuntimeError>;
  readonly pause: (
    machine: Target
  ) => Effect.Effect<void, RuntimeError | StateError>;
  readonly delete: (
    machine: Target,
    keep: ReadonlySet<Handle>
  ) => Effect.Effect<void, RuntimeError>;
  readonly capture: (
    machine: Target,
    checkpoint: Identity
  ) => Effect.Effect<Handle, RoomError | StateError>;
  readonly resize: (
    machine: Sized,
    to: Sizing,
    running: boolean
  ) => Effect.Effect<void, RuntimeError | Unsizable>;
  readonly sizes: (machine: Target) => Effect.Effect<Sizing, RuntimeError>;
  /** Fails `Conflict` where the provider keeps the checkpoint while something depends on it. */
  readonly deleteCheckpoint: (
    checkpoint: Target
  ) => Effect.Effect<void, RuntimeError | Conflict>;
  readonly exec: (
    machine: Target,
    command: Command
  ) => Effect.Effect<Execution, RuntimeError, Scope.Scope>;
}

export class Runtime extends Context.Service<Runtime, Interface>()(
  "@clankerbox/host/Runtime"
) {}
