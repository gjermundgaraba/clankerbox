import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Conflict, Desired } from "@gjermundgaraba/clankerbox-sdk";
import { Arbitrary, DateTime, Effect, Option, Result } from "effect";
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
import type { CheckpointRecord, Intent } from "../../src/store.ts";
import { mkdir, readDirectory, scratch, write } from "@gjermundgaraba/clankerbox-sdk/testing";

const withStore = <A, E>(
  stateDir: string,
  use: (store: Effect.Success<ReturnType<typeof open>>) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(open({ stateDir, id: "linux", kind: "linux" }), use).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );

const opening = (stateDir: string, owner?: Partial<Owner>) =>
  Effect.flip(open({ stateDir, id: "linux", kind: "linux", ...owner })).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );

const ports = new Map<string, number>();

const portOf = (name: string): number => {
  const port = ports.get(name) ?? 11_000 + ports.size;

  ports.set(name, port);

  return port;
};

const intent = (name: string, fields?: Partial<Intent>): Intent => ({
  name,
  instance: "0123456789abcdef0123456789abcdef",
  createdAt: DateTime.makeUnsafe("2026-10-04T12:00:00Z"),
  base: "ubuntu",
  profile: undefined,
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  port: portOf(name),
  desired: "running",
  generation: 1,
  ephemeral: false,
  made: false,
  hostKey: undefined,
  pin: undefined,
  ...fields,
});

const checkpoint = (name: string, fields?: Partial<CheckpointRecord>): CheckpointRecord => ({
  name,
  instance: "fedcba9876543210fedcba9876543210",
  createdAt: DateTime.makeUnsafe("2026-10-04T13:00:00Z"),
  machine: "dev",
  pin: "smolvm 0.0.0-test linux-x64",
  port: 10_000,
  base: "ubuntu",
  profile: undefined,
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  ...fields,
});

