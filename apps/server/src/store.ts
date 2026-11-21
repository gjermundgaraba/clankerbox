import { Handle, Step } from "@clankerbox/host-contract";
import type { RuntimeTraits } from "@clankerbox/host-contract/traits";
import {
  Build,
  Checkpoint,
  Desired,
  HostError,
  Labels,
  NotFound,
  Port,
  RuntimeName,
  Sizing,
  Unasked,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Conflict, Internal, Phase } from "@gjermundgaraba/clankerbox-sdk";
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

/**
 * Where a client reaches a machine's sshd: a port of its host, at the address its host answers. A
 * row migrated from schema 6, which kept only the port, has no `host` until its host's next adopt
 * answers it.
 */
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

/**
 * Where a machine's disk comes from. Copies stay on their source's host, and hold what a setup did,
 * so only a base has one to run, and only on a template's builder, which holds it in memory.
 */
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

/**
 * What a machine's row keeps of the runtime it was made on, the one way a host's traits reach a
 * row: its `runtime`, which a client is shown and a copy of the machine stays on, and what a capture
 * of it `captures`, its checkpoint's `kind`: `disk` for every row this release writes, and `ram`
 * only on a row an older release wrote, whose checkpoints kept RAM. Every
 * decision about what a host does reads the host's traits as it answers now, so a trait a release
 * adds or changes migrates no row.
 */
export const MadeOn = Schema.Struct({
  runtime: RuntimeName,
  captures: Checkpoint.fields.kind,
});

export type MadeOn = typeof MadeOn.Type;

export const madeOn = (traits: RuntimeTraits): MadeOn => ({
  runtime: traits.runtime,
  captures: "disk",
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

/** What a machine's row holds but for its leaf: what no leaf can tell, and its chart's context. */
export const Facts = Schema.Struct({
  ...made,
  ...MadeOn.fields,
  endpoint: UndefinedFromNull(Schema.fromJsonString(Endpoint)),
  desired: Desired.pick(["running", "stopped", "paused"]),
  prepared: Schema.BooleanFromBit,
  /** The resize still owed. One that runs is on its operation. */
  resize: UndefinedFromNull(Schema.fromJsonString(Sizing)),
  ephemeral: Schema.BooleanFromBit,
  /** Whether the machine requests the tailnet, which a copy of it inherits. */
  tailnet: Schema.BooleanFromBit,
  source: Schema.fromJsonString(Source),
  template: UndefinedFromNull(Schema.String),
  hostKey: UndefinedFromNull(Schema.String),
  undoneAt: UndefinedFromNull(Schema.DateTimeUtcFromString),
  /** The checkpoint whose capture a pause lets begin before it does. */
  after: UndefinedFromNull(Schema.String),
  /** The cold boots of the machine the control plane knows of, as `Machine.boots` tells them. */
  boots: Schema.Int,
  /** Whether the start under way boots a machine last read stopped, which `boots` counts once it is done. */
  booting: Schema.BooleanFromBit,
  /** Whether its host wrote a boot mark on the machine's disk, which each start then checks. */
  marked: Schema.BooleanFromBit,
  /** The runtime's mark of the machine's last reboot in place, as its last read answered it. */
  reboot: UndefinedFromNull(Schema.String),
  unasked: UndefinedFromNull(Schema.fromJsonString(Unasked)),
});

export type Facts = typeof Facts.Type;

export type ShownPhase = Checkpoint["phase"];

export const CheckpointFacts = Schema.Struct({
  ...made,
  runtime: RuntimeName,
  kind: Checkpoint.fields.kind,
  machine: Schema.String,
  failedAt: UndefinedFromNull(Schema.DateTimeUtcFromString),
  /** When the control plane deletes it, once ready. */
  expiresAt: UndefinedFromNull(Schema.DateTimeUtcFromString),
  build: UndefinedFromNull(Schema.String),
  /**
   * The name a copy's files have in the build store: the builder's copy publishes them under its
   * own name, and a copy on another host is fetched from it.
   */
  published: UndefinedFromNull(Schema.String),
  /** Whether its machine requested the tailnet, which a restore of it inherits. */
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
  /** Whether its setup runs on the tailnet, and each clone of it joins it. */
  tailnet: Schema.BooleanFromBit,
});

export type BuildRow = typeof BuildRow.Type;

export const TemplateFacts = Schema.Struct({
  name: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
});

/** A template is kept while it has a build, and its base, sizes and setup timeout are its builds'. */
export type TemplateRow = typeof TemplateFacts.Type & {
  readonly builds: Arr.NonEmptyReadonlyArray<BuildRow>;
};

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

export interface Decision<R> {
  readonly next: R | "removed";
  readonly begin?: Omit<Operation, "sequence">;
  readonly finish: boolean;
}

export interface Interface {
  /**
   * The next write of a resource's row, from now on: an insert, a move of its leaf or facts, or
   * the begin or end of its operation.
   */
  readonly watch: (
    resource: Lease["resource"],
    name: string
  ) => Effect.Effect<Effect.Effect<void>, never, Scope.Scope>;
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

/**
 * Reads `read` until what it answers is `done`, again after each write of `resource`'s row `name`,
 * and, given `orEvery`, once that long passes with no write.
 */
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
