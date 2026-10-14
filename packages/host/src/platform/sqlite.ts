// No setup script is kept: setup can carry secrets.
import { DatabaseSync } from "node:sqlite";
import {
  ActionName,
  ActionRecord,
  ActionStatus,
  Checkpoint,
  Conflict,
  HostError,
  Internal,
  type NotFound,
  Runtime,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Result,
  Schema,
  type Scope,
} from "effect";
import { idOn, type Kind, notFoundOn } from "../ids.ts";
import type { HostSettings } from "../settings.ts";
import { CannotStart } from "../startup.ts";
import {
  type CheckpointRecord,
  type Interface,
  type MachineRecord,
  NativeIds,
  type NativeIdRecorder,
  type NewRow,
  type Records,
  type Resource,
  type RowRef,
  Store,
  stoppedDuring,
  type Token,
} from "../store.ts";

export const databaseFile = "host.db";

/** `PRAGMA application_id`, "cbxh": tells our database from any other SQLite file. */
export const applicationId = 0x63_62_78_68;

/**
 * Entry `i` takes `user_version` from `i` to `i + 1`. Append only; a released entry never
 * changes, and one added since the last release may be folded into another before it ships.
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
  `CREATE TABLE host (
    one INTEGER PRIMARY KEY CHECK (one = 1),
    id TEXT NOT NULL,
    runtime TEXT NOT NULL
  ) STRICT`,
  "ALTER TABLE checkpoints DROP COLUMN native",
  `UPDATE machines SET action_name = CASE action_name
    WHEN 'create' THEN 'createMachine'
    WHEN 'start' THEN 'startMachine'
    WHEN 'stop' THEN 'stopMachine'
    WHEN 'delete' THEN 'deleteMachine'
    WHEN 'fork' THEN 'forkMachine'
    WHEN 'restore' THEN 'restoreMachine'
    WHEN 'capture' THEN 'captureCheckpoint'
  END;
  UPDATE checkpoints SET action_name = CASE action_name
    WHEN 'capture' THEN 'captureCheckpoint'
    WHEN 'delete' THEN 'deleteCheckpoint'
  END`,
  ["machines", "checkpoints"]
    .map(
      (table) => `ALTER TABLE ${table} ADD COLUMN action_error TEXT;
    UPDATE ${table} SET action_error = CASE action_error_tag
      WHEN 'Conflict' THEN json_object('_tag', 'Conflict', 'message', action_error_message,
        'kind', CASE WHEN action_error_message LIKE '% is busy: %' THEN 'busy' ELSE 'exists' END)
      WHEN 'Precondition' THEN CASE
        WHEN action_error_message GLOB 'setup exited *'
          OR action_error_message GLOB 'setup ran past *'
          THEN json_object('_tag', 'ScriptFailed', 'message', action_error_message, 'script', 'setup')
        WHEN action_error_message GLOB 'preparation exited *'
          OR action_error_message GLOB 'preparation ran past *'
          THEN json_object('_tag', 'ScriptFailed', 'message', action_error_message,
            'script', 'preparation')
        WHEN action_error_message GLOB 'machine *''s disk of *G is below its base''s*'
          THEN json_object('_tag', 'Unsizable', 'message', action_error_message)
        WHEN action_error_message GLOB 'boat * answered 403 *'
          THEN json_object('_tag', 'Refused', 'message', action_error_message)
        ELSE json_object('_tag', 'Internal', 'message', action_error_message)
      END
      ELSE json_object('_tag', action_error_tag, 'message', action_error_message)
    END
    WHERE action_error_tag IS NOT NULL AND action_error_message IS NOT NULL;
    ALTER TABLE ${table} DROP COLUMN action_error_tag;
    ALTER TABLE ${table} DROP COLUMN action_error_message`,
    )
    .join(";\n"),
];

const actionColumns = {
  action_name: ActionName,
  action_status: ActionStatus,
  action_error: Schema.NullOr(Schema.fromJsonString(Schema.toEncoded(HostError))),
};

const columns = {
  name: Schema.String,
  instance: Schema.String,
  created_at: Schema.DateTimeUtcFromString,
  base: Schema.String,
  profile: Schema.NullOr(Schema.String),
  cpu: Schema.Int,
  ram_mib: Schema.Int,
  disk_gib: Schema.Int,
};

const Columns = Schema.Struct(columns);

const Row = Schema.Struct({
  ...columns,
  ...actionColumns,
  native: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Int),
  host_key: Schema.NullOr(Schema.String),
  made: Schema.Literals([0, 1]),
});

const CheckpointRow = Schema.Struct({
  ...columns,
  ...actionColumns,
  machine: Schema.String,
  kind: Checkpoint.fields.kind,
  pin: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Int),
});

const decodeRow = Schema.decodeUnknownSync(Row);

const decodeCheckpointRow = Schema.decodeUnknownSync(CheckpointRow);

const ActionColumns = Schema.Struct(actionColumns);

const decodeAction = Schema.decodeUnknownSync(ActionRecord);

const actionOf = (row: typeof ActionColumns.Type): ActionRecord =>
  decodeAction(
    row.action_error === null
      ? { name: row.action_name, status: row.action_status }
      : { name: row.action_name, status: row.action_status, error: row.action_error },
  );

const encodeError = Schema.encodeSync(Schema.fromJsonString(HostError));

const resourceOf = (row: typeof Columns.Type): Resource => ({
  name: row.name,
  instance: row.instance,
  createdAt: row.created_at,
  base: row.base,
  profile: row.profile ?? undefined,
  cpu: row.cpu,
  ramMib: row.ram_mib,
  diskGib: row.disk_gib,
});

const fromRow = (row: typeof Row.Type): MachineRecord => ({
  ...resourceOf(row),
  native: row.native ?? undefined,
  action: actionOf(row),
  port: row.port ?? undefined,
  hostKey: row.host_key ?? undefined,
  made: row.made === 1,
});

const fromCheckpointRow = (row: typeof CheckpointRow.Type): CheckpointRecord => ({
  ...resourceOf(row),
  action: actionOf(row),
  machine: row.machine,
  kind: row.kind,
  pin: row.pin ?? undefined,
  port: row.port ?? undefined,
});

const columnParameters = (record: Resource, action: ActionName) => ({
  name: record.name,
  instance: record.instance,
  created_at: DateTime.formatIso(record.createdAt),
  base: record.base,
  profile: record.profile ?? null,
  cpu: record.cpu,
  ram_mib: record.ramMib,
  disk_gib: record.diskGib,
  action_name: action,
});

type Finders = { readonly [K in Kind]: (name: string) => Records[K] | undefined };

const isSqliteError = (cause: unknown): cause is Error & { readonly errcode: number } =>
  cause instanceof Error && "errcode" in cause && typeof cause.errcode === "number";

/** SQLITE_BUSY (sqlite3.h): the database file is locked. */
const sqliteBusy = 5;

