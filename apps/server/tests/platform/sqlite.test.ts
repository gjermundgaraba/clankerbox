import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";

import { Handle } from "@clankerbox/host-contract";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { presets } from "@gjermundgaraba/clankerbox-host/testing";
import { Conflict, Internal, NotFound } from "@gjermundgaraba/clankerbox-sdk";
import {
  mkdir,
  readDirectory,
  scratch,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Arbitrary, DateTime, Effect, Option, Result, Schema } from "effect";
import { expect } from "vite-plus/test";

import { applied } from "../../src/chart.ts";
import {
  checkpointChart,
  leaves as checkpointLeaves,
} from "../../src/checkpoint-chart.ts";
import type {
  CheckpointEvent,
  CheckpointRow,
} from "../../src/checkpoint-chart.ts";
import type { MachineRow } from "../../src/machine-chart.ts";
import {
  applicationId,
  databaseFile,
  migrations,
  open,
  transaction,
} from "../../src/platform/sqlite.ts";
import type {
  Interface,
  Lease,
  Operation,
  BuildRow,
  TemplateRow,
} from "../../src/store.ts";
import { freshBoot } from "../chart-rows.ts";

const earlierApplicationIds = [0x63_62_78_69, 0x63_62_78_73, 0x63_62_78_74];

const migration1As96bd402Shipped = `CREATE TABLE machines (
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
  INSERT INTO sequence (one, last) VALUES (1, 0)`;

const withStore = <A, E>(
  stateDir: string,
  use: (store: Interface) => Effect.Effect<A, E>
) =>
  Effect.flatMap(open({ stateDir }), use).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer)
  );

const opening = (stateDir: string) =>
  Effect.flip(open({ stateDir })).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer)
  );

const stateIn = Effect.map(scratch, (dir) => path.join(dir, "state"));

const stateDirAt = (version: number, fill: (db: DatabaseSync) => void) =>
  Effect.gen(function* () {
    const stateDir = yield* stateIn;

    yield* mkdir(stateDir);

    const db = new DatabaseSync(path.join(stateDir, databaseFile));

    fill(db);
    db.exec(
      `PRAGMA user_version = ${version}; PRAGMA application_id = ${applicationId}`
    );
    db.close();

    return stateDir;
  });

const stateDirAtVersion1 = (fill: (db: DatabaseSync) => void) =>
  stateDirAt(1, fill);

const storeFrom = (fixture: string) =>
  Effect.gen(function* () {
    const stateDir = yield* stateIn;

    yield* mkdir(stateDir);
    copyFileSync(
      new URL(`fixtures/${fixture}`, import.meta.url),
      path.join(stateDir, databaseFile)
    );

    return stateDir;
  });

const schema6Store = storeFrom("store-schema-6.db");

type SqlRow = Readonly<Record<string, SQLOutputValue>>;

const reading = <A>(stateDir: string, read: (db: DatabaseSync) => A): A => {
  const db = new DatabaseSync(path.join(stateDir, databaseFile), {
    readOnly: true,
  });

  try {
    return read(db);
  } finally {
    db.close();
  }
};

const tableRows = (db: DatabaseSync, table: string): SqlRow[] =>
  db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();

const rowsOf = (stateDir: string) =>
  reading(stateDir, (db) => ({
    user_version: db.prepare("PRAGMA user_version").get()?.["user_version"],
    machines: tableRows(db, "machines"),
    checkpoints: tableRows(db, "checkpoints"),
    rest: Object.fromEntries(
      ["hosts", "templates", "builds", "build_numbers", "sequence"].map(
        (table) => [table, tableRows(db, table)]
      )
    ),
  }));

const dumped = (stateDir: string) =>
  reading(stateDir, (db) => ({
    pragmas: [
      db.prepare("PRAGMA user_version").get(),
      db.prepare("PRAGMA application_id").get(),
    ],
    schema: db
      .prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name")
      .all(),
    rows: db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name"
      )
      .all()
      .map(({ name }) => tableRows(db, String(name))),
  }));

const traitsOf = (rows: readonly SqlRow[]) =>
  rows.map((row) =>
    row["kind"] === "mac" ? presets.tart.traits : presets.smolvm.traits
  );

const without =
  (...columns: readonly string[]) =>
  (row: SqlRow): SqlRow =>
    Object.fromEntries(
      Object.entries(row).filter(([key]) => !columns.includes(key))
    );

const portsOf = (rows: readonly SqlRow[]) =>
  rows.map(({ port }) => JSON.stringify({ port }));

const row = (name: string, fields?: Partial<MachineRow>): MachineRow => ({
  name,
  instance: "0123456789abcdef0123456789abcdef",
  createdAt: DateTime.makeUnsafe("2026-10-04T12:00:00Z"),
  traits: presets.smolvm.traits,
  base: "ubuntu",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  host: "linux",
  handle: undefined,
  endpoint: undefined,
  desired: "running",
  state: "making.due",
  prepared: false,
  error: undefined,
  resize: undefined,
  ephemeral: false,
  source: { kind: "base" },
  template: undefined,
  hostKey: undefined,
  pin: undefined,
  undoneAt: undefined,
  labels: undefined,
  after: undefined,
  ...fields,
});

const checkpoint = (
  name: string,
  fields?: Partial<CheckpointRow>
): CheckpointRow => ({
  name,
  instance: "fedcba9876543210fedcba9876543210",
  createdAt: DateTime.makeUnsafe("2026-10-04T13:00:00Z"),
  machine: "dev",
  host: "linux",
  traits: presets.smolvm.traits,
  pin: "smolvm 0.0.0-test linux-x64",
  handle: undefined,
  base: "ubuntu",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  state: "capturing.due",
  error: undefined,
  failedAt: undefined,
  labels: undefined,
  expiresAt: undefined,
  build: undefined,
  published: undefined,
  ...fields,
});

const instance = (n: number) => `${n}`.repeat(32);

let nextOperation = 0;

const operation = (
  name: string,
  fields?: Partial<Omit<Operation, "sequence">>
): Omit<Operation, "sequence"> => {
  nextOperation += 1;

  return {
    id: `operation-${nextOperation}`,
    kind: "start",
    resource: "machine",
    name,
    host: "linux",
    boot: "boot-1",
    leases: [{ resource: "machine", name, mode: "own" }],
    to: undefined,
    ...fields,
  };
};

const beginning = (store: Interface, wanted: Omit<Operation, "sequence">) =>
  store.advance("machine", wanted.name, (current) => ({
    next: current,
    begin: wanted,
    finish: false,
  }));

const resting = checkpointLeaves.filter((state) => state !== "failed");

const beginningCheckpoint = (
  store: Interface,
  wanted: Omit<Operation, "sequence">
) =>
  store.advance("checkpoint", wanted.name, (current) => ({
    next: current,
    begin: wanted,
    finish: false,
  }));

const finishing = (store: Interface, { resource, name }: Operation) =>
  store.advance(resource, name, (current) => ({ next: current, finish: true }));

const removing = (store: Interface, name: string) =>
  store.advance("machine", name, () => ({ next: "removed", finish: false }));

const starting = (pin: string) => (given: MachineRow) =>
  ({
    next: { ...given, state: "made.stepping.starting", pin },
    begin: operation("dev"),
    finish: false,
  }) as const;

const begun = (store: Interface, wanted: Omit<Operation, "sequence">) =>
  Effect.gen(function* () {
    yield* beginning(store, wanted);

    const taken = yield* store.operationOn(wanted.resource, wanted.name);

    if (Option.isNone(taken) || taken.value.id !== wanted.id) {
      return yield* Effect.die(`${wanted.id} wasn't begun`);
    }

    return taken.value;
  });

