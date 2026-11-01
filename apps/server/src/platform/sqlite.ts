import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";

import { Conflict, Internal } from "@gjermundgaraba/clankerbox-sdk";
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
import { leaves } from "../machine-chart.ts";
import {
  CannotStart,
  CheckpointFacts,
  Facts,
  Operation,
  Store,
} from "../store.ts";
import type { Advanced, Interface, Lease, Rows } from "../store.ts";

export const databaseFile = "server.db";

export const applicationId = 0x63_62_78_75;

export const migrations: readonly string[] = [
  `CREATE TABLE machines (
    name TEXT PRIMARY KEY,
    instance TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    kind TEXT NOT NULL,
    base TEXT NOT NULL,
    profile TEXT,
    cpu INTEGER NOT NULL,
    ramMib INTEGER NOT NULL,
    diskGib INTEGER NOT NULL,
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
    hostKey TEXT,
    pin TEXT,
    undoneAt TEXT,
    UNIQUE (host, port)
  ) STRICT;
  CREATE TABLE checkpoints (
    name TEXT PRIMARY KEY,
    instance TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    machine TEXT NOT NULL,
    host TEXT NOT NULL,
    kind TEXT NOT NULL,
    pin TEXT,
    port INTEGER NOT NULL,
    base TEXT NOT NULL,
    profile TEXT,
    cpu INTEGER NOT NULL,
    ramMib INTEGER NOT NULL,
    diskGib INTEGER NOT NULL,
    state TEXT NOT NULL,
    error TEXT,
    failedAt TEXT
  ) STRICT;
  CREATE TABLE operations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    resource TEXT NOT NULL,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    boot TEXT NOT NULL,
    sequence INTEGER NOT NULL,
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

const StoredMachine = Schema.Struct({
  ...Facts.fields,
  state: Schema.Literals(leaves),
});

const StoredCheckpoint = Schema.Struct({
  ...CheckpointFacts.fields,
  state: Schema.Literals(checkpointLeaves),
});

const decodeBoot = Schema.decodeUnknownSync(
  Schema.Struct({ boot: Schema.String })
);

type Bound = string | number | null;

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

const rowOf = Schema.decodeUnknownSync(StoredMachine);

const checkpointOf = Schema.decodeUnknownSync(StoredCheckpoint);

const operationOf = Schema.decodeUnknownSync(Operation);

const machineColumns = Schema.encodeSync(StoredMachine);

const checkpointColumns = Schema.encodeSync(StoredCheckpoint);

const operationColumns = Schema.encodeSync(Operation);

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
      "SELECT * FROM machines ORDER BY createdAt, name"
    );

    const selectMachine = db.prepare("SELECT * FROM machines WHERE name = ?");

    const insertMachine = db.prepare(insertInto("machines", StoredMachine));

    const updateMachine = db.prepare(updateIn("machines", StoredMachine));

    const deleteUndone = db.prepare(
      "DELETE FROM machines WHERE name = ? AND undoneAt IS NOT NULL"
    );

    const deleteMachine = db.prepare("DELETE FROM machines WHERE name = ?");

    const deleteExpired = db.prepare("DELETE FROM machines WHERE undoneAt < ?");

    const selectCheckpoints = db.prepare(
      "SELECT * FROM checkpoints ORDER BY createdAt, name"
    );

    const selectCheckpoint = db.prepare(
      "SELECT * FROM checkpoints WHERE name = ?"
    );

    const deleteFailedCheckpoint = db.prepare(
      "DELETE FROM checkpoints WHERE name = ? AND failedAt IS NOT NULL"
    );

    const insertCheckpoint = db.prepare(
      insertInto("checkpoints", StoredCheckpoint)
    );

    const updateCheckpoint = db.prepare(
      updateIn("checkpoints", StoredCheckpoint)
    );

    const deleteCheckpoint = db.prepare(
      "DELETE FROM checkpoints WHERE name = ?"
    );

    const deleteExpiredCheckpoints = db.prepare(
      "DELETE FROM checkpoints WHERE failedAt < ?"
    );

    const selectOperations = db.prepare(
      "SELECT * FROM operations ORDER BY sequence"
    );

    const selectOperation = db.prepare(
      "SELECT * FROM operations WHERE resource = ? AND name = ? ORDER BY sequence LIMIT 1"
    );

    const insertOperation = db.prepare(insertInto("operations", Operation));

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
        .map((raw) => operationOf(raw))
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
        selectMachines.all().map((raw) => rowOf(raw))
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
        selectCheckpoints.all().map((raw) => checkpointOf(raw))
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