/** SQLITE_CONSTRAINT_PRIMARYKEY: node:sqlite reports SQLite's extended result codes. */
const sqlitePrimaryKey = 1555;

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const sql = <A>(what: string, run: () => A): Effect.Effect<A, Internal> =>
  Effect.try({
    try: run,
    catch: (cause) => new Internal({ message: `state database: ${what}: ${describe(cause)}` }),
  });

/**
 * Some of SQLite's errors, such as a full disk, roll the transaction back themselves, so a throw
 * rolls back only a transaction still open, and the error is SQLite's.
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
 * With `locking_mode = EXCLUSIVE`, SQLite keeps its exclusive file lock after the first write
 * transaction, so another host process can't even read the database. The OS drops the lock when
 * the process ends, so a crash leaves no stale lock.
 */
const lock = (db: DatabaseSync, stateDir: string): Effect.Effect<void, CannotStart | Internal> =>
  Effect.try({
    try: () => {
      db.exec("PRAGMA locking_mode = EXCLUSIVE");
      db.exec("BEGIN EXCLUSIVE");
      db.exec("COMMIT");
    },
    catch: (cause) =>
      isSqliteError(cause) && cause.errcode === sqliteBusy
        ? new CannotStart({ message: `another host process holds state dir ${stateDir}` })
        : new Internal({ message: `couldn't lock state dir ${stateDir}: ${describe(cause)}` }),
  });

/**
 * A database left empty by a crash during init is initialized; a newer or foreign one is
 * refused.
 */
const migrate = (db: DatabaseSync, file: string): Effect.Effect<void, CannotStart | Internal> =>
  Effect.gen(function* () {
    const { id, version, tables } = yield* sql("read its header", () => ({
      id: pragma(db, "application_id"),
      version: pragma(db, "user_version"),
      tables: Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Int }))(
        db.prepare("SELECT count(*) AS count FROM sqlite_schema").get(),
      ).count,
    }));

    if (id !== applicationId && (id !== 0 || version !== 0 || tables !== 0)) {
      return yield* new CannotStart({ message: `${file} isn't a clankerbox host database` });
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

      return Result.void;
    });
  });

