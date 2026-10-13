// Machine state is always read from the runtime, never stored.
import type {
  ActionName,
  ActionRecord,
  Checkpoint,
  Conflict,
  Internal,
  NotFound,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, type DateTime, type Effect, type Option } from "effect";
import type { Kind } from "./ids.ts";

export interface Resource {
  readonly name: string;
  readonly instance: string;
  readonly native: string | undefined;
  readonly createdAt: DateTime.Utc;
  readonly base: string;
  readonly profile: string | undefined;
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
}

export interface MachineRecord extends Resource {
  readonly action: ActionRecord;
  readonly port: number | undefined;
  readonly hostKey: string | undefined;
  /**
   * Until the runtime work of the create, fork or restore succeeds, the machine can only be
   * read, stopped or deleted.
   */
  readonly made: boolean;
}

/**
 * Ready checkpoints never change, so restores read them without a claim. Only a capture or a
 * delete claims a checkpoint row, so its action is one of them.
 */
export interface CheckpointRecord extends Resource {
  readonly action: ActionRecord;
  readonly machine: string;
  readonly kind: Checkpoint["kind"];
  /** A `ram` checkpoint restores only under the runtime's pin at capture. */
  readonly pin: string | undefined;
  /**
   * The source's host port at capture: a `ram` restore comes up on it, until the runtime moves
   * it to the new machine's own.
   */
  readonly port: number | undefined;
}

export type NewMachine = Omit<MachineRecord, "action" | "made">;

export type NewCheckpoint = Omit<CheckpointRecord, "action">;

export interface Records {
  readonly machine: MachineRecord;
  readonly checkpoint: CheckpointRecord;
}

export interface RowRef<K extends Kind = Kind> {
  readonly kind: K;
  readonly name: string;
}

export type NewRow =
  | { readonly kind: "machine"; readonly record: NewMachine }
  | { readonly kind: "checkpoint"; readonly record: NewCheckpoint };

export interface HeldRow extends RowRef {
  readonly before: ActionRecord;
}

export interface Token {
  readonly action: ActionName;
  readonly inserted: ReadonlyArray<RowRef>;
  readonly held: ReadonlyArray<HeldRow>;
}

export interface Claim<A> {
  readonly token: Token;
  readonly held: A;
}

export interface Outcome {
  readonly action: ActionRecord;
  /** A preparation that printed no host key leaves the row's key as it was. */
  readonly prepared?: { readonly name: string; readonly hostKey: string | undefined } | undefined;
}

export interface Interface {
  readonly list: Effect.Effect<ReadonlyArray<MachineRecord>, Internal>;
  readonly find: (name: string) => Effect.Effect<Option.Option<MachineRecord>, Internal>;
  readonly ports: Effect.Effect<ReadonlySet<number>, Internal>;
  readonly checkpoints: Effect.Effect<ReadonlyArray<CheckpointRecord>, Internal>;
  readonly findCheckpoint: (
    name: string,
  ) => Effect.Effect<Option.Option<CheckpointRecord>, Internal>;
  /**
   * One transaction. A missing row is NotFound and one another action holds `Conflict{busy}`,
   * and then nothing is written. The token covers `joining`'s rows too, so an action can claim
   * in steps and still release or end everything at once.
   */
  readonly hold: <K extends Kind>(
    action: ActionName,
    row: RowRef<K>,
    joining?: Token,
  ) => Effect.Effect<Claim<Records[K]>, NotFound | Conflict | Internal>;
  /**
   * One transaction, held by `action` from the start and joined to `joining` as `hold` does. A
   * taken name is `Conflict{exists}`, and then nothing is written. Actions pick ports one at a
   * time, so the port's unique index is only a backstop.
   */
  readonly insert: <R extends NewRow>(
    action: ActionName,
    row: R,
    joining?: Token,
  ) => Effect.Effect<Token, Conflict | Internal>;
  /** One transaction: its inserted rows go, its held rows get `before`. */
  readonly release: (token: Token) => Effect.Effect<void, Internal>;
  /** One transaction; called once the runtime's work is done and before preparation. */
  readonly markMade: (token: Token) => Effect.Effect<void, Internal>;
  /** One transaction, recording `outcome` on every row of the claim. */
  readonly end: (token: Token, outcome: Outcome) => Effect.Effect<void, Internal>;
  /**
   * Called as soon as the runtime knows the ID (boat assigns its sandbox's), so a `delete` after
   * a crash has it. A row that is gone, or now holds another instance, is `Internal`.
   */
  readonly recordNative: (
    name: string,
    instance: string,
    native: string,
  ) => Effect.Effect<void, Internal>;
  readonly remove: (row: RowRef) => Effect.Effect<void, Internal>;
  /** Marks every action still running failed: the last host process's end cut it off. */
  readonly failInterrupted: Effect.Effect<void, Internal>;
}

export class Store extends Context.Service<Store, Interface>()("@clankerbox/host/Store") {}
