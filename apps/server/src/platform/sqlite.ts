import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";

import { MachineState } from "@clankerbox/host-contract";
import {
  Conflict,
  Desired,
  HostError,
  Internal,
  Kind,
  Sizing,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import type { Scope } from "effect";

import type { Decision } from "../chart.ts";
import { leaves as checkpointLeaves } from "../checkpoint-chart.ts";
import type { CheckpointRow } from "../checkpoint-chart.ts";
import { leaves } from "../machine-chart.ts";
import type { MachineRow } from "../machine-chart.ts";
import { CannotStart, Store } from "../store.ts";
import type { Advanced, Interface, Lease, Operation, Rows } from "../store.ts";

export const databaseFile = "server.db";

export const applicationId = 0x63_62_78_75;

export const migrations: readonly string[] = [
  `CREATE TABLE machines (
    name TEXT PRIMARY KEY,
    instance TEXT NOT NULL,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    base TEXT NOT NULL,
    profile TEXT,
    cpu INTEGER NOT NULL,
    ram_mib INTEGER NOT NULL,
    disk_gib INTEGER NOT NULL,
    host TEXT NOT NULL,
    port INTEGER,
    desired TEXT NOT NULL,
    state TEXT NOT NULL,
    prepared INTEGER NOT NULL,
    error TEXT,
    resize TEXT,
    ephemeral INTEGER NOT NULL,
    source TEXT NOT NULL,
    prebuild TEXT,
    host_key TEXT,
    pin TEXT,
    undone_at TEXT,
    UNIQUE (host, port)
  ) STRICT;
  CREATE TABLE checkpoints (
    name TEXT PRIMARY KEY,
    instance TEXT NOT NULL,
    created_at TEXT NOT NULL,
    machine TEXT NOT NULL,
    host TEXT NOT NULL,
    kind TEXT NOT NULL,
    pin TEXT,
    port INTEGER NOT NULL,
    base TEXT NOT NULL,
    profile TEXT,
    cpu INTEGER NOT NULL,
    ram_mib INTEGER NOT NULL,
    disk_gib INTEGER NOT NULL,
    state TEXT NOT NULL,
    error TEXT,
    failed_at TEXT
  ) STRICT;
  CREATE TABLE operations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    resource TEXT NOT NULL,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    boot TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    seen TEXT NOT NULL,
    leases TEXT NOT NULL,
    "to" TEXT
  ) STRICT;
  CREATE TABLE hosts (
    id TEXT PRIMARY KEY,
    boot TEXT NOT NULL
  ) STRICT;
  CREATE TABLE sequence (
    one INTEGER PRIMARY KEY CHECK (one = 1),
    last INTEGER NOT NULL
  ) STRICT;
  INSERT INTO sequence (one, last) VALUES (1, 0)`,
];

const isSqliteError = (
  cause: unknown
): cause is Error & { readonly errcode: number } =>
  cause instanceof Error &&
  "errcode" in cause &&
  typeof cause.errcode === "number";

// https://www.sqlite.org/rescode.html#busy
const sqliteBusy = 5;

// https://www.sqlite.org/rescode.html#constraint_primarykey
const sqlitePrimaryKey = 1555;

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const sql = <A>(what: string, run: () => A): Effect.Effect<A, Internal> =>
  Effect.try({
    try: run,
    catch: (cause) =>
      new Internal({ message: `state database: ${what}: ${describe(cause)}` }),
  });

export const transaction = <A>(
  db: DatabaseSync,
  what: string,
  body: () => A
): Effect.Effect<A, Internal> =>
  sql(what, () => {
    db.exec("BEGIN IMMEDIATE");

    try {
      const result = body();

      db.exec("COMMIT");

      return result;
    } catch (error) {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }

      throw error;
    }
  });

const pragma = (db: DatabaseSync, name: string): number => {
  const row = db.prepare(`PRAGMA ${name}`).get();

  return (
    Schema.decodeUnknownSync(Schema.Struct({ [name]: Schema.Int }))(row)[
      name
    ] ?? 0
  );
};

const lock = (
  db: DatabaseSync,
  stateDir: string
): Effect.Effect<void, CannotStart | Internal> =>
  Effect.try({
    try: () => {
      db.exec("PRAGMA locking_mode = EXCLUSIVE");
      db.exec("BEGIN EXCLUSIVE");
      db.exec("COMMIT");
    },
    catch: (cause) =>
      isSqliteError(cause) && cause.errcode === sqliteBusy
        ? new CannotStart({
            message: `another control plane process holds state dir ${stateDir}`,
          })
        : new Internal({
            message: `couldn't lock state dir ${stateDir}: ${describe(cause)}`,
          }),
  });

