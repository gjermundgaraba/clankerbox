import type {
  CheckpointRef,
  MachineRef,
  MachineState,
  Native,
} from "@clankerbox/host-contract";
import { Missing, readTimeout } from "@gjermundgaraba/clankerbox-sdk";
import type {
  Capacity,
  Internal,
  Kind,
  Reading,
  Sizing,
  Unsizable,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, Duration, Effect, Schema } from "effect";
import type { Scope, Stream } from "effect";

export type {
  CheckpointRef,
  MachineRef,
  MachineState,
  Native,
} from "@clankerbox/host-contract";

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

export interface Held {
  readonly machine: MachineRef;
  readonly booting: boolean;
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

export interface Command {
  readonly argv: readonly string[];
  readonly user?: string | undefined;
  readonly stdin?: Uint8Array | undefined;
}

export interface Execution {
  readonly output: Stream.Stream<Uint8Array, RuntimeError>;
  readonly exitCode: Effect.Effect<number, RuntimeError>;
}

export const missing = (
  kind: Kind,
  machine: Pick<MachineRef, "name">
): Missing =>
  new Missing({
    message: `machine ${machine.name} is missing from the ${kind} runtime; delete it`,
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

/**
 * A runtime that copies a build by branching a parked base of it, a VM kept from the build's
 * checkpoint, so a copy takes no restore. Its restore of a build branches once the base is parked.
 */
export interface Bases {
  /**
   * Parks `build`'s base, from whatever an earlier try left, unless the build is gone or the
   * checkpoint is no build's copy.
   */
  readonly park: (build: CheckpointRef) => Effect.Effect<void, RuntimeError>;
  /**
   * Parks a base for each build the host keeps, and deletes each base whose build or boot is gone
   * once no copy is branched from it, by what the runtime reads.
   */
  readonly settle: Effect.Effect<void, RuntimeError>;
}

export type Dial = (
  input: Stream.Stream<Uint8Array>
) => Stream.Stream<Uint8Array, RuntimeError>;

export type Reach =
  | { readonly _tag: "published"; readonly address: string }
  | {
      readonly _tag: "relayed";
      readonly address: string;
      readonly dial: (machine: Native) => Dial;
    };

export interface Admission {
  readonly admit: (activation: Activation) => Effect.Effect<void, RoomError>;
  readonly stopBoots: boolean;
}

export interface CheckpointFiles {
  readonly checkpointFiles: (
    checkpoint: CheckpointRef
  ) => Effect.Effect<readonly CheckpointFile[], RuntimeError>;
  /** Where a file of `key` lies on this host, in any of its checkpoints, if one does. */
  readonly held: (key: string) => Effect.Effect<string | undefined>;
  /** Where a copy of `checkpoint` is put together, on the filesystem it will lie on. */
  readonly staging: (checkpoint: CheckpointRef) => string;
  /** Makes `checkpoint` of the files put together in `staged`, which it takes. */
  readonly install: (
    checkpoint: CheckpointRef,
    staged: string
  ) => Effect.Effect<void, RuntimeError>;
}

export interface Interface {
  readonly version: string;
  readonly pin: string | undefined;
  readonly reach: Reach;
  readonly admission: Admission | undefined;
  readonly files: CheckpointFiles | undefined;
  readonly growsLive: boolean;
  readonly bases?: Bases | undefined;
  readonly sizable: (
    machine: Pick<MachineRef, "name">,
    from: Sizes,
    to: Sizes,
    live: boolean
  ) => Effect.Effect<void, Unsizable>;
  readonly startup: Effect.Effect<void, RuntimeError>;
  readonly adopt: (
    machines: readonly MachineRef[]
  ) => Effect.Effect<void, RuntimeError>;
  readonly observe: (
    machines: readonly Native[]
  ) => Effect.Effect<Observed, RuntimeError>;
  readonly capacity: (
    machines: readonly Held[]
  ) => Effect.Effect<readonly Reading[], RuntimeError>;
  readonly create: (
    machine: MachineRef,
    image: string
  ) => Effect.Effect<void, RoomError | Unsizable>;
  readonly start: (
    machine: MachineRef
  ) => Effect.Effect<void, RoomError | StateError>;
  readonly stop: (machine: MachineRef) => Effect.Effect<void, RuntimeError>;
  readonly pause: (
    machine: MachineRef
  ) => Effect.Effect<void, RuntimeError | StateError>;
  readonly delete: (machine: Native) => Effect.Effect<void, RuntimeError>;
  readonly capture: (
    machine: MachineRef,
    checkpoint: CheckpointRef
  ) => Effect.Effect<void, RoomError | StateError>;
  readonly restore: (
    checkpoint: CheckpointRef,
    machine: MachineRef
  ) => Effect.Effect<void, RoomError | Unsizable>;
  readonly fork: (
    source: MachineRef,
    machine: MachineRef
  ) => Effect.Effect<void, RoomError | StateError | Unsizable>;
  readonly resize: (
    machine: MachineRef,
    to: Sizing,
    running: boolean
  ) => Effect.Effect<void, RuntimeError | Unsizable>;
  readonly sizes: (machine: MachineRef) => Effect.Effect<Sizing, RuntimeError>;
  readonly deleteCheckpoint: (
    checkpoint: CheckpointRef
  ) => Effect.Effect<void, RuntimeError>;
  readonly exec: (
    machine: Native,
    command: Command
  ) => Effect.Effect<Execution, RuntimeError, Scope.Scope>;
}

export class Runtime extends Context.Service<Runtime, Interface>()(
  "@clankerbox/host/Runtime"
) {}
