import { DatabaseSync } from "node:sqlite";
import { Conflict, Desired, Internal, Kind } from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Effect, FileSystem, Layer, Option, Result, Schema, type Scope } from "effect";
import { idOn, type Resource } from "../ids.ts";
import type { HostSettings } from "../settings.ts";
import { CannotStart } from "../startup.ts";
import { type CheckpointRecord, type Intent, type Interface, Store } from "../store.ts";

export const databaseFile = "host.db";

export const applicationId = 0x63_62_78_6a;

export const migrations: ReadonlyArray<string> = [
  `CREATE TABLE host (
    one INTEGER PRIMARY KEY CHECK (one = 1),
    id TEXT NOT NULL,
    kind TEXT NOT NULL
  ) STRICT;
  CREATE TABLE machines (
    name TEXT PRIMARY KEY,
    instance TEXT NOT NULL,
    created_at TEXT NOT NULL,
    base TEXT NOT NULL,
    profile TEXT,
    cpu INTEGER NOT NULL,
    ram_mib INTEGER NOT NULL,
    disk_gib INTEGER NOT NULL,
    port INTEGER NOT NULL UNIQUE,
    desired TEXT NOT NULL,
    generation INTEGER NOT NULL,
    ephemeral INTEGER NOT NULL,
    made INTEGER NOT NULL,
    host_key TEXT
  ) STRICT;
  CREATE TABLE checkpoints (
    name TEXT PRIMARY KEY,
    instance TEXT NOT NULL,
    created_at TEXT NOT NULL,
    machine TEXT NOT NULL,
    pin TEXT,
    port INTEGER NOT NULL,
    base TEXT NOT NULL,
    profile TEXT,
    cpu INTEGER NOT NULL,
    ram_mib INTEGER NOT NULL,
    disk_gib INTEGER NOT NULL,
    ready INTEGER NOT NULL
  ) STRICT`,
  "ALTER TABLE machines ADD COLUMN paused_pin TEXT",
];

const Flag = Schema.Literals([0, 1]);

const shared = {
  name: Schema.String,
  instance: Schema.String,
  created_at: Schema.DateTimeUtcFromString,
  base: Schema.String,
  profile: Schema.NullOr(Schema.String),
  cpu: Schema.Int,
  ram_mib: Schema.Int,
  disk_gib: Schema.Int,
  port: Schema.Int,
};

const MachineRow = Schema.Struct({
  ...shared,
  desired: Desired,
  generation: Schema.Int,
  ephemeral: Flag,
  made: Flag,
  host_key: Schema.NullOr(Schema.String),
  paused_pin: Schema.NullOr(Schema.String),
});

const CheckpointRow = Schema.Struct({
  ...shared,
  machine: Schema.String,
  pin: Schema.NullOr(Schema.String),
});

const decodeMachine = Schema.decodeUnknownSync(MachineRow);

const decodeCheckpoint = Schema.decodeUnknownSync(CheckpointRow);

const decodeDesire = Schema.decodeUnknownSync(
  Schema.Struct({ desired: Desired, generation: Schema.Int }),
);

const intentOf = (row: typeof MachineRow.Type): Intent => ({
  name: row.name,
  instance: row.instance,
  createdAt: row.created_at,
  base: row.base,
  profile: row.profile ?? undefined,
  cpu: row.cpu,
  ramMib: row.ram_mib,
  diskGib: row.disk_gib,
  port: row.port,
  desired: row.desired,
  generation: row.generation,
  ephemeral: row.ephemeral === 1,
  made: row.made === 1,
  hostKey: row.host_key ?? undefined,
  pausedPin: row.paused_pin ?? undefined,
});

const checkpointOf = (row: typeof CheckpointRow.Type): CheckpointRecord => ({
  name: row.name,
  instance: row.instance,
  createdAt: row.created_at,
  machine: row.machine,
  pin: row.pin ?? undefined,
  port: row.port,
  base: row.base,
  profile: row.profile ?? undefined,
  cpu: row.cpu,
  ramMib: row.ram_mib,
  diskGib: row.disk_gib,
});

const flag = (value: boolean) => (value ? 1 : 0);

const isSqliteError = (cause: unknown): cause is Error & { readonly errcode: number } =>
  cause instanceof Error && "errcode" in cause && typeof cause.errcode === "number";

// Source: sqlite3.h SQLITE_BUSY
const sqliteBusy = 5;

