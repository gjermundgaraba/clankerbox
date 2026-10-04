import { execFileSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Conflict } from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Effect, Option } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import {
  applicationId,
  databaseFile,
  type NewCheckpoint,
  type NewMachine,
  migrations,
  open,
} from "../src/store.ts";
import { removeScratch, scratch } from "./scratch.ts";

const owned: Array<string> = [];

afterEach(() => removeScratch(owned));

/** Runs `use` against the store on `stateDir`, opened for the call only. */
const withStore = <A, E>(
  stateDir: string,
  use: (store: Effect.Success<ReturnType<typeof open>>) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(open(stateDir, "linux"), use).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  );

const opening = (stateDir: string) =>
  Effect.flip(open(stateDir, "linux")).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
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
  action: "create",
  ...fields,
});

const checkpoint = (name: string, fields?: Partial<NewCheckpoint>): NewCheckpoint => ({
  name,
  instance: "fedcba9876543210fedcba9876543210",
  native: undefined,
  createdAt: DateTime.makeUnsafe("2026-10-04T13:00:00Z"),
  machine: "dev",
  kind: "ram",
  pin: "smolvm 1.22.2 linux-x64",
  port: 10_000,
  base: "ubuntu",
  profile: undefined,
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  ...fields,
});

test("init makes the state dir and a database at the binary's schema version", async () => {
  const stateDir = join(await scratch(owned), "state");

  await withStore(stateDir, (store) => store.list);

  const db = new DatabaseSync(join(stateDir, databaseFile));

  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: migrations.length });
  expect(db.prepare("PRAGMA application_id").get()).toEqual({ application_id: applicationId });
  db.close();
});

test("rows round-trip, and a reopened database keeps them", async () => {
  const stateDir = join(await scratch(owned), "state");
  const made = record("dev", { profile: "small", port: 10_000, hostKey: "ssh-ed25519 AAAA" });

  await withStore(stateDir, (store) => store.insert(made));

  const found = await withStore(stateDir, (store) => store.find("dev"));

  expect(Option.getOrUndefined(found)).toEqual({
    ...made,
    action: { name: "create", status: "running" },
  });
});

test("a second owner of the state dir is refused while the first holds it", async () => {
  const stateDir = join(await scratch(owned), "state");

  const second = await withStore(stateDir, () => Effect.promise(() => opening(stateDir)));

  expect(second._tag).toBe("Precondition");
  expect(second.message).toContain("another host process holds state dir");
  await expect(withStore(stateDir, (store) => store.list)).resolves.toEqual([]);
});

