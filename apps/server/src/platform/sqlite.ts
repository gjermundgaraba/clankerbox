import { DatabaseSync } from "node:sqlite";

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
  Data,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import type { Scope } from "effect";

import { leaves } from "../machine-chart.ts";
import type { MachineRow } from "../machine-chart.ts";
import { CannotStart, Store } from "../store.ts";
import type {
  Advanced,
  CheckpointPatch,
  CheckpointPhase,
  CheckpointRow,
  Interface,
  Lease,
  Operation,
} from "../store.ts";

export const databaseFile = "server.db";

export const applicationId = 0x63_62_78_74;

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
    phase TEXT NOT NULL,
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

export const transaction = <A, E>(
  db: DatabaseSync,
  what: string,
  body: () => Result.Result<A, E>
): Effect.Effect<A, E | Internal> =>
  Effect.flatMap(
    sql(what, () => {
      db.exec("BEGIN IMMEDIATE");

      try {
        const result = body();

        db.exec(Result.isSuccess(result) ? "COMMIT" : "ROLLBACK");

        return result;
      } catch (error) {
        if (db.isTransaction) {
          db.exec("ROLLBACK");
        }

        throw error;
      }
    }),
    Effect.fromResult
  );

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

      return Result.void;
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
  phase: Schema.Literals([
    "capturing",
    "ready",
    "discarding",
    "deleting",
    "failed",
  ]),
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
    phase: row.phase,
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

type Column<P> = readonly [name: string, bound: (patch: P) => Bound];

type Columns<P> = { readonly [K in keyof P]-?: Column<P> };

const plain = (value: string | number | undefined): Bound => value ?? null;

const encodedError = (error: HostError | undefined): Bound =>
  error === undefined ? null : encodeError(error);

const machineColumns = (row: MachineRow) => ({
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
  resize: row.resize === undefined ? null : encodeSizing(row.resize),
  ephemeral: flag(row.ephemeral),
  source: encodeSource(row.source),
  prebuild: row.prebuild ?? null,
  host_key: row.hostKey ?? null,
  pin: row.pin ?? null,
  undone_at: time(row.undoneAt),
});

const checkpointColumns: Columns<CheckpointPatch> = {
  phase: ["phase", ({ phase }) => plain(phase)],
  error: ["error", ({ error }) => encodedError(error)],
  failedAt: ["failed_at", ({ failedAt }) => time(failedAt)],
};

const assignments = <P extends object>(
  patch: P,
  columns: Readonly<Record<string, Column<P>>>
) => {
  const written = Object.entries(columns).filter(([key]) =>
    Object.hasOwn(patch, key)
  );

  return {
    sets: written.map(([, [name]]) => `${name} = ?`).join(", "),
    values: written.map(([, [, bound]]) => bound(patch)),
  };
};

const taken = (resource: Lease["resource"], name: string) =>
  new Conflict({ message: `${resource} ${name} exists`, id: name });

const conflicting = (wanted: Lease, held: Lease): boolean =>
  wanted.resource === held.resource &&
  wanted.name === held.name &&
  (wanted.mode === "own" || held.mode === "own");

