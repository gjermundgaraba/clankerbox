import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ActionRecord,
  Capacity,
  Conflict,
  Internal,
  NotFound,
  Refused,
  ScriptFailed,
  Unsizable,
} from "@gjermundgaraba/clankerbox-sdk";
import { Arbitrary, DateTime, Effect, Exit, Option, Result, Schema } from "effect";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import {
  applicationId,
  databaseFile,
  migrations,
  open,
  type Owner,
  transaction,
} from "../../src/platform/sqlite.ts";
import { CannotStart } from "../../src/startup.ts";
import type {
  Interface,
  NewCheckpoint,
  NewMachine,
  NewRow,
  RowRef,
  Token,
} from "../../src/store.ts";
import { mkdir, readDirectory, scratch, write } from "@gjermundgaraba/clankerbox-sdk/testing";

const withStore = <A, E>(
  stateDir: string,
  use: (store: Effect.Success<ReturnType<typeof open>>) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(open({ stateDir, id: "linux", runtime: "smolvm" }), use).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );

const opening = (stateDir: string, owner?: Partial<Owner>) =>
  Effect.flip(open({ stateDir, id: "linux", runtime: "smolvm", ...owner })).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );

const record = (name: string, fields?: Partial<NewMachine>): NewMachine => ({
  name,
  instance: "0123456789abcdef0123456789abcdef",
  native: undefined,
  createdAt: DateTime.makeUnsafe("2026-10-04T12:00:00Z"),
  base: "ubuntu",
  profile: undefined,
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  port: undefined,
  hostKey: undefined,
  ...fields,
});

const checkpoint = (name: string, fields?: Partial<NewCheckpoint>): NewCheckpoint => ({
  name,
  instance: "fedcba9876543210fedcba9876543210",
  createdAt: DateTime.makeUnsafe("2026-10-04T13:00:00Z"),
  machine: "dev",
  kind: "ram",
  pin: "smolvm 1.27.3 linux-x64",
  port: 10_000,
  base: "ubuntu",
  profile: undefined,
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  ...fields,
});

const machine = (name: string): RowRef<"machine"> => ({ kind: "machine", name });

const refused = (name: ActionRecord["name"]): ActionRecord => ({
  name,
  status: "failed",
  error: new Capacity({ message: "no room" }),
});

const inserting = (made: NewMachine): NewRow => ({ kind: "machine", record: made });

const forking = (store: Interface, source: string, made: NewMachine) =>
  Effect.flatMap(store.hold("forkMachine", machine(source)), ({ token }) =>
    store.insert("forkMachine", inserting(made), token),
  );

const capturing = (store: Interface, made: NewCheckpoint) =>
  Effect.flatMap(store.hold("captureCheckpoint", machine(made.machine)), ({ token }) =>
    store.insert("captureCheckpoint", { kind: "checkpoint", record: made }, token),
  );

const planted = (store: Interface, made: NewMachine) =>
  Effect.flatMap(store.insert("createMachine", inserting(made)), (token) =>
    Effect.andThen(
      store.markMade(token),
      store.end(token, { action: { name: "createMachine", status: "done" } }),
    ),
  );

const RowName = Schema.Literals(["a", "b", "c"]);

const Slot = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }));

const Step = Schema.Union([
  Schema.Struct({ op: Schema.Literal("createMachine"), name: RowName }),
  Schema.Struct({ op: Schema.Literal("startMachine"), name: RowName }),
  Schema.Struct({ op: Schema.Literal("forkMachine"), source: RowName, name: RowName }),
  Schema.Struct({ op: Schema.Literal("release"), slot: Slot }),
  Schema.Struct({ op: Schema.Literal("end"), slot: Slot, failed: Schema.Boolean }),
]);

interface Held {
  readonly token: Token;
  readonly action: ActionRecord["name"];
  readonly inserted: ReadonlyArray<string>;
  readonly held: ReadonlyArray<string>;
}

const outcome = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Exit.isSuccess(exit)
    ? "ok"
    : Option.match(Exit.findErrorOption(exit), {
        onNone: () => "a defect",
        onSome: (error) => (error instanceof Conflict ? `Conflict ${error.kind}` : error._tag),
      });

