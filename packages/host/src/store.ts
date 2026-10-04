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
  type NotFound,
  Precondition,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, DateTime, Effect, FileSystem, Option, Result, Schema, type Scope } from "effect";
import { idOn, type Kind, notFoundOn } from "./ids.ts";

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

/** What every row holds, machine or checkpoint. */
interface Resource {
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

/** The columns every row keeps its last action in. */
const ActionColumns = Schema.Struct({
  action_name: ActionRecord.fields.name,
  action_status: ActionRecord.fields.status,
  action_error_tag: Schema.NullOr(Schema.String),
  action_error_message: Schema.NullOr(Schema.String),
});

/** The columns both tables have. */
const columns = {
  name: Schema.String,
  instance: Schema.String,
  native: Schema.NullOr(Schema.String),
  created_at: Schema.DateTimeUtcFromString,
  base: Schema.String,
  profile: Schema.NullOr(Schema.String),
  cpu: Schema.Int,
  ram_mib: Schema.Int,
  disk_gib: Schema.Int,
  ...ActionColumns.fields,
};

const Columns = Schema.Struct(columns);

const Row = Schema.Struct({
  ...columns,
  port: Schema.NullOr(Schema.Int),
  host_key: Schema.NullOr(Schema.String),
});

const CheckpointRow = Schema.Struct({
  ...columns,
  machine: Schema.String,
  kind: Checkpoint.fields.kind,
  pin: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Int),
});

const decodeRow = Schema.decodeUnknownSync(Row);

const decodeCheckpointRow = Schema.decodeUnknownSync(CheckpointRow);

const decodeActionColumns = Schema.decodeUnknownSync(ActionColumns);

const decodeAction = Schema.decodeUnknownSync(ActionRecord);

const actionOf = (row: typeof ActionColumns.Type): ActionRecord =>
  decodeAction(
    row.action_error_tag === null || row.action_error_message === null
      ? { name: row.action_name, status: row.action_status }
      : {
          name: row.action_name,
          status: row.action_status,
          error: { tag: row.action_error_tag, message: row.action_error_message },
        },
  );

const resourceOf = (row: typeof Columns.Type): Resource => ({
  name: row.name,
  instance: row.instance,
  native: row.native ?? undefined,
  createdAt: row.created_at,
  base: row.base,
  profile: row.profile ?? undefined,
  cpu: row.cpu,
  ramMib: row.ram_mib,
  diskGib: row.disk_gib,
  action: actionOf(row),
});

const fromRow = (row: typeof Row.Type): MachineRecord => ({
  ...resourceOf(row),
  port: row.port ?? undefined,
  hostKey: row.host_key ?? undefined,
});

const fromCheckpointRow = (row: typeof CheckpointRow.Type): CheckpointRecord => ({
  ...resourceOf(row),
  machine: row.machine,
  kind: row.kind,
  pin: row.pin ?? undefined,
  port: row.port ?? undefined,
});

/** The named parameters of the columns both tables have, for a new row held by `action`. */
const columnParameters = (record: Omit<Resource, "action">, action: ActionName) => ({
  name: record.name,
  instance: record.instance,
  native: record.native ?? null,
  created_at: DateTime.formatIso(record.createdAt),
  base: record.base,
  profile: record.profile ?? null,
  cpu: record.cpu,
  ram_mib: record.ramMib,
  disk_gib: record.diskGib,
  action_name: action,
});

/** A new machine row. Its claim's action holds it from the start. */
export type NewMachine = Omit<MachineRecord, "action">;

/** A new checkpoint row. Its claim's action holds it from the start. */
export type NewCheckpoint = Omit<CheckpointRecord, "action">;

export type Table = "machines" | "checkpoints";

/** A row, by its table and name. */
export interface RowRef {
  readonly table: Table;
  readonly name: string;
}

/** A row for a claim to insert. */
export type NewRow =
  | { readonly table: "machines"; readonly record: NewMachine }
  | { readonly table: "checkpoints"; readonly record: NewCheckpoint };

/** What a claim takes: existing rows to hold, then a new row to insert. */
export interface Rows {
  readonly hold?: ReadonlyArray<RowRef> | undefined;
  readonly insert?: NewRow | undefined;
}

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

/**
 * What an action records when it ends: its outcome, on every row it claimed, and the host key
 * it read, on its subject: the machine row it inserted, or else the one it holds.
 */
