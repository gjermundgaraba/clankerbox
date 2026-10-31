import { execFileSync } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import {
  Conflict,
  Desired,
  Internal,
  NotFound,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  mkdir,
  readDirectory,
  scratch,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Arbitrary, DateTime, Effect, Option, Result, Schema } from "effect";
import { expect } from "vite-plus/test";

import type { MachineRow } from "../../src/machine-chart.ts";
import {
  applicationId,
  databaseFile,
  migrations,
  open,
  transaction,
} from "../../src/platform/sqlite.ts";
import type {
  CheckpointRow,
  Interface,
  Lease,
  Operation,
} from "../../src/store.ts";
import { applying } from "../support.ts";

const earlierApplicationIds = [0x63_62_78_69, 0x63_62_78_73];

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

const row = (name: string, fields?: Partial<MachineRow>): MachineRow => ({
  name,
  instance: "0123456789abcdef0123456789abcdef",
  createdAt: DateTime.makeUnsafe("2026-10-04T12:00:00Z"),
  kind: "linux",
  base: "ubuntu",
  profile: undefined,
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  host: "linux",
  port: undefined,
  desired: "running",
  state: "making.due",
  prepared: false,
  error: undefined,
  resize: undefined,
  ephemeral: false,
  source: { kind: "base", scripted: false },
  prebuild: undefined,
  hostKey: undefined,
  pin: undefined,
  undoneAt: undefined,
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
  kind: "linux",
  pin: "smolvm 0.0.0-test linux-x64",
  port: 10_000,
  base: "ubuntu",
  profile: undefined,
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  phase: "capturing",
  error: undefined,
  failedAt: undefined,
  ...fields,
});

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
    seen: "stopped",
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

    const taken = (yield* store.operations).find(({ id }) => id === wanted.id);

    if (taken === undefined) {
      return yield* Effect.die(`${wanted.id} wasn't begun`);
    }

    return taken;
  });