class Busy extends Data.TaggedError("Busy") {}

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

    const insertMachine = db.prepare(
      `INSERT INTO machines (name, instance, created_at, kind, base, profile, cpu, ram_mib,
        disk_gib, host, port, desired, state, prepared, error, resize, ephemeral, source, prebuild,
        host_key, pin, undone_at)
       VALUES ($name, $instance, $created_at, $kind, $base, $profile, $cpu, $ram_mib, $disk_gib,
        $host, $port, $desired, $state, $prepared, $error, $resize, $ephemeral, $source, $prebuild,
        $host_key, $pin, $undone_at)`
    );

    const updateMachine = db.prepare(
      `UPDATE machines SET instance = $instance, created_at = $created_at, kind = $kind,
        base = $base, profile = $profile, cpu = $cpu, ram_mib = $ram_mib, disk_gib = $disk_gib,
        host = $host, port = $port, desired = $desired, state = $state, prepared = $prepared,
        error = $error, resize = $resize, ephemeral = $ephemeral, source = $source,
        prebuild = $prebuild, host_key = $host_key, pin = $pin, undone_at = $undone_at
       WHERE name = $name`
    );

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
      "DELETE FROM checkpoints WHERE name = ? AND phase = 'failed'"
    );

    const insertCheckpoint = db.prepare(
      `INSERT INTO checkpoints (name, instance, created_at, machine, host, kind, pin, port, base,
        profile, cpu, ram_mib, disk_gib, phase, error, failed_at)
       VALUES ($name, $instance, $created_at, $machine, $host, $kind, $pin, $port, $base,
        $profile, $cpu, $ram_mib, $disk_gib, $phase, $error, $failed_at)`
    );

    const deleteCheckpoint = db.prepare(
      "DELETE FROM checkpoints WHERE name = ?"
    );

    const deleteExpiredCheckpoints = db.prepare(
      "DELETE FROM checkpoints WHERE phase = 'failed' AND failed_at < ?"
    );

    const selectOperations = db.prepare(
      "SELECT * FROM operations ORDER BY sequence"
    );

    const selectOperation = db.prepare(
      "SELECT * FROM operations WHERE resource = ? AND name = ? ORDER BY sequence LIMIT 1"
    );

    const insertOperation = db.prepare(
      `INSERT INTO operations (id, kind, resource, name, host, boot, sequence, seen, leases, "to")
       VALUES ($id, $kind, $resource, $name, $host, $boot, $sequence, $seen, $leases, $to)`
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

    const writeCheckpoint = (
      name: string,
      patch: CheckpointPatch,
      from: CheckpointPhase | undefined
    ) => {
      const { sets, values } = assignments(patch, checkpointColumns);

      if (sets !== "") {
        db.prepare(
          `UPDATE checkpoints SET ${sets} WHERE name = ?${from === undefined ? "" : " AND phase = ?"}`
        ).run(...values, name, ...(from === undefined ? [] : [from]));
      }
    };

    const leased = (
      operation: Omit<Operation, "sequence">
    ): Operation | undefined => {
      const held = selectOperations
        .all()
        .flatMap((row) => operationOf(row).leases);

      if (
        operation.leases.some((wanted) =>
          held.some((lease) => conflicting(wanted, lease))
        )
      ) {
        return undefined;
      }

      const { last } = Schema.decodeUnknownSync(
        Schema.Struct({ last: Schema.Int })
      )(raiseSequence.get());

      const begun: Operation = { ...operation, sequence: last };

      insertOperation.run({
        id: begun.id,
        kind: begun.kind,
        resource: begun.resource,
        name: begun.name,
        host: begun.host,
        boot: begun.boot,
        sequence: begun.sequence,
        seen: begun.seen,
        leases: encodeLeases(begun.leases),
        to: begun.to === undefined ? null : encodeSizing(begun.to),
      });

      return begun;
    };

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
      advance: Effect.fn("Store.advance")((resource, name, decide) =>
        transaction(
          db,
          `advance ${resource} ${name}`,
          (): Result.Result<Advanced<MachineRow>, Busy> => {
            const raw = selectMachine.get(name);

            if (raw === undefined) {
              return Result.succeed({ at: "absent" });
            }

            const row = rowOf(raw);
            const stored = selectOperation.get(resource, name);
            const op = stored === undefined ? undefined : operationOf(stored);
            const { next, begin, finish } = decide(row, op);

            if (begin !== undefined && leased(begin) === undefined) {
              return Result.fail(new Busy());
            }

            if (finish && op !== undefined) {
              deleteOperation.run(op.id);
            }

            if (next === "removed") {
              deleteMachine.run(name);
            } else if (next !== row) {
              updateMachine.run(machineColumns(next));
            }

            return Result.succeed({
              at: "written",
              next,
              moved: next !== row,
            });
          }
        ).pipe(
          Effect.catchTag("Busy", () =>
            Effect.succeed<Advanced<MachineRow>>({ at: "busy" })
          )
        )
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
          insertCheckpoint.run({
            name: record.name,
            instance: record.instance,
            created_at: DateTime.formatIso(record.createdAt),
            machine: record.machine,
            host: record.host,
            kind: record.kind,
            pin: record.pin ?? null,
            port: record.port,
            base: record.base,
            profile: record.profile ?? null,
            cpu: record.cpu,
            ram_mib: record.ramMib,
            disk_gib: record.diskGib,
            phase: record.phase,
            error: encodedError(record.error),
            failed_at: time(record.failedAt),
          });
        })
      ),
      patchCheckpoint: Effect.fn("Store.patchCheckpoint")((name, patch) =>
        sql(`write checkpoint ${name}`, () => {
          writeCheckpoint(name, patch, undefined);
        })
      ),
      removeCheckpoint: Effect.fn("Store.removeCheckpoint")((name) =>
        sql(`remove checkpoint ${name}`, () => {
          deleteCheckpoint.run(name);
        })
      ),
      operations: sql("list operations", () =>
        selectOperations.all().map(operationOf)
      ).pipe(Effect.withSpan("Store.operations")),
      operationOn: Effect.fn("Store.operationOn")((resource, name) =>
        sql(`read the operation on ${name}`, () => {
          const row = selectOperation.get(resource, name);

          return row === undefined
            ? Option.none()
            : Option.some(operationOf(row));
        })
      ),
      begin: Effect.fn("Store.begin")((operation) =>
        transaction(db, `begin a ${operation.kind} of ${operation.name}`, () =>
          Result.succeed(Option.fromUndefinedOr(leased(operation)))
        )
      ),
      finish: Effect.fn("Store.finish")((operation, finish) =>
        transaction(
          db,
          `finish a ${operation.kind} of ${operation.name}`,
          () => {
            deleteOperation.run(operation.id);

            switch (finish.row) {
              case "checkpoint": {
                writeCheckpoint(operation.name, finish.patch, finish.from);
                break;
              }

              case "checkpoint-removed": {
                deleteCheckpoint.run(operation.name);
                break;
              }

              case "kept": {
                break;
              }
            }

            return Result.void;
          }
        )
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