export interface Outcome {
  readonly action: ActionRecord;
  readonly hostKey?: string | undefined;
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
   * Claims rows for `action` in one transaction: holds each row in `rows.hold`, then inserts
   * `rows.insert`, held by the action from the start. A missing row is NotFound, one another
   * action holds `Conflict{busy}` and a taken new name `Conflict{exists}`, and then nothing is
   * written. The token covers `joining`'s rows too, so an action can claim in steps and still
   * release or end everything at once. Actions pick ports one at a time, so the port's unique
   * index is only a backstop.
   */
  readonly claim: (
    action: ActionName,
    rows: Rows,
    joining?: Token,
  ) => Effect.Effect<Token, NotFound | Conflict | Internal>;
  /** Gives back a claim in one transaction: its inserted rows go, its held rows get `before`. */
  readonly release: (token: Token) => Effect.Effect<void, Internal>;
  /** Ends a claim in one transaction, recording `outcome` on its rows. */
  readonly end: (token: Token, outcome: Outcome) => Effect.Effect<void, Internal>;
  /** Removes a row, as a successful delete does. */
  readonly remove: (row: RowRef) => Effect.Effect<void, Internal>;
  /** At startup: every action still running was cut off by the last host process's end. */
  readonly failInterrupted: Effect.Effect<void, Internal>;
}

export class Store extends Context.Service<Store, Interface>()("@clankerbox/host/Store") {}

/** node:sqlite's errors carry SQLite's result code. */
const isSqliteError = (cause: unknown): cause is Error & { readonly errcode: number } =>
  cause instanceof Error && "errcode" in cause && typeof cause.errcode === "number";

const sqliteBusy = 5;

