/**
 * The host's state: one SQLite database in its state dir, through `node:sqlite`. It holds one
 * row per machine with its spec, `instance`, `native`, `createdAt`, host `port`, `hostKey` and
 * last `action`, and one row per checkpoint, and nothing else: machine state is always read from
 * the runtime, and no setup script is kept.
 */
import { DatabaseSync } from "node:sqlite";
import {
  type ActionName,
  ActionRecord,
  Checkpoint,
  Conflict,
  Internal,
  NotFound,
  Precondition,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, DateTime, Effect, FileSystem, Option, Result, Schema, type Scope } from "effect";
import { idOn } from "./actions.ts";

/** The database's file in the state dir. */
export const databaseFile = "host.db";

/** `PRAGMA application_id`, "cbxh": tells our database from any other SQLite file. */
export const applicationId = 0x63_62_78_68;

/**
 * The schema, one entry per version: entry `i` takes `user_version` from `i` to `i + 1`.
 * Append only; a released entry never changes.
 */
export const migrations: ReadonlyArray<string> = [
  `CREATE TABLE machines (
    name TEXT PRIMARY KEY,
    instance TEXT NOT NULL,
    native TEXT,
    created_at TEXT NOT NULL,
    base TEXT NOT NULL,
    profile TEXT,
    cpu INTEGER NOT NULL,
    ram_mib INTEGER NOT NULL,
    disk_gib INTEGER NOT NULL,
    port INTEGER UNIQUE,
    host_key TEXT,
    action_name TEXT NOT NULL,
    action_status TEXT NOT NULL,
    action_error_tag TEXT,
    action_error_message TEXT
  ) STRICT`,
  `CREATE TABLE checkpoints (
    name TEXT PRIMARY KEY,
    instance TEXT NOT NULL,
    native TEXT,
    created_at TEXT NOT NULL,
    machine TEXT NOT NULL,
    kind TEXT NOT NULL,
    pin TEXT,
    port INTEGER,
    base TEXT NOT NULL,
    profile TEXT,
    cpu INTEGER NOT NULL,
    ram_mib INTEGER NOT NULL,
    disk_gib INTEGER NOT NULL,
    action_name TEXT NOT NULL,
    action_status TEXT NOT NULL,
    action_error_tag TEXT,
    action_error_message TEXT
  ) STRICT`,
];

/** A machine row. */
export interface MachineRecord {
  readonly name: string;
  readonly instance: string;
  readonly native: string | undefined;
  readonly createdAt: DateTime.Utc;
  readonly base: string;
  readonly profile: string | undefined;
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
  readonly port: number | undefined;
  /** The guest's SSH host public key, as the last preparation printed it. */
  readonly hostKey: string | undefined;
  readonly action: ActionRecord;
}

const Row = Schema.Struct({
  name: Schema.String,
  instance: Schema.String,
  native: Schema.NullOr(Schema.String),
  created_at: Schema.DateTimeUtcFromString,
  base: Schema.String,
  profile: Schema.NullOr(Schema.String),
  cpu: Schema.Int,
  ram_mib: Schema.Int,
  disk_gib: Schema.Int,
  port: Schema.NullOr(Schema.Int),
  host_key: Schema.NullOr(Schema.String),
  action_name: ActionRecord.fields.name,
  action_status: ActionRecord.fields.status,
  action_error_tag: Schema.NullOr(Schema.String),
  action_error_message: Schema.NullOr(Schema.String),
});

const decodeRow = Schema.decodeUnknownSync(Row);

const decodeAction = Schema.decodeUnknownSync(ActionRecord);

/** The columns every row keeps its last action in. */
interface ActionColumns {
  readonly action_name: ActionName;
  readonly action_status: ActionRecord["status"];
  readonly action_error_tag: string | null;
  readonly action_error_message: string | null;
}

const actionOf = (row: ActionColumns): ActionRecord =>
  decodeAction(
    row.action_error_tag === null || row.action_error_message === null
      ? { name: row.action_name, status: row.action_status }
      : {
          name: row.action_name,
          status: row.action_status,
          error: { tag: row.action_error_tag, message: row.action_error_message },
        },
  );