// Source: sqlite3.h SQLITE_CONSTRAINT_PRIMARYKEY
const sqlitePrimaryKey = 1555;

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const sql = <A>(what: string, run: () => A): Effect.Effect<A, Internal> =>
  Effect.try({
    try: run,
    catch: (cause) => new Internal({ message: `state database: ${what}: ${describe(cause)}` }),
  });

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
      return yield* new CannotStart({
        message: `${file} isn't a host database this clankerbox reads: give the host a new state dir`,
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

      return Result.void;
    });
  });

const decodeOwner = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String, kind: Kind }));

const own = (
  db: DatabaseSync,
  file: string,
  { id, kind }: Owner,
): Effect.Effect<void, CannotStart | Internal> =>
  transaction(db, "record its host", () => {
    const row = db.prepare("SELECT id, kind FROM host").get();

    if (row === undefined) {
      db.prepare("INSERT INTO host (one, id, kind) VALUES (1, ?, ?)").run(id, kind);

      return Result.void;
    }

    const owner = decodeOwner(row);

    return owner.id === id && owner.kind === kind
      ? Result.void
      : Result.fail(
          new CannotStart({
            message: `${file} holds ${owner.kind} host ${owner.id}, and this config names ${kind} host ${id}: run it as ${owner.kind} host ${owner.id}, or give it a new state dir`,
          }),
        );
  });

export type Owner = Pick<HostSettings, "id" | "kind" | "stateDir">;