const migrate = (
  db: DatabaseSync,
  file: string
): Effect.Effect<void, CannotStart | Internal> =>
  Effect.gen(function* () {
    const { id, version, tables } = yield* sql("read its header", () => ({
      id: pragma(db, "application_id"),
      version: pragma(db, "user_version"),
      tables: Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Int }))(
        db.prepare("SELECT count(*) AS count FROM sqlite_schema").get()
      ).count,
    }));

    if (id !== applicationId && (id !== 0 || version !== 0 || tables !== 0)) {
      return yield* new CannotStart({
        message: `${file} isn't a control plane database this clankerbox reads: give it a new state dir`,
      });
    }

    if (version > migrations.length) {
      return yield* new CannotStart({
        message: `${file} is at schema version ${version}, newer than this binary's ${migrations.length}: run a newer clankerbox`,
      });
    }

    if (version === migrations.length && id === applicationId) {
      return;
    }

    yield* transaction(db, "migrate", () => {
      for (const migration of migrations.slice(version)) {
        db.exec(migration);
      }

      db.exec(`PRAGMA user_version = ${migrations.length}`);
      db.exec(`PRAGMA application_id = ${applicationId}`);
    });
  });

const Flag = Schema.Literals([0, 1]);

const Optional = Schema.NullOr(Schema.String);

const SourceJson = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal("base"), scripted: Schema.Boolean }),
    Schema.Struct({ kind: Schema.Literal("checkpoint"), name: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("machine"), name: Schema.String }),
  ])
);

const LeasesJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      resource: Schema.Literals(["machine", "checkpoint"]),
      name: Schema.String,
      mode: Schema.Literals(["own", "share"]),
    })
  )
);

const ErrorJson = Schema.fromJsonString(HostError);

const SizingJson = Schema.fromJsonString(Sizing);

const Stored = <S extends Schema.Top>(schema: S) => Schema.NullOr(schema);

const shared = {
  name: Schema.String,
  instance: Schema.String,
  created_at: Schema.DateTimeUtcFromString,
  kind: Kind,
  base: Schema.String,
  profile: Optional,
  cpu: Schema.Int,
  ram_mib: Schema.Int,
  disk_gib: Schema.Int,
  host: Schema.String,
  pin: Optional,
  error: Stored(ErrorJson),
};

const MachineFields = Schema.Struct({
  ...shared,
  port: Schema.NullOr(Schema.Int),
  desired: Desired.pick(["running", "stopped", "paused"]),
  state: Schema.Literals(leaves),
  prepared: Flag,
  resize: Stored(SizingJson),
  ephemeral: Flag,
  source: SourceJson,
  prebuild: Optional,
  host_key: Optional,
  undone_at: Schema.NullOr(Schema.DateTimeUtcFromString),
});

const CheckpointFields = Schema.Struct({
  ...shared,
  machine: Schema.String,
  port: Schema.Int,
  state: Schema.Literals(checkpointLeaves),
  failed_at: Schema.NullOr(Schema.DateTimeUtcFromString),
});

const OperationFields = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals([
    "make",
    "start",
    "stop",
    "pause",
    "remove",
    "resize",
    "capture",
    "deleteCheckpoint",
    "join",
  ]),
  resource: Schema.Literals(["machine", "checkpoint"]),
  name: Schema.String,
  host: Schema.String,
  boot: Schema.String,
  sequence: Schema.Int,
  seen: MachineState,
  leases: LeasesJson,
  to: Stored(SizingJson),
});

const decodeMachine = Schema.decodeUnknownSync(MachineFields);

const decodeCheckpoint = Schema.decodeUnknownSync(CheckpointFields);

const decodeOperation = Schema.decodeUnknownSync(OperationFields);

const encodeSource = Schema.encodeSync(SourceJson);

const encodeLeases = Schema.encodeSync(LeasesJson);

const encodeError = Schema.encodeSync(ErrorJson);

const encodeSizing = Schema.encodeSync(SizingJson);