const fromRow = (row: typeof Row.Type): MachineRecord => ({
  name: row.name,
  instance: row.instance,
  native: row.native ?? undefined,
  createdAt: row.created_at,
  base: row.base,
  profile: row.profile ?? undefined,
  cpu: row.cpu,
  ramMib: row.ram_mib,
  diskGib: row.disk_gib,
  port: row.port ?? undefined,
  hostKey: row.host_key ?? undefined,
  action: actionOf(row),
});

/** A checkpoint row. Ready checkpoints never change, so restores read them without a claim. */
export interface CheckpointRecord {
  readonly name: string;
  readonly instance: string;
  readonly native: string | undefined;
  readonly createdAt: DateTime.Utc;
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
  readonly base: string;
  readonly profile: string | undefined;
  readonly cpu: number;
  readonly ramMib: number;
  readonly diskGib: number;
  readonly action: ActionRecord;
}

const CheckpointRow = Schema.Struct({
  name: Schema.String,
  instance: Schema.String,
  native: Schema.NullOr(Schema.String),
  created_at: Schema.DateTimeUtcFromString,
  machine: Schema.String,
  kind: Checkpoint.fields.kind,
  pin: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Int),
  base: Schema.String,
  profile: Schema.NullOr(Schema.String),
  cpu: Schema.Int,
  ram_mib: Schema.Int,
  disk_gib: Schema.Int,
  action_name: ActionRecord.fields.name,
  action_status: ActionRecord.fields.status,
  action_error_tag: Schema.NullOr(Schema.String),
  action_error_message: Schema.NullOr(Schema.String),
});

const decodeCheckpointRow = Schema.decodeUnknownSync(CheckpointRow);

const fromCheckpointRow = (row: typeof CheckpointRow.Type): CheckpointRecord => ({
  name: row.name,
  instance: row.instance,
  native: row.native ?? undefined,
  createdAt: row.created_at,
  machine: row.machine,
  kind: row.kind,
  pin: row.pin ?? undefined,
  port: row.port ?? undefined,
  base: row.base,
  profile: row.profile ?? undefined,
  cpu: row.cpu,
  ramMib: row.ram_mib,
  diskGib: row.disk_gib,
  action: actionOf(row),
});

/** A new row: its fields, and the action that holds it from the start. */
export interface NewMachine extends Omit<MachineRecord, "action"> {
  readonly action: ActionName;
}

/** A new checkpoint row, held by its capture from the start. */
export type NewCheckpoint = Omit<CheckpointRecord, "action">;

/** What an action records on its row when it ends: its outcome, and the host key it read. */
export interface Outcome {
  readonly action: ActionRecord;
  readonly hostKey?: string | undefined;
}

export interface Interface {
  readonly list: Effect.Effect<ReadonlyArray<MachineRecord>, Internal>;
  readonly find: (name: string) => Effect.Effect<Option.Option<MachineRecord>, Internal>;
  /** The ports every machine row holds. */
  readonly ports: Effect.Effect<ReadonlySet<number>, Internal>;
  /**
   * Inserts a new row, held by its running action. A taken name is `Conflict{exists}`. Actions
   * pick ports one at a time, so the port's unique index is only a backstop.
   */
  readonly insert: (record: NewMachine) => Effect.Effect<void, Conflict | Internal>;
  /**
   * Inserts a new row made from the machine named `source`, such as a fork, and claims `source`
   * for the same action, in one transaction. It returns the source as it was.
   */
  readonly insertFrom: (
    record: NewMachine,
    source: string,
  ) => Effect.Effect<MachineRecord, NotFound | Conflict | Internal>;
  /**
   * Claims an existing row for `action`, and returns the row as it was, so the claim can be
   * released by putting its action back. A row another action holds is `Conflict{busy}`.
   */
  readonly claim: (
    name: string,
    action: ActionName,
  ) => Effect.Effect<MachineRecord, NotFound | Conflict | Internal>;
  /** Records an action's outcome on its row, or puts back the action a released claim replaced. */
  readonly record: (name: string, outcome: Outcome) => Effect.Effect<void, Internal>;
  readonly remove: (name: string) => Effect.Effect<void, Internal>;
  readonly checkpoints: Effect.Effect<ReadonlyArray<CheckpointRecord>, Internal>;
  readonly findCheckpoint: (
    name: string,
  ) => Effect.Effect<Option.Option<CheckpointRecord>, Internal>;
  /**
   * Inserts a new checkpoint row, held by its capture, and claims its source machine for the
   * capture, in one transaction. It returns the source as it was.
   */
  readonly insertCheckpoint: (
    record: NewCheckpoint,
  ) => Effect.Effect<MachineRecord, NotFound | Conflict | Internal>;
  /**
   * Claims a checkpoint row for its delete, as `claim` does a machine's: delete is the only
   * action that changes a ready checkpoint.
   */
  readonly claimCheckpoint: (
    name: string,
  ) => Effect.Effect<CheckpointRecord, NotFound | Conflict | Internal>;
  readonly recordCheckpoint: (name: string, action: ActionRecord) => Effect.Effect<void, Internal>;
  readonly removeCheckpoint: (name: string) => Effect.Effect<void, Internal>;
  /** At startup: every action still running was cut off by the last host process's end. */
  readonly failInterrupted: Effect.Effect<void, Internal>;
}

