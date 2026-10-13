/**
 * The host's state, as the core uses it: one row per machine and per checkpoint, each with its
 * last action, and the claims actions take on them. Machine state is always read from the
 * runtime, never stored. `platform/sqlite.ts` keeps it.
 */
import type {
  ActionName,
  ActionRecord,
  Checkpoint,
  Conflict,
  Internal,
  NotFound,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, type DateTime, type Effect, type Option } from "effect";

/** What every row holds, machine or checkpoint. */
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
  readonly action: ActionRecord;
}

/** A machine row. */
export interface MachineRecord extends Resource {
  readonly port: number | undefined;
  /** The guest's SSH host public key, as the last preparation printed it. */
  readonly hostKey: string | undefined;
  /**
   * Whether the runtime's work of the create, fork or restore that inserted the row succeeded:
   * the create with its setup, or the fork's or restore's native work. Until then the machine
   * can only be read, stopped or deleted.
   */
  readonly made: boolean;
}

/** A checkpoint row. Ready checkpoints never change, so restores read them without a claim. */
export interface CheckpointRecord extends Resource {
  /** The name of the machine it was captured from. */
  readonly machine: string;
  readonly kind: Checkpoint["kind"];
  /** What a `ram` checkpoint must be restored under: the runtime's pin at capture. */
  readonly pin: string | undefined;
  /**
   * The source's host port at capture. A `ram` restore comes up on it, as the checkpoint holds
   * the source's published port, until the runtime moves it to the new machine's own.
   */
  readonly port: number | undefined;
}

/** A new machine row. Its claim's action holds it from the start, and it isn't made yet. */
export type NewMachine = Omit<MachineRecord, "action" | "made">;

/** A new checkpoint row. Its claim's action holds it from the start. */
export type NewCheckpoint = Omit<CheckpointRecord, "action">;

export type Table = "machines" | "checkpoints";

/** Each table's records. */
export interface Records {
  readonly machines: MachineRecord;
  readonly checkpoints: CheckpointRecord;
}

/** A row, by its table and name. */
export interface RowRef<T extends Table = Table> {
  readonly table: T;
  readonly name: string;
}

/** A row for `insert`. */
export type NewRow =
  | { readonly table: "machines"; readonly record: NewMachine }
  | { readonly table: "checkpoints"; readonly record: NewCheckpoint };

/** A row a claim holds, and the action the claim replaced on it. */
export interface HeldRow extends RowRef {
  readonly before: ActionRecord;
}

/**
 * An action's claim: every row it inserted and every row it holds. A release removes the first
 * and puts back each held row's `before`; an end records the action's outcome on all of them.
 */
export interface Token {
  readonly action: ActionName;
  readonly inserted: ReadonlyArray<RowRef>;
  readonly held: ReadonlyArray<HeldRow>;
}

/** What a hold returns: its token, and the record of the row it held, as the hold left it. */
export interface Claim<A> {
  readonly token: Token;
  readonly held: A;
}

/** What an action records when it ends: its outcome, on every row it claimed. */
export interface Outcome {
  readonly action: ActionRecord;
  /**
   * The machine a preparation ran on, and the host key it printed, which goes on that row. A
   * preparation that printed none leaves the row's key as it was.
   */
  readonly prepared?: { readonly name: string; readonly hostKey: string | undefined } | undefined;
}

export interface Interface {
  readonly list: Effect.Effect<ReadonlyArray<MachineRecord>, Internal>;
  readonly find: (name: string) => Effect.Effect<Option.Option<MachineRecord>, Internal>;
  /** The ports every machine row holds. */
  readonly ports: Effect.Effect<ReadonlySet<number>, Internal>;
  readonly checkpoints: Effect.Effect<ReadonlyArray<CheckpointRecord>, Internal>;
  readonly findCheckpoint: (
    name: string,
  ) => Effect.Effect<Option.Option<CheckpointRecord>, Internal>;
  /**
   * Claims an existing row for `action` in one transaction. A missing row is NotFound and one
   * another action holds `Conflict{busy}`, and then nothing is written. The token covers
   * `joining`'s rows too, so an action can claim in steps, such as a fork's source and then its
   * copy, and still release or end everything at once.
   */
  readonly hold: <T extends Table>(
    action: ActionName,
    row: RowRef<T>,
    joining?: Token,
  ) => Effect.Effect<Claim<Records[T]>, NotFound | Conflict | Internal>;
  /**
   * Inserts a new row in one transaction, held by `action` from the start, and joins it to
   * `joining` as `hold` does. A taken name is `Conflict{exists}`, and then nothing is written.
   * Actions pick ports one at a time, so the port's unique index is only a backstop.
   */
  readonly insert: (
    action: ActionName,
    row: NewRow,
    joining?: Token,
  ) => Effect.Effect<Token, Conflict | Internal>;
  /** Gives back a claim in one transaction: its inserted rows go, its held rows get `before`. */
  readonly release: (token: Token) => Effect.Effect<void, Internal>;
  /**
   * Marks every machine row the claim inserted made, in one transaction: the machine its create,
   * fork or restore made, once the runtime's work is done and before its preparation.
   */
  readonly markMade: (token: Token) => Effect.Effect<void, Internal>;
  /** Ends a claim in one transaction, recording `outcome` on its rows. */
  readonly end: (token: Token, outcome: Outcome) => Effect.Effect<void, Internal>;
  /**
   * Records the runtime's native ID on the machine row `name` of instance `instance`, as soon as
   * the runtime knows it: boat's sandbox ID, which boat assigns, so that a `delete` after a crash
   * has it. A row that is gone, or now holds another instance, is `Internal`.
   */
  readonly recordNative: (
    name: string,
    instance: string,
    native: string,
  ) => Effect.Effect<void, Internal>;
  /** Removes a row, as a successful delete does. */
  readonly remove: (row: RowRef) => Effect.Effect<void, Internal>;
  /** At startup: every action still running was cut off by the last host process's end. */
  readonly failInterrupted: Effect.Effect<void, Internal>;
}

export class Store extends Context.Service<Store, Interface>()("@clankerbox/host/Store") {}