const rowOf = (raw: unknown): MachineRow => {
  const row = decodeMachine(raw);

  return {
    name: row.name,
    instance: row.instance,
    createdAt: row.created_at,
    kind: row.kind,
    base: row.base,
    profile: row.profile ?? undefined,
    cpu: row.cpu,
    ramMib: row.ram_mib,
    diskGib: row.disk_gib,
    host: row.host,
    port: row.port ?? undefined,
    desired: row.desired,
    state: row.state,
    prepared: row.prepared === 1,
    error: row.error ?? undefined,
    resize: row.resize ?? undefined,
    ephemeral: row.ephemeral === 1,
    source: row.source,
    prebuild: row.prebuild ?? undefined,
    hostKey: row.host_key ?? undefined,
    pin: row.pin ?? undefined,
    undoneAt: row.undone_at ?? undefined,
  };
};

const checkpointOf = (raw: unknown): CheckpointRow => {
  const row = decodeCheckpoint(raw);

  return {
    name: row.name,
    instance: row.instance,
    createdAt: row.created_at,
    machine: row.machine,
    host: row.host,
    kind: row.kind,
    pin: row.pin ?? undefined,
    port: row.port,
    base: row.base,
    profile: row.profile ?? undefined,
    cpu: row.cpu,
    ramMib: row.ram_mib,
    diskGib: row.disk_gib,
    state: row.state,
    error: row.error ?? undefined,
    failedAt: row.failed_at ?? undefined,
  };
};

const operationOf = (raw: unknown): Operation => {
  const operation = decodeOperation(raw);

  return { ...operation, to: operation.to ?? undefined };
};

const decodeBoot = Schema.decodeUnknownSync(
  Schema.Struct({ boot: Schema.String })
);

const flag = (value: boolean | undefined) => (value === true ? 1 : 0);

const time = (value: DateTime.Utc | undefined) =>
  value === undefined ? null : DateTime.formatIso(value);

type Bound = string | number | null;

type Columns<S extends { readonly fields: object }> = {
  readonly [K in keyof S["fields"]]: Bound;
};

const insertInto = (
  table: string,
  { fields }: { readonly fields: object }
): string => {
  const names = Object.keys(fields);
  const columns = names.map((name) => `"${name}"`).join(", ");
  const values = names.map((name) => `$${name}`).join(", ");

  return `INSERT INTO ${table} (${columns}) VALUES (${values})`;
};

const updateIn = (
  table: string,
  { fields }: { readonly fields: object }
): string => {
  const set = Object.keys(fields)
    .filter((name) => name !== "name")
    .map((name) => `"${name}" = $${name}`);

  return `UPDATE ${table} SET ${set.join(", ")} WHERE name = $name`;
};

const encodedError = (error: HostError | undefined): Bound =>
  error === undefined ? null : encodeError(error);

const sizing = (value: Sizing | undefined): Bound =>
  value === undefined ? null : encodeSizing(value);

const machineColumns = (row: MachineRow): Columns<typeof MachineFields> => ({
  name: row.name,
  instance: row.instance,
  created_at: DateTime.formatIso(row.createdAt),
  kind: row.kind,
  base: row.base,
  profile: row.profile ?? null,
  cpu: row.cpu,
  ram_mib: row.ramMib,
  disk_gib: row.diskGib,
  host: row.host,
  port: row.port ?? null,
  desired: row.desired,
  state: row.state,
  prepared: flag(row.prepared),
  error: encodedError(row.error),
  resize: sizing(row.resize),
  ephemeral: flag(row.ephemeral),
  source: encodeSource(row.source),
  prebuild: row.prebuild ?? null,
  host_key: row.hostKey ?? null,
  pin: row.pin ?? null,
  undone_at: time(row.undoneAt),
});

const checkpointColumns = (
  row: CheckpointRow
): Columns<typeof CheckpointFields> => ({
  name: row.name,
  instance: row.instance,
  created_at: DateTime.formatIso(row.createdAt),
  machine: row.machine,
  host: row.host,
  kind: row.kind,
  pin: row.pin ?? null,
  port: row.port,
  base: row.base,
  profile: row.profile ?? null,
  cpu: row.cpu,
  ram_mib: row.ramMib,
  disk_gib: row.diskGib,
  state: row.state,
  error: encodedError(row.error),
  failed_at: time(row.failedAt),
});

const operationColumns = (
  operation: Operation
): Columns<typeof OperationFields> => ({
  id: operation.id,
  kind: operation.kind,
  resource: operation.resource,
  name: operation.name,
  host: operation.host,
  boot: operation.boot,
  sequence: operation.sequence,
  seen: operation.seen,
  leases: encodeLeases(operation.leases),
  to: sizing(operation.to),
});