layer(NodeServices.layer)((it) => {
  it.effect("init makes the state dir and a database at the binary's schema version", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      yield* withStore(stateDir, (store) => store.machines);

      const db = new DatabaseSync(join(stateDir, databaseFile));

      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: migrations.length });
      expect(db.prepare("PRAGMA application_id").get()).toEqual({ application_id: applicationId });
      db.close();
    }),
  );

  it.effect("machine rows round-trip whole, and a reopened database keeps them", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      const rows = [
        intent("dev", {
          profile: "small",
          port: 10_000,
          hostKey: "ssh-ed25519 AAAA",
          ephemeral: true,
          made: true,
          desired: "paused",
          generation: 4,
          pin: "smolvm 0.0.0-test linux-x64",
        }),
        intent("copy", { createdAt: DateTime.makeUnsafe("2026-10-04T12:01:00Z") }),
      ];

      yield* withStore(stateDir, (store) =>
        Effect.forEach(rows, store.insertMachine, { discard: true }),
      );

      const [listed, found] = yield* withStore(stateDir, (store) =>
        Effect.all([store.machines, store.findMachine("copy")]),
      );

      expect(listed).toEqual(rows);
      expect(Option.getOrUndefined(found)).toEqual(rows[1]);
    }),
  );

  it.effect("a second owner of the state dir is refused while the first holds it", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      const second = yield* withStore(stateDir, () => opening(stateDir));

      expect(second._tag).toBe("CannotStart");
      expect(second.message).toContain("another host process holds state dir");
      expect(yield* withStore(stateDir, (store) => store.machines)).toEqual([]);
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

      yield* withStore(stateDir, (store) => store.machines);

      const db = new DatabaseSync(join(stateDir, databaseFile));

      db.exec(`PRAGMA user_version = ${migrations.length + 1}`);
      db.close();

      const error = yield* opening(stateDir);

      expect(error._tag).toBe("CannotStart");
      expect(error.message).toContain("newer than this binary");
    }),
  );

  it.effect("a database refuses a host of another ID or kind, and keeps its rows for its own", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      yield* withStore(stateDir, (store) => store.insertMachine(intent("dev")));

      const renamed = yield* opening(stateDir, { id: "mac" });
      const moved = yield* opening(stateDir, { kind: "mac" });
      const kept = yield* withStore(stateDir, (store) => store.machines);

      expect(renamed).toEqual(
        new CannotStart({
          message: `${join(stateDir, databaseFile)} holds linux host linux, and this config names linux host mac: run it as linux host linux, or give it a new state dir`,
        }),
      );
      expect(moved.message).toContain("this config names mac host linux");
      expect(kept.map(({ name }) => name)).toEqual(["dev"]);
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

      expect(yield* withStore(stateDir, (store) => store.machines)).toEqual([]);
      expect((yield* readDirectory(stateDir)).sort()).toEqual([
        databaseFile,
        "lost+found",
        "notes.txt",
      ]);
    }),
  );

  it.effect(
    "another SQLite database under our file name is refused, and so is an earlier release's host database",
    () =>
      Effect.gen(function* () {
        const other = join(yield* scratch, "state");
        const earlier = join(yield* scratch, "state");

        yield* mkdir(other);
        yield* mkdir(earlier);

        const foreign = new DatabaseSync(join(other, databaseFile));

        foreign.exec("CREATE TABLE other (x)");
        foreign.close();

        const old = new DatabaseSync(join(earlier, databaseFile));

        old.exec("CREATE TABLE machines (name TEXT PRIMARY KEY)");
        old.exec(`PRAGMA user_version = 2; PRAGMA application_id = ${0x63_62_78_69}`);
        old.close();

        for (const stateDir of [other, earlier]) {
          const error = yield* opening(stateDir);

          expect(error._tag).toBe("CannotStart");
          expect(error.message).toContain("isn't a host database this clankerbox reads");
        }
      }),
  );

  it.effect("an empty database file, as a crash during init leaves, is initialized", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      yield* mkdir(stateDir);
      yield* write(join(stateDir, databaseFile), "");

      expect(yield* withStore(stateDir, (store) => store.machines)).toEqual([]);
    }),
  );

  it.effect(
    "a taken machine name is Conflict and writes nothing, and the unique index refuses a taken port",
    () =>
      Effect.gen(function* () {
        const stateDir = join(yield* scratch, "state");
        const first = intent("dev", { port: 10_000 });

        const [name, port, rows, ports] = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* store.insertMachine(first);

            return [
              yield* Effect.flip(
                store.insertMachine(intent("dev", { port: 10_001, base: "other" })),
              ),
              yield* Effect.flip(store.insertMachine(intent("other", { port: 10_000 }))),
              yield* store.machines,
              yield* store.ports,
            ] as const;
          }),
        );

        expect(name).toEqual(
          new Conflict({ message: "machine linux_dev exists", id: "linux_dev" }),
        );
        expect(port._tag).toBe("Internal");
        expect(port.message).toContain("insert machine linux_other");
        expect(rows).toEqual([first]);
        expect([...ports]).toEqual([10_000]);
      }),
  );

  it.effect("made, a host key and a boot's pin write only themselves, never what was asked", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      const [booted, unpinned] = yield* withStore(stateDir, (store) =>
        Effect.gen(function* () {
          yield* store.insertMachine(intent("dev"));
          yield* store.desire("dev", "stopped");
          yield* store.made("dev");
          yield* store.hostKey("dev", "ssh-ed25519 AAAAnew");
          yield* store.bootedUnder("dev", "smolvm 0.0.0-test linux-x64");

          const booted = yield* store.findMachine("dev");

          yield* store.bootedUnder("dev", undefined);

          return [booted, yield* store.findMachine("dev")] as const;
        }),
      );

      const written = intent("dev", {
        made: true,
        hostKey: "ssh-ed25519 AAAAnew",
        desired: "stopped",
        generation: 2,
      });

      expect(Option.getOrUndefined(booted)).toEqual({
        ...written,
        pin: "smolvm 0.0.0-test linux-x64",
      });
      expect(Option.getOrUndefined(unpinned)).toEqual(written);
    }),
  );

  it.effect(
    "a database the last release left, at schema version 1, gains the pause's pin and keeps its machines",
    () =>
      Effect.gen(function* () {
        const stateDir = join(yield* scratch, "state");

        yield* mkdir(stateDir);

        const old = new DatabaseSync(join(stateDir, databaseFile));

        old.exec(migrations[0] ?? "");
        old.exec(
          `INSERT INTO host (one, id, kind) VALUES (1, 'linux', 'linux');
           INSERT INTO machines (name, instance, created_at, base, profile, cpu, ram_mib,
             disk_gib, port, desired, generation, ephemeral, made, host_key)
           VALUES ('dev', '0123456789abcdef0123456789abcdef', '2026-10-04T12:00:00Z', 'ubuntu',
             NULL, 1, 1024, 10, 10000, 'running', 1, 0, 1, NULL);
           PRAGMA user_version = 1; PRAGMA application_id = ${applicationId}`,
        );
        old.close();

        const found = yield* withStore(stateDir, (store) => store.findMachine("dev"));

        expect(Option.getOrUndefined(found)).toEqual(intent("dev", { port: 10_000, made: true }));

        const db = new DatabaseSync(join(stateDir, databaseFile));

        expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
        db.close();
      }),
  );

  it.effect("removeMachine deletes the row and frees its name and port", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");

      const [rows, ports] = yield* withStore(stateDir, (store) =>
        Effect.gen(function* () {
          yield* store.insertMachine(intent("dev", { port: 10_000 }));
          yield* store.removeMachine("dev");
          yield* store.insertMachine(intent("dev", { port: 10_000, base: "again" }));
          yield* store.removeMachine("dev");

          return [yield* store.machines, yield* store.ports] as const;
        }),
      );

      expect(rows).toEqual([]);
      expect([...ports]).toEqual([]);
    }),
  );

  it.effect.prop(
    "desire numbers each request one past the last and keeps it, but never over a delete",
    [Arbitrary.array(Arbitrary.schema(Desired), { maxLength: 20 })],
    ([requests]) =>
      Effect.gen(function* () {
        const store = yield* open({
          stateDir: join(yield* scratch, "state"),
          id: "linux",
          kind: "linux",
        });

        yield* store.insertMachine(intent("dev", { made: true }));

        let model: Pick<Intent, "desired" | "generation"> = { desired: "running", generation: 1 };

        for (const desired of requests) {
          const answered = yield* store.desire("dev", desired);

          model = {
            desired: model.desired === "deleted" ? "deleted" : desired,
            generation: model.generation + 1,
          };

          const found = Option.getOrThrow(yield* store.findMachine("dev"));

          expect([
            Option.getOrUndefined(answered),
            { desired: found.desired, generation: found.generation },
          ]).toEqual([model, model]);
        }

        expect(Option.isNone(yield* store.desire("gone", "running"))).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a capture under way is no checkpoint: only unready and its row read it, until ready makes it one",
    () =>
      Effect.gen(function* () {
        const stateDir = join(yield* scratch, "state");
        const snap = checkpoint("snap", { profile: "small" });
        const disk = checkpoint("disk", { pin: undefined });

        const [before, foundBefore, unread, row, after, foundAfter, unreadAfter] = yield* withStore(
          stateDir,
          (store) =>
            Effect.gen(function* () {
              yield* store.beginCheckpoint(snap);
              yield* store.beginCheckpoint(disk);

              const seen = [
                yield* store.checkpoints,
                yield* store.findCheckpoint("snap"),
                yield* store.unready,
                yield* store.anyCheckpoint("snap"),
              ] as const;

              yield* store.readyCheckpoint("snap");

              return [
                ...seen,
                yield* store.checkpoints,
                yield* store.findCheckpoint("snap"),
                yield* store.unready,
              ] as const;
            }),
        );

        expect(before).toEqual([]);
        expect(foundBefore).toEqual(Option.none());
        expect(unread).toEqual([disk, snap]);
        expect(row).toEqual(Option.some(snap));
        expect(after).toEqual([snap]);
        expect(foundAfter).toEqual(Option.some(snap));
        expect(unreadAfter).toEqual([disk]);
      }),
  );

  it.effect(
    "a taken checkpoint name is Conflict and writes nothing, ready or not; a removed one frees it",
    () =>
      Effect.gen(function* () {
        const stateDir = join(yield* scratch, "state");
        const snap = checkpoint("snap");

        const [unreadTaken, readyTaken, kept, reused] = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* store.beginCheckpoint(snap);

            const unreadTaken = yield* Effect.flip(
              store.beginCheckpoint(checkpoint("snap", { machine: "other" })),
            );

            yield* store.readyCheckpoint("snap");

            const readyTaken = yield* Effect.flip(
              store.beginCheckpoint(checkpoint("snap", { machine: "other" })),
            );

            const kept = yield* store.checkpoints;

            yield* store.removeCheckpoint("snap");
            yield* store.beginCheckpoint(checkpoint("snap", { machine: "other" }));

            return [unreadTaken, readyTaken, kept, yield* store.unready] as const;
          }),
        );

        const conflict = new Conflict({
          message: "checkpoint linux_snap exists",
          id: "linux_snap",
        });

        expect(unreadTaken).toEqual(conflict);
        expect(readyTaken).toEqual(conflict);
        expect(kept).toEqual([snap]);
        expect(reused).toEqual([checkpoint("snap", { machine: "other" })]);
      }),
  );

  it.effect("checkpoint rows survive a reopen", () =>
    Effect.gen(function* () {
      const stateDir = join(yield* scratch, "state");
      const snap = checkpoint("snap");

      yield* withStore(stateDir, (store) =>
        Effect.andThen(store.beginCheckpoint(snap), store.readyCheckpoint("snap")),
      );

      expect(yield* withStore(stateDir, (store) => store.checkpoints)).toEqual([snap]);
    }),
  );
});
