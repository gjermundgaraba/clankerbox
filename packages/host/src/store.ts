/**
 * The host's state: one SQLite database in its state dir, through `node:sqlite`. It holds one
 * row per machine with its spec, `instance`, `native`, `createdAt`, host `port`, `hostKey`,
 * whether it was made, and its last `action`, and one row per checkpoint, and nothing else: machine state is always read from
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
    made INTEGER NOT NULL,
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
  made: Schema.Literals([0, 1]),
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
  made: row.made === 1,
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

/** Reads a row of each table by name, inside a transaction. */
type Finders = { readonly [T in Table]: (name: string) => Records[T] | undefined };

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
 * back. The failure comes out as the effect's own, and SQLite's as `Internal`. Some of SQLite's
 * errors, such as a full disk, roll the transaction back themselves, so a throw rolls back only
 * a transaction still open, and the error is SQLite's.
 */
export const transaction = <A, E>(
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
        if (db.isTransaction) {
          db.exec("ROLLBACK");
        }

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
        disk_gib, port, host_key, made, action_name, action_status)
       VALUES ($name, $instance, $native, $created_at, $base, $profile, $cpu, $ram_mib,
        $disk_gib, $port, $host_key, 0, $action_name, 'running')`,
    );

    const insertCheckpoint = db.prepare(
      `INSERT INTO checkpoints (name, instance, native, created_at, machine, kind, pin, port, base,
        profile, cpu, ram_mib, disk_gib, action_name, action_status)
       VALUES ($name, $instance, $native, $created_at, $machine, $kind, $pin, $port, $base,
        $profile, $cpu, $ram_mib, $disk_gib, $action_name, 'running')`,
    );

    const updateHostKey = db.prepare("UPDATE machines SET host_key = ? WHERE name = ?");

    const updateMade = db.prepare("UPDATE machines SET made = 1 WHERE name = ?");

    const updateNative = db.prepare(
      "UPDATE machines SET native = $native WHERE name = $name AND instance = $instance",
    );

    /** The statements that record a row's action and remove the row, per table. */
    const statementsOf = (table: Table) => ({
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

    const finders: Finders = {
      machines: findSync,
      checkpoints: findCheckpointSync,
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

    /**
     * Holds a row inside a transaction, unless it is missing or another action holds it, and
     * returns its record as the hold leaves it.
     */
    const holdSync = <T extends Table>(
      action: ActionName,
      row: RowRef<T>,
    ): Result.Result<
      { readonly row: HeldRow; readonly record: Records[T] },
      NotFound | Conflict
    > => {
      const kind = kinds[row.table];
      const found = finders[row.table](row.name);

      if (found === undefined) {
        return Result.fail(notFound(kind, row.name));
      }

      const before = found.action;

      if (before.status === "running") {
        return Result.fail(
          new Conflict({
            message: `${kind} ${id(row.name)} is busy: ${before.name} is running`,
            kind: "busy",
          }),
        );
      }

      const running: ActionRecord = { name: action, status: "running" };

      record(row, running);

      return Result.succeed({
        row: { table: row.table, name: row.name, before },
        record: { ...found, action: running },
      });
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
      hold: (action, row, joining) =>
        transaction(db, `claim ${id(row.name)} for ${action}`, () =>
          Result.map(holdSync(action, row), ({ row: held, record }) => ({
            token: {
              action,
              inserted: joining?.inserted ?? [],
              held: [...(joining?.held ?? []), held],
            },
            held: record,
          })),
        ),
      insert: (action, row, joining) =>
        transaction(db, `claim ${id(row.record.name)} for ${action}`, () =>
          Result.map(insertSync(action, row), (inserted) => ({
            action,
            inserted: [...(joining?.inserted ?? []), inserted],
            held: joining?.held ?? [],
          })),
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
      markMade: (token) =>
        transaction(db, `mark ${token.inserted.map((row) => id(row.name)).join(", ")} made`, () => {
          for (const row of token.inserted) {
            if (row.table === "machines") {
              updateMade.run(row.name);
            }
          }

          return Result.void;
        }),
      end: (token, { action, prepared }) =>
        transaction(db, `record ${action.name} on ${named(token)}`, () => {
          for (const row of [...token.inserted, ...token.held]) {
            record(row, action);
          }

          if (prepared?.hostKey !== undefined) {
            updateHostKey.run(prepared.hostKey, prepared.name);
          }

          return Result.void;
        }),
      recordNative: (name, instance, native) =>
        Effect.flatMap(
          sql(`record ${id(name)}'s native ID`, () =>
            Number(updateNative.run({ name, instance, native }).changes),
          ),
          (changes) =>
            changes === 1
              ? Effect.void
              : Effect.fail(
                  new Internal({
                    message: `state database: machine ${id(name)} of instance ${instance} is gone, so its native ID ${native} wasn't recorded`,
                  }),
                ),
        ),
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