export class Store extends Context.Service<Store, Interface>()("@clankerbox/host/Store") {}

/** node:sqlite's errors carry SQLite's result code. */
const isSqliteError = (cause: unknown): cause is Error & { readonly errcode: number } =>
  cause instanceof Error && "errcode" in cause && typeof cause.errcode === "number";

const sqliteBusy = 5;

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Runs SQL; SQLite's own failures, such as a full disk, are the host's. */
const sql = <A>(what: string, run: () => A): Effect.Effect<A, Internal> =>
  Effect.try({
    try: run,
    catch: (cause) => new Internal({ message: `state database: ${what}: ${describe(cause)}` }),
  });

/**
 * Runs `body` in one transaction. Its success commits; its typed failure, or a throw, rolls
 * back. The failure comes out as the effect's own, and SQLite's as `Internal`.
 */
const transaction = <A, E>(
  db: DatabaseSync,
  what: string,
  body: () => Result.Result<A, E>,
): Effect.Effect<A, E | Internal> =>
  Effect.flatMap(
    sql(what, () => {
      db.exec("BEGIN IMMEDIATE");

      try {
        const result = body();

        db.exec(Result.isSuccess(result) ? "COMMIT" : "ROLLBACK");

        return result;
      } catch (cause) {
        db.exec("ROLLBACK");

        throw cause;
      }
    }),
    Effect.fromResult,
  );

const pragma = (db: DatabaseSync, name: string): number => {
  const row = db.prepare(`PRAGMA ${name}`).get();

  return Schema.decodeUnknownSync(Schema.Struct({ [name]: Schema.Int }))(row)[name] ?? 0;
};

/**
 * Takes the owner lock for the connection's life. With `locking_mode = EXCLUSIVE`, SQLite keeps
 * its exclusive file lock after the first write transaction, so another host process on the
 * same state dir can't even read the database. The OS drops the lock when the process ends,
 * so a crash leaves no stale lock to clean up.
 */
const lock = (db: DatabaseSync, stateDir: string): Effect.Effect<void, Precondition | Internal> =>
  Effect.try({
    try: () => {
      db.exec("PRAGMA locking_mode = EXCLUSIVE");
      db.exec("BEGIN EXCLUSIVE");
      db.exec("COMMIT");
    },
    catch: (cause) =>
      isSqliteError(cause) && cause.errcode === sqliteBusy
        ? new Precondition({ message: `another host process holds state dir ${stateDir}` })
        : new Internal({ message: `couldn't lock state dir ${stateDir}: ${describe(cause)}` }),
  });

/**
 * Brings the schema to the binary's version in one transaction. A fresh database, including
 * one left empty by a crash during init, is initialized; a newer or foreign one is refused.
 */
const migrate = (db: DatabaseSync, file: string): Effect.Effect<void, Precondition | Internal> =>
  Effect.gen(function* () {
    const { id, version, tables } = yield* sql("read its header", () => ({
      id: pragma(db, "application_id"),
      version: pragma(db, "user_version"),
      tables: Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Int }))(
        db.prepare("SELECT count(*) AS count FROM sqlite_schema").get(),
      ).count,
    }));

    if (id !== applicationId && (id !== 0 || version !== 0 || tables !== 0)) {
      return yield* new Precondition({ message: `${file} isn't a clankerbox host database` });
    }

    if (version > migrations.length) {
      return yield* new Precondition({
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

      return Result.void;
    });
  });

