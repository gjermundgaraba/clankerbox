import type { Step } from "@clankerbox/host-contract";
import type {
  Conflict,
  Desired,
  HostError,
  Internal,
  Kind,
  Phase,
  Sizing,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, Schema } from "effect";
import type { DateTime, Effect, Option } from "effect";

export class CannotStart extends Schema.TaggedError<
  CannotStart,
  { readonly brand: unique symbol }
>()("CannotStart", {
  message: Schema.String,
}) {}

/**
 * How far a machine is made: `making` until its make is done, `undoing` while a failed make's VM
 * goes, and `undone` once it has, when the row rests to tell why until it expires or a create of
 * its name replaces it.
 */
export type Stage = "making" | "made" | "undoing" | "undone";

/** Where a machine's disk comes from. Copies stay on their source's host. */
export type Source =
  | { readonly kind: "base" }
  | { readonly kind: "checkpoint"; readonly name: string }
  | { readonly kind: "machine"; readonly name: string };

export interface Lease {
  readonly resource: "machine" | "checkpoint";
  readonly name: string;
  readonly mode: "own" | "share";
}

/** One step on a host. Its row in the store is every lease there is: restarts lose none. */
export interface Operation {
  readonly id: string;
  readonly kind: Step["_tag"];
  readonly resource: Lease["resource"];
  readonly name: string;
  readonly host: string;
  readonly boot: string;
  readonly sequence: number;
  readonly generation: number;
  readonly seen: "running" | "stopped" | "paused" | "missing" | "unknown";
  readonly leases: readonly Lease[];
}

export interface MachineRow {
  readonly name: string;
  readonly instance: string;
  readonly createdAt: DateTime.Utc;
  readonly kind: Kind;
  readonly base: string;
  readonly profile: string | undefined;
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
  readonly host: string;
  readonly port: number | undefined;
  readonly desired: Desired;
  readonly generation: number;
  readonly phase: Phase;
  readonly stage: Stage;
  readonly prepared: boolean;
  readonly error: HostError | undefined;
  readonly resize: Sizing | undefined;
  readonly ephemeral: boolean;
  readonly source: Source;
  readonly scripted: boolean;
  readonly prebuild: string | undefined;
  readonly hostKey: string | undefined;
  readonly pin: string | undefined;
  readonly undoneAt: DateTime.Utc | undefined;
}

/** `discarding` clears what a failed capture left, and reads `failed` to a client. */
export type CheckpointPhase =
  | "capturing"
  | "ready"
  | "discarding"
  | "deleting"
  | "failed";

export interface CheckpointRow {
  readonly name: string;
  readonly instance: string;
  readonly createdAt: DateTime.Utc;
  readonly machine: string;
  readonly host: string;
  readonly kind: Kind;
  readonly pin: string | undefined;
  readonly port: number;
  readonly base: string;
  readonly profile: string | undefined;
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
  readonly phase: CheckpointPhase;
  readonly error: HostError | undefined;
  readonly failedAt: DateTime.Utc | undefined;
}

export type MachinePatch = Partial<Omit<MachineRow, "name" | "createdAt">>;

export type CheckpointPatch = Partial<
  Pick<CheckpointRow, "phase" | "error" | "failedAt">
>;

/**
 * What a report does to its resource, written with the leases' release. A `patch` from before a
 * later request keeps what the step did and drops what it said of the request, so the row is
 * decided afresh: `generation` is the one it was worked out at. A checkpoint's patch with `from`
 * writes only from that phase, so a capture's end leaves a delete asked since.
 */
export type Finish =
  | {
      readonly row: "patch";
      readonly generation: number;
      readonly patch: MachinePatch;
    }
  | {
      readonly row: "checkpoint";
      readonly patch: CheckpointPatch;
      readonly from?: CheckpointPhase;
    }
  | { readonly row: "removed" }
  | { readonly row: "checkpoint-removed" }
  | { readonly row: "kept" };

export interface Interface {
  readonly machines: Effect.Effect<readonly MachineRow[], Internal>;
  readonly findMachine: (
    name: string
  ) => Effect.Effect<Option.Option<MachineRow>, Internal>;
  /** A create over a row left `undone` replaces it. */
  readonly insertMachine: (
    row: MachineRow
  ) => Effect.Effect<void, Conflict | Internal>;
  /**
   * Records what was asked: the generation rises, the row stops resting and its error goes, all in
   * one write. `deleted` stays deleted.
   */
  readonly desire: (
    name: string,
    desired: Desired
  ) => Effect.Effect<Option.Option<MachineRow>, Internal>;
  readonly resize: (
    name: string,
    sizing: Sizing
  ) => Effect.Effect<Option.Option<MachineRow>, Internal>;
  /** Writes a rest or a patch only at `generation`, so a later request is never overwritten. */
  readonly patch: (
    name: string,
    generation: number,
    patch: MachinePatch
  ) => Effect.Effect<boolean, Internal>;
  readonly removeMachine: (name: string) => Effect.Effect<void, Internal>;
  /** Removes the rows of failed creates and captures older than `before`. */
  readonly expire: (before: DateTime.Utc) => Effect.Effect<void, Internal>;
  readonly checkpoints: Effect.Effect<readonly CheckpointRow[], Internal>;
  readonly findCheckpoint: (
    name: string
  ) => Effect.Effect<Option.Option<CheckpointRow>, Internal>;
  /** A capture over a row left `failed` replaces it. */
  readonly insertCheckpoint: (
    row: CheckpointRow
  ) => Effect.Effect<void, Conflict | Internal>;
  readonly patchCheckpoint: (
    name: string,
    patch: CheckpointPatch
  ) => Effect.Effect<void, Internal>;
  readonly removeCheckpoint: (name: string) => Effect.Effect<void, Internal>;
  /** Every lease is an operation in flight here. */
  readonly operations: Effect.Effect<readonly Operation[], Internal>;
  readonly operationOn: (
    resource: Lease["resource"],
    name: string
  ) => Effect.Effect<Option.Option<Operation>, Internal>;
  /**
   * Takes the leases and records the operation in one write, with the row's phase for a machine.
   * None when a lease is taken, as what owns a resource excludes all else and what shares it
   * excludes an owner, or when a machine's row has moved past `generation` since.
   */
  readonly begin: (
    operation: Omit<Operation, "sequence">,
    phase: Phase | undefined,
    patch: MachinePatch
  ) => Effect.Effect<Option.Option<Operation>, Internal>;
  /** Frees the operation's leases and writes what its report says, in one write. */
  readonly finish: (
    operation: Operation,
    finish: Finish
  ) => Effect.Effect<void, Internal>;
  readonly hostBoot: (
    host: string
  ) => Effect.Effect<Option.Option<string>, Internal>;
  readonly recordBoot: (
    host: string,
    boot: string
  ) => Effect.Effect<void, Internal>;
}

export class Store extends Context.Service<Store, Interface>()(
  "@clankerbox/server/Store"
) {}