interface Table<R> {
  readonly select: StatementSync;
  readonly update: StatementSync;
  readonly remove: StatementSync;
  readonly decoded: (raw: unknown) => R;
  readonly columns: (row: R) => Readonly<Record<string, Bound>>;
}

type Tables = { readonly [K in Lease["resource"]]: Table<Rows[K]> };

const taken = (resource: Lease["resource"], name: string) =>
  new Conflict({ message: `${resource} ${name} exists`, id: name });

const conflicting = (wanted: Lease, held: Lease): boolean =>
  wanted.resource === held.resource &&
  wanted.name === held.name &&
  (wanted.mode === "own" || held.mode === "own");

export interface Owner {
  readonly stateDir: string;
}

export const open = (
  owner: Owner
): Effect.Effect<
  Interface,
  CannotStart | Internal,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const { stateDir } = owner;
    const fs = yield* FileSystem.FileSystem;
    const file = `${stateDir}/${databaseFile}`;

    yield* fs.makeDirectory(stateDir, { recursive: true, mode: 0o700 }).pipe(
      Effect.mapError(
        (error) =>
          new Internal({
            message: `couldn't create state dir ${stateDir}: ${error.message}`,
          })
      )
    );

    const db = yield* Effect.acquireRelease(
      sql(`open ${file}`, () => new DatabaseSync(file, { timeout: 0 })),
      (opened) =>
        Effect.sync(() => {
          opened.close();
        })
    );

    yield* lock(db, stateDir);
    yield* migrate(db, file);

    const selectMachines = db.prepare(
      "SELECT * FROM machines ORDER BY created_at, name"
    );

    const selectMachine = db.prepare("SELECT * FROM machines WHERE name = ?");

    const insertMachine = db.prepare(insertInto("machines", MachineFields));

    const updateMachine = db.prepare(updateIn("machines", MachineFields));

    const deleteUndone = db.prepare(
      "DELETE FROM machines WHERE name = ? AND undone_at IS NOT NULL"
    );

    const deleteMachine = db.prepare("DELETE FROM machines WHERE name = ?");

    const deleteExpired = db.prepare(
      "DELETE FROM machines WHERE undone_at < ?"
    );

    const selectCheckpoints = db.prepare(
      "SELECT * FROM checkpoints ORDER BY created_at, name"
    );

    const selectCheckpoint = db.prepare(
      "SELECT * FROM checkpoints WHERE name = ?"
    );

    const deleteFailedCheckpoint = db.prepare(
      "DELETE FROM checkpoints WHERE name = ? AND failed_at IS NOT NULL"
    );

    const insertCheckpoint = db.prepare(
      insertInto("checkpoints", CheckpointFields)
    );

    const updateCheckpoint = db.prepare(
      updateIn("checkpoints", CheckpointFields)
    );

    const deleteCheckpoint = db.prepare(
      "DELETE FROM checkpoints WHERE name = ?"
    );

    const deleteExpiredCheckpoints = db.prepare(
      "DELETE FROM checkpoints WHERE failed_at < ?"
    );

    const selectOperations = db.prepare(
      "SELECT * FROM operations ORDER BY sequence"
    );

    const selectOperation = db.prepare(
      "SELECT * FROM operations WHERE resource = ? AND name = ? ORDER BY sequence LIMIT 1"
    );

    const insertOperation = db.prepare(
      insertInto("operations", OperationFields)
    );

    const deleteOperation = db.prepare("DELETE FROM operations WHERE id = ?");

    const raiseSequence = db.prepare(
      "UPDATE sequence SET last = last + 1 RETURNING last"
    );

    const selectBoot = db.prepare("SELECT boot FROM hosts WHERE id = ?");

    const upsertBoot = db.prepare(
      "INSERT INTO hosts (id, boot) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET boot = excluded.boot"
    );

    const inserting = (
      resource: Lease["resource"],
      name: string,
      run: () => void
    ) =>
      Effect.flatMap(
        sql(`insert ${resource} ${name}`, () => {
          try {
            run();

            return Result.void;
          } catch (error) {
            if (isSqliteError(error) && error.errcode === sqlitePrimaryKey) {
              return Result.fail(taken(resource, name));
            }

            throw error;
          }
        }),
        Effect.fromResult
      );

    const holderOf = (wanted: readonly Lease[]): Operation | undefined =>
      selectOperations
        .all()
        .map(operationOf)
        .find(({ leases }) =>
          wanted.some((lease) =>
            leases.some((held) => conflicting(lease, held))
          )
        );

    const begun = (operation: Omit<Operation, "sequence">) => {
      const { last } = Schema.decodeUnknownSync(
        Schema.Struct({ last: Schema.Int })
      )(raiseSequence.get());

      insertOperation.run(operationColumns({ ...operation, sequence: last }));
    };

    const tables: Tables = {
      machine: {
        select: selectMachine,
        update: updateMachine,
        remove: deleteMachine,
        decoded: rowOf,
        columns: machineColumns,
      },
      checkpoint: {
        select: selectCheckpoint,
        update: updateCheckpoint,
        remove: deleteCheckpoint,
        decoded: checkpointOf,
        columns: checkpointColumns,
      },
    };

    const advanced = <R>(
      resource: Lease["resource"],
      table: Table<R>,
      name: string,
      decide: (row: R, op: Operation | undefined) => Decision<R>
    ) =>
      transaction(db, `advance ${resource} ${name}`, (): Advanced<R> => {
        const raw = table.select.get(name);

        if (raw === undefined) {
          return { at: "absent" };
        }

        const row = table.decoded(raw);
        const stored = selectOperation.get(resource, name);
        const op = stored === undefined ? undefined : operationOf(stored);
        const { next, begin, finish } = decide(row, op);

        if (begin !== undefined) {
          const by = holderOf(begin.leases);

          if (by !== undefined) {
            return { at: "busy", by };
          }

          begun(begin);
        }

        if (finish && op !== undefined) {
          deleteOperation.run(op.id);
        }

        if (next === "removed") {
          table.remove.run(name);
        } else if (next !== row) {
          table.update.run(table.columns(next));
        }

        return { at: "written", next, moved: next !== row };
      });

    const store: Interface = {
      machines: sql("list machines", () =>
        selectMachines.all().map(rowOf)
      ).pipe(Effect.withSpan("Store.machines")),
      findMachine: Effect.fn("Store.findMachine")((name) =>
        sql(`read ${name}`, () => {
          const row = selectMachine.get(name);

          return row === undefined ? Option.none() : Option.some(rowOf(row));
        })
      ),
      insertMachine: Effect.fn("Store.insertMachine")((row) =>
        inserting("machine", row.name, () => {
          deleteUndone.run(row.name);
          insertMachine.run(machineColumns(row));
        })
      ),
      advance: (resource, name, decide) =>
        advanced(resource, tables[resource], name, decide).pipe(
          Effect.withSpan("Store.advance")
        ),
      expire: Effect.fn("Store.expire")((before) =>
        sql("expire failed rows", () => {
          const at = DateTime.formatIso(before);

          deleteExpired.run(at);
          deleteExpiredCheckpoints.run(at);
        })
      ),
      checkpoints: sql("list checkpoints", () =>
        selectCheckpoints.all().map(checkpointOf)
      ).pipe(Effect.withSpan("Store.checkpoints")),
      findCheckpoint: Effect.fn("Store.findCheckpoint")((name) =>
        sql(`read checkpoint ${name}`, () => {
          const row = selectCheckpoint.get(name);

          return row === undefined
            ? Option.none()
            : Option.some(checkpointOf(row));
        })
      ),
      insertCheckpoint: Effect.fn("Store.insertCheckpoint")((record) =>
        inserting("checkpoint", record.name, () => {
          deleteFailedCheckpoint.run(record.name);
          insertCheckpoint.run(checkpointColumns(record));
        })
      ),
      operationOn: Effect.fn("Store.operationOn")((resource, name) =>
        sql(`read the operation on ${name}`, () => {
          const row = selectOperation.get(resource, name);

          return row === undefined
            ? Option.none()
            : Option.some(operationOf(row));
        })
      ),
      hostBoot: Effect.fn("Store.hostBoot")((host) =>
        sql(`read host ${host}'s boot`, () => {
          const row = selectBoot.get(host);

          return row === undefined
            ? Option.none()
            : Option.some(decodeBoot(row).boot);
        })
      ),
      recordBoot: Effect.fn("Store.recordBoot")((host, boot) =>
        sql(`record host ${host}'s boot`, () => {
          upsertBoot.run(host, boot);
        })
      ),
    };

    return store;
  });

export const layer = (
  owner: Owner
): Layer.Layer<Store, CannotStart | Internal, FileSystem.FileSystem> =>
  Layer.effect(Store, open(owner));
