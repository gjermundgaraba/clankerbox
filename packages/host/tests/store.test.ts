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
  type MachineRecord,
  migrations,
  open,
  PortTaken,
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

const record = (name: string, fields?: Partial<MachineRecord>): MachineRecord => ({
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
  action: { name: "create", status: "running" },
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

  expect(Option.getOrUndefined(found)).toEqual(made);
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

test("a non-empty directory without our database is refused, and left alone", async () => {
  const stateDir = join(await scratch(owned), "state");

  await mkdir(stateDir);
  await writeFile(join(stateDir, "notes.txt"), "mine\n");

  const error = await opening(stateDir);

  expect(error._tag).toBe("Precondition");
  expect(error.message).toContain("isn't empty");
  expect(await readdir(stateDir)).toEqual(["notes.txt"]);
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

test("a taken name is Conflict{exists}, and a taken port is PortTaken", async () => {
  const stateDir = join(await scratch(owned), "state");

  const [name, port] = await withStore(stateDir, (store) =>
    Effect.gen(function* () {
      yield* store.insert(record("dev", { port: 10_000 }));

      return [
        yield* Effect.flip(store.insert(record("dev", { port: 10_001 }))),
        yield* Effect.flip(store.insert(record("other", { port: 10_000 }))),
      ] as const;
    }),
  );

  expect(name).toEqual(new Conflict({ message: "machine linux_dev exists", kind: "exists" }));
  expect(port).toEqual(new PortTaken({ port: 10_000 }));
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
