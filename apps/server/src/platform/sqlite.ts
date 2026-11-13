import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";

import { Conflict, Internal } from "@gjermundgaraba/clankerbox-sdk";
import {
  Array as Arr,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Record,
  Result,
  Schema,
} from "effect";
import type { Scope } from "effect";

import type { Decision } from "../chart.ts";
import { leaves as checkpointLeaves } from "../checkpoint-chart.ts";
import { leaves } from "../machine-chart.ts";
import {
  BuildRow,
  CannotStart,
  CheckpointFacts,
  ended,
  Facts,
  holdOf,
  Lease,
  Operation,
  Store,
  TemplateFacts,
} from "../store.ts";
import type { Advanced, Hold, Interface, Rows, TemplateRow } from "../store.ts";

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
  `ALTER TABLE machines ADD COLUMN labels TEXT;
  ALTER TABLE machines ADD COLUMN after TEXT;
  ALTER TABLE checkpoints ADD COLUMN labels TEXT;
  ALTER TABLE checkpoints ADD COLUMN expires_at TEXT`,
  `ALTER TABLE machines DROP COLUMN profile;
  ALTER TABLE machines DROP COLUMN prebuild;
  ALTER TABLE machines ADD COLUMN template TEXT;
  ALTER TABLE checkpoints DROP COLUMN profile;
  ALTER TABLE checkpoints ADD COLUMN build TEXT;
  CREATE TABLE templates (
    name TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    base TEXT NOT NULL,
    cpu INTEGER NOT NULL,
    ram_mib INTEGER NOT NULL,
    disk_gib INTEGER NOT NULL,
    setup_timeout_seconds INTEGER
  ) STRICT;
  CREATE TABLE builds (
    template TEXT NOT NULL,
    number INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    phase TEXT NOT NULL,
    error TEXT,
    host TEXT NOT NULL,
    pin TEXT,
    image TEXT NOT NULL,
    PRIMARY KEY (template, number)
  ) STRICT;
  CREATE TABLE build_numbers (
    template TEXT PRIMARY KEY,
    last INTEGER NOT NULL
  ) STRICT`,
  "ALTER TABLE checkpoints ADD COLUMN published TEXT",
  `DELETE FROM operations WHERE kind = 'make' AND resource = 'machine' AND name IN (
    SELECT name FROM machines
      WHERE ephemeral = 0 AND json_extract(source, '$.scripted') = 1 AND state LIKE 'making.%'
  );
  UPDATE machines
    SET state = 'undoing.due',
      error = json_object('_tag', 'Internal', 'message', 'the make of machine ' || name || ' ended before its host reported it: its setup left with the control plane this one upgraded from, and a create runs none now')
    WHERE ephemeral = 0 AND json_extract(source, '$.scripted') = 1 AND state LIKE 'making.%';
  UPDATE machines SET source = json_remove(source, '$.scripted')
    WHERE json_extract(source, '$.kind') = 'base'`,
  `CREATE TABLE built (
    template TEXT NOT NULL,
    number INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    phase TEXT NOT NULL,
    error TEXT,
    host TEXT NOT NULL,
    pin TEXT,
    image TEXT NOT NULL,
    base TEXT NOT NULL,
    cpu INTEGER NOT NULL,
    ram_mib INTEGER NOT NULL,
    disk_gib INTEGER NOT NULL,
    setup_timeout_seconds INTEGER,
    PRIMARY KEY (template, number)
  ) STRICT;
  INSERT INTO built
    SELECT builds.template, builds.number, builds.created_at, builds.phase, builds.error,
      builds.host, builds.pin, builds.image, templates.base, templates.cpu, templates.ram_mib,
      templates.disk_gib, templates.setup_timeout_seconds
    FROM builds JOIN templates ON templates.name = builds.template;
  DROP TABLE builds;
  ALTER TABLE built RENAME TO builds;
  ALTER TABLE templates DROP COLUMN base;
  ALTER TABLE templates DROP COLUMN cpu;
  ALTER TABLE templates DROP COLUMN ram_mib;
  ALTER TABLE templates DROP COLUMN disk_gib;
  ALTER TABLE templates DROP COLUMN setup_timeout_seconds`,
  `ALTER TABLE machines ADD COLUMN traits TEXT NOT NULL DEFAULT '';
  ALTER TABLE checkpoints ADD COLUMN traits TEXT NOT NULL DEFAULT '';
  CREATE TEMP TABLE kind_traits (kind TEXT PRIMARY KEY, traits TEXT NOT NULL) STRICT;
  INSERT INTO kind_traits VALUES
    ('linux', json_object('runtime', 'smolvm', 'images', 'references', 'checkpoint', 'ram',
      'captureFrom', 'running', 'pause', 'saves', 'copies', 'grow',
      'resize', json_object('running', 'grow', 'stopped', 'any'),
      'sizes', json_object('_tag', 'free'), 'stopsOnItsOwn', json('false'))),
    ('mac', json_object('runtime', 'tart', 'images', 'named', 'checkpoint', 'disk',
      'captureFrom', 'stopped', 'pause', 'saves', 'copies', 'any',
      'resize', json_object('running', 'none', 'stopped', 'any'),
      'sizes', json_object('_tag', 'free'), 'stopsOnItsOwn', json('false')));
  UPDATE machines
    SET traits = (SELECT traits FROM kind_traits WHERE kind_traits.kind = machines.kind);
  UPDATE checkpoints
    SET traits = (SELECT traits FROM kind_traits WHERE kind_traits.kind = checkpoints.kind);
  DROP TABLE kind_traits;
  ALTER TABLE machines DROP COLUMN kind;
  ALTER TABLE checkpoints DROP COLUMN kind`,
  `CREATE TABLE reached (
    name TEXT PRIMARY KEY,
    instance TEXT NOT NULL,
    created_at TEXT NOT NULL,
    base TEXT NOT NULL,
    cpu INTEGER NOT NULL,
    ram_mib INTEGER NOT NULL,
    disk_gib INTEGER NOT NULL,
    host TEXT NOT NULL,
    handle TEXT,
    endpoint TEXT,
    desired TEXT NOT NULL,
    state TEXT NOT NULL,
    prepared INTEGER NOT NULL,
    error TEXT,
    resize TEXT,
    ephemeral INTEGER NOT NULL,
    source TEXT NOT NULL,
    host_key TEXT,
    pin TEXT,
    undone_at TEXT,
    labels TEXT,
    after TEXT,
    template TEXT,
    traits TEXT NOT NULL
  ) STRICT;
  INSERT INTO reached
    SELECT name, instance, created_at, base, cpu, ram_mib, disk_gib, host, NULL,
      CASE WHEN port IS NULL THEN NULL ELSE json_object('port', port) END,
      desired, state, prepared, error, resize, ephemeral, source, host_key, pin, undone_at,
      labels, after, template, traits
    FROM machines;
  DROP TABLE machines;
  ALTER TABLE reached RENAME TO machines;
  ALTER TABLE checkpoints DROP COLUMN port;
  ALTER TABLE checkpoints ADD COLUMN handle TEXT;
  DELETE FROM hosts`,
  `CREATE TABLE retired (
    host TEXT NOT NULL,
    resource TEXT NOT NULL,
    instance TEXT NOT NULL,
    retired_at TEXT NOT NULL,
    PRIMARY KEY (host, resource, instance)
  ) STRICT`,
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