const decodeOwner = Schema.decodeUnknownSync(
  Schema.Struct({ id: Schema.String, runtime: Runtime }),
);

/**
 * Tart names its VMs and launchd jobs after the host ID, and each runtime knows only its own
 * machines, so under another ID or runtime the rows' machines would read `missing`, and deleting
 * the rows would orphan what the runtime made for them.
 */
const own = (
  db: DatabaseSync,
  file: string,
  { id, runtime }: Owner,
): Effect.Effect<void, CannotStart | Internal> =>
  transaction(db, "record its host", () => {
    const row = db.prepare("SELECT id, runtime FROM host").get();

    if (row === undefined) {
      db.prepare("INSERT INTO host (one, id, runtime) VALUES (1, ?, ?)").run(id, runtime);

      return Result.void;
    }

    const owner = decodeOwner(row);

    return owner.id === id && owner.runtime === runtime
      ? Result.void
      : Result.fail(
          new CannotStart({
            message: `${file} holds host ${owner.id} on ${owner.runtime}, and this config names host ${id} on ${runtime}: run it as ${owner.id} on ${owner.runtime}, or give it a new state dir`,
          }),
        );
  });

export type Owner = Pick<HostSettings, "id" | "runtime" | "stateDir">;

/**
 * Other files in the directory, such as a mount point's `lost+found`, are left alone:
 * `application_id` refuses a foreign database, and the lock a second host.
 */
