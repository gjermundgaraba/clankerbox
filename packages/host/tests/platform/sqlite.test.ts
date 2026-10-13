import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Conflict, NotFound, Precondition } from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Effect, Option, Result } from "effect";
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
import type { Interface, NewCheckpoint, NewMachine, NewRow, RowRef } from "../../src/store.ts";
import { mkdir, readDirectory, scratch, write } from "@gjermundgaraba/clankerbox-sdk/testing";

/** Runs `use` against the store on `stateDir`, opened for the call only. */
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
  native: undefined,
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

const inserting = (made: NewMachine): NewRow => ({ kind: "machine", record: made });

/** A fork's claims: its source, then its copy joined to it. */
const forking = (store: Interface, source: string, made: NewMachine) =>
  Effect.flatMap(store.hold("fork", machine(source)), ({ token }) =>
    store.insert("fork", inserting(made), token),
  );

/** A capture's claims: its source, then its checkpoint joined to it. */
const capturing = (store: Interface, made: NewCheckpoint) =>
  Effect.flatMap(store.hold("capture", machine(made.machine)), ({ token }) =>
    store.insert("capture", { kind: "checkpoint", record: made }, token),
  );

/** Inserts a machine row whose create is done, and so made. */
const planted = (store: Interface, made: NewMachine) =>
  Effect.flatMap(store.insert("create", inserting(made)), (token) =>
    Effect.andThen(
      store.markMade(token),
      store.end(token, { action: { name: "create", status: "done" } }),
    ),
  );

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

      yield* withStore(stateDir, (store) => store.insert("create", inserting(made)));

      const found = yield* withStore(stateDir, (store) => store.find("dev"));

      expect(Option.getOrUndefined(found)).toEqual({
        ...made,
        made: false,
        action: { name: "create", status: "running" },
      });
    }),
  );

  it.effect("a second owner of the state dir is refused while the first holds it", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      const second = yield* withStore(stateDir, () => opening(stateDir));

      expect(second._tag).toBe("Precondition");
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

      expect(error._tag).toBe("Precondition");
      expect(error.message).toContain("newer than this binary");
    }),
  );

  it.effect(
    "a database refuses a host of another ID or runtime, and keeps its rows for its own",
    () =>
      Effect.gen(function* () {
        const stateDir = join(yield* scratch, "state");

        yield* withStore(stateDir, (store) => store.insert("create", inserting(record("dev"))));

        const renamed = yield* opening(stateDir, { id: "mac" });
        const moved = yield* opening(stateDir, { runtime: "tart" });
        const kept = yield* withStore(stateDir, (store) => store.list);

        expect(renamed).toEqual(
          new Precondition({
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

      expect((yield* opening(stateDir, { id: "mac" }))._tag).toBe("Precondition");
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

      expect(error._tag).toBe("Precondition");
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
          yield* store.insert("create", inserting(record("dev", { port: 10_000 })));

          return [
            yield* Effect.flip(store.insert("create", inserting(record("dev", { port: 10_001 })))),
            yield* Effect.flip(
              store.insert("create", inserting(record("other", { port: 10_000 }))),
            ),
            (yield* store.list).map((row) => row.name),
          ] as const;
        }),
      );

      expect(name).toEqual(new Conflict({ message: "machine linux_dev exists", kind: "exists" }));
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
            const created = yield* store.insert("create", inserting(record("dev")));

            const busy = yield* Effect.flip(store.hold("start", machine("dev")));
            const missing = yield* Effect.flip(store.hold("start", machine("gone")));

            yield* store.end(created, { action: { name: "create", status: "done" } });

            const stopping = yield* store.hold("stop", machine("dev"));
            const after = yield* store.find("dev");

            return [
              busy,
              missing,
              [stopping.token.held, stopping.held, Option.getOrUndefined(after)],
            ] as const;
          }),
        );

        expect(busy).toEqual(
          new Conflict({ message: "machine linux_dev is busy: create is running", kind: "busy" }),
        );
        expect(missing).toEqual(new NotFound({ message: "no machine linux_gone" }));

        const stopping = {
          ...record("dev"),
          made: false,
          action: { name: "stop", status: "running" },
        };

        expect(claimed).toEqual([
          [{ kind: "machine", name: "dev", before: { name: "create", status: "done" } }],
          stopping,
          stopping,
        ]);
      }),
  );

  it.effect(
    "a release removes the rows its claim inserted and puts back what it replaced, at once",
    () =>
      Effect.gen(function* () {
        const stateDir = join(yield* scratch, "state");

        const rows = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* planted(store, record("dev"));

            const token = yield* forking(store, "dev", record("copy", { port: 10_001 }));

            yield* store.release(token);

            return (yield* store.list).map(({ name, action }) => [name, action]);
          }),
        );

        expect(rows).toEqual([["dev", { name: "create", status: "done" }]]);
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
              action: { name: "fork", status: "done" },
              prepared: { name: "copy", hostKey: "copy key" },
            });

            const start = yield* store.hold("start", machine("dev"));

            yield* store.end(start.token, {
              action: {
                name: "start",
                status: "failed",
                error: { tag: "Internal", message: "no" },
              },
            });

            return (yield* store.list).map(({ name, action, hostKey }) => [name, action, hostKey]);
          }),
        );

        expect(rows).toEqual([
          ["copy", { name: "fork", status: "done" }, "copy key"],
          [
            "dev",
            { name: "start", status: "failed", error: { tag: "Internal", message: "no" } },
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
            const created = yield* store.insert("create", inserting(record("dev")));

            yield* store.end(created, { action: { name: "create", status: "done" } });

            const fork = yield* forking(store, "dev", record("copy", { port: 10_001 }));

            yield* store.markMade(fork);
            yield* store.end(fork, {
              action: { name: "fork", status: "failed", error: { tag: "Internal", message: "no" } },
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

            yield* store.insert("create", inserting(record("dev")));
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

            const { token: source } = yield* store.hold("capture", machine("dev"));

            const taken = yield* Effect.flip(
              store.insert("capture", inserting(record("other", { port: 10_002 })), source),
            );

            const held = Option.getOrUndefined(yield* store.find("dev"))?.action;

            const joined = yield* store.insert(
              "capture",
              { kind: "checkpoint", record: checkpoint("snap") },
              source,
            );

            yield* store.release(joined);

            return [
              taken,
              held,
              [Option.getOrUndefined(yield* store.find("dev"))?.action, yield* store.checkpoints],
            ] as const;
          }),
        );

        expect(taken).toEqual(
          new Conflict({ message: "machine linux_other exists", kind: "exists" }),
        );
        expect(held).toEqual({ name: "capture", status: "running" });
        expect(released).toEqual([{ name: "create", status: "done" }, []]);
      }),
  );

  it.effect("startup marks every running action failed: the host restarted during it", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      const actions = yield* withStore(stateDir, (store) =>
        Effect.gen(function* () {
          yield* store.insert("create", inserting(record("a")));
          yield* planted(store, record("b", { port: 10_001 }));
          yield* store.failInterrupted;

          return (yield* store.list).map(({ name, action }) => [name, action]);
        }),
      );

      expect(actions).toEqual([
        [
          "a",
          {
            name: "create",
            status: "failed",
            error: { tag: "Internal", message: "host restarted during create" },
          },
        ],
        ["b", { name: "create", status: "done" }],
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
          action: "capture",
          inserted: [{ kind: "checkpoint", name: "snap" }],
          held: [{ kind: "machine", name: "dev", before: { name: "create", status: "done" } }],
        });
        expect(Option.getOrUndefined(source)?.action).toEqual({
          name: "capture",
          status: "running",
        });
        expect(busy).toEqual(
          new Conflict({ message: "machine linux_dev is busy: capture is running", kind: "busy" }),
        );
        expect(Option.getOrUndefined(found)).toEqual({
          ...made,
          action: { name: "capture", status: "running" },
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

            yield* store.end(captured, { action: { name: "capture", status: "done" } });

            const forked = yield* store.hold("fork", machine("dev"));

            const fork = yield* Effect.flip(
              store.insert("fork", inserting(record("copy")), forked.token),
            );

            const held = Option.getOrUndefined(yield* store.find("dev"))?.action;

            yield* store.release(forked.token);

            const again = yield* store.hold("capture", machine("dev"));

            const capture = yield* Effect.flip(
              store.insert(
                "capture",
                { kind: "checkpoint", record: checkpoint("snap") },
                again.token,
              ),
            );

            yield* store.release(again.token);

            return [fork, capture, held, yield* store.find("dev")] as const;
          }),
        );

        expect(fork).toEqual(
          new Conflict({ message: "machine linux_copy exists", kind: "exists" }),
        );
        expect(capture).toEqual(
          new Conflict({ message: "checkpoint linux_snap exists", kind: "exists" }),
        );
        expect(held).toEqual({ name: "fork", status: "running" });
        expect(Option.getOrUndefined(source)?.action).toEqual({ name: "capture", status: "done" });
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

      expect(missing).toEqual(new NotFound({ message: "no machine linux_dev" }));
      expect(rows).toEqual([
        ["copy", { name: "fork", status: "running" }],
        ["dev", { name: "fork", status: "running" }],
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

            const busy = yield* Effect.flip(store.hold("delete", snap("snap")));
            const missing = yield* Effect.flip(store.hold("delete", snap("gone")));

            yield* store.failInterrupted;

            return [busy, missing, (yield* store.checkpoints).map(({ action }) => action)] as const;
          }),
        );

        expect(busy).toEqual(
          new Conflict({
            message: "checkpoint linux_snap is busy: capture is running",
            kind: "busy",
          }),
        );
        expect(missing).toEqual(new NotFound({ message: "no checkpoint linux_gone" }));
        expect(actions).toEqual([
          {
            name: "capture",
            status: "failed",
            error: { tag: "Internal", message: "host restarted during capture" },
          },
        ]);
      }),
  );
});