const snakeCase = (field: string): string =>
  field.replaceAll(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);

const snakeColumns = <const Fields extends Schema.Struct.Fields>(
  fields: Fields
) =>
  Schema.Struct(fields).pipe(
    Schema.encodeKeys(Record.map(fields, (_, field) => snakeCase(field)))
  );

const StoredMachine = snakeColumns({
  ...Facts.fields,
  state: Schema.Literals(leaves),
});

const StoredCheckpoint = snakeColumns({
  ...CheckpointFacts.fields,
  state: Schema.Literals(checkpointLeaves),
});

const StoredTemplate = snakeColumns(TemplateFacts.fields);

const StoredBuild = snakeColumns({
  template: Schema.String,
  ...BuildRow.fields,
});

const decodeBoot = Schema.decodeUnknownSync(
  Schema.Struct({ boot: Schema.String })
);

const decodeRetired = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({ resource: Lease.fields.resource, instance: Schema.String })
  )
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

const templateFactsOf = Schema.decodeUnknownSync(StoredTemplate);

const decodeLastBuild = Schema.decodeUnknownSync(
  Schema.Struct({ last: Schema.Int })
);

const buildsOf = Schema.decodeUnknownSync(Schema.NonEmptyArray(StoredBuild));

const templateColumns = Schema.encodeSync(StoredTemplate);

const buildColumns = Schema.encodeSync(StoredBuild);

