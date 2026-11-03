import { Step } from "@clankerbox/host-contract";
import {
  Desired,
  HostError,
  Kind,
  Labels,
  NotFound,
  Sizing,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  Checkpoint,
  Conflict,
  Internal,
  Phase,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, Schema, SchemaGetter } from "effect";
import type { DateTime, Effect, Option } from "effect";
import { Hex } from "effect/encoding";

import type { Decision } from "./chart.ts";
import type { CheckpointRow } from "./checkpoint-chart.ts";
import type { MachineRow } from "./machine-chart.ts";

export type { MachineState } from "@clankerbox/host-contract";

export class CannotStart extends Schema.TaggedError<
  CannotStart,
  { readonly brand: unique symbol }
>()("CannotStart", {
  message: Schema.String,
}) {}

const UndefinedFromNull = <S extends Schema.Top>(schema: S) =>
  Schema.NullOr(schema).pipe(
    Schema.decodeTo(Schema.UndefinedOr(Schema.toType(schema)), {
      decode: SchemaGetter.transform((value) => value ?? undefined),
      encode: SchemaGetter.transform((value) => value ?? null),
    })
  );

/**
 * Where a machine's disk comes from. Copies stay on their source's host, and hold what a setup did,
 * so only a base can have one to run: `scripted` outlives the setup, which stays in memory.
 */
export const Source = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("base"), scripted: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("checkpoint"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("machine"), name: Schema.String }),
]);

export type Source = typeof Source.Type;

export const Lease = Schema.Struct({
  resource: Schema.Literals(["machine", "checkpoint"]),
  name: Schema.String,
  mode: Schema.Literals(["own", "share"]),
});

export type Lease = typeof Lease.Type;

/** A new ID for a row's instance or an operation. */
export const newId = (): string =>
  Hex.encode(globalThis.crypto.getRandomValues(new Uint8Array(16)));

export const notFound = (resource: Lease["resource"], name: string): NotFound =>
  new NotFound({ message: `no ${resource} ${name}`, id: name });

/** One step on a host. Its row in the store is every lease there is: restarts lose none. */
export const Operation = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(
    Step.members.map(({ fields }) => fields._tag.schema.literal)
  ),
  resource: Lease.fields.resource,
  name: Schema.String,
  host: Schema.String,
  boot: Schema.String,
  sequence: Schema.Int,
  leases: Schema.fromJsonString(Schema.Array(Lease)),
  /** What a resize gives, which left the row when the step began. */
  to: UndefinedFromNull(Schema.fromJsonString(Sizing)),
});

export type Operation = typeof Operation.Type;

export type MachinePhase = Exclude<Phase, "waiting">;

const made = {
  name: Schema.String,
  instance: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  kind: Kind,
  base: Schema.String,
  profile: UndefinedFromNull(Schema.String),
  cpu: Schema.Int,
  ramMib: Schema.Int,
  diskGib: Schema.Int,
  host: Schema.String,
  pin: UndefinedFromNull(Schema.String),
  error: UndefinedFromNull(Schema.fromJsonString(HostError)),
  labels: UndefinedFromNull(Schema.fromJsonString(Labels)),
};

/** What a machine's row holds but for its leaf: what no leaf can tell, and its chart's context. */
export const Facts = Schema.Struct({
  ...made,
  port: UndefinedFromNull(Schema.Int),
  desired: Desired.pick(["running", "stopped", "paused"]),
  prepared: Schema.BooleanFromBit,
  /** The resize still owed. One that runs is on its operation. */
  resize: UndefinedFromNull(Schema.fromJsonString(Sizing)),
  ephemeral: Schema.BooleanFromBit,
  source: Schema.fromJsonString(Source),
  prebuild: UndefinedFromNull(Schema.String),
  hostKey: UndefinedFromNull(Schema.String),
  undoneAt: UndefinedFromNull(Schema.DateTimeUtcFromString),
  /** The checkpoint whose capture a pause lets begin before it does. */
  after: UndefinedFromNull(Schema.String),
});

export type Facts = typeof Facts.Type;

/** What a client reads of a checkpoint's leaf. */
export type ShownPhase = Checkpoint["phase"];

/** What a checkpoint's row holds but for its leaf. */
export const CheckpointFacts = Schema.Struct({
  ...made,
  machine: Schema.String,
  port: Schema.Int,
  failedAt: UndefinedFromNull(Schema.DateTimeUtcFromString),
  /** When the control plane deletes it, once ready. */
  expiresAt: UndefinedFromNull(Schema.DateTimeUtcFromString),
});

export type CheckpointFacts = typeof CheckpointFacts.Type;

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
  /** The oldest operation in flight on a resource. Every lease is an operation in flight here. */
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