export const open = (
  owner: Owner,
): Effect.Effect<
  Interface & NativeIdRecorder,
  CannotStart | Internal,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const { stateDir, id: hostId } = owner;
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
    yield* own(db, file, owner);

    const id = idOn(hostId);
    const notFound = notFoundOn(hostId);

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
      `INSERT INTO checkpoints (name, instance, created_at, machine, kind, pin, port, base,
        profile, cpu, ram_mib, disk_gib, action_name, action_status)
       VALUES ($name, $instance, $created_at, $machine, $kind, $pin, $port, $base,
        $profile, $cpu, $ram_mib, $disk_gib, $action_name, 'running')`,
    );

    const updateHostKey = db.prepare("UPDATE machines SET host_key = ? WHERE name = ?");

    const updateMade = db.prepare("UPDATE machines SET made = 1 WHERE name = ?");

    const updateNative = db.prepare(
      "UPDATE machines SET native = $native WHERE name = $name AND instance = $instance",
    );

    const statementsOf = (table: "machines" | "checkpoints") => ({
      record: db.prepare(
        `UPDATE ${table} SET action_name = $action_name, action_status = $action_status,
          action_error = $action_error
         WHERE name = $name`,
      ),
      remove: db.prepare(`DELETE FROM ${table} WHERE name = ?`),
    });

    const statements = {
      machine: statementsOf("machines"),
      checkpoint: statementsOf("checkpoints"),
    } satisfies Record<Kind, ReturnType<typeof statementsOf>>;

    const findSync = (name: string) => {
      const row = selectOne.get(name);

      return row === undefined ? undefined : fromRow(decodeRow(row));
    };

    const findCheckpointSync = (name: string) => {
      const row = selectCheckpoint.get(name);

      return row === undefined ? undefined : fromCheckpointRow(decodeCheckpointRow(row));
    };

    const finders: Finders = {
      machine: findSync,
      checkpoint: findCheckpointSync,
    };

    const record = (row: RowRef, action: ActionRecord) => {
      statements[row.kind].record.run({
        name: row.name,
        action_name: action.name,
        action_status: action.status,
        action_error: action.status === "failed" ? encodeError(action.error) : null,
      });
    };

    const holdSync = <K extends Kind>(
      action: ActionName,
      row: RowRef<K>,
    ): Result.Result<
      { readonly row: RowRef; readonly record: Records[K] },
      NotFound | Conflict
    > => {
      const { kind } = row;
      const found = finders[row.kind](row.name);

      if (found === undefined) {
        return Result.fail(notFound(kind, row.name));
      }

      if (found.action.status === "running") {
        return Result.fail(
          new Conflict({
            message: `${kind} ${id(row.name)} is busy: ${found.action.name} is running`,
            kind: "busy",
          }),
        );
      }

      const running: ActionRecord = { name: action, status: "running" };

      record(row, running);

      return Result.succeed({
        row: { kind: row.kind, name: row.name },
        record: { ...found, action: running },
      });
    };

    /** The port's unique index is only a backstop, so its refusal is SQLite's. */
    const insertSync = (action: ActionName, row: NewRow): Result.Result<RowRef, Conflict> => {
      const columns = columnParameters(row.record, action);

      try {
        if (row.kind === "machine") {
          insertMachine.run({
            ...columns,
            native: row.record.native ?? null,
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
              message: `${row.kind} ${id(row.record.name)} exists`,
              kind: "exists",
            }),
          );
        }

        throw cause;
      }

      return Result.succeed({ kind: row.kind, name: row.record.name });
    };

    const named = (token: Token) =>
      [...token.inserted, ...token.held].map((row) => id(row.name)).join(", ");

    const store: Interface & NativeIdRecorder = {
      list: sql("list machines", () => selectAll.all().map((row) => fromRow(decodeRow(row)))).pipe(
        Effect.withSpan("Store.list"),
      ),
      find: Effect.fn("Store.find")((name) =>
        sql(`read ${id(name)}`, () => Option.fromNullishOr(findSync(name))),
      ),
      ports: sql(
        "read ports",
        () =>
          new Set(
            Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ port: Schema.Int })))(
              selectPorts.all(),
            ).map(({ port }) => port),
          ),
      ).pipe(Effect.withSpan("Store.ports")),
      checkpoints: sql("list checkpoints", () =>
        selectCheckpoints.all().map((row) => fromCheckpointRow(decodeCheckpointRow(row))),
      ).pipe(Effect.withSpan("Store.checkpoints")),
      findCheckpoint: Effect.fn("Store.findCheckpoint")((name) =>
        sql(`read checkpoint ${id(name)}`, () => Option.fromNullishOr(findCheckpointSync(name))),
      ),
      hold: Effect.fn("Store.hold")((action, row, joining) =>
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
      ),
      insert: Effect.fn("Store.insert")((action, row, joining) =>
        transaction(db, `claim ${id(row.record.name)} for ${action}`, () =>
          Result.map(insertSync(action, row), (inserted) => ({
            action,
            inserted: [...(joining?.inserted ?? []), inserted],
            held: joining?.held ?? [],
          })),
        ),
      ),
      release: Effect.fn("Store.release")((token, action) =>
        transaction(db, `release ${named(token)} from ${token.action}`, () => {
          for (const row of token.inserted) {
            statements[row.kind].remove.run(row.name);
          }

          for (const row of token.held) {
            record(row, action);
          }

          return Result.void;
        }),
      ),
      markMade: Effect.fn("Store.markMade")((token) =>
        transaction(db, `mark ${token.inserted.map((row) => id(row.name)).join(", ")} made`, () => {
          for (const row of token.inserted) {
            if (row.kind === "machine") {
              updateMade.run(row.name);
            }
          }

          return Result.void;
        }),
      ),
      end: Effect.fn("Store.end")((token, { action, prepared }) =>
        transaction(db, `record ${action.name} on ${named(token)}`, () => {
          for (const row of [...token.inserted, ...token.held]) {
            record(row, action);
          }

          if (prepared?.hostKey !== undefined) {
            updateHostKey.run(prepared.hostKey, prepared.name);
          }

          return Result.void;
        }),
      ),
      recordNative: Effect.fn("Store.recordNative")((name, instance, native) =>
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
      ),
      remove: Effect.fn("Store.remove")((row) =>
        sql(`remove ${row.kind} ${id(row.name)}`, () => {
          statements[row.kind].remove.run(row.name);
        }),
      ),
      failInterrupted: sql("fail interrupted actions", () => {
        for (const table of ["machines", "checkpoints"]) {
          db.prepare(
            `UPDATE ${table} SET action_status = 'failed',
              action_error = json_object('_tag', 'Internal', 'message', ? || action_name)
             WHERE action_status = 'running'`,
          ).run(stoppedDuring);
        }
      }).pipe(Effect.withSpan("Store.failInterrupted")),
    };

    return store;
  });

export const layer = (
  owner: Owner,
): Layer.Layer<Store | NativeIds, CannotStart | Internal, FileSystem.FileSystem> =>
  Layer.effectContext(
    Effect.map(open(owner), (opened) =>
      Context.make(Store, opened).pipe(Context.add(NativeIds, opened)),
    ),
  );