interface Table<R> {
  readonly select: StatementSync;
  readonly update: StatementSync;
  readonly remove: StatementSync;
  readonly decoded: (raw: unknown) => R;
  readonly columns: (row: R) => Readonly<Record<string, Bound>>;
  readonly holdOf: (row: R) => Hold | undefined;
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

    const prepare = (statement: string) =>
      Effect.try({
        try: () => db.prepare(statement),
        catch: (cause) =>
          new CannotStart({
            message: `${file} has tables this clankerbox can't read: ${describe(cause)}`,
          }),
      });

    const selectMachines = yield* prepare(
      "SELECT * FROM machines ORDER BY created_at, name"
    );

    const selectMachine = yield* prepare(
      "SELECT * FROM machines WHERE name = ?"
    );

    const insertMachine = yield* prepare(
      insertInto("machines", StoredMachine.from)
    );

    const updateMachine = yield* prepare(
      updateIn("machines", StoredMachine.from)
    );

    const deleteUndone = yield* prepare(
      "DELETE FROM machines WHERE name = ? AND undone_at IS NOT NULL"
    );

    const deleteMachine = yield* prepare("DELETE FROM machines WHERE name = ?");

    const deleteExpired = yield* prepare(
      "DELETE FROM machines WHERE undone_at < ?"
    );

    const selectCheckpoints = yield* prepare(
      "SELECT * FROM checkpoints ORDER BY created_at, name"
    );

    const selectCheckpoint = yield* prepare(
      "SELECT * FROM checkpoints WHERE name = ?"
    );

    const deleteFailedCheckpoint = yield* prepare(
      "DELETE FROM checkpoints WHERE name = ? AND failed_at IS NOT NULL"
    );

    const insertCheckpoint = yield* prepare(
      insertInto("checkpoints", StoredCheckpoint.from)
    );

    const updateCheckpoint = yield* prepare(
      updateIn("checkpoints", StoredCheckpoint.from)
    );

    const deleteCheckpoint = yield* prepare(
      "DELETE FROM checkpoints WHERE name = ?"
    );

    const deleteExpiredCheckpoints = yield* prepare(
      "DELETE FROM checkpoints WHERE failed_at < ?"
    );

    const selectOperations = yield* prepare(
      "SELECT * FROM operations ORDER BY sequence"
    );

    const selectOperation = yield* prepare(
      "SELECT * FROM operations WHERE resource = ? AND name = ? ORDER BY sequence LIMIT 1"
    );

    const insertOperation = yield* prepare(insertInto("operations", Operation));

    const deleteOperation = yield* prepare(
      "DELETE FROM operations WHERE id = ?"
    );

    const raiseSequence = yield* prepare(
      "UPDATE sequence SET last = last + 1 RETURNING last"
    );

    const selectTemplates = yield* prepare(
      "SELECT * FROM templates ORDER BY created_at, name"
    );

    const selectTemplate = yield* prepare(
      "SELECT * FROM templates WHERE name = ?"
    );

    const insertTemplate = yield* prepare(
      insertInto("templates", StoredTemplate.from)
    );

    const deleteTemplate = yield* prepare(
      "DELETE FROM templates WHERE name = ?"
    );

    const selectBuilds = yield* prepare(
      "SELECT * FROM builds WHERE template = ? ORDER BY number"
    );

    const insertBuild = yield* prepare(insertInto("builds", StoredBuild.from));

    const deleteBuilds = yield* prepare(
      "DELETE FROM builds WHERE template = ?"
    );

    const selectLastBuild = yield* prepare(
      "SELECT last FROM build_numbers WHERE template = ?"
    );

    const raiseLastBuild = yield* prepare(
      `INSERT INTO build_numbers (template, last) VALUES (?, ?)
      ON CONFLICT (template) DO UPDATE SET last = MAX(last, excluded.last)`
    );

    const insertRetired = yield* prepare(
      "INSERT INTO retired (host, resource, instance, retired_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING"
    );

    const selectRetired = yield* prepare(
      "SELECT resource, instance FROM retired WHERE host = ? ORDER BY retired_at, instance"
    );

    const deleteRetired = yield* prepare(
      "DELETE FROM retired WHERE retired_at < ?"
    );

    const selectBoot = yield* prepare("SELECT boot FROM hosts WHERE id = ?");

