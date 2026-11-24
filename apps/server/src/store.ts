import { Handle, Step } from "@clankerbox/host-contract";
import type { RuntimeTraits } from "@clankerbox/host-contract/traits";
import {
  Build,
  Desired,
  HostError,
  Labels,
  NotFound,
  Port,
  RuntimeName,
  Sizing,
  Unasked,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  Checkpoint,
  Conflict,
  Internal,
  Phase,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, Effect, Schema, SchemaGetter } from "effect";
import type {
  Array as Arr,
  DateTime,
  Option,
  Result,
  Scope,
  Duration,
} from "effect";

import type { CheckpointRow } from "./checkpoint-chart.ts";
import type { MachineRow } from "./machine-chart.ts";

export type { MachineState } from "@clankerbox/host-contract";

export const Endpoint = Schema.Struct({
  host: Schema.optionalKey(Schema.String),
  port: Port,
});

export type Endpoint = typeof Endpoint.Type;

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

export const Source = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("base") }),
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

export const notFound = (resource: Lease["resource"], name: string): NotFound =>
  new NotFound({ message: `no ${resource} ${name}`, id: name });

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
  to: UndefinedFromNull(Schema.fromJsonString(Sizing)),
});

export type Operation = typeof Operation.Type;

export type MachinePhase = Exclude<Phase, "waiting">;

export const MadeOn = Schema.Struct({ runtime: RuntimeName });

export type MadeOn = typeof MadeOn.Type;

export const madeOn = (traits: RuntimeTraits): MadeOn => ({
  runtime: traits.runtime,
});

const made = {
  name: Schema.String,
  instance: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  base: Schema.String,
  cpu: Schema.Int,
  ramMib: Schema.Int,
  diskGib: Schema.Int,
  host: Schema.String,
  pin: UndefinedFromNull(Schema.String),
  handle: UndefinedFromNull(Handle),
  error: UndefinedFromNull(Schema.fromJsonString(HostError)),
  labels: UndefinedFromNull(Schema.fromJsonString(Labels)),
};

export const Facts = Schema.Struct({
  ...made,
  ...MadeOn.fields,
  endpoint: UndefinedFromNull(Schema.fromJsonString(Endpoint)),
  desired: Desired.pick(["running", "stopped"]),
  prepared: Schema.BooleanFromBit,
  resize: UndefinedFromNull(Schema.fromJsonString(Sizing)),
  ephemeral: Schema.BooleanFromBit,
  tailnet: Schema.BooleanFromBit,
  source: Schema.fromJsonString(Source),
  template: UndefinedFromNull(Schema.String),
  hostKey: UndefinedFromNull(Schema.String),
  undoneAt: UndefinedFromNull(Schema.DateTimeUtcFromString),
  after: UndefinedFromNull(Schema.String),
  boots: Schema.Int,
  booting: Schema.BooleanFromBit,
  reboot: UndefinedFromNull(Schema.String),
  unasked: UndefinedFromNull(Schema.fromJsonString(Unasked)),
});

export type Facts = typeof Facts.Type;

export type ShownPhase = Checkpoint["phase"];

export const CheckpointFacts = Schema.Struct({
  ...made,
  runtime: RuntimeName,
  machine: Schema.String,
  failedAt: UndefinedFromNull(Schema.DateTimeUtcFromString),
  expiresAt: UndefinedFromNull(Schema.DateTimeUtcFromString),
  build: UndefinedFromNull(Schema.String),
  published: UndefinedFromNull(Schema.String),
  tailnet: Schema.BooleanFromBit,
});

export type CheckpointFacts = typeof CheckpointFacts.Type;

export const BuildRow = Schema.Struct({
  number: Schema.Int,
  createdAt: Schema.DateTimeUtcFromString,
  phase: Build.fields.phase,
  error: UndefinedFromNull(Schema.fromJsonString(HostError)),
  host: Schema.String,
  pin: UndefinedFromNull(Schema.String),
  image: Schema.String,
  base: Schema.String,
  cpu: Schema.Int,
  ramMib: Schema.Int,
  diskGib: Schema.Int,
  setupTimeoutSeconds: UndefinedFromNull(Schema.Int),
  tailnet: Schema.BooleanFromBit,
});

