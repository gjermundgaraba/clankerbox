/**
 * The host's state: one SQLite database in its state dir, through `node:sqlite`. It holds one
 * row per machine with its spec, `instance`, `native`, `createdAt`, host `port`, `hostKey` and
 * last `action`, and nothing else: machine state is always read from the runtime, and no setup
 * script is kept.
 */
import { DatabaseSync } from "node:sqlite";
import {
  type ActionName,
  ActionRecord,
  Conflict,
  Internal,
  NotFound,
  Precondition,
} from "@gjermundgaraba/clankerbox-sdk";
import { Context, Data, DateTime, Effect, FileSystem, Option, Schema, type Scope } from "effect";

/** A directory is ours if it holds this database; there is no other marker. */
export const databaseFile = "host.db";

/** SQLite's own files beside the database. */
const journalFile = `${databaseFile}-journal`;

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
  action: decodeAction(
    row.action_error_tag === null || row.action_error_message === null
      ? { name: row.action_name, status: row.action_status }
      : {
          name: row.action_name,
          status: row.action_status,
          error: { tag: row.action_error_tag, message: row.action_error_message },
        },
  ),
});

/** A new row: its fields, and the action that holds it from the start. */
export interface NewMachine extends Omit<MachineRecord, "action"> {
  readonly action: ActionName;
}

/** Another row already holds the port a new row asked for. */
export class PortTaken extends Data.TaggedError("PortTaken")<{ readonly port: number }> {}

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
   * Inserts a new row, held by its running action. A taken name is `Conflict{exists}`; a port
   * another row holds is `PortTaken`, and the caller picks again.
   */
  readonly insert: (record: NewMachine) => Effect.Effect<void, Conflict | PortTaken | Internal>;
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
  /** At startup: every action still running was cut off by the last host process's end. */
  readonly failInterrupted: Effect.Effect<void, Internal>;
}

export class Store extends Context.Service<Store, Interface>()("@clankerbox/host/Store") {}

/** node:sqlite's errors carry SQLite's result code. */
const isSqliteError = (cause: unknown): cause is Error & { readonly errcode: number } =>
  cause instanceof Error && "errcode" in cause && typeof cause.errcode === "number";

const sqliteBusy = 5;

const sqliteConstraintUnique = 2067;

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Runs SQL; SQLite's own failures, such as a full disk, are the host's. */
const sql = <A>(what: string, run: () => A): Effect.Effect<A, Internal> =>
  Effect.try({
    try: run,
    catch: (cause) => new Internal({ message: `state database: ${what}: ${describe(cause)}` }),
  });

/** Runs `body` in one transaction, rolled back if it throws. */
const transaction = <A>(db: DatabaseSync, body: () => A): A => {
  db.exec("BEGIN IMMEDIATE");

  try {
    const result = body();

    db.exec("COMMIT");

    return result;
  } catch (cause) {
    db.exec("ROLLBACK");

    throw cause;
  }
};

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

    yield* sql("migrate", () =>
      transaction(db, () => {
        for (const migration of migrations.slice(version)) {
          db.exec(migration);
        }

        db.exec(`PRAGMA user_version = ${migrations.length}`);
        db.exec(`PRAGMA application_id = ${applicationId}`);
      }),
    );
  });

/**
 * Opens the state dir's database for the scope: creates the directory if needed, refuses a
 * non-empty one without our database, takes the owner lock and migrates.
 */
export const open = (
  stateDir: string,
  hostId: string,
): Effect.Effect<Interface, Precondition | Internal, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${stateDir}/${databaseFile}`;

    const failed = (what: string) => (error: { readonly message: string }) =>
      new Internal({ message: `couldn't ${what} state dir ${stateDir}: ${error.message}` });

    yield* fs
      .makeDirectory(stateDir, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(failed("create")));

    const entries = yield* fs.readDirectory(stateDir).pipe(Effect.mapError(failed("read")));

    if (!entries.includes(databaseFile) && entries.some((entry) => entry !== journalFile)) {
      return yield* new Precondition({
        message: `state dir ${stateDir} isn't empty and holds no ${databaseFile}: give the host an empty or its own directory`,
      });
    }

    const db = yield* Effect.acquireRelease(
      sql(`open ${file}`, () => new DatabaseSync(file, { timeout: 0 })),
      (opened) => Effect.sync(() => opened.close()),
    );

    yield* lock(db, stateDir);
    yield* migrate(db, file);

    const id = (name: string) => `${hostId}_${name}`;

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

    const findSync = (name: string) => {
      const row = selectOne.get(name);

      return row === undefined ? undefined : fromRow(decodeRow(row));
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
      insert: (record) =>
        Effect.try({
          try: () =>
            transaction(db, () => {
              if (findSync(record.name) !== undefined) {
                return new Conflict({
                  message: `machine ${id(record.name)} exists`,
                  kind: "exists",
                });
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

              return undefined;
            }),
          catch: (cause) =>
            isSqliteError(cause) &&
            cause.errcode === sqliteConstraintUnique &&
            cause.message.includes("machines.port") &&
            record.port !== undefined
              ? new PortTaken({ port: record.port })
              : new Internal({
                  message: `state database: insert ${id(record.name)}: ${describe(cause)}`,
                }),
        }).pipe(
          Effect.flatMap((conflict) =>
            conflict === undefined ? Effect.void : Effect.fail(conflict),
          ),
        ),
      claim: (name, action) =>
        sql(`claim ${id(name)}`, () =>
          transaction(db, () => {
            const found = findSync(name);

            if (found === undefined) {
              return new NotFound({ message: `no machine ${id(name)}` });
            }

            if (found.action.status === "running") {
              return new Conflict({
                message: `machine ${id(name)} is busy: ${found.action.name} is running`,
                kind: "busy",
              });
            }

            writeAction(name, { action: { name: action, status: "running" } });

            return found;
          }),
        ).pipe(
          Effect.flatMap((claimed) =>
            claimed instanceof NotFound || claimed instanceof Conflict
              ? Effect.fail(claimed)
              : Effect.succeed(claimed),
          ),
        ),
      record: (name, outcome) =>
        sql(`record ${outcome.action.name} on ${id(name)}`, () => {
          writeAction(name, outcome);
        }),
      remove: (name) =>
        sql(`remove ${id(name)}`, () => {
          deleteRow.run(name);
        }),
      failInterrupted: sql("fail interrupted actions", () => {
        db.exec(
          `UPDATE machines SET action_status = 'failed', action_error_tag = 'Internal',
            action_error_message = 'host restarted during ' || action_name
           WHERE action_status = 'running'`,
        );
      }),
    };

    return store;
  });