    const upsertBoot = yield* prepare(
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
        holdOf: holdOf.machine,
      },
      checkpoint: {
        select: selectCheckpoint,
        update: updateCheckpoint,
        remove: deleteCheckpoint,
        decoded: checkpointOf,
        columns: checkpointColumns,
        holdOf: holdOf.checkpoint,
      },
    };

    const written = yield* PubSub.unbounded<{
      readonly resource: Lease["resource"];
      readonly name: string;
    }>();

    const told = (resource: Lease["resource"], name: string) =>
      Effect.asVoid(PubSub.publish(written, { resource, name }));

    const advanced = <R>(
      resource: Lease["resource"],
      table: Table<R>,
      name: string,
      decide: (row: R, op: Operation | undefined) => Decision<R>
    ) =>
      Effect.flatMap(DateTime.now, (now) =>
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

          const retired = ended(
            table.holdOf(row),
            next === "removed" ? undefined : table.holdOf(next)
          );

          if (retired !== undefined) {
            insertRetired.run(
              retired.host,
              resource,
              retired.instance,
              DateTime.formatIso(now)
            );
          }

          return { at: "written", next, moved: next !== row };
        })
      ).pipe(
        Effect.tap((answer) =>
          answer.at === "written" && answer.moved
            ? told(resource, name)
            : Effect.void
        ),
        Effect.uninterruptible
      );

    const templateOf = (raw: unknown): TemplateRow => {
      const facts = templateFactsOf(raw);

      return {
        ...facts,
        builds: Arr.map(
          buildsOf(selectBuilds.all(facts.name)),
          ({ template: _template, ...build }) => build
        ),
      };
    };

    const foundTemplate = (name: string) => {
      const raw = selectTemplate.get(name);

      return raw === undefined ? Option.none() : Option.some(templateOf(raw));
    };

    const findMachine = Effect.fn("Store.findMachine")((name: string) =>
      sql(`read ${name}`, () => {
        const row = selectMachine.get(name);

        return row === undefined ? Option.none() : Option.some(rowOf(row));
      })
    );

    const store: Interface = {
      watchMachine: Effect.fn("Store.watchMachine")(function* (name) {
        const writes = yield* PubSub.subscribe(written);

        const next = PubSub.take(writes).pipe(
          Effect.repeat({
            until: (write) =>
              write.resource === "machine" && write.name === name,
          }),
          Effect.andThen(findMachine(name))
        );

        return { now: yield* findMachine(name), next };
      }),
      machines: sql("list machines", () =>
        selectMachines.all().map((raw) => rowOf(raw))
      ).pipe(Effect.withSpan("Store.machines")),
      findMachine,
      insertMachine: Effect.fn("Store.insertMachine")((row) =>
        inserting("machine", row.name, () => {
          deleteUndone.run(row.name);
          insertMachine.run(machineColumns(row));
        }).pipe(
          Effect.andThen(told("machine", row.name)),
          Effect.uninterruptible
        )
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
      retired: Effect.fn("Store.retired")((host) =>
        sql(`read what host ${host} retired`, () => {
          const rows = decodeRetired(selectRetired.all(host));

          const of = (resource: Lease["resource"]) =>
            rows.flatMap((row) =>
              row.resource === resource ? [row.instance] : []
            );

          return { machines: of("machine"), checkpoints: of("checkpoint") };
        })
      ),
      forgetRetired: Effect.fn("Store.forgetRetired")((before) =>
        sql("forget old retired instances", () => {
          deleteRetired.run(DateTime.formatIso(before));
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
      templates: sql("list templates", () =>
        selectTemplates.all().map((raw) => templateOf(raw))
      ).pipe(Effect.withSpan("Store.templates")),
      findTemplate: Effect.fn("Store.findTemplate")((name) =>
        sql(`read template ${name}`, () => foundTemplate(name))
      ),
      advanceTemplate: (name, decide) =>
        transaction(db, `change template ${name}`, () => {
          const stored = selectLastBuild.get(name);

          const decided = decide(
            foundTemplate(name),
            stored === undefined ? 0 : decodeLastBuild(stored).last
          );

          if (Result.isSuccess(decided)) {
            deleteTemplate.run(name);
            deleteBuilds.run(name);

            const row: TemplateRow | "removed" = decided.success;

            if (row !== "removed") {
              const { builds, ...facts } = row;

              insertTemplate.run(templateColumns(facts));

              for (const build of builds) {
                insertBuild.run(buildColumns({ template: name, ...build }));
                raiseLastBuild.run(name, build.number);
              }
            }
          }

          return decided;
        }).pipe(
          Effect.flatMap(Effect.fromResult),
          Effect.withSpan("Store.advanceTemplate")
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
