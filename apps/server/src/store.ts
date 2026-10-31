import type { Step } from "@clankerbox/host-contract";
import type {
  Checkpoint,
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

import type { Decision } from "./chart.ts";
import type { CheckpointRow } from "./checkpoint-chart.ts";
import type { MachineRow } from "./machine-chart.ts";

export class CannotStart extends Schema.TaggedError<
  CannotStart,
  { readonly brand: unique symbol }
>()("CannotStart", {
  message: Schema.String,
}) {}

/**
 * Where a machine's disk comes from. Copies stay on their source's host, and hold what a setup did,
 * so only a base can have one to run: `scripted` outlives the setup, which stays in memory.
 */
export type Source =
  | { readonly kind: "base"; readonly scripted: boolean }
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
  readonly seen: "running" | "stopped" | "paused" | "missing" | "unknown";
  readonly leases: readonly Lease[];
  /** What a resize gives, which left the row when the step began. */
  readonly to: Sizing | undefined;
}

/** `waiting` is never stored: a read tells it, as it tells the state. */
export type MachinePhase = Exclude<Phase, "waiting">;

/** What a machine's row holds but for its leaf: what no leaf can tell, and its chart's context. */
export interface Facts {
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
  /** What was asked. A delete is the `deleting` region, so the wire's `deleted` is no wish. */
  readonly desired: Exclude<Desired, "deleted">;
  readonly prepared: boolean;
  readonly error: HostError | undefined;
  /** The resize still owed. One that runs is on its operation. */
  readonly resize: Sizing | undefined;
  readonly ephemeral: boolean;
  readonly source: Source;
  readonly prebuild: string | undefined;
  readonly hostKey: string | undefined;
  readonly pin: string | undefined;
  readonly undoneAt: DateTime.Utc | undefined;
}

/** What a client reads of a checkpoint's leaf. */
export type ShownPhase = Checkpoint["phase"];

/** What a checkpoint's row holds but for its leaf. */
export interface CheckpointFacts {
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
  readonly error: HostError | undefined;
  readonly failedAt: DateTime.Utc | undefined;
}

/** A row of each resource, as `advance` reads and writes it. */
export interface Rows {
  readonly machine: MachineRow;
  readonly checkpoint: CheckpointRow;
}

/**
 * What a write did. `written` also answers a `decide` that changed nothing: then `moved` is false
 * and `next` the row as it stands. `busy` wrote nothing, as the operation in flight `by` holds a
 * lease the one begun conflicts with.
 */
export type Advanced<R> =
  | {
      readonly at: "written";
      readonly next: R | "removed";
      readonly moved: boolean;
    }
  | { readonly at: "absent" }
  | { readonly at: "busy"; readonly by: Operation };

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
   * One write of a resource's row, decided inside it: `decide` reads the row and its operation in
   * the transaction that writes what it answers, so nothing can come between, and no write needs a
   * fence. A `begin` takes its leases there, as what owns a resource excludes all else and what
   * shares it excludes an owner, and when one is taken nothing is written.
   */
  readonly advance: <K extends Lease["resource"]>(
    resource: K,
    name: string,
    decide: (row: Rows[K], op: Operation | undefined) => Decision<Rows[K]>
  ) => Effect.Effect<Advanced<Rows[K]>, Internal>;
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
  /** Every lease is an operation in flight here. */
  readonly operations: Effect.Effect<readonly Operation[], Internal>;
  readonly operationOn: (
    resource: Lease["resource"],
    name: string
  ) => Effect.Effect<Option.Option<Operation>, Internal>;
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