const found = (store: Interface, name: string) =>
  Effect.map(store.findMachine(name), Option.getOrThrow);

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
            kind: "mac",
            profile: "small",
            port: 10_000,
            hostKey: "ssh-ed25519 AAAA",
            ephemeral: true,
            state: "made.failed",
            prepared: true,
            desired: "paused",
            error: new Internal({ message: "sshd didn't start" }),
            resize: { cpu: 2, diskGib: 20 },
            source: { kind: "checkpoint", name: "snap" },
            prebuild: "prebuilt-0123456789ab",
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
        const snap = checkpoint("snap", { phase: "ready" });

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
                yield* store.operations,
                yield* beginning(store, operation("dev")),
                yield* begun(store, operation("other")),
                yield* store.hostBoot("linux"),
                yield* store.checkpoints,
                yield* found(store, "dev"),
              ] as const;
            })
          );

        expect(operations).toStrictEqual([held]);
        expect(conflict).toStrictEqual({ at: "busy" });
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

          return Result.void;
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
    "a taken machine name is Conflict and writes nothing, and a host's taken port fails, while another host may use it",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;
        const first = row("dev", { port: 10_000 });
        const elsewhere = row("away", { host: "mac", port: 10_000 });

        const [name, port, rows] = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* store.insertMachine(first);
            yield* store.insertMachine(elsewhere);

            return [
              yield* Effect.flip(
                store.insertMachine(row("dev", { port: 10_001, base: "other" }))
              ),
              yield* Effect.flip(
                store.insertMachine(row("other", { port: 10_000 }))
              ),
              yield* store.machines,
            ] as const;
          })
        );

        expect(name).toStrictEqual(
          new Conflict({ message: "machine dev exists", id: "dev" })
        );
        expect(port._tag).toBe("Internal");
        expect(port.message).toContain("insert machine other");
        expect(rows).toStrictEqual([elsewhere, first]);
      })
  );

  it.effect(
    "machines without a port yet may share a host, and a removed row frees its name and port",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        const rows = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* store.insertMachine(row("one"));
            yield* store.insertMachine(row("two"));
            yield* store.insertMachine(row("dev", { port: 10_000 }));
            yield* removing(store, "dev");
            yield* store.insertMachine(row("dev", { port: 10_000 }));
            yield* store.insertMachine(row("gone", { port: 10_001 }));
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

  it.effect.prop(
    "requests through the chart keep the last wish but never over a delete, and start the row afresh in one write",
    [Arbitrary.array(Arbitrary.schema(Desired), { maxLength: 20 })],
    ([requests]) =>
      Effect.gen(function* () {
        const store = yield* open({ stateDir: yield* stateIn });
        const error = new Internal({ message: "earlier" });

        const row0 = row("dev", {
          state: "made.failed",
          error,
          prepared: true,
        });

        yield* store.insertMachine(row0);

        let { desired: kept, prepared } = row0;
        let state: MachineRow["state"] = row0.state;
        let cleared: MachineRow["error"] = error;

        for (const desired of requests) {
          const answered = yield* applying(
            store,
            "dev",
            desired === "deleted"
              ? { type: "delete" }
              : { type: "ask", desired }
          );

          if (desired === "deleted") {
            state = "deleting.due";
            cleared = undefined;
          } else if (state !== "deleting.due") {
            state = "made.observing";
            cleared = undefined;
            kept = desired;
            prepared = desired === "running" ? false : prepared;
          }

          const model: MachineRow = {
            ...row0,
            desired: kept,
            prepared,
            state,
            error: cleared,
          };

          expect(answered).toMatchObject({ at: "written", next: model });
          expect(yield* found(store, "dev")).toStrictEqual(model);
        }

        expect(
          yield* applying(store, "gone", { type: "ask", desired: "running" })
        ).toStrictEqual({ at: "absent" });
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.effect("a row left undone moves for no request, and its error stays", () =>
    Effect.gen(function* () {
      const stateDir = yield* stateIn;

      const undone = row("dev", {
        state: "undone",
        error: new Internal({ message: "setup failed" }),
      });

      const [asked, resized, after] = yield* withStore(stateDir, (store) =>
        Effect.gen(function* () {
          yield* store.insertMachine(undone);

          return [
            yield* applying(store, "dev", {
              type: "ask",
              desired: "stopped",
            }),
            yield* applying(store, "dev", {
              type: "resize",
              sizing: { cpu: 2 },
            }),
            yield* found(store, "dev"),
          ] as const;
        })
      );

      expect(asked).toStrictEqual({
        at: "written",
        next: undone,
        moved: false,
      });
      expect(resized).toStrictEqual(asked);
      expect(after).toStrictEqual(undone);
    })
  );

  it.effect(
    "a resize keeps the sizes asked, starts the row afresh, and leaves what was asked of it",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        const before = row("dev", {
          state: "made.failed",
          desired: "stopped",
          error: new Internal({ message: "earlier" }),
          prepared: true,
        });

        const [answered, other] = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* store.insertMachine(before);
            yield* store.insertMachine(row("other"));

            return [
              yield* applying(store, "dev", {
                type: "resize",
                sizing: { ramMib: 2048 },
              }),
              yield* found(store, "other"),
            ] as const;
          })
        );

        expect(answered).toStrictEqual({
          at: "written",
          moved: true,
          next: {
            ...before,
            resize: { ramMib: 2048 },
            state: "made.observing",
            error: undefined,
          },
        });
        expect(other).toStrictEqual(row("other"));
      })
  );

  it.effect(
    "advance writes the row decide answers, and a key set to undefined clears its column; the row it was given writes nothing; no row answers absent",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;
        const before = row("dev", { pin: "fake 1", hostKey: "key" });

        const [same, unchanged, written, current, gone] = yield* withStore(
          stateDir,
          (store) =>
            Effect.gen(function* () {
              yield* store.insertMachine(before);

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
                    port: 10_000,
                    prepared: true,
                    pin: undefined,
                  },
                  finish: false,
                })),
                yield* found(store, "dev"),
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
          port: 10_000,
          prepared: true,
          pin: undefined,
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
        expect(gone).toStrictEqual({ at: "absent" });
      })
  );

  it.effect("a machine's every column writes through advance", () =>
    Effect.gen(function* () {
      const stateDir = yield* stateIn;

      const fields = {
        instance: "abcd",
        createdAt: DateTime.makeUnsafe("2026-10-04T12:01:00Z"),
        kind: "mac",
        base: "macos",
        profile: "large",
        cpu: 8,
        ramMib: 2048,
        diskGib: 40,
        host: "mac",
        port: 10_001,
        desired: "paused",
        state: "undoing.held",
        prepared: true,
        error: new NotFound({ message: "no checkpoint snap", id: "snap" }),
        resize: { cpu: 8 },
        ephemeral: true,
        source: { kind: "machine", name: "other" },
        prebuild: "prebuilt-0123456789ab",
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

  it.effect("a row at a leaf the chart hasn't is no row", () =>
    Effect.gen(function* () {
      const stateDir = yield* stateIn;

      const error = yield* withStore(stateDir, (store) =>
        Effect.gen(function* () {
          yield* store.insertMachine(
            // @ts-expect-error a row can't name a leaf the chart hasn't
            row("dev", { state: "made.nowhere" })
          );

          return yield* Effect.flip(store.machines);
        })
      );

      expect(error._tag).toBe("Internal");
      expect(error.message).toContain("list machines");
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

        let held: readonly Operation[] = [];
        let cpu = 1;
        let last = 0;

        for (const step of script) {
          if (step.action === "finish") {
            const [oldest, ...rest] = held;

            if (oldest !== undefined) {
              yield* store.finish(oldest, { row: "kept" });
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

            const inFlight = held.flatMap(({ leases }) => leases);
            const free = step.leases.every((lease) => holds(lease, inFlight));

            if (step.subject === "machine") {
              const answered = yield* store.advance(
                "machine",
                "subject",
                (given) => ({
                  next: { ...given, cpu: given.cpu + 1 },
                  begin: wanted,
                  finish: false,
                })
              );

              expect(answered.at).toBe(free ? "written" : "busy");
              cpu += free ? 1 : 0;
            } else {
              expect(Option.isSome(yield* store.begin(wanted))).toBe(free);
            }

            if (free) {
              const taken = (yield* store.operations).find(
                ({ id }) => id === wanted.id
              );

              expect(taken).toStrictEqual({
                ...wanted,
                sequence: taken?.sequence,
              });
              expect(taken?.sequence).toBeGreaterThan(last);
              last = taken?.sequence ?? last;
              held = taken === undefined ? held : [...held, taken];
            }
          }

          expect(yield* store.operations).toStrictEqual(held);
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

              const first = yield* begun(
                store,
                operation("one", { leases: [share("snap")] })
              );

              const second = yield* begun(
                store,
                operation("two", { leases: [share("snap")] })
              );

              const refused = yield* store.begin(
                operation("snap", {
                  resource: "checkpoint",
                  leases: [own("snap")],
                })
              );

              const beside = yield* beginning(store, operation("snap"));

              yield* store.finish(first, { row: "kept" });
              yield* store.finish(second, { row: "kept" });

              return [
                first,
                second,
                refused,
                beside,
                yield* store.begin(
                  operation("snap", {
                    resource: "checkpoint",
                    leases: [own("snap")],
                  })
                ),
              ] as const;
            })
        );

        expect([one.name, two.name]).toStrictEqual(["one", "two"]);
        expect(owner).toStrictEqual(Option.none());
        expect(apart.at).toBe("written");
        expect(Option.isSome(afterwards)).toBe(true);
      })
  );

  it.effect(
    "a begin writes its row with the lease, and neither when it is refused, and a write that fails takes the lease back",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        const [taken, refused, after, none, broken, operations, thrown] =
          yield* withStore(stateDir, (store) =>
            Effect.gen(function* () {
              yield* store.insertMachine(row("dev"));
              yield* store.insertMachine(row("full", { port: 10_000 }));
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
                    next: { ...given, port: 10_000 },
                    begin: operation("other"),
                    finish: false,
                  }))
                ),
                yield* store.operations,
                yield* Effect.flip(
                  store.advance("machine", "other", () => {
                    throw new Error("a chart threw");
                  })
                ),
              ] as const;
            })
          );

        expect(taken.at).toBe("written");
        expect(refused).toStrictEqual({ at: "busy" });
        expect(after).toStrictEqual(
          row("dev", { state: "made.stepping.starting", pin: "fake 2" })
        );
        expect(none).toStrictEqual({ at: "absent" });
        expect(broken._tag).toBe("Internal");
        expect(operations.map(({ name }) => name)).toStrictEqual(["dev"]);
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

            yield* begun(
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

      const [operations, after, again] = yield* withStore(stateDir, (store) =>
        Effect.gen(function* () {
          yield* store.insertMachine(row("dev", { port: 10_000 }));
          yield* beginning(store, operation("dev"));
          yield* store.advance("machine", "dev", (given) => ({
            next: { ...given, state: "made.observing", prepared: true },
            finish: true,
          }));

          return [
            yield* store.operations,
            yield* found(store, "dev"),
            yield* beginning(store, operation("dev")),
          ] as const;
        })
      );

      expect(operations).toStrictEqual([]);
      expect(after).toStrictEqual(
        row("dev", { port: 10_000, state: "made.observing", prepared: true })
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

        const operations = yield* withStore(
          stateDir,
          (store) => store.operations
        );

        expect(left.resize).toBeUndefined();
        expect(operations.map(({ to }) => to)).toStrictEqual([{ cpu: 2 }]);
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

              const deleting = Option.getOrThrow(
                yield* store.begin(
                  operation("snap", {
                    resource: "checkpoint",
                    kind: "deleteCheckpoint",
                    leases: [
                      { resource: "checkpoint", name: "snap", mode: "own" },
                    ],
                  })
                )
              );

              yield* store.advance("machine", "dev", () => ({
                next: "removed",
                finish: true,
              }));
              yield* store.finish(keeping, { row: "kept" });
              yield* store.finish(deleting, { row: "checkpoint-removed" });

              return [
                yield* store.machines,
                yield* store.checkpoints,
                yield* store.operations,
              ] as const;
            })
        );

        expect(machines).toStrictEqual([row("kept")]);
        expect(checkpoints).toStrictEqual([]);
        expect(operations).toStrictEqual([]);
      })
  );

  it.effect(
    "a capture's end writes only from capturing, so a delete asked meanwhile stands",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;

        const [kept, written] = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* store.insertCheckpoint(checkpoint("deleted"));
            yield* store.insertCheckpoint(checkpoint("snap"));

            const captures = yield* Effect.forEach(
              ["deleted", "snap"],
              (name) =>
                Effect.map(
                  store.begin(
                    operation(name, {
                      resource: "checkpoint",
                      kind: "capture",
                      leases: [{ resource: "checkpoint", name, mode: "own" }],
                    })
                  ),
                  Option.getOrThrow
                )
            );

            yield* store.patchCheckpoint("deleted", { phase: "deleting" });
            yield* Effect.forEach(
              captures,
              (op) =>
                store.finish(op, {
                  row: "checkpoint",
                  from: "capturing",
                  patch: { phase: "ready" },
                }),
              { discard: true }
            );

            return [
              yield* store.findCheckpoint("deleted"),
              yield* store.findCheckpoint("snap"),
            ] as const;
          })
        );

        expect(Option.getOrThrow(kept).phase).toBe("deleting");
        expect(Option.getOrThrow(written).phase).toBe("ready");
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
          checkpoint(name, { phase: "failed", error, failedAt });

        const [machines, checkpoints] = yield* withStore(stateDir, (store) =>
          Effect.gen(function* () {
            yield* store.insertMachine(failedRow("old", earlier));
            yield* store.insertMachine(failedRow("at", before));
            yield* store.insertMachine(row("live", { state: "made.failed" }));
            yield* store.insertCheckpoint(failedCheckpoint("old", earlier));
            yield* store.insertCheckpoint(failedCheckpoint("at", before));
            yield* store.insertCheckpoint(
              checkpoint("ready", { phase: "ready" })
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
    "checkpoint rows round-trip every phase, and only a failed one gives way to a capture",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* stateIn;
        const failedAt = DateTime.makeUnsafe("2026-10-04T14:00:00Z");

        const rows = [
          checkpoint("capturing", { profile: "small" }),
          checkpoint("ready", { phase: "ready", pin: undefined, kind: "mac" }),
          checkpoint("discarding", {
            phase: "discarding",
            error: new Internal({ message: "ENOSPC" }),
          }),
          checkpoint("deleting", { phase: "deleting" }),
          checkpoint("failed", {
            phase: "failed",
            error: new Internal({ message: "ENOSPC" }),
            failedAt,
          }),
        ];

        const [listed, refused, replaced] = yield* withStore(
          stateDir,
          (store) =>
            Effect.gen(function* () {
              yield* Effect.forEach(rows, store.insertCheckpoint, {
                discard: true,
              });

              const read = yield* store.checkpoints;

              const conflicts = yield* Effect.forEach(
                ["capturing", "ready", "discarding", "deleting"],
                (name) =>
                  Effect.flip(
                    store.insertCheckpoint(
                      checkpoint(name, { machine: "other" })
                    )
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
          ["capturing", "ready", "discarding", "deleting"].map(
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
    "a checkpoint patch writes only that checkpoint, and clears with undefined",
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
              yield* store.patchCheckpoint("snap", {
                phase: "failed",
                error,
                failedAt,
              });

              const first = yield* store.findCheckpoint("snap");

              yield* store.patchCheckpoint("snap", {
                phase: "deleting",
                error: undefined,
                failedAt: undefined,
              });
              yield* store.removeCheckpoint("gone");

              return [
                first,
                yield* store.findCheckpoint("snap"),
                yield* store.findCheckpoint("other"),
                yield* store.findCheckpoint("gone"),
              ] as const;
            })
        );

        expect(failed).toStrictEqual(
          Option.some(checkpoint("snap", { phase: "failed", error, failedAt }))
        );
        expect(cleared).toStrictEqual(
          Option.some(checkpoint("snap", { phase: "deleting" }))
        );
        expect(other).toStrictEqual(Option.some(checkpoint("other")));
        expect(none).toStrictEqual(Option.none());
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
});
