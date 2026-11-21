import type {
  Handle,
  MachineRef,
  MachineState,
  Ref,
} from "@clankerbox/host-contract";
import type { RuntimeTraits } from "@clankerbox/host-contract/traits";
import { Internal, Missing, readTimeout } from "@gjermundgaraba/clankerbox-sdk";
import type {
  Capacity,
  Conflict,
  Invalid,
  Reading,
  RuntimeName,
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

export const inTime = (what: string) =>
  timeoutFail(
    stateReadWait,
    () =>
      new Internal({
        message: `${what} didn't answer within ${Duration.format(stateReadWait)}`,
      })
  );

export interface Target {
  readonly name: string;
  readonly instance: string;
  readonly handle: Handle;
}

export const targetOf = (
  { name, instance }: Identity,
  handle: Handle
): Target => ({ name, instance, handle });

const tailLines = 20;

const tailCharacters = 4000;

export const lastLines = (text: string): string =>
  text
    .trimEnd()
    .split("\n")
    .slice(-tailLines)
    .join("\n")
    .slice(-tailCharacters);

export type Sized = Target & Sizes;

export type Held =
  | { readonly _tag: "found"; readonly machine: Sized }
  | { readonly _tag: "unread"; readonly machine: MachineRef }
  | { readonly _tag: "booting"; readonly machine: MachineRef };

export type Origin =
  | { readonly _tag: "image"; readonly image: string }
  | { readonly _tag: "checkpoint"; readonly checkpoint: Sized }
  | { readonly _tag: "machine"; readonly machine: Sized };

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
 * Pass the launcher's arguments and stdin through unchanged. The command's own arguments and
 * environment are carried in stdin so they do not appear in the host process arguments.
 * With no `user`, run the command as the guest's root.
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

export const missingCheckpoint = (
  runtime: RuntimeName,
  checkpoint: Pick<Ref, "name">
): Missing =>
  new Missing({
    message: `checkpoint ${checkpoint.name} is missing from the ${runtime} runtime of this host`,
    checkpoint: checkpoint.name,
  });

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
}

export interface SharedBuilds {
  readonly shared: true;
  readonly publish: (checkpoint: Target) => Effect.Effect<void, RuntimeError>;
  readonly fetch: (
    checkpoint: Identity,
    from: string,
    build: string
  ) => Effect.Effect<Handle, RuntimeError>;
  readonly unpublish: (name: string) => Effect.Effect<void, RuntimeError>;
}

export type Builds =
  | SharedBuilds
  | {
      readonly shared: false;
      readonly unpublish: SharedBuilds["unpublish"];
    };

export const unshared = (runtime: RuntimeName): Builds => ({
  shared: false,
  unpublish: (name) =>
    Effect.logWarning(
      `unpublish ${name}: this host's ${runtime} runtime shares no template builds, so what it published stays in the build store`
    ),
});

/**
 * Each adapter keeps two rules. A provider call that can't be cut short runs masked and is polled
 * to its end, so a step cut short ends only once its call has. An answer that leaves the outcome
 * unknown, such as a dropped connection, never ends a step: the adapter reads the resource by its
 * instance before it answers. `prepares` is `always` where the runtime's images lack the login
 * user, so every machine made from a base is prepared, and `with-setup` where only a machine with
 * a setup is. `kernel` is `own` where each machine boots its own kernel and a new identity must
 * reseed a copied random generator, and `shared` where containers share their node's kernel and
 * cannot reseed it.
 */
export interface Interface {
  readonly traits: RuntimeTraits;
  readonly guest: "debian" | "macos";
  readonly kernel: "own" | "shared";
  readonly version: string;
  readonly pin: string | undefined;
  readonly reach: Reach;
  readonly prepares: "with-setup" | "always";
  readonly admission: Admission | undefined;
  readonly builds: Builds;
  readonly sizable: (
    machine: Pick<MachineRef, "name">,
    from: Sizes,
    to: Sizes,
    live: boolean
  ) => Effect.Effect<void, Unsizable>;
  readonly startup: Effect.Effect<void, RuntimeError>;
  readonly find: (
    machine: Identity
  ) => Effect.Effect<Handle | undefined, RuntimeError>;
  /**
   * Derives the same handle that capture and install return, from the checkpoint identity and
   * host ID alone, without a search. A step uses this if its row has no handle. Returns undefined
   * if the provider mints the handle, in which case the row records it.
   */
  readonly checkpointHandle: (checkpoint: Identity) => Handle | undefined;
  readonly observe: (
    machines: readonly Target[]
  ) => Effect.Effect<Observed, RuntimeError>;
  readonly capacity: (
    machines: readonly Held[]
  ) => Effect.Effect<readonly Reading[], RuntimeError>;
  /**
   * Makes a machine from an image or copy. A published runtime forwards `hostSshPort` to guest
   * port 22; a relayed one leaves it to the relay. `requestsTailnet` lets the runtime enable guest
   * support such as a TUN device. Refuse an invalid VM name with `Invalid`, and a checkpoint
   * the runtime no longer holds with `Missing` naming the checkpoint, without making anything.
   */
  readonly make: (
    machine: Identity & Sizes,
    origin: Origin,
    hostSshPort: number,
    requestsTailnet?: boolean
  ) => Effect.Effect<Made, RoomError | StateError | Unsizable | Invalid>;
  /**
   * Starts or resumes the machine. A runtime that holds checkpoints through its machine prunes
   * any outside `keepCheckpoints` only once the machine runs, so it can read the pause checkpoint
   * before deleting it.
   */
  readonly start: (
    machine: Target,
    keepCheckpoints: ReadonlySet<Handle>
  ) => Effect.Effect<void, RoomError | StateError>;
  readonly stop: (machine: Target) => Effect.Effect<void, RuntimeError>;
  readonly pause: (
    machine: Target
  ) => Effect.Effect<void, RuntimeError | StateError>;
  /**
   * Deletes this instance and its checkpoints outside `keepCheckpoints`. Remove calls this even
   * if find returned no handle. Once delete answers, anything that later appears for the same
   * instance must also be deleted. The control plane will not make that instance again; adapters
   * whose provider can complete a make after its answer was lost must handle late arrivals.
   */
  readonly delete: (
    machine: Identity & { readonly handle: Handle | undefined },
    keepCheckpoints: ReadonlySet<Handle>
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
  /**
   * Closing the scope ends what the exec holds on the host. The guest process may outlive it,
   * depending on the runtime; `exec.ts` ends a cut command in the guest through another exec.
   */
  readonly exec: (
    machine: Target,
    command: Command
  ) => Effect.Effect<Execution, RuntimeError, Scope.Scope>;
}

export class Runtime extends Context.Service<Runtime, Interface>()(
  "@clankerbox/host/Runtime"
) {}