/** SQLITE_CONSTRAINT_PRIMARYKEY: node:sqlite reports SQLite's extended result codes. */
const sqlitePrimaryKey = 1555;

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
    const notFound = notFoundOn(hostId);

    const kinds = {
      machines: "machine",
      checkpoints: "checkpoint",
    } as const satisfies { readonly [T in Table]: Kind };

    const selectAll = db.prepare("SELECT * FROM machines ORDER BY created_at, name");
    const selectOne = db.prepare("SELECT * FROM machines WHERE name = ?");
    const selectPorts = db.prepare("SELECT port FROM machines WHERE port IS NOT NULL");
    const selectCheckpoints = db.prepare("SELECT * FROM checkpoints ORDER BY created_at, name");
    const selectCheckpoint = db.prepare("SELECT * FROM checkpoints WHERE name = ?");

    const insertMachine = db.prepare(
      `INSERT INTO machines (name, instance, native, created_at, base, profile, cpu, ram_mib,
        disk_gib, port, host_key, action_name, action_status)
       VALUES ($name, $instance, $native, $created_at, $base, $profile, $cpu, $ram_mib,
        $disk_gib, $port, $host_key, $action_name, 'running')`,
    );

    const insertCheckpoint = db.prepare(
      `INSERT INTO checkpoints (name, instance, native, created_at, machine, kind, pin, port, base,
        profile, cpu, ram_mib, disk_gib, action_name, action_status)
       VALUES ($name, $instance, $native, $created_at, $machine, $kind, $pin, $port, $base,
        $profile, $cpu, $ram_mib, $disk_gib, $action_name, 'running')`,
    );

    const updateHostKey = db.prepare("UPDATE machines SET host_key = ? WHERE name = ?");

    /** The statements that read, record and remove a row's action, per table. */
    const statementsOf = (table: Table) => ({
      action: db.prepare(
        `SELECT action_name, action_status, action_error_tag, action_error_message
         FROM ${table} WHERE name = ?`,
      ),
      record: db.prepare(
        `UPDATE ${table} SET action_name = $action_name, action_status = $action_status,
          action_error_tag = $action_error_tag, action_error_message = $action_error_message
         WHERE name = $name`,
      ),
      remove: db.prepare(`DELETE FROM ${table} WHERE name = ?`),
    });

    const statements = {
      machines: statementsOf("machines"),
      checkpoints: statementsOf("checkpoints"),
    };

    const findSync = (name: string) => {
      const row = selectOne.get(name);

      return row === undefined ? undefined : fromRow(decodeRow(row));
    };

    const findCheckpointSync = (name: string) => {
      const row = selectCheckpoint.get(name);

      return row === undefined ? undefined : fromCheckpointRow(decodeCheckpointRow(row));
    };

    const record = (row: RowRef, action: ActionRecord) => {
      statements[row.table].record.run({
        name: row.name,
        action_name: action.name,
        action_status: action.status,
        action_error_tag: action.error?.tag ?? null,
        action_error_message: action.error?.message ?? null,
      });
    };

    /** Holds a row inside a transaction, unless it is missing or another action holds it. */
    const holdSync = (
      action: ActionName,
      row: RowRef,
    ): Result.Result<HeldRow, NotFound | Conflict> => {
      const kind = kinds[row.table];
      const found = statements[row.table].action.get(row.name);

      if (found === undefined) {
        return Result.fail(notFound(kind, row.name));
      }

      const before = actionOf(decodeActionColumns(found));

      if (before.status === "running") {
        return Result.fail(
          new Conflict({
            message: `${kind} ${id(row.name)} is busy: ${before.name} is running`,
            kind: "busy",
          }),
        );
      }

      record(row, { name: action, status: "running" });

      return Result.succeed({ table: row.table, name: row.name, before });
    };

    /**
     * Inserts a row inside a transaction. The primary key refuses a taken name, which is
     * `Conflict{exists}`; the port's unique index is only a backstop, so its refusal is SQLite's.
     */
    const insertSync = (action: ActionName, row: NewRow): Result.Result<RowRef, Conflict> => {
      const columns = columnParameters(row.record, action);

      try {
        if (row.table === "machines") {
          insertMachine.run({
            ...columns,
            port: row.record.port ?? null,
            host_key: row.record.hostKey ?? null,
          });
        } else {
          insertCheckpoint.run({
            ...columns,
            machine: row.record.machine,
            kind: row.record.kind,
            pin: row.record.pin ?? null,
            port: row.record.port ?? null,
          });
        }
      } catch (cause) {
        if (isSqliteError(cause) && cause.errcode === sqlitePrimaryKey) {
          return Result.fail(
            new Conflict({
              message: `${kinds[row.table]} ${id(row.record.name)} exists`,
              kind: "exists",
            }),
          );
        }

        throw cause;
      }

      return Result.succeed({ table: row.table, name: row.record.name });
    };

    /** Holds then inserts, as `claim` describes, inside a transaction. */
    const claimSync = (
      action: ActionName,
      rows: Rows,
      joining: Token | undefined,
    ): Result.Result<Token, NotFound | Conflict> => {
      const held = [...(joining?.held ?? [])];
      const inserted = [...(joining?.inserted ?? [])];

      for (const row of rows.hold ?? []) {
        const result = holdSync(action, row);

        if (Result.isFailure(result)) {
          return Result.fail(result.failure);
        }

        held.push(result.success);
      }

      if (rows.insert !== undefined) {
        const result = insertSync(action, rows.insert);

        if (Result.isFailure(result)) {
          return Result.fail(result.failure);
        }

        inserted.push(result.success);
      }

      return Result.succeed({ action, inserted, held });
    };

    /** The rows a claim takes, for errors; a claim that takes none joins rows later. */
    const claimed = (rows: Rows) =>
      [...(rows.hold ?? []), ...(rows.insert === undefined ? [] : [rows.insert.record])]
        .map((row) => id(row.name))
        .join(", ") || "no rows yet";

    /** The rows a token names, for errors. */
    const named = (token: Token) =>
      [...token.inserted, ...token.held].map((row) => id(row.name)).join(", ");

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
      checkpoints: sql("list checkpoints", () =>
        selectCheckpoints.all().map((row) => fromCheckpointRow(decodeCheckpointRow(row))),
      ),
      findCheckpoint: (name) =>
        sql(`read checkpoint ${id(name)}`, () => Option.fromNullishOr(findCheckpointSync(name))),
      claim: (action, rows, joining) =>
        transaction(db, `claim ${claimed(rows)} for ${action}`, () =>
          claimSync(action, rows, joining),
        ),
      release: (token) =>
        transaction(db, `release ${named(token)} from ${token.action}`, () => {
          for (const row of token.inserted) {
            statements[row.table].remove.run(row.name);
          }

          for (const row of token.held) {
            record(row, row.before);
          }

          return Result.void;
        }),
      end: (token, { action, hostKey }) =>
        transaction(db, `record ${action.name} on ${named(token)}`, () => {
          for (const row of [...token.inserted, ...token.held]) {
            record(row, action);
          }

          const subject = token.inserted[0] ?? token.held[0];

          if (hostKey !== undefined && subject?.table === "machines") {
            updateHostKey.run(hostKey, subject.name);
          }

          return Result.void;
        }),
      remove: (row) =>
        sql(`remove ${kinds[row.table]} ${id(row.name)}`, () => {
          statements[row.table].remove.run(row.name);
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
