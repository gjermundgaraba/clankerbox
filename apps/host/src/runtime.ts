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

/** A host that can't serve at all, before it listens. */
export class CannotStart extends Schema.TaggedError<
  CannotStart,
  { readonly brand: unique symbol }
>()("CannotStart", {
  message: Schema.String,
}) {}

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

export interface Interface {
  readonly version: string;
  readonly publishAddress: string;
  readonly pin: string | undefined;
  readonly stopResumes: boolean;
  readonly growsLive: boolean;
  readonly sizable: (
    machine: Pick<MachineRef, "name">,
    from: Sizes,
    to: Sizes,
    live: boolean
  ) => Effect.Effect<void, Unsizable>;
  /** What the host clears when it starts, knowing no machines yet. */
  readonly startup: Effect.Effect<void, RuntimeError>;
  /** What the runtime keeps beside each VM, once the control plane says which it holds. */
  readonly adopt: (
    machines: readonly MachineRef[]
  ) => Effect.Effect<void, RuntimeError>;
  readonly observe: (
    machines: readonly Native[]
  ) => Effect.Effect<Observed, RuntimeError>;
  readonly admit: (activation: Activation) => Effect.Effect<void, RoomError>;
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
    machine: MachineRef,
    command: Command
  ) => Effect.Effect<Execution, RuntimeError, Scope.Scope>;
}

export class Runtime extends Context.Service<Runtime, Interface>()(
  "@clankerbox/host/Runtime"
) {}