layer(NodeServices.layer)((it) => {
  it.effect("init makes the state dir and a database at the binary's schema version", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      yield* withStore(stateDir, (store) => store.list);

      const db = new DatabaseSync(join(stateDir, databaseFile));

      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: migrations.length });
      expect(db.prepare("PRAGMA application_id").get()).toEqual({ application_id: applicationId });
      db.close();
    }),
  );

  it.effect("rows round-trip, and a reopened database keeps them", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");
      const made = record("dev", { profile: "small", port: 10_000, hostKey: "ssh-ed25519 AAAA" });

      yield* withStore(stateDir, (store) => store.insert("createMachine", inserting(made)));

      const found = yield* withStore(stateDir, (store) => store.find("dev"));

      expect(Option.getOrUndefined(found)).toEqual({
        ...made,
        made: false,
        action: { name: "createMachine", status: "running" },
      });
    }),
  );

  it.effect("a second owner of the state dir is refused while the first holds it", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      const second = yield* withStore(stateDir, () => opening(stateDir));

      expect(second._tag).toBe("CannotStart");
      expect(second.message).toContain("another host process holds state dir");
      expect(yield* withStore(stateDir, (store) => store.list)).toEqual([]);
    }),
  );

  it.effect("another process can't open the state dir while the host holds it", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");
      const file = join(stateDir, databaseFile);

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
              { stdio: "pipe" },
            );

            return "read";
          } catch (cause) {
            return cause instanceof Error ? cause.message : "failed";
          }
        }),
      );

      expect(reader).toContain("database is locked");
    }),
  );

  it.effect("a database newer than the binary is refused", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      yield* withStore(stateDir, (store) => store.list);

      const db = new DatabaseSync(join(stateDir, databaseFile));

      db.exec(`PRAGMA user_version = ${migrations.length + 1}`);
      db.close();

      const error = yield* opening(stateDir);

      expect(error._tag).toBe("CannotStart");
      expect(error.message).toContain("newer than this binary");
    }),
  );

  it.effect(
    "a database refuses a host of another ID or runtime, and keeps its rows for its own",
    () =>
      Effect.gen(function* () {
        const stateDir = join(yield* scratch, "state");

        yield* withStore(stateDir, (store) =>
          store.insert("createMachine", inserting(record("dev"))),
        );

        const renamed = yield* opening(stateDir, { id: "mac" });
        const moved = yield* opening(stateDir, { runtime: "tart" });
        const kept = yield* withStore(stateDir, (store) => store.list);

        expect(renamed).toEqual(
          new CannotStart({
            message: `${join(stateDir, databaseFile)} holds host linux on smolvm, and this config names host mac on smolvm: run it as linux on smolvm, or give it a new state dir`,
          }),
        );
        expect(moved.message).toContain("this config names host linux on tart");
        expect(kept.map(({ name }) => name)).toEqual(["dev"]);
      }),
  );

  it.effect("a database from before hosts were recorded takes the first host that opens it", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      yield* mkdir(stateDir);

      const db = new DatabaseSync(join(stateDir, databaseFile));

      for (const migration of migrations.slice(0, 2)) {
        db.exec(migration);
      }

      db.exec(`PRAGMA user_version = 2; PRAGMA application_id = ${applicationId}`);
      db.close();

      yield* withStore(stateDir, (store) => store.list);

      expect((yield* opening(stateDir, { id: "mac" }))._tag).toBe("CannotStart");
    }),
  );

  it.effect(
    "a full database fails a transaction with SQLite's own error, which rolled it back",
    () =>
      Effect.gen(function* () {
        const db = new DatabaseSync(":memory:");

        db.exec("CREATE TABLE blobs (data BLOB) STRICT");
        db.exec("PRAGMA max_page_count = 4");

        const error = yield* transaction(db, "write a blob", () => {
          db.prepare("INSERT INTO blobs VALUES (?)").run(new Uint8Array(1 << 20));

          return Result.void;
        }).pipe(Effect.flip);

        expect(error.message).toBe("state database: write a blob: database or disk is full");
        expect(db.isTransaction).toBe(false);
        db.close();
      }),
  );

  it.effect("a directory that holds other files, as a mount point holds lost+found, is used", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      yield* mkdir(join(stateDir, "lost+found"));
      yield* write(join(stateDir, "notes.txt"), "mine\n");

      expect(yield* withStore(stateDir, (store) => store.list)).toEqual([]);
      expect((yield* readDirectory(stateDir)).sort()).toEqual([
        databaseFile,
        "lost+found",
        "notes.txt",
      ]);
    }),
  );

  it.effect("another SQLite database under our file name is refused", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      yield* mkdir(stateDir);

      const db = new DatabaseSync(join(stateDir, databaseFile));

      db.exec("CREATE TABLE other (x)");
      db.close();

      const error = yield* opening(stateDir);

      expect(error._tag).toBe("CannotStart");
      expect(error.message).toContain("isn't a clankerbox host database");
    }),
  );

  it.effect("an empty database file, as a crash during init leaves, is initialized", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      yield* mkdir(stateDir);
      yield* write(join(stateDir, databaseFile), "");

      expect(yield* withStore(stateDir, (store) => store.list)).toEqual([]);
    }),
  );

  it.effect("a taken name is Conflict{exists}, and the unique index refuses a taken port", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      const [name, port, names] = yield* withStore(stateDir, (store) =>
        Effect.gen(function* () {
          yield* store.insert("createMachine", inserting(record("dev", { port: 10_000 })));

          return [
            yield* Effect.flip(
              store.insert("createMachine", inserting(record("dev", { port: 10_001 }))),
            ),
            yield* Effect.flip(
              store.insert("createMachine", inserting(record("other", { port: 10_000 }))),
            ),
            (yield* store.list).map((row) => row.name),
          ] as const;
        }),
      );

      expect(name).toEqual(
        new Conflict({ message: "machine linux_dev exists", kind: "exists", id: "linux_dev" }),
      );
      expect(port._tag).toBe("Internal");
      expect(port.message).toContain("claim linux_other for create");
      expect(names).toEqual(["dev"]);
    }),
  );

  it.effect(
    "a claimed row is busy until its action ends, and a claim returns its record; a missing row is NotFound",
    () =>
      Effect.gen(function* () {
        const stateDir = join(yield* scratch, "state");

        const [busy, missing, claimed] = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            const created = yield* store.insert("createMachine", inserting(record("dev")));

            const busy = yield* Effect.flip(store.hold("startMachine", machine("dev")));
            const missing = yield* Effect.flip(store.hold("startMachine", machine("gone")));

            yield* store.end(created, { action: { name: "createMachine", status: "done" } });

            const stopping = yield* store.hold("stopMachine", machine("dev"));
            const after = yield* store.find("dev");

            return [
              busy,
              missing,
              [stopping.token.held, stopping.held, Option.getOrUndefined(after)],
            ] as const;
          }),
        );

        expect(busy).toEqual(
          new Conflict({
            message: "machine linux_dev is busy: create is running",
            kind: "busy",
            id: "linux_dev",
          }),
        );
        expect(missing).toEqual(
          new NotFound({ message: "no machine linux_gone", id: "linux_gone" }),
        );

        const stopping = {
          ...record("dev"),
          made: false,
          action: { name: "stopMachine", status: "running" },
        };

        expect(claimed).toEqual([[{ kind: "machine", name: "dev" }], stopping, stopping]);
      }),
  );

  it.effect(
    "a release removes the rows its claim inserted and records the failure on those it held, at once",
    () =>
      Effect.gen(function* () {
        const stateDir = join(yield* scratch, "state");

        const rows = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* planted(store, record("dev"));

            const token = yield* forking(store, "dev", record("copy", { port: 10_001 }));

            yield* store.release(token, refused("forkMachine"));

            return (yield* store.list).map(({ name, action }) => [name, action]);
          }),
        );

        expect(rows).toEqual([["dev", refused("forkMachine")]]);
      }),
  );

  it.effect(
    "an end records the outcome on every claimed row, and the host key on the prepared row only",
    () =>
      Effect.gen(function* () {
        const stateDir = join(yield* scratch, "state");

        const rows = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* planted(store, record("dev"));

            const fork = yield* forking(store, "dev", record("copy", { port: 10_001 }));

            yield* store.end(fork, {
              action: { name: "forkMachine", status: "done" },
              prepared: { name: "copy", hostKey: "copy key" },
            });

            const start = yield* store.hold("startMachine", machine("dev"));

            yield* store.end(start.token, {
              action: {
                name: "startMachine",
                status: "failed",
                error: new Internal({ message: "no" }),
              },
            });

            return (yield* store.list).map(({ name, action, hostKey }) => [name, action, hostKey]);
          }),
        );

        expect(rows).toEqual([
          ["copy", { name: "forkMachine", status: "done" }, "copy key"],
          [
            "dev",
            { name: "startMachine", status: "failed", error: new Internal({ message: "no" }) },
            undefined,
          ],
        ]);
      }),
  );

  it.effect(
    "markMade marks the machines its claim inserted made, not those it holds; an end marks none",
    () =>
      Effect.gen(function* () {
        const stateDir = join(yield* scratch, "state");

        const made = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            const created = yield* store.insert("createMachine", inserting(record("dev")));

            yield* store.end(created, { action: { name: "createMachine", status: "done" } });

            const fork = yield* forking(store, "dev", record("copy", { port: 10_001 }));

            yield* store.markMade(fork);
            yield* store.end(fork, {
              action: {
                name: "forkMachine",
                status: "failed",
                error: new Internal({ message: "no" }),
              },
            });

            return (yield* store.list).map(({ name, made }) => [name, made]);
          }),
        );

        expect(made).toEqual([
          ["copy", true],
          ["dev", false],
        ]);
      }),
  );

  it.effect(
    "recordNative keeps the runtime's ID on its row's instance, and refuses a row that's gone or another instance's",
    () =>
      Effect.gen(function* () {
        const stateDir = join(yield* scratch, "state");

        const [native, gone, other] = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            const { instance } = record("dev");

            yield* store.insert("createMachine", inserting(record("dev")));
            yield* store.recordNative("dev", instance, "bx_first");

            const found = yield* store.find("dev");

            return [
              Option.map(found, (row) => row.native),
              yield* Effect.flip(store.recordNative("gone", instance, "bx_second")),
              yield* Effect.flip(
                store.recordNative("dev", "ffffffffffffffffffffffffffffffff", "bx_third"),
              ),
            ] as const;
          }),
        );

        expect(native).toEqual(Option.some("bx_first"));
        expect([gone._tag, gone.message]).toEqual([
          "Internal",
          "state database: machine linux_gone of instance 0123456789abcdef0123456789abcdef is gone, so its native ID bx_second wasn't recorded",
        ]);
        expect(other._tag).toBe("Internal");
      }),
  );

  it.effect(
    "a claim joining another covers both rows, and a joining claim that fails writes nothing",
    () =>
      Effect.gen(function* () {
        const stateDir = join(yield* scratch, "state");

        const [taken, held, released] = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* planted(store, record("dev"));
            yield* planted(store, record("other", { port: 10_001 }));

            const { token: source } = yield* store.hold("captureCheckpoint", machine("dev"));

            const taken = yield* Effect.flip(
              store.insert(
                "captureCheckpoint",
                inserting(record("other", { port: 10_002 })),
                source,
              ),
            );

            const held = Option.getOrUndefined(yield* store.find("dev"))?.action;

            const joined = yield* store.insert(
              "captureCheckpoint",
              { kind: "checkpoint", record: checkpoint("snap") },
              source,
            );

            yield* store.release(joined, refused("captureCheckpoint"));

            return [
              taken,
              held,
              [Option.getOrUndefined(yield* store.find("dev"))?.action, yield* store.checkpoints],
            ] as const;
          }),
        );

        expect(taken).toEqual(
          new Conflict({
            message: "machine linux_other exists",
            kind: "exists",
            id: "linux_other",
          }),
        );
        expect(held).toEqual({ name: "captureCheckpoint", status: "running" });
        expect(released).toEqual([refused("captureCheckpoint"), []]);
      }),
  );

  it.effect("startup marks every running action failed: the host stopped during it", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      const actions = yield* withStore(stateDir, (store) =>
        Effect.gen(function* () {
          yield* store.insert("createMachine", inserting(record("a")));
          yield* planted(store, record("b", { port: 10_001 }));
          yield* store.failInterrupted;

          return (yield* store.list).map(({ name, action }) => [name, action]);
        }),
      );

      expect(actions).toEqual([
        [
          "a",
          {
            name: "createMachine",
            status: "failed",
            error: new Internal({ message: "the host stopped during createMachine" }),
          },
        ],
        ["b", { name: "createMachine", status: "done" }],
      ]);
    }),
  );

  it.effect(
    "a database at schema version 1 gains the checkpoint table and keeps its machines",
    () =>
      Effect.gen(function* () {
        const stateDir = join(yield* scratch, "state");

        yield* mkdir(stateDir);

        const db = new DatabaseSync(join(stateDir, databaseFile));

        db.exec(migrations[0] ?? "");
        db.exec(
          `INSERT INTO machines (name, instance, created_at, base, cpu, ram_mib, disk_gib, made,
        action_name, action_status) VALUES ('dev', 'abc', '2026-10-04T12:00:00.000Z', 'ubuntu', 1,
        1024, 10, 1, 'create', 'done')`,
        );
        db.exec(`PRAGMA user_version = 1; PRAGMA application_id = ${applicationId}`);
        db.close();

        const [machines, checkpoints] = yield* withStore(stateDir, (store) =>
          Effect.all([store.list, store.checkpoints]),
        );

        expect(machines.map(({ name }) => name)).toEqual(["dev"]);
        expect(checkpoints).toEqual([]);
      }),
  );

  it.effect("a database at schema version 3 drops the checkpoints' native and keeps them", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      yield* mkdir(stateDir);

      const db = new DatabaseSync(join(stateDir, databaseFile));

      for (const migration of migrations.slice(0, 3)) {
        db.exec(migration);
      }

      db.exec(
        `INSERT INTO checkpoints (name, instance, native, created_at, machine, kind, base, cpu,
        ram_mib, disk_gib, action_name, action_status) VALUES ('snap', 'abc', NULL,
        '2026-10-04T12:00:00.000Z', 'dev', 'disk', 'ubuntu', 1, 1024, 10, 'capture', 'done')`,
      );
      db.exec(`PRAGMA user_version = 3; PRAGMA application_id = ${applicationId}`);
      db.close();

      const checkpoints = yield* withStore(stateDir, (store) => store.checkpoints);

      expect(checkpoints.map(({ name }) => name)).toEqual(["snap"]);
      expect(checkpoints[0]).not.toHaveProperty("native");
    }),
  );

  it.effect(
    "a database at schema version 5 keeps each failed action's whole error, and names a Precondition by the message v0.16.0 wrote",
    () =>
      Effect.gen(function* () {
        const stateDir = join(yield* scratch, "state");

        yield* mkdir(stateDir);

        const db = new DatabaseSync(join(stateDir, databaseFile));

        for (const migration of migrations.slice(0, 5)) {
          db.exec(migration);
        }

        const exited = "setup exited 3; its last output:\ninstalling\nno network";
        const overran = "preparation ran past its 1m timeout; its last output:\nwaiting";

        const shrunk =
          "machine mac_small's disk of 20G is below its base's, and Tart only grows a disk: new disk size of 22 GB should be larger than the current disk size of 50 GB";

        const forbidden =
          "boat POST /sandboxes/bx_1/sshkey answered 403 api_key_action_forbidden: this API key may not add keys (req_0123)";

        const unmade =
          "machine linux_dev was never made: its create, fork or restore failed; delete it";

        const failed: ReadonlyArray<readonly [string, string | null, string | null]> = [
          ["done", null, null],
          ["taken", "Conflict", "machine linux_copy exists"],
          ["full", "Capacity", "no free port in 10000-10001 on 127.0.0.1"],
          ["setup", "Precondition", exited],
          ["preparation", "Precondition", overran],
          ["small", "Precondition", shrunk],
          ["forbidden", "Precondition", forbidden],
          ["unmade", "Precondition", unmade],
        ];

        for (const [name, tag, message] of failed) {
          db.prepare(
            `INSERT INTO machines (name, instance, created_at, base, cpu, ram_mib, disk_gib, made,
          action_name, action_status, action_error_tag, action_error_message) VALUES (?, 'abc',
          '2026-10-04T12:00:00.000Z', 'ubuntu', 1, 1024, 10, 1, 'forkMachine', ?, ?, ?)`,
          ).run(name, tag === null ? "done" : "failed", tag, message);
        }

        db.prepare(
          `INSERT INTO checkpoints (name, instance, created_at, machine, kind, base, cpu, ram_mib,
        disk_gib, action_name, action_status, action_error_tag, action_error_message) VALUES
        ('snap', 'abc', '2026-10-04T12:00:00.000Z', 'dev', 'disk', 'ubuntu', 1, 1024, 10,
        'captureCheckpoint', 'failed', 'Internal', 'the host stopped during captureCheckpoint')`,
        ).run();
        db.exec(`PRAGMA user_version = 5; PRAGMA application_id = ${applicationId}`);
        db.close();

        const [machines, checkpoints] = yield* withStore(stateDir, (store) =>
          Effect.all([store.list, store.checkpoints]),
        );

        expect(Object.fromEntries(machines.map(({ name, action }) => [name, action]))).toEqual({
          done: { name: "forkMachine", status: "done" },
          taken: {
            name: "forkMachine",
            status: "failed",
            error: new Conflict({ message: "machine linux_copy exists", kind: "exists" }),
          },
          full: {
            name: "forkMachine",
            status: "failed",
            error: new Capacity({ message: "no free port in 10000-10001 on 127.0.0.1" }),
          },
          setup: {
            name: "forkMachine",
            status: "failed",
            error: new ScriptFailed({ message: exited, script: "setup" }),
          },
          preparation: {
            name: "forkMachine",
            status: "failed",
            error: new ScriptFailed({ message: overran, script: "preparation" }),
          },
          small: {
            name: "forkMachine",
            status: "failed",
            error: new Unsizable({ message: shrunk }),
          },
          forbidden: {
            name: "forkMachine",
            status: "failed",
            error: new Refused({ message: forbidden }),
          },
          unmade: {
            name: "forkMachine",
            status: "failed",
            error: new Internal({ message: unmade }),
          },
        });
        expect(checkpoints[0]?.action).toEqual({
          name: "captureCheckpoint",
          status: "failed",
          error: new Internal({ message: "the host stopped during captureCheckpoint" }),
        });
      }),
  );

  it.effect("a database at schema version 4 records its actions under the contract's names", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      yield* mkdir(stateDir);

      const db = new DatabaseSync(join(stateDir, databaseFile));

      for (const migration of migrations.slice(0, 4)) {
        db.exec(migration);
      }

      const machineActions = ["create", "start", "stop", "delete", "fork", "restore", "capture"];

      for (const action of machineActions) {
        db.prepare(
          `INSERT INTO machines (name, instance, created_at, base, cpu, ram_mib, disk_gib, made,
          action_name, action_status) VALUES (?, 'abc', '2026-10-04T12:00:00.000Z', 'ubuntu', 1,
          1024, 10, 1, ?, 'done')`,
        ).run(action, action);
      }

      for (const action of ["capture", "delete"]) {
        db.prepare(
          `INSERT INTO checkpoints (name, instance, created_at, machine, kind, base, cpu, ram_mib,
          disk_gib, action_name, action_status) VALUES (?, 'abc', '2026-10-04T12:00:00.000Z',
          'dev', 'disk', 'ubuntu', 1, 1024, 10, ?, 'done')`,
        ).run(action, action);
      }

      db.exec(`PRAGMA user_version = 4; PRAGMA application_id = ${applicationId}`);
      db.close();

      const [machines, checkpoints] = yield* withStore(stateDir, (store) =>
        Effect.all([store.list, store.checkpoints]),
      );

      const named = (
        rows: ReadonlyArray<{ readonly name: string; readonly action: ActionRecord }>,
      ) => Object.fromEntries(rows.map(({ name, action }) => [name, action.name]));

      expect(named(machines)).toEqual({
        create: "createMachine",
        start: "startMachine",
        stop: "stopMachine",
        delete: "deleteMachine",
        fork: "forkMachine",
        restore: "restoreMachine",
        capture: "captureCheckpoint",
      });
      expect(named(checkpoints)).toEqual({
        capture: "captureCheckpoint",
        delete: "deleteCheckpoint",
      });
    }),
  );

  it.effect(
    "checkpoint rows round-trip, and a capture claims its source in the same transaction",
    () =>
      Effect.gen(function* () {
        const stateDir = join(yield* scratch, "state");
        const made = checkpoint("snap", { profile: "small" });

        const [token, source, busy, found] = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* planted(store, record("dev"));

            const token = yield* capturing(store, made);
            const source = yield* store.find("dev");
            const busy = yield* Effect.flip(capturing(store, checkpoint("other")));

            return [token, source, busy, yield* store.findCheckpoint("snap")] as const;
          }),
        );

        expect(token).toEqual({
          action: "captureCheckpoint",
          inserted: [{ kind: "checkpoint", name: "snap" }],
          held: [{ kind: "machine", name: "dev" }],
        });
        expect(Option.getOrUndefined(source)?.action).toEqual({
          name: "captureCheckpoint",
          status: "running",
        });
        expect(busy).toEqual(
          new Conflict({
            message: "machine linux_dev is busy: captureCheckpoint is running",
            kind: "busy",
            id: "linux_dev",
          }),
        );
        expect(Option.getOrUndefined(found)).toEqual({
          ...made,
          action: { name: "captureCheckpoint", status: "running" },
        });
      }),
  );

  it.effect(
    "a join with a taken new name writes nothing; the source stays held until its own release",
    () =>
      Effect.gen(function* () {
        const stateDir = join(yield* scratch, "state");

        const [fork, capture, held, source] = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* planted(store, record("dev"));
            yield* planted(store, record("copy", { port: 10_001 }));

            const captured = yield* capturing(store, checkpoint("snap"));

            yield* store.end(captured, { action: { name: "captureCheckpoint", status: "done" } });

            const forked = yield* store.hold("forkMachine", machine("dev"));

            const fork = yield* Effect.flip(
              store.insert("forkMachine", inserting(record("copy")), forked.token),
            );

            const held = Option.getOrUndefined(yield* store.find("dev"))?.action;

            yield* store.release(forked.token, refused("forkMachine"));

            const again = yield* store.hold("captureCheckpoint", machine("dev"));

            const capture = yield* Effect.flip(
              store.insert(
                "captureCheckpoint",
                { kind: "checkpoint", record: checkpoint("snap") },
                again.token,
              ),
            );

            yield* store.release(again.token, refused("captureCheckpoint"));

            return [fork, capture, held, yield* store.find("dev")] as const;
          }),
        );

        expect(fork).toEqual(
          new Conflict({ message: "machine linux_copy exists", kind: "exists", id: "linux_copy" }),
        );
        expect(capture).toEqual(
          new Conflict({
            message: "checkpoint linux_snap exists",
            kind: "exists",
            id: "linux_snap",
          }),
        );
        expect(held).toEqual({ name: "forkMachine", status: "running" });
        expect(Option.getOrUndefined(source)?.action).toEqual(refused("captureCheckpoint"));
      }),
  );

  it.effect("a fork inserts its row and claims its source; a missing source is NotFound", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");
      const copy = record("copy", { port: 10_001 });

      const [missing, rows] = yield* withStore(stateDir, (store) =>
        Effect.gen(function* () {
          const missing = yield* Effect.flip(forking(store, "dev", copy));

          yield* planted(store, record("dev"));
          yield* forking(store, "dev", copy);

          return [missing, (yield* store.list).map(({ name, action }) => [name, action])];
        }),
      );

      expect(missing).toEqual(new NotFound({ message: "no machine linux_dev", id: "linux_dev" }));
      expect(rows).toEqual([
        ["copy", { name: "forkMachine", status: "running" }],
        ["dev", { name: "forkMachine", status: "running" }],
      ]);
    }),
  );

  it.effect(
    "a claimed checkpoint is busy; a missing one is NotFound; startup fails its interrupted capture",
    () =>
      Effect.gen(function* () {
        const stateDir = join(yield* scratch, "state");
        const snap = (name: string): RowRef<"checkpoint"> => ({ kind: "checkpoint", name });

        const [busy, missing, actions] = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* planted(store, record("dev"));
            yield* capturing(store, checkpoint("snap"));

            const busy = yield* Effect.flip(store.hold("deleteCheckpoint", snap("snap")));
            const missing = yield* Effect.flip(store.hold("deleteCheckpoint", snap("gone")));

            yield* store.failInterrupted;

            return [busy, missing, (yield* store.checkpoints).map(({ action }) => action)] as const;
          }),
        );

        expect(busy).toEqual(
          new Conflict({
            message: "checkpoint linux_snap is busy: captureCheckpoint is running",
            kind: "busy",
            id: "linux_snap",
          }),
        );
        expect(missing).toEqual(
          new NotFound({ message: "no checkpoint linux_gone", id: "linux_gone" }),
        );
        expect(actions).toEqual([
          {
            name: "captureCheckpoint",
            status: "failed",
            error: new Internal({ message: "the host stopped during captureCheckpoint" }),
          },
        ]);
      }),
  );

  it.effect.prop(
    "claims behave as a model of rows and their holders: a held row is busy, a release undoes a claim and an end records it on every row",
    [Arbitrary.array(Arbitrary.schema(Step), { minLength: 10, maxLength: 40 })],
    ([steps]) =>
      Effect.gen(function* () {
        const store = yield* open({
          stateDir: join(yield* scratch, "state"),
          id: "linux",
          runtime: "smolvm",
        });

        const done: ActionRecord = { name: "createMachine", status: "done" };

        const rows = new Map<string, ActionRecord>([
          ["a", done],
          ["b", done],
        ]);

        const claims: Array<Held> = [];

        yield* Effect.forEach(["a", "b"], (name) => planted(store, record(name)));

        const claimed = (name: string, action: ActionRecord["name"]) => {
          const current = rows.get(name);

          if (current === undefined) {
            return Result.fail("NotFound");
          }

          if (current.status === "running") {
            return Result.fail("Conflict busy");
          }

          rows.set(name, { name: action, status: "running" });

          return Result.void;
        };

        for (const step of steps) {
          if (step.op === "createMachine") {
            const expected = rows.has(step.name) ? "Conflict exists" : "ok";

            const exit = yield* Effect.exit(
              store.insert("createMachine", inserting(record(step.name))),
            );

            expect(outcome(exit), JSON.stringify(step)).toBe(expected);

            if (Exit.isSuccess(exit)) {
              rows.set(step.name, { name: "createMachine", status: "running" });
              claims.push({
                token: exit.value,
                action: "createMachine",
                inserted: [step.name],
                held: [],
              });
            }
          } else if (step.op === "startMachine" || step.op === "forkMachine") {
            const source = step.op === "startMachine" ? step.name : step.source;
            const before = claimed(source, step.op);
            const exit = yield* Effect.exit(store.hold(step.op, machine(source)));

            expect(outcome(exit), JSON.stringify(step)).toBe(
              Result.match(before, { onSuccess: () => "ok", onFailure: (refusal) => refusal }),
            );

            if (Exit.isFailure(exit) || Result.isFailure(before)) {
              continue;
            }

            const holding: Held = {
              token: exit.value.token,
              action: step.op,
              inserted: [],
              held: [source],
            };

            if (step.op === "startMachine") {
              claims.push(holding);
              continue;
            }

            const copy = rows.has(step.name) ? "Conflict exists" : "ok";

            const joined = yield* Effect.exit(
              store.insert("forkMachine", inserting(record(step.name)), holding.token),
            );

            expect(outcome(joined), JSON.stringify(step)).toBe(copy);

            if (Exit.isSuccess(joined)) {
              rows.set(step.name, { name: "forkMachine", status: "running" });
              claims.push({ ...holding, token: joined.value, inserted: [step.name] });
            } else {
              claims.push(holding);
            }
          } else if (claims.length > 0) {
            const [claim] = claims.splice(step.slot % claims.length, 1);

            if (claim === undefined) {
              continue;
            }

            const names = [...claim.inserted, ...claim.held];

            if (step.op === "release") {
              yield* store.release(claim.token, refused(claim.action));

              claim.inserted.forEach((name) => rows.delete(name));
              claim.held.forEach((name) => rows.set(name, refused(claim.action)));
            } else {
              const action: ActionRecord = step.failed
                ? {
                    name: claim.action,
                    status: "failed",
                    error: new Internal({ message: "disk full" }),
                  }
                : { name: claim.action, status: "done" };

              yield* store.end(claim.token, { action });

              names.forEach((name) => rows.set(name, action));
            }
          }

          const listed = (yield* store.list).map(({ name, action }) => [name, action] as const);

          expect(new Map(listed), JSON.stringify(step)).toEqual(rows);
        }
      }).pipe(Effect.scoped),
    { timeout: 30_000, arbitrary: { runs: 50 } },
  );
});