test("another process can't open the state dir while the host holds it", async () => {
  const stateDir = join(await scratch(owned), "state");
  const file = join(stateDir, databaseFile);

  const reader = await withStore(stateDir, () =>
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
});

test("a database newer than the binary is refused", async () => {
  const stateDir = join(await scratch(owned), "state");

  await withStore(stateDir, (store) => store.list);

  const db = new DatabaseSync(join(stateDir, databaseFile));

  db.exec(`PRAGMA user_version = ${migrations.length + 1}`);
  db.close();

  const error = await opening(stateDir);

  expect(error._tag).toBe("Precondition");
  expect(error.message).toContain("newer than this binary");
});

test("a directory that holds other files, as a mount point holds lost+found, is used", async () => {
  const stateDir = join(await scratch(owned), "state");

  await mkdir(join(stateDir, "lost+found"), { recursive: true });
  await writeFile(join(stateDir, "notes.txt"), "mine\n");

  await expect(withStore(stateDir, (store) => store.list)).resolves.toEqual([]);
  expect((await readdir(stateDir)).sort()).toEqual([databaseFile, "lost+found", "notes.txt"]);
});

test("another SQLite database under our file name is refused", async () => {
  const stateDir = join(await scratch(owned), "state");

  await mkdir(stateDir);

  const db = new DatabaseSync(join(stateDir, databaseFile));

  db.exec("CREATE TABLE other (x)");
  db.close();

  const error = await opening(stateDir);

  expect(error._tag).toBe("Precondition");
  expect(error.message).toContain("isn't a clankerbox host database");
});

test("an empty database file, as a crash during init leaves, is initialized", async () => {
  const stateDir = join(await scratch(owned), "state");

  await mkdir(stateDir);
  await writeFile(join(stateDir, databaseFile), "");

  await expect(withStore(stateDir, (store) => store.list)).resolves.toEqual([]);
});

test("a taken name is Conflict{exists}, and the unique index refuses a taken port", async () => {
  const stateDir = join(await scratch(owned), "state");

  const [name, port, names] = await withStore(stateDir, (store) =>
    Effect.gen(function* () {
      yield* store.insert(record("dev", { port: 10_000 }));

      return [
        yield* Effect.flip(store.insert(record("dev", { port: 10_001 }))),
        yield* Effect.flip(store.insert(record("other", { port: 10_000 }))),
        (yield* store.list).map((row) => row.name),
      ] as const;
    }),
  );

  expect(name).toEqual(new Conflict({ message: "machine linux_dev exists", kind: "exists" }));
  expect(port._tag).toBe("Internal");
  expect(port.message).toContain("insert linux_other");
  expect(names).toEqual(["dev"]);
});

test("a claimed row is busy until its action ends; a missing row is NotFound", async () => {
  const stateDir = join(await scratch(owned), "state");

  const [busy, missing, claimed] = await withStore(stateDir, (store) =>
    Effect.gen(function* () {
      yield* store.insert(record("dev"));

      const busy = yield* Effect.flip(store.claim("dev", "start"));
      const missing = yield* Effect.flip(store.claim("gone", "start"));

      yield* store.record("dev", { action: { name: "create", status: "done" } });

      const before = yield* store.claim("dev", "stop");
      const after = yield* store.find("dev");

      return [busy, missing, [before.action, Option.getOrUndefined(after)?.action]] as const;
    }),
  );

  expect(busy).toEqual(
    new Conflict({ message: "machine linux_dev is busy: create is running", kind: "busy" }),
  );
  expect(missing._tag).toBe("NotFound");
  expect(claimed).toEqual([
    { name: "create", status: "done" },
    { name: "stop", status: "running" },
  ]);
});

test("startup marks every running action failed: the host restarted during it", async () => {
  const stateDir = join(await scratch(owned), "state");

  const actions = await withStore(stateDir, (store) =>
    Effect.gen(function* () {
      yield* store.insert(record("a"));
      yield* store.insert(record("b"));
      yield* store.record("b", { action: { name: "create", status: "done" } });
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
});

test("a database at schema version 1 gains the checkpoint table and keeps its machines", async () => {
  const stateDir = join(await scratch(owned), "state");

  await mkdir(stateDir);

  const db = new DatabaseSync(join(stateDir, databaseFile));

  db.exec(migrations[0] ?? "");
  db.exec(
    `INSERT INTO machines (name, instance, created_at, base, cpu, ram_mib, disk_gib, action_name,
      action_status) VALUES ('dev', 'abc', '2026-10-04T12:00:00.000Z', 'ubuntu', 1, 1024, 10,
      'create', 'done')`,
  );
  db.exec(`PRAGMA user_version = 1; PRAGMA application_id = ${applicationId}`);
  db.close();

  const [machines, checkpoints] = await withStore(stateDir, (store) =>
    Effect.all([store.list, store.checkpoints]),
  );

  expect(machines.map(({ name }) => name)).toEqual(["dev"]);
  expect(checkpoints).toEqual([]);
});

test("checkpoint rows round-trip, and a capture claims its source in the same transaction", async () => {
  const stateDir = join(await scratch(owned), "state");
  const made = checkpoint("snap", { profile: "small" });

  const [before, source, busy, found] = await withStore(stateDir, (store) =>
    Effect.gen(function* () {
      yield* store.insert(record("dev"));
      yield* store.record("dev", { action: { name: "create", status: "done" } });

      const before = yield* store.insertCheckpoint(made);
      const source = yield* store.find("dev");
      const busy = yield* Effect.flip(store.insertCheckpoint(checkpoint("other")));

      return [before, source, busy, yield* store.findCheckpoint("snap")] as const;
    }),
  );

  expect(before.action).toEqual({ name: "create", status: "done" });
  expect(Option.getOrUndefined(source)?.action).toEqual({ name: "capture", status: "running" });
  expect(busy).toEqual(
    new Conflict({ message: "machine linux_dev is busy: capture is running", kind: "busy" }),
  );
  expect(Option.getOrUndefined(found)).toEqual({
    ...made,
    action: { name: "capture", status: "running" },
  });
});

test("a taken new name rolls back the source's claim with it", async () => {
  const stateDir = join(await scratch(owned), "state");

  const [fork, capture, source] = await withStore(stateDir, (store) =>
    Effect.gen(function* () {
      yield* store.insert(record("dev"));
      yield* store.record("dev", { action: { name: "create", status: "done" } });
      yield* store.insert(record("copy", { port: 10_001 }));
      yield* store.insertCheckpoint(checkpoint("snap"));
      yield* store.recordCheckpoint("snap", { name: "capture", status: "done" });
      yield* store.record("dev", { action: { name: "capture", status: "done" } });

      return [
        yield* Effect.flip(store.insertFrom(record("copy", { action: "fork" }), "dev")),
        yield* Effect.flip(store.insertCheckpoint(checkpoint("snap"))),
        yield* store.find("dev"),
      ] as const;
    }),
  );

  expect(fork).toEqual(new Conflict({ message: "machine linux_copy exists", kind: "exists" }));
  expect(capture).toEqual(
    new Conflict({ message: "checkpoint linux_snap exists", kind: "exists" }),
  );
  expect(Option.getOrUndefined(source)?.action).toEqual({ name: "capture", status: "done" });
});

test("a fork inserts its row and claims its source; a missing source is NotFound", async () => {
  const stateDir = join(await scratch(owned), "state");

  const [missing, before, rows] = await withStore(stateDir, (store) =>
    Effect.gen(function* () {
      const missing = yield* Effect.flip(
        store.insertFrom(record("copy", { action: "fork" }), "dev"),
      );

      yield* store.insert(record("dev"));
      yield* store.record("dev", { action: { name: "create", status: "done" } });

      const before = yield* store.insertFrom(record("copy", { action: "fork" }), "dev");

      return [missing, before, (yield* store.list).map(({ name, action }) => [name, action])];
    }),
  );

  expect(missing._tag).toBe("NotFound");
  expect(before.action).toEqual({ name: "create", status: "done" });
  expect(rows).toEqual([
    ["copy", { name: "fork", status: "running" }],
    ["dev", { name: "fork", status: "running" }],
  ]);
});

test("a claimed checkpoint is busy; a missing one is NotFound; startup fails its interrupted capture", async () => {
  const stateDir = join(await scratch(owned), "state");

  const [busy, missing, actions] = await withStore(stateDir, (store) =>
    Effect.gen(function* () {
      yield* store.insert(record("dev"));
      yield* store.record("dev", { action: { name: "create", status: "done" } });
      yield* store.insertCheckpoint(checkpoint("snap"));

      const busy = yield* Effect.flip(store.claimCheckpoint("snap", "delete"));
      const missing = yield* Effect.flip(store.claimCheckpoint("gone", "delete"));

      yield* store.failInterrupted;

      return [busy, missing, (yield* store.checkpoints).map(({ action }) => action)] as const;
    }),
  );

  expect(busy).toEqual(
    new Conflict({ message: "checkpoint linux_snap is busy: capture is running", kind: "busy" }),
  );
  expect(missing._tag).toBe("NotFound");
  expect(actions).toEqual([
    {
      name: "capture",
      status: "failed",
      error: { tag: "Internal", message: "host restarted during capture" },
    },
  ]);
});