export const open = (
  owner: Owner,
): Effect.Effect<Interface, CannotStart | Internal, FileSystem.FileSystem | Scope.Scope> =>
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

    const selectMachines = db.prepare("SELECT * FROM machines ORDER BY created_at, name");
    const selectMachine = db.prepare("SELECT * FROM machines WHERE name = ?");
    const selectPorts = db.prepare("SELECT port FROM machines");

    const insertMachine = db.prepare(
      `INSERT INTO machines (name, instance, created_at, base, profile, cpu, ram_mib, disk_gib,
        port, desired, generation, ephemeral, made, host_key, paused_pin)
       VALUES ($name, $instance, $created_at, $base, $profile, $cpu, $ram_mib, $disk_gib,
        $port, $desired, $generation, $ephemeral, $made, $host_key, $paused_pin)`,
    );

    const updateDesire = db.prepare(
      `UPDATE machines SET
        desired = CASE WHEN desired = 'deleted' THEN desired ELSE $desired END,
        generation = generation + 1
       WHERE name = $name
       RETURNING desired, generation`,
    );

    const updateMade = db.prepare("UPDATE machines SET made = 1 WHERE name = ?");

    const updateHostKey = db.prepare("UPDATE machines SET host_key = $host_key WHERE name = $name");

    const updatePausedPin = db.prepare(
      "UPDATE machines SET paused_pin = $paused_pin WHERE name = $name",
    );

    const deleteMachine = db.prepare("DELETE FROM machines WHERE name = ?");

    const selectCheckpoints = db.prepare(
      "SELECT * FROM checkpoints WHERE ready = 1 ORDER BY created_at, name",
    );

    const selectCheckpoint = db.prepare("SELECT * FROM checkpoints WHERE name = ? AND ready = 1");

    const selectAnyCheckpoint = db.prepare("SELECT * FROM checkpoints WHERE name = ?");

    const selectUnready = db.prepare("SELECT * FROM checkpoints WHERE ready = 0 ORDER BY name");

    const insertCheckpoint = db.prepare(
      `INSERT INTO checkpoints (name, instance, created_at, machine, pin, port, base, profile,
        cpu, ram_mib, disk_gib, ready)
       VALUES ($name, $instance, $created_at, $machine, $pin, $port, $base, $profile,
        $cpu, $ram_mib, $disk_gib, 0)`,
    );

    const updateReady = db.prepare("UPDATE checkpoints SET ready = 1 WHERE name = ?");

    const updateRetired = db.prepare("UPDATE checkpoints SET ready = 0 WHERE name = ?");

    const deleteCheckpoint = db.prepare("DELETE FROM checkpoints WHERE name = ?");

    const taken = (resource: Resource, name: string) =>
      new Conflict({ message: `${resource} ${id(name)} exists`, id: id(name) });

    const inserting = (resource: Resource, name: string, run: () => void) =>
      Effect.flatMap(
        sql(`insert ${resource} ${id(name)}`, () => {
          try {
            run();

            return Result.void;
          } catch (cause) {
            if (isSqliteError(cause) && cause.errcode === sqlitePrimaryKey) {
              return Result.fail(taken(resource, name));
            }

            throw cause;
          }
        }),
        Effect.fromResult,
      );

    const store: Interface = {
      machines: sql("list machines", () =>
        selectMachines.all().map((row) => intentOf(decodeMachine(row))),
      ).pipe(Effect.withSpan("Store.machines")),
      findMachine: Effect.fn("Store.findMachine")((name) =>
        sql(`read ${id(name)}`, () => {
          const row = selectMachine.get(name);

          return row === undefined ? Option.none() : Option.some(intentOf(decodeMachine(row)));
        }),
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
      insertMachine: Effect.fn("Store.insertMachine")((intent) =>
        inserting("machine", intent.name, () => {
          insertMachine.run({
            name: intent.name,
            instance: intent.instance,
            created_at: DateTime.formatIso(intent.createdAt),
            base: intent.base,
            profile: intent.profile ?? null,
            cpu: intent.cpu,
            ram_mib: intent.ramMib,
            disk_gib: intent.diskGib,
            port: intent.port,
            desired: intent.desired,
            generation: intent.generation,
            ephemeral: flag(intent.ephemeral),
            made: flag(intent.made),
            host_key: intent.hostKey ?? null,
            paused_pin: intent.pausedPin ?? null,
          });
        }),
      ),
      desire: Effect.fn("Store.desire")((name, desired) =>
        sql(`record what ${id(name)} should be`, () => {
          const row = updateDesire.get({ name, desired });

          return row === undefined ? Option.none() : Option.some(decodeDesire(row));
        }),
      ),
      made: Effect.fn("Store.made")((name) =>
        sql(`record ${id(name)} made`, () => {
          updateMade.run(name);
        }),
      ),
      hostKey: Effect.fn("Store.hostKey")((name, hostKey) =>
        sql(`record ${id(name)}'s host key`, () => {
          updateHostKey.run({ name, host_key: hostKey });
        }),
      ),
      pausedUnder: Effect.fn("Store.pausedUnder")((name, pin) =>
        sql(`record the pin ${id(name)} is paused under`, () => {
          updatePausedPin.run({ name, paused_pin: pin ?? null });
        }),
      ),
      removeMachine: Effect.fn("Store.removeMachine")((name) =>
        sql(`remove machine ${id(name)}`, () => {
          deleteMachine.run(name);
        }),
      ),
      checkpoints: sql("list checkpoints", () =>
        selectCheckpoints.all().map((row) => checkpointOf(decodeCheckpoint(row))),
      ).pipe(Effect.withSpan("Store.checkpoints")),
      findCheckpoint: Effect.fn("Store.findCheckpoint")((name) =>
        sql(`read checkpoint ${id(name)}`, () => {
          const row = selectCheckpoint.get(name);

          return row === undefined
            ? Option.none()
            : Option.some(checkpointOf(decodeCheckpoint(row)));
        }),
      ),
      anyCheckpoint: Effect.fn("Store.anyCheckpoint")((name) =>
        sql(`read checkpoint ${id(name)}'s row`, () => {
          const row = selectAnyCheckpoint.get(name);

          return row === undefined
            ? Option.none()
            : Option.some(checkpointOf(decodeCheckpoint(row)));
        }),
      ),
      beginCheckpoint: Effect.fn("Store.beginCheckpoint")((record) =>
        inserting("checkpoint", record.name, () => {
          insertCheckpoint.run({
            name: record.name,
            instance: record.instance,
            created_at: DateTime.formatIso(record.createdAt),
            machine: record.machine,
            pin: record.pin ?? null,
            port: record.port,
            base: record.base,
            profile: record.profile ?? null,
            cpu: record.cpu,
            ram_mib: record.ramMib,
            disk_gib: record.diskGib,
          });
        }),
      ),
      readyCheckpoint: Effect.fn("Store.readyCheckpoint")((name) =>
        sql(`mark checkpoint ${id(name)} ready`, () => {
          updateReady.run(name);
        }),
      ),
      retireCheckpoint: Effect.fn("Store.retireCheckpoint")((name) =>
        sql(`retire checkpoint ${id(name)}`, () => {
          updateRetired.run(name);
        }),
      ),
      removeCheckpoint: Effect.fn("Store.removeCheckpoint")((name) =>
        sql(`remove checkpoint ${id(name)}`, () => {
          deleteCheckpoint.run(name);
        }),
      ),
      unready: sql("list failed captures", () =>
        selectUnready.all().map((row) => checkpointOf(decodeCheckpoint(row))),
      ).pipe(Effect.withSpan("Store.unready")),
    };

    return store;
  });

export const layer = (
  owner: Owner,
): Layer.Layer<Store, CannotStart | Internal, FileSystem.FileSystem> =>
  Layer.effect(Store, open(owner));
