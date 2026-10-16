import type { Checkpoint, Conflict, Desired, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Context, type DateTime, type Effect, type Option } from "effect";

/** What the store answers a request with: what the row now asks for, and the request's number. */
export interface Desire {
  readonly desired: Desired;
  readonly generation: number;
}

/** A machine's row: what the operator asked for, and the progress toward it. */
export interface Intent {
  readonly name: string;
  readonly instance: string;
  /** Recorded by the runtime through `NativeIds`; a step reads it from the row, never a copy. */
  readonly native: string | undefined;
  readonly createdAt: DateTime.Utc;
  readonly base: string;
  readonly profile: string | undefined;
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
  /** Picked when the row is inserted, and never changes. */
  readonly port: number | undefined;
  readonly desired: Desired;
  /** Raised by every request, so a request can tell its own answer from a later one's. */
  readonly generation: number;
  /**
   * Once its copy and its setup succeeded, in the request that created it; one the host finds
   * unmade at its start is deleted. After that, a machine the runtime lacks is lost.
   */
  readonly made: boolean;
  /** The key the last preparation that printed one printed, which no runtime can tell again. */
  readonly hostKey: string | undefined;
}

/** Only a capture that succeeded is a checkpoint; the store keeps the rest out of every read. */
export interface CheckpointRecord {
  readonly name: string;
  readonly instance: string;
  readonly createdAt: DateTime.Utc;
  readonly machine: string;
  readonly kind: Checkpoint["kind"];
  /** A `ram` checkpoint restores only under the runtime's pin at capture. */
  readonly pin: string | undefined;
  /**
   * The source's host port at capture: a `ram` restore comes up on it, until the runtime moves
   * it to the new machine's own.
   */
  readonly port: number | undefined;
  readonly base: string;
  readonly profile: string | undefined;
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
}

export interface Interface {
  readonly machines: Effect.Effect<ReadonlyArray<Intent>, Internal>;
  readonly findMachine: (name: string) => Effect.Effect<Option.Option<Intent>, Internal>;
  readonly ports: Effect.Effect<ReadonlySet<number>, Internal>;
  /** A taken name is `Conflict`, and then nothing is written. */
  readonly insertMachine: (intent: Intent) => Effect.Effect<void, Conflict | Internal>;
  /**
   * Numbers the request one past the row's last, in the one write that records it; a deleted row
   * stays deleted. `None` when the row is gone.
   */
  readonly desire: (
    name: string,
    desired: Desired,
  ) => Effect.Effect<Option.Option<Desire>, Internal>;
  readonly made: (name: string) => Effect.Effect<void, Internal>;
  readonly hostKey: (name: string, hostKey: string) => Effect.Effect<void, Internal>;
  readonly removeMachine: (name: string) => Effect.Effect<void, Internal>;
  readonly checkpoints: Effect.Effect<ReadonlyArray<CheckpointRecord>, Internal>;
  readonly findCheckpoint: (
    name: string,
  ) => Effect.Effect<Option.Option<CheckpointRecord>, Internal>;
  /** The row under `name`, also one a capture or a delete that failed left unready. */
  readonly anyCheckpoint: (
    name: string,
  ) => Effect.Effect<Option.Option<CheckpointRecord>, Internal>;
  /** The row of a capture under way, which no read shows; a taken name is `Conflict`. */
  readonly beginCheckpoint: (record: CheckpointRecord) => Effect.Effect<void, Conflict | Internal>;
  readonly readyCheckpoint: (name: string) => Effect.Effect<void, Internal>;
  /** Hides a checkpoint whose delete begins, so a delete that fails leaves it unready for the next. */
  readonly retireCheckpoint: (name: string) => Effect.Effect<void, Internal>;
  readonly removeCheckpoint: (name: string) => Effect.Effect<void, Internal>;
  /** The captures and deletes that failed, or that the last host's end cut off, with what they left. */
  readonly unready: Effect.Effect<ReadonlyArray<CheckpointRecord>, Internal>;
}

export class Store extends Context.Service<Store, Interface>()("@clankerbox/host/Store") {}

/** The one write to the host's state a runtime makes. */
export interface NativeIdRecorder {
  /**
   * Called as soon as the runtime knows the ID (boat assigns its sandbox's), so a `delete` after
   * a crash has it. A row that is gone, or now holds another instance, is `Internal`.
   */
  readonly recordNative: (
    name: string,
    instance: string,
    native: string,
  ) => Effect.Effect<void, Internal>;
}

export class NativeIds extends Context.Service<NativeIds, NativeIdRecorder>()(
  "@clankerbox/host/NativeIds",
) {}