export type BuildRow = typeof BuildRow.Type;

export const TemplateFacts = Schema.Struct({
  name: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
});

export type TemplateRow = typeof TemplateFacts.Type & {
  readonly builds: Arr.NonEmptyReadonlyArray<BuildRow>;
};

export interface TokenRow {
  readonly name: string;
  readonly hash: Uint8Array;
  readonly mintedBy: string | undefined;
  readonly mintedAt: DateTime.Utc;
  readonly revokedAt: DateTime.Utc | undefined;
}

export interface Rows {
  readonly machine: MachineRow;
  readonly checkpoint: CheckpointRow;
}

export type Advanced<R> =
  | {
      readonly at: "written";
      readonly next: R | "removed";
      readonly moved: boolean;
    }
  | { readonly at: "absent" }
  | { readonly at: "busy"; readonly by: Operation };

export interface Decision<R> {
  readonly next: R | "removed";
  readonly begin?: Omit<Operation, "sequence">;
  readonly finish: boolean;
}

export interface Interface {
  readonly watch: (
    resource: Lease["resource"],
    name: string
  ) => Effect.Effect<Effect.Effect<void>, never, Scope.Scope>;
  readonly machines: Effect.Effect<readonly MachineRow[], Internal>;
  readonly findMachine: (
    name: string
  ) => Effect.Effect<Option.Option<MachineRow>, Internal>;
  readonly insertMachine: (
    row: MachineRow
  ) => Effect.Effect<void, Conflict | Internal>;
  readonly advance: <K extends Lease["resource"]>(
    resource: K,
    name: string,
    decide: (row: Rows[K], op: Operation | undefined) => Decision<Rows[K]>
  ) => Effect.Effect<Advanced<Rows[K]>, Internal>;
  readonly expire: (before: DateTime.Utc) => Effect.Effect<void, Internal>;
  readonly checkpoints: Effect.Effect<readonly CheckpointRow[], Internal>;
  readonly findCheckpoint: (
    name: string
  ) => Effect.Effect<Option.Option<CheckpointRow>, Internal>;
  readonly insertCheckpoint: (
    row: CheckpointRow
  ) => Effect.Effect<void, Conflict | Internal>;
  readonly templates: Effect.Effect<readonly TemplateRow[], Internal>;
  readonly findTemplate: (
    name: string
  ) => Effect.Effect<Option.Option<TemplateRow>, Internal>;
  readonly advanceTemplate: <A extends TemplateRow | "removed", E>(
    name: string,
    decide: (
      found: Option.Option<TemplateRow>,
      lastBuild: number
    ) => Result.Result<A, E>
  ) => Effect.Effect<A, E | Internal>;
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
  /** Every token ever minted, those revoked included, in the order they were minted. */
  readonly tokens: Effect.Effect<readonly TokenRow[], Internal>;
  readonly insertToken: (
    row: TokenRow
  ) => Effect.Effect<void, Conflict | Internal>;
  /** The token's row once revoked, at `at` or when it was revoked first; none for no such token. */
  readonly revokeToken: (
    name: string,
    at: DateTime.Utc
  ) => Effect.Effect<Option.Option<TokenRow>, Internal>;
}

export class Store extends Context.Service<Store, Interface>()(
  "@clankerbox/server/Store"
) {}

export const readUntil = <A, E>(
  store: Pick<Interface, "watch">,
  resource: Lease["resource"],
  name: string,
  read: Effect.Effect<A, E>,
  done: (found: A) => boolean,
  orEvery?: Duration.Duration
): Effect.Effect<A, E> =>
  Effect.scoped(
    Effect.gen(function* () {
      const written = yield* store.watch(resource, name);

      const wake =
        orEvery === undefined
          ? written
          : Effect.timeoutOption(written, orEvery);

      const until = (found: A): Effect.Effect<A, E> =>
        done(found)
          ? Effect.succeed(found)
          : Effect.flatMap(Effect.andThen(wake, read), until);

      return yield* Effect.flatMap(read, until);
    })
  );