/**
 * Opens the state dir's database for the scope: creates the directory if needed, takes the
 * owner lock and migrates. Other files in the directory, such as a mount point's `lost+found`,
 * are left alone: `application_id` refuses a foreign database, and the lock a second host.
 */
export const open = (
  stateDir: string,
  hostId: string,
): Effect.Effect<Interface, Precondition | Internal, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${stateDir}/${databaseFile}`;

    yield* fs
      .makeDirectory(stateDir, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError(
          (error) =>
            new Internal({ message: `couldn't create state dir ${stateDir}: ${error.message}` }),
        ),
      );

    const db = yield* Effect.acquireRelease(
      sql(`open ${file}`, () => new DatabaseSync(file, { timeout: 0 })),
      (opened) => Effect.sync(() => opened.close()),
    );

    yield* lock(db, stateDir);
    yield* migrate(db, file);

    const id = idOn(hostId);

    const selectAll = db.prepare("SELECT * FROM machines ORDER BY created_at, name");
    const selectOne = db.prepare("SELECT * FROM machines WHERE name = ?");
    const selectPorts = db.prepare("SELECT port FROM machines WHERE port IS NOT NULL");

    const insertRow = db.prepare(
      `INSERT INTO machines (name, instance, native, created_at, base, profile, cpu, ram_mib,
        disk_gib, port, host_key, action_name, action_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')`,
    );

    const updateAction = db.prepare(
      `UPDATE machines SET action_name = ?, action_status = ?, action_error_tag = ?,
        action_error_message = ?, host_key = coalesce(?, host_key) WHERE name = ?`,
    );

    const deleteRow = db.prepare("DELETE FROM machines WHERE name = ?");

    const selectCheckpoints = db.prepare("SELECT * FROM checkpoints ORDER BY created_at, name");
    const selectCheckpoint = db.prepare("SELECT * FROM checkpoints WHERE name = ?");

    const insertCheckpointRow = db.prepare(
      `INSERT INTO checkpoints (name, instance, native, created_at, machine, kind, pin, port, base,
        profile, cpu, ram_mib, disk_gib, action_name, action_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'capture', 'running')`,
    );

    const updateCheckpointAction = db.prepare(
      `UPDATE checkpoints SET action_name = ?, action_status = ?, action_error_tag = ?,
        action_error_message = ? WHERE name = ?`,
    );

    const deleteCheckpointRow = db.prepare("DELETE FROM checkpoints WHERE name = ?");

    const findSync = (name: string) => {
      const row = selectOne.get(name);

      return row === undefined ? undefined : fromRow(decodeRow(row));
    };

    const findCheckpointSync = (name: string) => {
      const row = selectCheckpoint.get(name);

      return row === undefined ? undefined : fromCheckpointRow(decodeCheckpointRow(row));
    };

    const writeAction = (name: string, { action, hostKey }: Outcome) =>
      updateAction.run(
        action.name,
        action.status,
        action.error?.tag ?? null,
        action.error?.message ?? null,
        hostKey ?? null,
        name,
      );

    const writeCheckpointAction = (name: string, action: ActionRecord) =>
      updateCheckpointAction.run(
        action.name,
        action.status,
        action.error?.tag ?? null,
        action.error?.message ?? null,
        name,
      );

    /**
     * The claim of a row, inside a transaction: a missing row is NotFound and one another action
     * holds is busy; otherwise `hold` marks it, and the row comes back as it was.
     */
    const claimRow = <R extends { readonly action: ActionRecord }>(
      kind: "machine" | "checkpoint",
      name: string,
      found: R | undefined,
      hold: () => void,
    ): Result.Result<R, NotFound | Conflict> => {
      if (found === undefined) {
        return Result.fail(new NotFound({ message: `no ${kind} ${id(name)}` }));
      }

      if (found.action.status === "running") {
        return Result.fail(
          new Conflict({
            message: `${kind} ${id(name)} is busy: ${found.action.name} is running`,
            kind: "busy",
          }),
        );
      }

      hold();

      return Result.succeed(found);
    };

    /** The claim of a machine row, inside a transaction. */
    const claimSync = (name: string, action: ActionName) =>
      claimRow("machine", name, findSync(name), () => {
        writeAction(name, { action: { name: action, status: "running" } });
      });

    /** The insert of a machine row, inside a transaction. */
    const insertSync = (record: NewMachine): Result.Result<void, Conflict> => {
      if (findSync(record.name) !== undefined) {
        return Result.fail(
          new Conflict({ message: `machine ${id(record.name)} exists`, kind: "exists" }),
        );
      }

      insertRow.run(
        record.name,
        record.instance,
        record.native ?? null,
        DateTime.formatIso(record.createdAt),
        record.base,
        record.profile ?? null,
        record.cpu,
        record.ramMib,
        record.diskGib,
        record.port ?? null,
        record.hostKey ?? null,
        record.action,
      );

      return Result.void;
    };

    const insertCheckpointSync = (record: NewCheckpoint): Result.Result<void, Conflict> => {
      if (findCheckpointSync(record.name) !== undefined) {
        return Result.fail(
          new Conflict({ message: `checkpoint ${id(record.name)} exists`, kind: "exists" }),
        );
      }

      insertCheckpointRow.run(
        record.name,
        record.instance,
        record.native ?? null,
        DateTime.formatIso(record.createdAt),
        record.machine,
        record.kind,
        record.pin ?? null,
        record.port ?? null,
        record.base,
        record.profile ?? null,
        record.cpu,
        record.ramMib,
        record.diskGib,
      );

      return Result.void;
    };

    const store: Interface = {
      list: sql("list machines", () => selectAll.all().map((row) => fromRow(decodeRow(row)))),
      find: (name) => sql(`read ${id(name)}`, () => Option.fromNullishOr(findSync(name))),
      ports: sql(
        "read ports",
        () =>
          new Set(
            Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ port: Schema.Int })))(
              selectPorts.all(),
            ).map(({ port }) => port),
          ),
      ),
      insert: (record) => transaction(db, `insert ${id(record.name)}`, () => insertSync(record)),
      insertFrom: (record, source) =>
        transaction(db, `insert ${id(record.name)} from ${id(source)}`, () =>
          Result.flatMap(claimSync(source, record.action), (before) =>
            Result.map(insertSync(record), () => before),
          ),
        ),
      claim: (name, action) => transaction(db, `claim ${id(name)}`, () => claimSync(name, action)),
      record: (name, outcome) =>
        sql(`record ${outcome.action.name} on ${id(name)}`, () => {
          writeAction(name, outcome);
        }),
      remove: (name) =>
        sql(`remove ${id(name)}`, () => {
          deleteRow.run(name);
        }),
      checkpoints: sql("list checkpoints", () =>
        selectCheckpoints.all().map((row) => fromCheckpointRow(decodeCheckpointRow(row))),
      ),
      findCheckpoint: (name) =>
        sql(`read checkpoint ${id(name)}`, () => Option.fromNullishOr(findCheckpointSync(name))),
      insertCheckpoint: (record) =>
        transaction(db, `insert checkpoint ${id(record.name)}`, () =>
          Result.flatMap(claimSync(record.machine, "capture"), (before) =>
            Result.map(insertCheckpointSync(record), () => before),
          ),
        ),
      claimCheckpoint: (name) =>
        transaction(db, `claim checkpoint ${id(name)}`, () =>
          claimRow("checkpoint", name, findCheckpointSync(name), () => {
            writeCheckpointAction(name, { name: "delete", status: "running" });
          }),
        ),
      recordCheckpoint: (name, action) =>
        sql(`record ${action.name} on checkpoint ${id(name)}`, () => {
          writeCheckpointAction(name, action);
        }),
      removeCheckpoint: (name) =>
        sql(`remove checkpoint ${id(name)}`, () => {
          deleteCheckpointRow.run(name);
        }),
      failInterrupted: sql("fail interrupted actions", () => {
        for (const table of ["machines", "checkpoints"]) {
          db.exec(
            `UPDATE ${table} SET action_status = 'failed', action_error_tag = 'Internal',
              action_error_message = 'host restarted during ' || action_name
             WHERE action_status = 'running'`,
          );
        }
      }),
    };

    return store;
  });