const found = (store: Interface, name: string) =>
  Effect.map(store.findMachine(name), Option.getOrThrow);

const lostWithUpgrade = (name: string) =>
  new Internal({
    message: `the make of machine ${name} ended before its host reported it: its setup left with the control plane this one upgraded from, and a create runs none now`,
  });

const Generated = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("begin"),
    subject: Schema.Literals(["machine", "checkpoint"]),
    leases: Schema.Array(
      Schema.Struct({
        resource: Schema.Literals(["machine", "checkpoint"]),
        name: Schema.Literals(["one", "two"]),
        mode: Schema.Literals(["own", "share"]),
      })
    ).check(Schema.isMaxLength(3)),
  }),
  Schema.Struct({ action: Schema.Literal("finish") }),
]);

const share = (name: string): Lease => ({
  resource: "checkpoint",
  name,
  mode: "share",
});

const own = (name: string): Lease => ({
  resource: "checkpoint",
  name,
  mode: "own",
});

const holds = (wanted: Lease, held: readonly Lease[]): boolean =>
  held.every(
    (lease) =>
      lease.resource !== wanted.resource ||
      lease.name !== wanted.name ||
      (lease.mode === "share" && wanted.mode === "share")
  );

layer(NodeServices.layer)((it) => {
  it.effect(
    "init makes the state dir and a database at the binary's schema version",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        yield* withStore(stateDir, (store) => store.machines);

        const db = new DatabaseSync(path.join(stateDir, databaseFile));

        expect({ ...db.prepare("PRAGMA user_version").get() }).toStrictEqual({
          user_version: migrations.length,
        });
        expect({ ...db.prepare("PRAGMA application_id").get() }).toStrictEqual({
          application_id: applicationId,
        });
        db.close();
      })
  );

  it.effect(
    "machine rows round-trip whole, and a reopened database keeps them",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        const rows = [
          row("dev", {
            traits: presets.tart.traits,
            handle: Handle.make("dev-handle"),
            endpoint: { host: "127.0.0.1", port: 10_000 },
            hostKey: "ssh-ed25519 AAAA",
            ephemeral: true,
            state: "made.failed",
            prepared: true,
            desired: "paused",
            error: new Internal({ message: "sshd didn't start" }),
            resize: { cpu: 2, diskGib: 20 },
            source: { kind: "checkpoint", name: "built-0123456789abcdef" },
            template: "web@1",
            pin: "smolvm 0.0.0-test linux-x64",
          }),
          row("copy", {
            createdAt: DateTime.makeUnsafe("2026-10-04T12:01:00Z"),
            source: { kind: "machine", name: "dev" },
            state: "undone",
            undoneAt: DateTime.makeUnsafe("2026-10-04T12:02:00Z"),
          }),
        ];

        yield* withStore(stateDir, (store) =>
          Effect.forEach(rows, store.insertMachine, { discard: true })
        );

        const [listed, one] = yield* withStore(stateDir, (store) =>
          Effect.all([store.machines, store.findMachine("copy")])
        );

        expect(listed).toStrictEqual(rows);
        expect(Option.getOrUndefined(one)).toStrictEqual(rows[1]);
      })
  );

  it.effect(
    "what a restart needs survives a reopen: leases, sequence numbers, a host's boot, checkpoints",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;
        const snap = checkpoint("snap", { state: "ready" });

        const held = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* store.insertMachine(row("dev"));
            yield* store.insertCheckpoint(snap);
            yield* store.recordBoot("linux", "boot-1");

            return yield* begun(store, operation("dev"));
          })
        );

        const [operations, conflict, later, boot, checkpoints, machine] =
          yield* withStore(stateDir, (store) =>
            Effect.gen(function* () {
              yield* store.insertMachine(row("other"));

              return [
                yield* store.operationOn("machine", "dev"),
                yield* beginning(store, operation("dev")),
                yield* begun(store, operation("other")),
                yield* store.hostBoot("linux"),
                yield* store.checkpoints,
                yield* found(store, "dev"),
              ] as const;
            })
          );

        expect(operations).toStrictEqual(Option.some(held));
        expect(conflict).toStrictEqual({ at: "busy", by: held });
        expect(later.sequence).toBeGreaterThan(held.sequence);
        expect(boot).toStrictEqual(Option.some("boot-1"));
        expect(checkpoints).toStrictEqual([snap]);
        expect(machine).toStrictEqual(row("dev"));
      })
  );

  it.effect(
    "a second owner of the state dir is refused while the first holds it",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        const second = yield* withStore(stateDir, () => opening(stateDir));

        expect(second._tag).toBe("CannotStart");
        expect(second.message).toContain(
          "another control plane process holds state dir"
        );
        expect(
          yield* withStore(stateDir, (store) => store.machines)
        ).toStrictEqual([]);
      })
  );

  it.effect(
    "another process can't open the state dir while the control plane holds it",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;
        const file = path.join(stateDir, databaseFile);

        const reader = yield* withStore(stateDir, () =>
          Effect.sync(() => {
            try {
              execFileSync(
                process.execPath,
                [
                  "-e",
                  `new (require("node:sqlite").DatabaseSync)(process.argv[1]).prepare("SELECT 1 FROM machines").all()`,
                  file,
                ],
                { stdio: "pipe" }
              );

              return "read";
            } catch (error) {
              return error instanceof Error ? error.message : "failed";
            }
          })
        );

        expect(reader).toContain("database is locked");
      })
  );

  it.effect(
    "a store at 0.40.1's schema opens with each row's traits stamped from its kind, its other columns as they were, and opens again unchanged",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* schema6Store;
        const before = rowsOf(stateDir);

        const read = yield* withStore(stateDir, (store) =>
          Effect.all([store.machines, store.checkpoints])
        );

        const after = rowsOf(stateDir);
        const once = dumped(stateDir);

        yield* withStore(stateDir, (store) => store.machines);

        expect(before.user_version).toBe(6);
        expect(before.machines.map(({ name }) => name)).toStrictEqual([
          "keep",
          "big",
          "mbox",
        ]);
        expect(before.checkpoints.map(({ kind }) => kind)).toStrictEqual([
          "linux",
          "linux",
          "mac",
        ]);
        expect(read[0].map(({ traits }) => traits)).toStrictEqual(
          traitsOf(before.machines)
        );
        expect(read[1].map(({ traits }) => traits)).toStrictEqual(
          traitsOf(before.checkpoints)
        );
        expect(after.user_version).toBe(migrations.length);
        expect(
          after.machines.map(without("traits", "handle", "endpoint"))
        ).toStrictEqual(before.machines.map(without("kind", "port")));
        expect(after.machines.map(({ endpoint }) => endpoint)).toStrictEqual(
          portsOf(before.machines)
        );
        expect(
          after.checkpoints.map(without("traits", "handle"))
        ).toStrictEqual(before.checkpoints.map(without("kind", "port")));
        expect(after.rest).toStrictEqual({ ...before.rest, hosts: [] });
        expect(dumped(stateDir)).toStrictEqual(once);
      })
  );

  it.effect(
    "a store at 0.40.1's schema holding a kind no runtime has is refused, and left as it was",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* schema6Store;
        const file = path.join(stateDir, databaseFile);
        const db = new DatabaseSync(file);

        db.exec("UPDATE machines SET kind = 'beos' WHERE name = 'keep'");
        db.close();

        const before = dumped(stateDir);
        const error = yield* opening(stateDir);

        expect(error).toBeInstanceOf(Internal);
        expect(error.message).toContain("NOT NULL");
        expect(dumped(stateDir)).toStrictEqual(before);
      })
  );

  it.effect("a database newer than the binary is refused", () =>
    Effect.gen(function* () {
      const stateDir = yield* stateIn;

      yield* withStore(stateDir, (store) => store.machines);

      const db = new DatabaseSync(path.join(stateDir, databaseFile));

      db.exec(`PRAGMA user_version = ${migrations.length + 1}`);
      db.close();

      const error = yield* opening(stateDir);

      expect(error._tag).toBe("CannotStart");
      expect(error.message).toContain("newer than this binary");
    })
  );

  it.effect(
    "a full database fails a transaction with SQLite's own error, which rolled it back",
    () =>
      Effect.gen(function* () {
        const db = new DatabaseSync(":memory:");

        db.exec("CREATE TABLE blobs (data BLOB) STRICT");
        db.exec("PRAGMA max_page_count = 4");

        const error = yield* transaction(db, "write a blob", () => {
          db.prepare("INSERT INTO blobs VALUES (?)").run(
            new Uint8Array(1 << 20)
          );
        }).pipe(Effect.flip);

        expect(error.message).toBe(
          "state database: write a blob: database or disk is full"
        );
        expect(db.isTransaction).toBe(false);
        db.close();
      })
  );

  it.effect(
    "a directory that holds other files, as a mount point holds lost+found, is used",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        yield* mkdir(path.join(stateDir, "lost+found"));
        yield* write(path.join(stateDir, "notes.txt"), "mine\n");

        expect(
          yield* withStore(stateDir, (store) => store.machines)
        ).toStrictEqual([]);
        expect((yield* readDirectory(stateDir)).toSorted()).toStrictEqual([
          "lost+found",
          "notes.txt",
          databaseFile,
        ]);
      })
  );

  it.effect(
    "another SQLite database under our file name is refused, and so is a host's or a control plane's from an earlier release",
    () =>
      Effect.gen(function* () {
        const other = yield* stateIn;

        yield* mkdir(other);

        const foreign = new DatabaseSync(path.join(other, databaseFile));

        foreign.exec("CREATE TABLE other (x)");
        foreign.close();

        const earlier = yield* Effect.forEach(earlierApplicationIds, (id) =>
          Effect.gen(function* () {
            const stateDir = yield* stateIn;

            yield* mkdir(stateDir);

            const old = new DatabaseSync(path.join(stateDir, databaseFile));

            old.exec("CREATE TABLE machines (name TEXT PRIMARY KEY)");
            old.exec(`PRAGMA user_version = 2; PRAGMA application_id = ${id}`);
            old.close();

            return stateDir;
          })
        );

        for (const stateDir of [other, ...earlier]) {
          const error = yield* opening(stateDir);

          expect(error._tag).toBe("CannotStart");
          expect(error.message).toContain(
            "isn't a control plane database this clankerbox reads"
          );
        }
      })
  );

  it.effect(
    "an empty database file, as a crash during init leaves, is initialized",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        yield* mkdir(stateDir);
        yield* write(path.join(stateDir, databaseFile), "");

        expect(
          yield* withStore(stateDir, (store) => store.machines)
        ).toStrictEqual([]);
      })
  );

  it.effect(
    "a state dir that 96bd402 wrote opens, reads every row as it wrote it but for the profile and the prebuild that templates replaced and the host boots that a recheck reads again, and takes writes",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateDirAtVersion1((db) => {
          db.exec(migration1As96bd402Shipped);

          const insertMachine = db.prepare(
            `INSERT INTO machines (name, instance, created_at, kind, base, profile, cpu, ram_mib, disk_gib, host, port, desired, state, prepared, error, resize, ephemeral, source, prebuild, host_key, pin, undone_at)
              VALUES ($name, '0123456789abcdef0123456789abcdef', $created, $kind, 'ubuntu', $profile, $cpu, $ram, $disk, 'linux', $port, $desired, $state, $prepared, $error, $resize, $ephemeral, $source, $prebuild, $key, $pin, $undone)`
          );

          insertMachine.run({
            name: "dev",
            created: "2026-10-04T12:00:00.000Z",
            kind: "mac",
            profile: "small",
            cpu: 2,
            ram: 2048,
            disk: 20,
            port: 10_000,
            desired: "paused",
            state: "made.failed",
            prepared: 1,
            error: `{"_tag":"Internal","message":"sshd didn't start"}`,
            resize: `{"cpu":4,"diskGib":40}`,
            ephemeral: 1,
            source: `{"kind":"checkpoint","name":"snap"}`,
            prebuild: "prebuilt-0123456789ab",
            key: "ssh-ed25519 AAAA",
            pin: "smolvm 0.0.0-test linux-x64",
            undone: null,
          });
          insertMachine.run({
            name: "gone",
            created: "2026-10-04T12:01:00.000Z",
            kind: "linux",
            profile: null,
            cpu: 1,
            ram: 1024,
            disk: 10,
            port: null,
            desired: "running",
            state: "undone",
            prepared: 0,
            error: `{"_tag":"Internal","message":"setup failed"}`,
            resize: null,
            ephemeral: 0,
            source: `{"kind":"base","scripted":true}`,
            prebuild: null,
            key: null,
            pin: null,
            undone: "2026-10-04T12:02:00.000Z",
          });

          const insertCheckpoint = db.prepare(
            `INSERT INTO checkpoints (name, instance, created_at, machine, host, kind, pin, port, base, profile, cpu, ram_mib, disk_gib, state, error, failed_at)
              VALUES ($name, 'fedcba9876543210fedcba9876543210', $created, 'dev', 'linux', 'linux', 'smolvm 0.0.0-test linux-x64', 10000, 'ubuntu', NULL, 1, 1024, 10, $state, $error, $failed)`
          );

          insertCheckpoint.run({
            name: "snap",
            created: "2026-10-04T13:00:00.000Z",
            state: "ready",
            error: null,
            failed: null,
          });
          insertCheckpoint.run({
            name: "broken",
            created: "2026-10-04T13:01:00.000Z",
            state: "failed",
            error: `{"_tag":"Internal","message":"ENOSPC"}`,
            failed: "2026-10-04T14:00:00.000Z",
          });

          db.exec(`INSERT INTO operations (id, kind, resource, name, host, boot, sequence, leases, "to")
              VALUES ('op-7', 'resize', 'machine', 'dev', 'linux', 'boot-1', 7, '[{"resource":"machine","name":"dev","mode":"own"}]', '{"cpu":4,"diskGib":40}');
            UPDATE sequence SET last = 7;
            INSERT INTO hosts (id, boot) VALUES ('linux', 'boot-1')`);
        });

        const dev = row("dev", {
          traits: presets.tart.traits,
          cpu: 2,
          ramMib: 2048,
          diskGib: 20,
          endpoint: { port: 10_000 },
          desired: "paused",
          state: "made.failed",
          prepared: true,
          error: new Internal({ message: "sshd didn't start" }),
          resize: { cpu: 4, diskGib: 40 },
          ephemeral: true,
          source: { kind: "checkpoint", name: "snap" },
          hostKey: "ssh-ed25519 AAAA",
          pin: "smolvm 0.0.0-test linux-x64",
        });

        const gone = row("gone", {
          createdAt: DateTime.makeUnsafe("2026-10-04T12:01:00Z"),
          state: "undone",
          error: new Internal({ message: "setup failed" }),
          source: { kind: "base" },
          undoneAt: DateTime.makeUnsafe("2026-10-04T12:02:00Z"),
        });

        const [machines, checkpoints, resizing, boot, written, after, later] =
          yield* withStore(stateDir, (store) =>
            Effect.gen(function* () {
              const read = [
                yield* store.machines,
                yield* store.checkpoints,
                yield* store.operationOn("machine", "dev"),
                yield* store.hostBoot("linux"),
              ] as const;

              yield* store.advance("machine", "dev", (given) => ({
                next: { ...given, cpu: 4, diskGib: 40, resize: undefined },
                finish: true,
              }));

              return [
                ...read,
                yield* found(store, "dev"),
                yield* store.operationOn("machine", "dev"),
                yield* begun(store, operation("gone")),
              ] as const;
            })
          );

        expect(machines).toStrictEqual([dev, gone]);
        expect(checkpoints).toStrictEqual([
          checkpoint("snap", { state: "ready" }),
          checkpoint("broken", {
            createdAt: DateTime.makeUnsafe("2026-10-04T13:01:00Z"),
            state: "failed",
            error: new Internal({ message: "ENOSPC" }),
            failedAt: DateTime.makeUnsafe("2026-10-04T14:00:00Z"),
          }),
        ]);
        expect(resizing).toStrictEqual(
          Option.some({
            id: "op-7",
            kind: "resize",
            resource: "machine",
            name: "dev",
            host: "linux",
            boot: "boot-1",
            sequence: 7,
            leases: [{ resource: "machine", name: "dev", mode: "own" }],
            to: { cpu: 4, diskGib: 40 },
          })
        );
        expect(boot).toStrictEqual(Option.none());
        expect(written).toStrictEqual({
          ...dev,
          cpu: 4,
          diskGib: 40,
          resize: undefined,
        });
        expect(after).toStrictEqual(Option.none());
        expect(later.sequence).toBe(8);
      })
  );

  it.effect(
    "a state dir from 0.36 keeps each row but scripted, and a create whose setup is still to run goes to be undone, its make with it, as its setup left with that control plane",
    () =>
      Effect.gen(function* () {
        const shipped = 4;

        const stateDir = yield* stateDirAt(shipped, (db) => {
          for (const migration of migrations.slice(0, shipped)) {
            db.exec(migration);
          }

          const insertMachine = db.prepare(
            `INSERT INTO machines (name, instance, created_at, kind, base, cpu, ram_mib, disk_gib, host, port, desired, state, prepared, ephemeral, source)
              VALUES ($name, '0123456789abcdef0123456789abcdef', '2026-10-04T12:00:00.000Z', 'linux', 'ubuntu', 1, 1024, 10, 'linux', $port, 'running', $state, 0, $ephemeral, $source)`
          );

          const scripted = `{"kind":"base","scripted":true}`;

          for (const [name, state, ephemeral, source, port] of [
            ["sent", "making.sent", 0, scripted, 10_000],
            ["due", "making.due", 0, scripted, null],
            ["builder", "making.sent", 1, scripted, 10_001],
            ["made", "made.settled", 0, scripted, 10_002],
            [
              "plain",
              "making.sent",
              0,
              `{"kind":"base","scripted":false}`,
              10_003,
            ],
            [
              "copy",
              "making.sent",
              0,
              `{"kind":"machine","name":"made"}`,
              10_004,
            ],
          ] as const) {
            insertMachine.run({ name, state, ephemeral, source, port });
          }

          const insertOperation = db.prepare(
            `INSERT INTO operations (id, kind, resource, name, host, boot, sequence, leases)
              VALUES ($name, 'make', 'machine', $name, 'linux', 'boot-1', $sequence, $leases)`
          );

          for (const [sequence, name] of [
            "sent",
            "builder",
            "plain",
            "copy",
          ].entries()) {
            insertOperation.run({
              name,
              sequence: sequence + 1,
              leases: JSON.stringify([
                { resource: "machine", name, mode: "own" },
                ...(name === "copy"
                  ? [{ resource: "machine", name: "made", mode: "share" }]
                  : []),
              ]),
            });
          }

          db.exec("UPDATE sequence SET last = 4");
        });

        const [machines, operations] = yield* withStore(stateDir, (store) =>
          Effect.all([
            store.machines,
            Effect.forEach(["sent", "builder", "plain", "copy"], (name) =>
              Effect.map(store.operationOn("machine", name), (op) =>
                Option.map(op, ({ id }) => id)
              )
            ),
          ])
        );

        const db = new DatabaseSync(path.join(stateDir, databaseFile));

        const sources = db
          .prepare("SELECT name, source FROM machines ORDER BY name")
          .all()
          .map(({ name, source }) => [name, source]);

        db.close();

        expect(
          machines
            .toSorted((a, b) => a.name.localeCompare(b.name))
            .map(({ name, state, error, source }) => [
              name,
              state,
              error,
              source,
            ])
        ).toStrictEqual([
          ["builder", "making.sent", undefined, { kind: "base" }],
          ["copy", "making.sent", undefined, { kind: "machine", name: "made" }],
          ["due", "undoing.due", lostWithUpgrade("due"), { kind: "base" }],
          ["made", "made.settled", undefined, { kind: "base" }],
          ["plain", "making.sent", undefined, { kind: "base" }],
          ["sent", "undoing.due", lostWithUpgrade("sent"), { kind: "base" }],
        ]);
        expect(operations).toStrictEqual([
          Option.none(),
          Option.some("builder"),
          Option.some("plain"),
          Option.some("copy"),
        ]);
        expect(sources).toStrictEqual([
          ["builder", `{"kind":"base"}`],
          ["copy", `{"kind":"machine","name":"made"}`],
          ["due", `{"kind":"base"}`],
          ["made", `{"kind":"base"}`],
          ["plain", `{"kind":"base"}`],
          ["sent", `{"kind":"base"}`],
        ]);
      })
  );

  it.effect(
    "a database at this binary's version whose tables it can't read is refused, not a crash",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateDirAt(migrations.length, (db) => {
          db.exec("CREATE TABLE machines (name TEXT PRIMARY KEY) STRICT");
        });

        const error = yield* opening(stateDir);

        expect(error._tag).toBe("CannotStart");
        expect(error.message).toContain(path.join(stateDir, databaseFile));
        expect(error.message).toContain("no such column");
      })
  );

  it.effect("a taken machine name is Conflict and writes nothing", () =>
    Effect.gen(function* () {
      const stateDir = yield* stateIn;
      const first = row("dev");

      const [name, rows] = yield* withStore(stateDir, (store) =>
        Effect.gen(function* () {
          yield* store.insertMachine(first);

          return [
            yield* Effect.flip(
              store.insertMachine(row("dev", { base: "other" }))
            ),
            yield* store.machines,
          ] as const;
        })
      );

      expect(name).toStrictEqual(
        new Conflict({ message: "machine dev exists", id: "dev" })
      );
      expect(rows).toStrictEqual([first]);
    })
  );

  it.effect(
    "machines on one host may hold any endpoint, which their host gives them, and a removed row frees its name",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;
        const endpoint = { host: "127.0.0.1", port: 10_000 };

        const rows = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* store.insertMachine(row("one", { endpoint }));
            yield* store.insertMachine(row("two", { endpoint }));
            yield* store.insertMachine(row("dev", { endpoint }));
            yield* removing(store, "dev");
            yield* store.insertMachine(row("dev", { endpoint }));
            yield* store.insertMachine(row("gone"));
            yield* removing(store, "gone");
            yield* removing(store, "gone");

            return yield* store.machines;
          })
        );

        expect(rows.map(({ name }) => name).toSorted()).toStrictEqual([
          "dev",
          "one",
          "two",
        ]);
      })
  );

  it.effect(
    "a create replaces a row left undone, and only that: one still making is Conflict",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        const undone = row("failed", {
          state: "undone",
          error: new Internal({ message: "setup failed" }),
          undoneAt: DateTime.makeUnsafe("2026-10-04T12:02:00Z"),
        });

        const fresh = row("failed", { instance: "ffff" });

        const [replaced, refused] = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* store.insertMachine(undone);
            yield* store.insertMachine(fresh);

            return [
              yield* found(store, "failed"),
              yield* Effect.flip(store.insertMachine(row("failed"))),
            ] as const;
          })
        );

        expect(replaced).toStrictEqual(fresh);
        expect(refused._tag).toBe("Conflict");
      })
  );

  it.effect(
    "advance writes the row decide answers, and only it, and a key set to undefined clears its column; the row it was given writes nothing; no row answers absent",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        const before = row("dev", {
          pin: "fake 1",
          hostKey: "key",
          error: new Internal({ message: "earlier" }),
        });

        const [same, unchanged, written, current, other, gone] =
          yield* withStore(stateDir, (store) =>
            Effect.gen(function* () {
              yield* store.insertMachine(before);
              yield* store.insertMachine(row("other"));

              return [
                yield* store.advance("machine", "dev", (given) => ({
                  next: given,
                  finish: false,
                })),
                yield* found(store, "dev"),
                yield* store.advance("machine", "dev", (given) => ({
                  next: {
                    ...given,
                    state: "made.settled",
                    endpoint: { host: "127.0.0.1", port: 10_000 },
                    prepared: true,
                    pin: undefined,
                    error: undefined,
                  },
                  finish: false,
                })),
                yield* found(store, "dev"),
                yield* found(store, "other"),
                yield* store.advance("machine", "gone", (given) => ({
                  next: given,
                  finish: false,
                })),
              ] as const;
            })
          );

        const after = {
          ...before,
          state: "made.settled",
          endpoint: { host: "127.0.0.1", port: 10_000 },
          prepared: true,
          pin: undefined,
          error: undefined,
        } as const;

        expect(same).toStrictEqual({
          at: "written",
          next: before,
          moved: false,
        });
        expect(unchanged).toStrictEqual(before);
        expect(written).toStrictEqual({
          at: "written",
          next: after,
          moved: true,
        });
        expect(current).toStrictEqual(after);
        expect(other).toStrictEqual(row("other"));
        expect(gone).toStrictEqual({ at: "absent" });
      })
  );

  it.effect("a machine's every column writes through advance", () =>
    Effect.gen(function* () {
      const stateDir = yield* stateIn;

      const fields = {
        instance: "abcd",
        createdAt: DateTime.makeUnsafe("2026-10-04T12:01:00Z"),
        traits: presets.tart.traits,
        base: "macos",
        cpu: 8,
        ramMib: 2048,
        diskGib: 40,
        host: "mac",
        handle: Handle.make("abcd-handle"),
        endpoint: { host: "127.0.0.1", port: 10_001 },
        desired: "paused",
        state: "undoing.held",
        prepared: true,
        error: new NotFound({ message: "no checkpoint snap", id: "snap" }),
        resize: { cpu: 8 },
        ephemeral: true,
        source: { kind: "machine", name: "other" },
        template: "web@2",
        hostKey: "key",
        pin: "fake 1",
        undoneAt: DateTime.makeUnsafe("2026-10-04T12:02:00Z"),
      } as const;

      const written = yield* withStore(stateDir, (store) =>
        Effect.gen(function* () {
          yield* store.insertMachine(row("dev"));
          yield* store.advance("machine", "dev", (given) => ({
            next: { ...given, ...fields },
            finish: false,
          }));

          return yield* found(store, "dev");
        })
      );

      expect(written).toStrictEqual(row("dev", fields));
    })
  );

  it.effect(
    "a row at a leaf the chart hasn't is refused, and nothing is written",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        const { error, rows } = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            const refused = yield* Effect.flip(
              store.insertMachine(
                // @ts-expect-error a row can't name a leaf the chart hasn't
                row("dev", { state: "made.nowhere" })
              )
            );

            return { error: refused, rows: yield* store.machines };
          })
        );

        expect(error._tag).toBe("Internal");
        expect(error.message).toContain("insert machine dev");
        expect(rows).toStrictEqual([]);
      })
  );

  it.effect(
    "a checkpoint at a leaf the chart hasn't is refused, and nothing is written",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        const { error, rows } = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            const refused = yield* Effect.flip(
              store.insertCheckpoint(
                // @ts-expect-error a row can't name a leaf the chart hasn't
                checkpoint("snap", { state: "capturing.nowhere" })
              )
            );

            return { error: refused, rows: yield* store.checkpoints };
          })
        );

        expect(error._tag).toBe("Internal");
        expect(error.message).toContain("insert checkpoint snap");
        expect(rows).toStrictEqual([]);
      })
  );

  it.effect.prop(
    "a begin takes every lease of an operation or none, against what the operations in flight hold, and one refused writes nothing",
    [
      Arbitrary.array(Arbitrary.schema(Generated), {
        minLength: 1,
        maxLength: 30,
      }),
    ],
    ([script]) =>
      Effect.gen(function* () {
        const store = yield* open({ stateDir: yield* stateIn });

        yield* store.insertMachine(row("subject"));
        yield* store.insertCheckpoint(checkpoint("subject"));

        let held: readonly Operation[] = [];
        let cpu = 1;
        let last = 0;

        for (const step of script) {
          if (step.action === "finish") {
            const [oldest, ...rest] = held;

            if (oldest !== undefined) {
              yield* finishing(store, oldest);
              held = rest;
            }
          } else {
            const wanted = operation("subject", {
              resource: step.subject,
              leases: step.leases.map(({ resource, name, mode }) => ({
                resource,
                name,
                mode,
              })),
            });

            const by = held.find(
              ({ leases }) =>
                !step.leases.every((lease) => holds(lease, leases))
            );

            const answered =
              step.subject === "machine"
                ? yield* store.advance("machine", "subject", (given) => ({
                    next: { ...given, cpu: given.cpu + 1 },
                    begin: wanted,
                    finish: false,
                  }))
                : yield* beginningCheckpoint(store, wanted);

            if (by === undefined) {
              expect(answered.at).toBe("written");
              last += 1;
              cpu += step.subject === "machine" ? 1 : 0;
              held = [...held, { ...wanted, sequence: last }];
            } else {
              expect(answered).toStrictEqual({ at: "busy", by });
            }
          }

          for (const resource of ["machine", "checkpoint"] as const) {
            expect(yield* store.operationOn(resource, "subject")).toStrictEqual(
              Option.fromUndefinedOr(
                held.find((op) => op.resource === resource)
              )
            );
          }

          expect((yield* found(store, "subject")).cpu).toBe(cpu);
        }
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.effect(
    "shares of one resource sit side by side, an owner excludes them, and machines and checkpoints of a name are apart",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        const [one, two, owner, apart, afterwards] = yield* withStore(
          stateDir,
          (store) =>
            Effect.gen(function* () {
              yield* store.insertMachine(row("one"));
              yield* store.insertMachine(row("two"));
              yield* store.insertMachine(row("snap"));
              yield* store.insertCheckpoint(checkpoint("snap"));

              const first = yield* begun(
                store,
                operation("one", { leases: [share("snap")] })
              );

              const second = yield* begun(
                store,
                operation("two", { leases: [share("snap")] })
              );

              const refused = yield* beginningCheckpoint(
                store,
                operation("snap", {
                  resource: "checkpoint",
                  leases: [own("snap")],
                })
              );

              const beside = yield* beginning(store, operation("snap"));

              yield* finishing(store, first);
              yield* finishing(store, second);

              return [
                first,
                second,
                refused,
                beside,
                yield* beginningCheckpoint(
                  store,
                  operation("snap", {
                    resource: "checkpoint",
                    leases: [own("snap")],
                  })
                ),
              ] as const;
            })
        );

        expect([one.name, two.name]).toStrictEqual(["one", "two"]);
        expect(owner.at).toBe("busy");
        expect(apart.at).toBe("written");
        expect(afterwards.at).toBe("written");
      })
  );

  it.effect(
    "a begin writes its row with the lease, and neither when it is refused, and a write that fails takes the lease back",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        const [taken, refused, after, none, broken, devs, others, thrown] =
          yield* withStore(stateDir, (store) =>
            Effect.gen(function* () {
              yield* store.insertMachine(row("dev"));
              yield* store.insertMachine(row("other"));

              const first = yield* store.advance(
                "machine",
                "dev",
                starting("fake 2")
              );

              const second = yield* store.advance(
                "machine",
                "dev",
                starting("fake 3")
              );

              return [
                first,
                second,
                yield* found(store, "dev"),
                yield* store.advance("machine", "gone", starting("fake 4")),
                yield* Effect.flip(
                  store.advance("machine", "other", (given) => ({
                    next: { ...given, cpu: 0.5 },
                    begin: operation("other"),
                    finish: false,
                  }))
                ),
                yield* store.operationOn("machine", "dev"),
                yield* store.operationOn("machine", "other"),
                yield* Effect.flip(
                  store.advance("machine", "other", () => {
                    throw new Error("a chart threw");
                  })
                ),
              ] as const;
            })
          );

        expect(taken.at).toBe("written");
        expect(refused).toStrictEqual({
          at: "busy",
          by: Option.getOrThrow(devs),
        });
        expect(after).toStrictEqual(
          row("dev", { state: "made.stepping.starting", pin: "fake 2" })
        );
        expect(none).toStrictEqual({ at: "absent" });
        expect(broken._tag).toBe("Internal");
        expect(Option.map(devs, ({ name }) => name)).toStrictEqual(
          Option.some("dev")
        );
        expect(others).toStrictEqual(Option.none());
        expect(thrown.message).toContain("a chart threw");
      })
  );

  it.effect(
    "operationOn reads the oldest operation of a resource, and of no other",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        const [first, read, of, none] = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* store.insertMachine(row("dev"));

            const start = yield* begun(store, operation("dev"));

            yield* beginning(
              store,
              operation("dev", {
                kind: "join",
                leases: [{ resource: "machine", name: "other", mode: "share" }],
              })
            );

            return [
              start,
              yield* store.operationOn("machine", "dev"),
              yield* store.operationOn("checkpoint", "dev"),
              yield* store.operationOn("machine", "other"),
            ] as const;
          })
        );

        expect(read).toStrictEqual(Option.some(first));
        expect(of).toStrictEqual(Option.none());
        expect(none).toStrictEqual(Option.none());
      })
  );

  it.effect("a finish frees the leases and writes the row, in one write", () =>
    Effect.gen(function* () {
      const stateDir = yield* stateIn;
      const endpoint = { host: "127.0.0.1", port: 10_000 };

      const [operations, after, again] = yield* withStore(stateDir, (store) =>
        Effect.gen(function* () {
          yield* store.insertMachine(row("dev", { endpoint }));
          yield* beginning(store, operation("dev"));
          yield* store.advance("machine", "dev", (given) => ({
            next: { ...given, state: "made.observing", prepared: true },
            finish: true,
          }));

          return [
            yield* store.operationOn("machine", "dev"),
            yield* found(store, "dev"),
            yield* beginning(store, operation("dev")),
          ] as const;
        })
      );

      expect(operations).toStrictEqual(Option.none());
      expect(after).toStrictEqual(
        row("dev", { endpoint, state: "made.observing", prepared: true })
      );
      expect(again.at).toBe("written");
    })
  );

  it.effect(
    "a resize leaves the row when it begins, and its operation keeps it through a restart",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        const left = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* store.insertMachine(row("dev", { resize: { cpu: 2 } }));
            yield* store.advance("machine", "dev", (given) => ({
              next: { ...given, resize: undefined },
              begin: operation("dev", { kind: "resize", to: { cpu: 2 } }),
              finish: false,
            }));

            return yield* found(store, "dev");
          })
        );

        const resizing = yield* withStore(stateDir, (store) =>
          store.operationOn("machine", "dev")
        );

        expect(left.resize).toBeUndefined();
        expect(Option.map(resizing, ({ to }) => to)).toStrictEqual(
          Option.some({ cpu: 2 })
        );
      })
  );

  it.effect(
    "a machine goes with its operation, a checkpoint with its own, and a kept row stays as it is",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        const [machines, checkpoints, operations] = yield* withStore(
          stateDir,
          (store) =>
            Effect.gen(function* () {
              yield* store.insertMachine(row("dev"));
              yield* store.insertMachine(row("kept"));
              yield* store.insertCheckpoint(checkpoint("snap"));

              yield* beginning(store, operation("dev"));

              const keeping = yield* begun(store, operation("kept"));

              yield* beginningCheckpoint(
                store,
                operation("snap", {
                  resource: "checkpoint",
                  kind: "deleteCheckpoint",
                  leases: [
                    { resource: "checkpoint", name: "snap", mode: "own" },
                  ],
                })
              );

              yield* store.advance("machine", "dev", () => ({
                next: "removed",
                finish: true,
              }));
              yield* finishing(store, keeping);
              yield* store.advance("checkpoint", "snap", () => ({
                next: "removed",
                finish: true,
              }));

              return [
                yield* store.machines,
                yield* store.checkpoints,
                [
                  yield* store.operationOn("machine", "dev"),
                  yield* store.operationOn("machine", "kept"),
                  yield* store.operationOn("checkpoint", "snap"),
                ],
              ] as const;
            })
        );

        expect(machines).toStrictEqual([row("kept")]);
        expect(checkpoints).toStrictEqual([]);
        expect(operations).toStrictEqual([
          Option.none(),
          Option.none(),
          Option.none(),
        ]);
      })
  );

  it.effect(
    "a capture's end is decided from the row as it stands, so a delete asked meanwhile stands",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        const [kept, written] = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            const told = (name: string, event: CheckpointEvent) =>
              store.advance("checkpoint", name, (given, op) =>
                applied(checkpointChart, given, event, op)
              );

            yield* Effect.forEach(
              ["deleted", "snap"],
              (name) =>
                Effect.andThen(
                  store.insertCheckpoint(checkpoint(name)),
                  told(name, {
                    type: "read",
                    boot: freshBoot("boot-1"),
                    id: name,
                    awaiting: false,
                  })
                ),
              { discard: true }
            );

            yield* told("deleted", { type: "delete" });
            yield* Effect.forEach(
              ["deleted", "snap"],
              (name) =>
                told(name, {
                  type: "reported",
                  status: "done",
                  at: DateTime.makeUnsafe(0),
                }),
              { discard: true }
            );

            return [
              yield* store.findCheckpoint("deleted"),
              yield* store.findCheckpoint("snap"),
            ] as const;
          })
        );

        expect(Option.getOrThrow(kept).state).toBe("deleting.due");
        expect(Option.getOrThrow(written).state).toBe("ready");
      })
  );

  it.effect(
    "expire takes undone machines and failed checkpoints from before the time it is given, and nothing else",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;
        const before = DateTime.makeUnsafe("2026-10-05T00:00:00Z");
        const earlier = DateTime.makeUnsafe("2026-10-04T23:59:59Z");
        const error = new Internal({ message: "failed" });

        const failedRow = (name: string, undoneAt: DateTime.Utc) =>
          row(name, { state: "undone", error, undoneAt });

        const failedCheckpoint = (name: string, failedAt: DateTime.Utc) =>
          checkpoint(name, { state: "failed", error, failedAt });

        const [machines, checkpoints] = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* store.insertMachine(failedRow("old", earlier));
            yield* store.insertMachine(failedRow("at", before));
            yield* store.insertMachine(row("live", { state: "made.failed" }));
            yield* store.insertCheckpoint(failedCheckpoint("old", earlier));
            yield* store.insertCheckpoint(failedCheckpoint("at", before));
            yield* store.insertCheckpoint(
              checkpoint("ready", { state: "ready" })
            );
            yield* store.expire(before);

            return [
              (yield* store.machines).map(({ name }) => name),
              (yield* store.checkpoints).map(({ name }) => name),
            ] as const;
          })
        );

        expect(machines.toSorted()).toStrictEqual(["at", "live"]);
        expect(checkpoints.toSorted()).toStrictEqual(["at", "ready"]);
      })
  );

  it.effect(
    "a write that ends a row's hold on its instance retires it on its host, past the row, until it is forgotten once told",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;
        const error = new Internal({ message: "failed" });
        const at = DateTime.makeUnsafe("2026-10-05T00:00:00Z");

        const moving = (given: MachineRow) => ({
          next: { ...given, host: "other", instance: instance(9) },
          finish: false,
        });

        const read = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* Effect.forEach([1, 2, 3, 4], (n) =>
              store.insertMachine(row(`m${n}`, { instance: instance(n) }))
            );
            yield* Effect.forEach([5, 6], (n) =>
              store.insertCheckpoint(
                checkpoint(`c${n}`, { instance: instance(n) })
              )
            );
            yield* removing(store, "m1");
            yield* store.advance("machine", "m2", (given) => ({
              next: { ...given, state: "undone", error, undoneAt: at },
              finish: false,
            }));
            yield* store.advance("machine", "m3", moving);
            yield* store.advance("machine", "m4", (given) => ({
              next: { ...given, state: "made.settled" },
              finish: false,
            }));
            yield* store.advance("checkpoint", "c5", (given) => ({
              next: { ...given, state: "failed", error, failedAt: at },
              finish: false,
            }));
            yield* store.advance("checkpoint", "c6", () => ({
              next: "removed",
              finish: false,
            }));
            yield* store.insertMachine(row("m2", { instance: instance(7) }));
            yield* store.advance("machine", "m2", (given) => ({
              next: { ...given, state: "made.settled" },
              finish: false,
            }));

            const retired = yield* store.retired("linux");
            const elsewhere = yield* store.retired("other");

            yield* store.forgetRetired(DateTime.makeUnsafe(0));

            const kept = yield* store.retired("linux");

            yield* store.told(
              "linux",
              { gone: retired, left: { machines: [], checkpoints: [] } },
              at
            );
            yield* store.forgetRetired(
              DateTime.makeUnsafe("2100-01-01T00:00:00Z")
            );

            return {
              retired,
              elsewhere,
              kept,
              forgotten: yield* store.retired("linux"),
            };
          })
        );

        const none = { machines: [], checkpoints: [] };

        expect({
          machines: read.retired.machines.toSorted(),
          checkpoints: read.retired.checkpoints.toSorted(),
        }).toStrictEqual({
          machines: [instance(1), instance(2), instance(3)],
          checkpoints: [instance(5), instance(6)],
        });
        expect(read.elsewhere).toStrictEqual(none);
        expect(read.kept).toStrictEqual(read.retired);
        expect(read.forgotten).toStrictEqual(none);
      })
  );

  it.effect(
    "a retired instance is forgotten only once its host was first told of it before the time given, however long ago it was retired",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;
        const first = DateTime.makeUnsafe("2026-10-05T00:00:00Z");
        const later = DateTime.makeUnsafe("2026-10-06T00:00:00Z");

        const read = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* Effect.forEach([1, 2], (n) =>
              store.insertMachine(row(`m${n}`, { instance: instance(n) }))
            );
            yield* removing(store, "m1");

            const once = yield* store.retired("linux");

            yield* store.forgetRetired(
              DateTime.makeUnsafe("2100-01-01T00:00:00Z")
            );

            const untold = yield* store.retired("linux");

            yield* store.told(
              "linux",
              { gone: once, left: { machines: [], checkpoints: [] } },
              first
            );
            yield* removing(store, "m2");
            yield* store.told(
              "linux",
              {
                gone: yield* store.retired("linux"),
                left: { machines: [], checkpoints: [] },
              },
              later
            );
            yield* store.forgetRetired(first);

            const toldAtFirst = yield* store.retired("linux");

            yield* store.forgetRetired(DateTime.addDuration(first, "1 milli"));

            return {
              untold,
              toldAtFirst,
              forgotten: yield* store.retired("linux"),
            };
          })
        );

        expect(read.untold.machines).toStrictEqual([instance(1)]);
        expect(read.toldAtFirst.machines.toSorted()).toStrictEqual([
          instance(1),
          instance(2),
        ]);
        expect(read.forgotten.machines).toStrictEqual([instance(2)]);
      })
  );

  it.effect(
    "a retired instance a sweep left is untold, and outlives any forget until a sweep finds it gone",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;
        const first = DateTime.makeUnsafe("2026-10-05T00:00:00Z");
        const later = DateTime.makeUnsafe("2026-10-06T00:00:00Z");
        const longAfter = DateTime.makeUnsafe("2100-01-01T00:00:00Z");
        const none = { machines: [], checkpoints: [] };

        const read = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* store.insertMachine(row("m1", { instance: instance(1) }));
            yield* removing(store, "m1");

            const retired = yield* store.retired("linux");

            yield* store.told("linux", { gone: retired, left: none }, first);
            yield* store.told("linux", { gone: none, left: retired }, later);
            yield* store.forgetRetired(longAfter);

            const left = yield* store.retired("linux");

            yield* store.told("linux", { gone: retired, left: none }, later);
            yield* store.forgetRetired(DateTime.addDuration(later, "1 milli"));

            return { retired, left, forgotten: yield* store.retired("linux") };
          })
        );

        expect(read.retired.machines).toStrictEqual([instance(1)]);
        expect(read.left).toStrictEqual(read.retired);
        expect(read.forgotten).toStrictEqual({ machines: [], checkpoints: [] });
      })
  );

  it.effect(
    "checkpoint rows round-trip every leaf, and only a failed one gives way to a capture",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;
        const failedAt = DateTime.makeUnsafe("2026-10-04T14:00:00Z");
        const error = new Internal({ message: "ENOSPC" });

        const rows = checkpointLeaves.map((state) =>
          checkpoint(state, {
            state,
            ...(state === "failed" ? { error, failedAt } : {}),
            ...(state.startsWith("discarding") ? { error } : {}),
            ...(state === "ready"
              ? { pin: undefined, traits: presets.tart.traits }
              : {}),
            ...(state === "capturing.due" ? { build: "web@1" } : {}),
          })
        );

        const [listed, refused, replaced] = yield* withStore(
          stateDir,
          (store) =>
            Effect.gen(function* () {
              yield* Effect.forEach(rows, store.insertCheckpoint, {
                discard: true,
              });

              const read = yield* store.checkpoints;

              const conflicts = yield* Effect.forEach(resting, (name) =>
                Effect.flip(
                  store.insertCheckpoint(checkpoint(name, { machine: "other" }))
                )
              );

              yield* store.insertCheckpoint(
                checkpoint("failed", { machine: "other" })
              );

              return [
                read,
                conflicts,
                yield* store.findCheckpoint("failed"),
              ] as const;
            })
        );

        expect(
          listed.toSorted((a, b) => a.name.localeCompare(b.name))
        ).toStrictEqual(rows.toSorted((a, b) => a.name.localeCompare(b.name)));
        expect(refused).toStrictEqual(
          resting.map(
            (name) =>
              new Conflict({ message: `checkpoint ${name} exists`, id: name })
          )
        );
        expect(replaced).toStrictEqual(
          Option.some(checkpoint("failed", { machine: "other" }))
        );
      })
  );

  it.effect(
    "a checkpoint's advance writes only that checkpoint, and clears with undefined",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;
        const failedAt = DateTime.makeUnsafe("2026-10-04T14:00:00Z");
        const error = new Internal({ message: "EBUSY" });

        const [failed, cleared, other, none] = yield* withStore(
          stateDir,
          (store) =>
            Effect.gen(function* () {
              yield* store.insertCheckpoint(checkpoint("snap"));
              yield* store.insertCheckpoint(checkpoint("other"));
              yield* store.advance("checkpoint", "snap", (given) => ({
                next: { ...given, state: "failed", error, failedAt },
                finish: false,
              }));

              const first = yield* store.findCheckpoint("snap");

              yield* store.advance("checkpoint", "snap", (given) => ({
                next: {
                  ...given,
                  state: "deleting.due",
                  error: undefined,
                  failedAt: undefined,
                },
                finish: false,
              }));

              return [
                first,
                yield* store.findCheckpoint("snap"),
                yield* store.findCheckpoint("other"),
                yield* store.advance("checkpoint", "gone", () => ({
                  next: "removed",
                  finish: false,
                })),
              ] as const;
            })
        );

        expect(failed).toStrictEqual(
          Option.some(checkpoint("snap", { state: "failed", error, failedAt }))
        );
        expect(cleared).toStrictEqual(
          Option.some(checkpoint("snap", { state: "deleting.due" }))
        );
        expect(other).toStrictEqual(Option.some(checkpoint("other")));
        expect(none).toStrictEqual({ at: "absent" });
      })
  );

  it.effect(
    "a host's boot reads none until recorded, and the last one recorded after",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        const [before, first, second, other] = yield* withStore(
          stateDir,
          (store) =>
            Effect.gen(function* () {
              const unknown = yield* store.hostBoot("linux");

              yield* store.recordBoot("linux", "boot-1");

              const one = yield* store.hostBoot("linux");

              yield* store.recordBoot("linux", "boot-2");

              return [
                unknown,
                one,
                yield* store.hostBoot("linux"),
                yield* store.hostBoot("mac"),
              ] as const;
            })
        );

        expect(before).toStrictEqual(Option.none());
        expect(first).toStrictEqual(Option.some("boot-1"));
        expect(second).toStrictEqual(Option.some("boot-2"));
        expect(other).toStrictEqual(Option.none());
      })
  );

  it.effect(
    "a template's row and its builds round-trip through a reopen, a change writes what it decides or nothing, and a removal takes its builds",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        const ready: BuildRow = {
          number: 1,
          createdAt: DateTime.makeUnsafe("2026-10-04T12:00:00Z"),
          phase: "ready",
          error: undefined,
          host: "linux",
          pin: "smolvm 0.0.0-test linux-x64",
          image: "registry.example/ubuntu:24.04",
          base: "ubuntu",
          cpu: 2,
          ramMib: 4096,
          diskGib: 20,
          setupTimeoutSeconds: 600,
        };

        const failed: BuildRow = {
          number: 2,
          createdAt: DateTime.makeUnsafe("2026-10-04T12:05:00Z"),
          phase: "failed",
          error: new Internal({ message: "setup exited 3" }),
          host: "linux",
          pin: undefined,
          image: "debian",
          base: "debian",
          cpu: 1,
          ramMib: 1024,
          diskGib: 10,
          setupTimeoutSeconds: undefined,
        };

        const web: TemplateRow = {
          name: "web",
          createdAt: DateTime.makeUnsafe("2026-10-04T12:00:00Z"),
          builds: [ready, failed],
        };

        const api: TemplateRow = {
          name: "api",
          createdAt: web.createdAt,
          builds: [ready],
        };

        const rebuilt: TemplateRow = {
          ...web,
          builds: [{ ...failed, number: 3 }],
        };

        const [refused, unchanged] = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* store.advanceTemplate("web", () => Result.succeed(web));
            yield* store.advanceTemplate("api", () => Result.succeed(api));

            const conflict = yield* Effect.flip(
              store.advanceTemplate("web", () =>
                Result.fail(new Conflict({ message: "building", id: "web" }))
              )
            );

            return [conflict, yield* store.findTemplate("web")] as const;
          })
        );

        const [reopened, removed] = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            const read = yield* store.templates;

            yield* store.advanceTemplate("web", () =>
              Result.succeed("removed")
            );
            yield* store.advanceTemplate("web", () => Result.succeed(rebuilt));

            return [read, yield* store.templates] as const;
          })
        );

        expect(refused).toStrictEqual(
          new Conflict({ message: "building", id: "web" })
        );
        expect(unchanged).toStrictEqual(Option.some(web));
        expect(reopened).toStrictEqual([api, web]);
        expect(removed).toStrictEqual([api, rebuilt]);
      })
  );

  it.effect(
    "a state dir that 0.37 wrote gives each build its template's base, sizes and setup timeout",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateDirAt(5, (db) => {
          for (const migration of migrations.slice(0, 5)) {
            db.exec(migration);
          }

          db.exec(`INSERT INTO templates (name, created_at, base, cpu, ram_mib, disk_gib, setup_timeout_seconds)
              VALUES ('web', '2026-10-04T12:00:00.000Z', 'ubuntu', 2, 4096, 20, 600);
            INSERT INTO builds (template, number, created_at, phase, error, host, pin, image)
              VALUES ('web', 1, '2026-10-04T12:00:00.000Z', 'ready', NULL, 'linux', NULL, 'ubuntu'),
                ('web', 2, '2026-10-04T12:05:00.000Z', 'building', NULL, 'linux', NULL, 'ubuntu')`);
        });

        const read = yield* withStore(stateDir, (store) => store.templates);

        const facts = {
          error: undefined,
          host: "linux",
          pin: undefined,
          image: "ubuntu",
          base: "ubuntu",
          cpu: 2,
          ramMib: 4096,
          diskGib: 20,
          setupTimeoutSeconds: 600,
        };

        expect(read).toStrictEqual([
          {
            name: "web",
            createdAt: DateTime.makeUnsafe("2026-10-04T12:00:00Z"),
            builds: [
              {
                ...facts,
                number: 1,
                createdAt: DateTime.makeUnsafe("2026-10-04T12:00:00Z"),
                phase: "ready",
              },
              {
                ...facts,
                number: 2,
                createdAt: DateTime.makeUnsafe("2026-10-04T12:05:00Z"),
                phase: "building",
              },
            ],
          },
        ]);
      })
  );
});
