import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import {
  Capacity,
  Conflict,
  formatId,
  Internal,
  PinMismatch,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  HostError,
  Machine,
  PrebuildRequest,
} from "@gjermundgaraba/clankerbox-sdk";
import { read } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { DateTime, Duration, Effect, Fiber, Option, Schedule } from "effect";
import { expect } from "vite-plus/test";

import { builderName } from "../src/checkpoints.ts";
import * as Sqlite from "../src/platform/sqlite.ts";
import type * as Store from "../src/store.ts";
import { fakeRuntime } from "./fake-runtime.ts";
import { at, eventually, failure, hostOn, pause, request } from "./support.ts";
import type { TestHost } from "./support.ts";

const ports = { first: 21_110, last: 21_119 };

const host = hostOn(ports);

const names = (testHost: TestHost) =>
  Effect.map(testHost.run(testHost.store.machines), (rows) =>
    rows.map(({ name }) => name)
  );

const checkpointNames = (testHost: TestHost) =>
  Effect.map(testHost.run(testHost.store.checkpoints), (rows) =>
    rows.map(({ name }) => name)
  );

const seeded = <A, E>(
  linux: TestHost,
  use: (store: Store.Interface) => Effect.Effect<A, E>
) =>
  Effect.scoped(
    Effect.flatMap(
      Sqlite.open({ stateDir: linux.stateDir, id: "linux", kind: "linux" }),
      use
    )
  );

const machineId = (testHost: TestHost, name: string) =>
  read(
    path.join(testHost.fake.root(name) ?? "", "var/lib/clankerbox/machine-id")
  );

const keyed = {
  script: [
    "#!/bin/sh",
    'mkdir -p "$CLANKERBOX_ROOT/etc/ssh"',
    ': >"$CLANKERBOX_ROOT/etc/ssh/ssh_host_ed25519_key"',
    'echo "ssh-ed25519 AAAAimage root@image" >"$CLANKERBOX_ROOT/etc/ssh/ssh_host_ed25519_key.pub"',
  ].join("\n"),
  timeoutSeconds: 30,
};

const withSource = (options?: Parameters<typeof host>[0]) =>
  Effect.gen(function* () {
    const linux = yield* host(options);

    yield* linux.run(
      linux.machines.create(
        request("dev", { profile: "small", setup: keyed }, options?.kind)
      )
    );
    linux.fake.calls.length = 0;

    return linux;
  });

const prebuild = (fields?: Partial<PrebuildRequest>): PrebuildRequest => ({
  id: "linux_prebuilt-0123456789ab",
  base: "ubuntu",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  setup: keyed,
  ...fields,
});

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "a fork copies the running machine to a new one, prepared with its own identity and port",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();
        const source = yield* linux.run(linux.machines.get("linux_dev"));
        const copy = yield* linux.run(linux.machines.fork("linux_dev", "copy"));

        expect(copy).toMatchObject({
          id: "linux_copy",
          base: "ubuntu",
          profile: "small",
          cpu: 1,
          ramMib: 1024,
          diskGib: 10,
          state: "running",
          desired: "running",
          phase: "settled",
        });
        expect([source.ssh?.port, copy.ssh?.port]).toStrictEqual([
          ports.first,
          ports.first + 1,
        ]);
        expect(copy.hostKey).toMatch(/^ssh-ed25519 AAAA[0-9a-f]+$/u);
        expect(copy.hostKey).not.toBe(source.hostKey);
        expect(yield* machineId(linux, "copy")).toBe("linux_copy\n");
        expect(yield* machineId(linux, "dev")).toBe("linux_dev\n");
        expect(linux.fake.calls).toStrictEqual([
          "admit linux_copy",
          "fork linux_copy",
          "start linux_copy",
          "exec linux_copy",
        ]);
      })
  );

  it.effect(
    "a fork shares its source: a stop of it waits for the copy, and a second fork copies beside the first",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();
        const { release, entered } = linux.fake.holdNext("fork");

        const fork = yield* Effect.forkChild(
          linux.run(linux.machines.fork("linux_dev", "copy"))
        );

        yield* entered;

        const other = yield* linux.run(
          linux.machines.fork("linux_dev", "other")
        );

        const stopping = yield* Effect.forkChild(
          linux.run(linux.machines.stop("linux_dev"))
        );

        yield* Effect.repeat(linux.run(linux.machines.get("linux_dev")), {
          until: (machine) => machine.phase === "stopping",
          schedule: Schedule.spaced(Duration.millis(10)),
        });
        yield* pause;

        const beforeRelease = [...linux.fake.calls];

        yield* release;

        const [copy, stopped] = yield* Effect.all([
          Fiber.join(fork),
          Fiber.join(stopping),
        ]);

        expect(beforeRelease).not.toContain("stop linux_dev");
        expect([copy, other].map(at)).toStrictEqual([
          ["running", "running", "settled"],
          ["running", "running", "settled"],
        ]);
        expect(at(stopped)).toStrictEqual(["stopped", "stopped", "settled"]);
      })
  );

  it.effect(
    "an admission during a fork counts the copy as booting, not the source the fork shares",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();
        const { release, entered } = linux.fake.holdNext("fork");

        const fork = yield* Effect.forkChild(
          linux.run(linux.machines.fork("linux_dev", "copy"))
        );

        const booting = () =>
          Object.fromEntries(
            (linux.fake.activations.at(-1)?.machines ?? []).map((activated) => [
              activated.machine.name,
              activated.booting,
            ])
          );

        yield* entered;
        yield* linux.run(linux.machines.create(request("other")));

        const duringFork = booting();

        yield* release;
        yield* Fiber.join(fork);
        yield* linux.run(linux.machines.create(request("later")));

        expect(duringFork).toStrictEqual({
          dev: false,
          copy: true,
          other: true,
        });
        expect(booting()).toStrictEqual({
          dev: false,
          copy: false,
          other: false,
          later: true,
        });
      })
  );

  it.effect("a fork refused at admission makes no new machine", () =>
    Effect.gen(function* () {
      const linux = yield* withSource();

      linux.fake.failNext("admit", new Capacity({ message: "no room" }));

      const error = yield* failure(
        linux,
        linux.machines.fork("linux_dev", "copy")
      );

      expect(error).toStrictEqual(new Capacity({ message: "no room" }));
      expect(yield* names(linux)).toStrictEqual(["dev"]);
    })
  );

  it.effect(
    "a fork of a source the runtime doesn't copy is refused, and makes no new machine",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        yield* linux.run(linux.machines.stop("linux_dev"));

        const error = yield* failure(
          linux,
          linux.machines.fork("linux_dev", "copy")
        );

        expect([error._tag, error.message]).toStrictEqual([
          "WrongState",
          "linux_dev is stopped: start it first",
        ]);
        expect(yield* names(linux)).toStrictEqual(["dev"]);
        expect(
          linux.fake.calls.filter((call) => call.startsWith("fork"))
        ).toStrictEqual(["fork linux_copy"]);
      })
  );

  it.effect(
    "a fork or restore that fails natively deletes its machine, and answers the failure",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        yield* linux.run(linux.checkpoints.capture("linux_dev", "snap"));

        for (const [name, operation, make] of [
          ["forked", "fork", () => linux.machines.fork("linux_dev", "forked")],
          [
            "restored",
            "restore",
            () => linux.machines.restore("linux_snap", "restored"),
          ],
        ] as const) {
          linux.fake.calls.length = 0;
          linux.fake.failNext(
            operation,
            new Internal({ message: "port swap failed" })
          );

          const error = yield* failure<Machine, HostError>(linux, make());

          const got = yield* failure(
            linux,
            linux.machines.get(`linux_${name}`)
          );

          expect([error._tag, error.message, got._tag]).toStrictEqual([
            "Internal",
            "port swap failed",
            "NotFound",
          ]);
          expect(linux.fake.calls).toStrictEqual([
            `admit linux_${name}`,
            `${operation} linux_${name}`,
            `delete linux_${name}`,
          ]);
        }

        expect(yield* names(linux)).toStrictEqual(["dev"]);
      })
  );

  it.effect(
    "a fork or restore that fails only in preparation leaves its machine made, and a start prepares it again",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        yield* linux.run(linux.checkpoints.capture("linux_dev", "snap"));

        for (const [name, make] of [
          ["forked", () => linux.machines.fork("linux_dev", "forked")],
          ["restored", () => linux.machines.restore("linux_snap", "restored")],
        ] as const) {
          linux.fake.failNext(
            "exec",
            new Internal({ message: "sshd didn't start" })
          );
          yield* failure<Machine, HostError>(linux, make());

          const row = Option.getOrUndefined(
            yield* linux.run(linux.store.findMachine(name))
          );

          linux.fake.calls.length = 0;

          const started = yield* linux.run(
            linux.machines.start(`linux_${name}`)
          );

          expect(row?.made).toBe(true);
          expect(at(started)).toStrictEqual(["running", "running", "settled"]);
          expect(linux.fake.calls).toStrictEqual([
            `start linux_${name}`,
            `exec linux_${name}`,
          ]);
        }
      })
  );

  it.effect("a fork to a taken name is Conflict, and calls nothing", () =>
    Effect.gen(function* () {
      const linux = yield* withSource();

      yield* linux.run(linux.machines.create(request("copy")));
      linux.fake.calls.length = 0;

      const error = yield* failure(
        linux,
        linux.machines.fork("linux_dev", "copy")
      );

      expect(error).toStrictEqual(
        new Conflict({ message: "machine linux_copy exists", id: "linux_copy" })
      );
      expect(linux.fake.calls).toStrictEqual([]);
    })
  );

  it.effect(
    "a capture to a taken name is Conflict, and leaves the checkpoint as it was",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        const first = yield* linux.run(
          linux.checkpoints.capture("linux_dev", "snap")
        );

        const error = yield* failure(
          linux,
          linux.checkpoints.capture("linux_dev", "snap")
        );

        expect(error).toStrictEqual(
          new Conflict({
            message: "checkpoint linux_snap exists",
            id: "linux_snap",
          })
        );
        expect(yield* linux.run(linux.checkpoints.list)).toStrictEqual([first]);
      })
  );

  it.effect(
    "IDs are checked whole: another host's source or checkpoint, or a new ID too long, is Invalid",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();
        const long = "a".repeat(57);

        const errors = yield* Effect.all(
          [
            failure(linux, linux.machines.fork("mac_dev", "copy")),
            failure(linux, linux.machines.fork("linux_dev", long)),
            failure(linux, linux.machines.restore("mac_snap", "copy")),
            failure(linux, linux.machines.restore("linux_snap", long)),
            failure(linux, linux.checkpoints.capture("mac_dev", "snap")),
            failure(linux, linux.checkpoints.capture("linux_dev", long)),
            failure(linux, linux.checkpoints.get("mac_snap")),
            failure(linux, linux.checkpoints.delete("mac_snap")),
            failure(
              linux,
              linux.checkpoints.prebuild(prebuild({ id: "mac_prebuilt" }))
            ),
          ],
          { concurrency: "unbounded" }
        );

        expect(errors.map(({ _tag }) => _tag)).toStrictEqual(
          Array.from({ length: 9 }, () => "Invalid")
        );
        expect(errors[1]?.message).toContain(`linux_${long}`);
        expect(linux.fake.calls).toStrictEqual([]);
      })
  );

  it.effect(
    "a capture of a running machine is ram, with the source's spec and the runtime's pin",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        const ram = yield* linux.run(
          linux.checkpoints.capture("linux_dev", "hot")
        );

        const rows = yield* linux.run(linux.store.checkpoints);

        expect(ram).toStrictEqual({
          id: "linux_hot",
          createdAt: ram.createdAt,
          machine: "linux_dev",
          kind: "ram",
          base: "ubuntu",
          profile: "small",
          cpu: 1,
          ramMib: 1024,
          diskGib: 10,
        });
        expect(rows.map(({ name, pin }) => [name, pin])).toStrictEqual([
          ["hot", "fake 1"],
        ]);
        expect(yield* linux.run(linux.checkpoints.list)).toStrictEqual([ram]);
      })
  );

  it.effect(
    "a capture of a stopped machine on a ram runtime is WrongState, and makes no checkpoint",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        yield* linux.run(linux.machines.stop("linux_dev"));

        const error = yield* failure(
          linux,
          linux.checkpoints.capture("linux_dev", "cold")
        );

        expect(error).toStrictEqual(
          new WrongState({
            message: "linux_dev is stopped: start it first",
            machine: "linux_dev",
            state: "stopped",
          })
        );
        expect(yield* checkpointNames(linux)).toStrictEqual([]);
        expect(yield* linux.run(linux.store.unready)).toStrictEqual([]);
        expect(linux.fake.calls).toContain("deleteCheckpoint linux_cold");
      })
  );

  it.effect("a mac capture of a stopped machine is disk, with no pin", () =>
    Effect.gen(function* () {
      const mac = yield* withSource({ kind: "mac" });

      yield* mac.run(mac.machines.stop("mac_dev"));

      const disk = yield* mac.run(mac.checkpoints.capture("mac_dev", "cold"));
      const rows = yield* mac.run(mac.store.checkpoints);

      expect(disk).toMatchObject({ id: "mac_cold", kind: "disk" });
      expect(rows.map(({ name, pin }) => [name, pin])).toStrictEqual([
        ["cold", undefined],
      ]);
    })
  );

  it.effect(
    "a capture sent while a create runs waits for the create, then captures",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();
        const { release, entered } = linux.fake.holdNext("create");

        const create = yield* Effect.forkChild(
          linux.run(linux.machines.create(request("dev")))
        );

        yield* entered;

        const capturing = yield* Effect.forkChild(
          linux.run(linux.checkpoints.capture("linux_dev", "snap"))
        );

        yield* pause;

        const beforeRelease = [...linux.fake.calls];

        yield* release;
        yield* Fiber.join(create);

        const snap = yield* Fiber.join(capturing);

        expect(beforeRelease).not.toContain("capture linux_snap");
        expect(snap.id).toBe("linux_snap");
      })
  );

  it.effect(
    "a capture of a machine the runtime doesn't have is Missing, and of no machine NotFound",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        linux.fake.machines.clear();

        const missing = yield* failure(
          linux,
          linux.checkpoints.capture("linux_dev", "snap")
        );

        const none = yield* failure(
          linux,
          linux.checkpoints.capture("linux_gone", "snap")
        );

        expect(missing._tag).toBe("Missing");
        expect(none._tag).toBe("NotFound");
        expect(yield* checkpointNames(linux)).toStrictEqual([]);
      })
  );

  it.effect(
    "a capture that fails natively makes no checkpoint, and deletes what it began",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        linux.fake.failNext("capture", new Internal({ message: "ENOTSUP" }));

        const error = yield* failure(
          linux,
          linux.checkpoints.capture("linux_dev", "snap")
        );

        const got = yield* failure(linux, linux.checkpoints.get("linux_snap"));

        expect(error.message).toBe("ENOTSUP");
        expect(got._tag).toBe("NotFound");
        expect(linux.fake.calls).toStrictEqual([
          "capture linux_snap",
          "deleteCheckpoint linux_snap",
        ]);
        expect(yield* linux.run(linux.store.unready)).toStrictEqual([]);
      })
  );

  it.effect(
    "a capture under way is no checkpoint yet: a restore or get of it is NotFound",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();
        const { release, entered } = linux.fake.holdNext("capture");

        const capture = yield* Effect.forkChild(
          linux.run(linux.checkpoints.capture("linux_dev", "snap"))
        );

        yield* entered;

        const restoring = yield* failure(
          linux,
          linux.machines.restore("linux_snap", "copy")
        );

        const listed = yield* linux.run(linux.checkpoints.list);

        yield* release;
        yield* Fiber.join(capture);

        expect(restoring._tag).toBe("NotFound");
        expect(listed).toStrictEqual([]);
        expect(yield* names(linux)).toStrictEqual(["dev"]);
      })
  );

  it.effect(
    "a restore makes a machine with the checkpoint's spec, prepared with a new identity, and may take its deleted source's name",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();
        const source = yield* linux.run(linux.machines.get("linux_dev"));

        yield* linux.run(linux.checkpoints.capture("linux_dev", "snap"));
        yield* linux.run(linux.machines.delete("linux_dev"));
        linux.fake.calls.length = 0;

        const restored = yield* linux.run(
          linux.machines.restore("linux_snap", "dev")
        );

        expect(restored).toMatchObject({
          id: "linux_dev",
          profile: "small",
          state: "running",
          phase: "settled",
          ssh: { host: "127.0.0.1", port: ports.first },
        });
        expect(source.ssh).toStrictEqual({
          user: "admin",
          host: "127.0.0.1",
          port: ports.first,
        });
        expect(restored.hostKey).not.toBe(source.hostKey);
        expect(yield* machineId(linux, "dev")).toBe("linux_dev\n");
        expect(linux.fake.calls).toStrictEqual([
          "admit linux_dev",
          "restore linux_dev",
          "start linux_dev",
          "exec linux_dev",
        ]);
        expect(yield* checkpointNames(linux)).toStrictEqual(["snap"]);
      })
  );

  it.effect(
    "restores of one checkpoint share it, so they run side by side",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        yield* linux.run(linux.checkpoints.capture("linux_dev", "snap"));

        const { release, entered } = linux.fake.holdNext("restore");

        const first = yield* Effect.forkChild(
          linux.run(linux.machines.restore("linux_snap", "one"))
        );

        yield* entered;

        const second = yield* linux.run(
          linux.machines.restore("linux_snap", "two")
        );

        yield* release;

        const one = yield* Fiber.join(first);

        expect([one.state, second.state]).toStrictEqual(["running", "running"]);
        expect([one.ssh?.port, second.ssh?.port]).toStrictEqual([
          ports.first + 1,
          ports.first + 2,
        ]);
      })
  );

  it.effect(
    "a capture of a machine a restore makes, into the checkpoint it reads, waits for the restore rather than deadlocking",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        yield* linux.run(linux.checkpoints.capture("linux_dev", "snap"));

        const { release, entered } = linux.fake.holdNext("admit");

        const restoring = yield* Effect.forkChild(
          linux.run(linux.machines.restore("linux_snap", "restored"))
        );

        yield* entered;

        const capturing = yield* Effect.forkChild(
          linux.run(
            Effect.flip(linux.checkpoints.capture("linux_restored", "snap"))
          )
        );

        yield* pause;
        yield* release;

        const [restored, refused] = yield* Effect.all([
          Fiber.join(restoring),
          Fiber.join(capturing),
        ]).pipe(Effect.timeout("5 seconds"));

        expect([restored.id, refused._tag]).toStrictEqual([
          "linux_restored",
          "Conflict",
        ]);
      })
  );

  it.effect(
    "a delete of a checkpoint waits for the restore that reads it, which succeeds",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        yield* linux.run(linux.checkpoints.capture("linux_dev", "snap"));

        const { release, entered } = linux.fake.holdNext("restore");

        const restore = yield* Effect.forkChild(
          linux.run(linux.machines.restore("linux_snap", "copy"))
        );

        yield* entered;

        const deleting = yield* Effect.forkChild(
          linux.run(linux.checkpoints.delete("linux_snap"))
        );

        yield* pause;

        const beforeRelease = [...linux.fake.calls];

        yield* release;

        const copy = yield* Fiber.join(restore);

        yield* Fiber.join(deleting);

        expect(beforeRelease).not.toContain("deleteCheckpoint linux_snap");
        expect(at(copy)).toStrictEqual(["running", "running", "settled"]);
        expect(yield* checkpointNames(linux)).toStrictEqual([]);
      })
  );

  it.effect(
    "a restore of no checkpoint is NotFound, and makes no machine",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        const none = yield* failure(
          linux,
          linux.machines.restore("linux_gone", "copy")
        );

        expect(none._tag).toBe("NotFound");
        expect(yield* names(linux)).toStrictEqual(["dev"]);
      })
  );

  it.effect(
    "a ram checkpoint restores only under its pin, and writes nothing otherwise",
    () =>
      Effect.gen(function* () {
        const first = yield* withSource();

        yield* first.run(first.checkpoints.capture("linux_dev", "hot"));
        yield* first.dispose;

        const upgraded = yield* host({
          dir: first.dir,
          fake: fakeRuntime({ dir: first.dir, pin: "fake 2" }),
        });

        const refused = yield* failure(
          upgraded,
          upgraded.machines.restore("linux_hot", "copy")
        );

        expect(refused).toStrictEqual(
          new PinMismatch({
            message:
              "checkpoint linux_hot holds RAM state saved under fake 1, and this host runs fake 2; it restores only under the same one",
          })
        );
        expect(upgraded.fake.calls).toStrictEqual([
          "startup",
          "sizes linux_dev",
        ]);
        expect(yield* names(upgraded)).toStrictEqual(["dev"]);
      })
  );

  it.effect(
    "a machine whose VM booted under another runtime build is captured or forked only after a stop and a start",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        yield* linux.run(linux.store.bootedUnder("dev", "fake 0"));

        const refused = [
          yield* failure(linux, linux.checkpoints.capture("linux_dev", "hot")),
          yield* failure(linux, linux.machines.fork("linux_dev", "copy")),
        ];

        expect(refused).toStrictEqual(
          Array.from(
            { length: 2 },
            () =>
              new PinMismatch({
                message:
                  "machine linux_dev's VM booted under fake 0, and this host runs fake 1, so a copy of its RAM would restore under the wrong one: stop it and start it again first",
              })
          )
        );
        expect(
          linux.fake.calls.filter((call) => /^(?:capture|fork) /u.test(call))
        ).toStrictEqual([]);
        expect(yield* names(linux)).toStrictEqual(["dev"]);
        expect(yield* checkpointNames(linux)).toStrictEqual([]);

        yield* linux.run(linux.machines.stop("linux_dev"));
        yield* linux.run(linux.machines.start("linux_dev"));
        yield* linux.run(linux.checkpoints.capture("linux_dev", "hot"));
        yield* linux.run(linux.machines.fork("linux_dev", "copy"));

        expect(yield* checkpointNames(linux)).toStrictEqual(["hot"]);
        expect(yield* names(linux)).toStrictEqual(["dev", "copy"]);
      })
  );

  it.effect("a capture cut short by the host's end deletes what it began", () =>
    Effect.gen(function* () {
      const linux = yield* withSource();
      const { entered } = linux.fake.holdNext("capture");

      yield* Effect.forkChild(linux.checkpoints.capture("linux_dev", "snap"));
      yield* entered;
      yield* linux.dispose;

      const restarted = yield* host({ fake: linux.fake, dir: linux.dir });

      expect(linux.fake.calls).toContain("deleteCheckpoint linux_snap");
      expect(yield* checkpointNames(restarted)).toStrictEqual([]);
      expect(yield* restarted.run(restarted.store.unready)).toStrictEqual([]);
    })
  );

  it.effect(
    "a capture a crash cut off is no checkpoint: the next host deletes it",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        yield* linux.dispose;
        yield* seeded(linux, (store) =>
          store.beginCheckpoint({
            name: "snap",
            instance: "cafe0001cafe0001cafe0001cafe0001",
            createdAt: DateTime.makeUnsafe("2026-10-15T10:00:00Z"),
            machine: "dev",
            pin: "fake 1",
            port: ports.first,
            base: "ubuntu",
            profile: undefined,
            cpu: 1,
            ramMib: 1024,
            diskGib: 10,
          })
        );
        linux.fake.calls.length = 0;

        const restarted = yield* host({ fake: linux.fake, dir: linux.dir });

        expect(linux.fake.calls).toStrictEqual([
          "deleteCheckpoint linux_snap",
          "startup",
          "sizes linux_dev",
        ]);
        expect(yield* checkpointNames(restarted)).toStrictEqual([]);
        expect(yield* restarted.run(restarted.store.unready)).toStrictEqual([]);

        const again = yield* restarted.run(
          restarted.checkpoints.capture("linux_dev", "snap")
        );

        expect(again.id).toBe("linux_snap");
      })
  );

  it.effect(
    "a checkpoint whose delete the last host's end cut off is gone, and the next host clears what it left",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        yield* linux.run(linux.checkpoints.capture("linux_dev", "snap"));

        const { entered } = linux.fake.holdNext("deleteCheckpoint");

        yield* Effect.forkChild(linux.checkpoints.delete("linux_snap"));
        yield* entered;
        yield* linux.dispose;
        linux.fake.calls.length = 0;

        const restarted = yield* host({ fake: linux.fake, dir: linux.dir });

        expect(yield* checkpointNames(restarted)).toStrictEqual([]);
        expect(yield* restarted.run(restarted.store.unready)).toStrictEqual([]);
        expect(
          linux.fake.calls.filter((call) => !call.startsWith("exec "))
        ).toStrictEqual([
          "deleteCheckpoint linux_snap",
          "startup",
          "sizes linux_dev",
        ]);
      })
  );

  it.effect(
    "a checkpoint whose native delete fails is gone, and the next delete clears what it left",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        yield* linux.run(linux.checkpoints.capture("linux_dev", "snap"));
        linux.fake.failNext(
          "deleteCheckpoint",
          new Internal({ message: "EBUSY" })
        );

        const error = yield* failure(
          linux,
          linux.checkpoints.delete("linux_snap")
        );

        const gone = yield* failure(linux, linux.checkpoints.get("linux_snap"));

        linux.fake.calls.length = 0;
        yield* linux.run(linux.checkpoints.delete("linux_snap"));

        expect([error.message, gone._tag]).toStrictEqual(["EBUSY", "NotFound"]);
        expect(linux.fake.calls).toStrictEqual(["deleteCheckpoint linux_snap"]);
        expect(yield* linux.run(linux.store.unready)).toStrictEqual([]);
        expect(
          (yield* failure(linux, linux.checkpoints.delete("linux_snap")))._tag
        ).toBe("NotFound");
      })
  );

  it.effect(
    "a capture whose cleanup fails too leaves what it began for the next host",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        linux.fake.failNext("capture", new Internal({ message: "ENOTSUP" }));
        linux.fake.failNext(
          "deleteCheckpoint",
          new Internal({ message: "EBUSY" })
        );

        yield* failure(linux, linux.checkpoints.capture("linux_dev", "snap"));

        const left = (yield* linux.run(linux.store.unready)).map(
          ({ name }) => name
        );

        yield* linux.dispose;
        linux.fake.calls.length = 0;

        const restarted = yield* host({ fake: linux.fake, dir: linux.dir });

        expect(left).toStrictEqual(["snap"]);
        expect(linux.fake.calls).toStrictEqual([
          "deleteCheckpoint linux_snap",
          "startup",
          "sizes linux_dev",
        ]);
        expect(yield* restarted.run(restarted.store.unready)).toStrictEqual([]);
      })
  );

  it.effect(
    "a capture under the name a failed cleanup left clears it first, on the same host",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        linux.fake.failNext("capture", new Internal({ message: "ENOTSUP" }));
        linux.fake.failNext(
          "deleteCheckpoint",
          new Internal({ message: "EBUSY" })
        );

        yield* failure(linux, linux.checkpoints.capture("linux_dev", "snap"));
        linux.fake.calls.length = 0;

        const again = yield* linux.run(
          linux.checkpoints.capture("linux_dev", "snap")
        );

        expect(again.id).toBe("linux_snap");
        expect(linux.fake.calls).toStrictEqual([
          "deleteCheckpoint linux_snap",
          "capture linux_snap",
        ]);
        expect([
          yield* checkpointNames(linux),
          yield* linux.run(linux.store.unready),
        ]).toStrictEqual([["snap"], []]);
      })
  );

  it.effect(
    "a prebuild builds the checkpoint from a machine of its own, setup and all, and deletes the machine after",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        const built = yield* linux.run(
          linux.checkpoints.prebuild(prebuild({ profile: "small" }))
        );

        expect(built).toMatchObject({
          id: "linux_prebuilt-0123456789ab",
          kind: "ram",
          base: "ubuntu",
          profile: "small",
        });
        expect(built.machine).toMatch(/^linux_prebuilding-[0-9a-f]{16}$/u);
        expect(
          linux.fake.calls.map((call) => call.split(" ")[0])
        ).toStrictEqual([
          "startup",
          "admit",
          "create",
          "exec",
          "start",
          "exec",
          "capture",
          "delete",
        ]);
        expect(yield* names(linux)).toStrictEqual([]);
      })
  );

  it.effect("a prebuild's builder ID fits the longest host ID", () =>
    Effect.gen(function* () {
      const id = yield* formatId("h".repeat(32), builderName());

      expect(id.length).toBeLessThanOrEqual(61);
    })
  );

  it.effect(
    "a prebuild that exists is built again, and replaced once the setup has run",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();
        const first = yield* linux.run(linux.checkpoints.prebuild(prebuild()));

        linux.fake.calls.length = 0;

        const again = yield* linux.run(linux.checkpoints.prebuild(prebuild()));

        expect(again.id).toBe(first.id);
        expect(again.machine).not.toBe(first.machine);
        expect(
          linux.fake.calls.map((call) => call.split(" ")[0])
        ).toStrictEqual([
          "admit",
          "create",
          "exec",
          "start",
          "exec",
          "deleteCheckpoint",
          "capture",
          "delete",
        ]);
        expect(yield* linux.run(linux.checkpoints.get(first.id))).toStrictEqual(
          again
        );
        expect(yield* checkpointNames(linux)).toStrictEqual([
          "prebuilt-0123456789ab",
        ]);
        expect(yield* names(linux)).toStrictEqual([]);
      })
  );

  it.effect(
    "a rebuild whose setup fails leaves the prebuild it would replace",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();
        const first = yield* linux.run(linux.checkpoints.prebuild(prebuild()));

        const error = yield* failure(
          linux,
          linux.checkpoints.prebuild(
            prebuild({ setup: { script: "#!/bin/sh\nexit 4\n" } })
          )
        );

        expect(error._tag).toBe("ScriptFailed");
        expect(yield* linux.run(linux.checkpoints.get(first.id))).toStrictEqual(
          first
        );
        expect(linux.fake.calls).not.toContain(`deleteCheckpoint ${first.id}`);
        expect(yield* names(linux)).toStrictEqual([]);
      })
  );

  it.effect(
    "a rebuild whose capture fails leaves no prebuild, and the next one builds it",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        yield* linux.run(linux.checkpoints.prebuild(prebuild()));
        linux.fake.failNext("capture", new Internal({ message: "ENOSPC" }));

        const error = yield* failure(
          linux,
          linux.checkpoints.prebuild(prebuild())
        );

        expect(error._tag).toBe("Internal");
        expect([
          yield* checkpointNames(linux),
          yield* linux.run(linux.store.unready),
        ]).toStrictEqual([[], []]);

        const again = yield* linux.run(linux.checkpoints.prebuild(prebuild()));

        expect(again.id).toBe("linux_prebuilt-0123456789ab");
        expect(yield* names(linux)).toStrictEqual([]);
      })
  );

  it.effect(
    "a rebuild replaces its prebuild only once the restores reading it are done",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();
        const first = yield* linux.run(linux.checkpoints.prebuild(prebuild()));
        const { release, entered } = linux.fake.holdNext("restore");

        const restoring = yield* Effect.forkChild(
          linux.run(linux.machines.restore(first.id, "copy"))
        );

        yield* entered;
        linux.fake.calls.length = 0;

        const rebuilding = yield* Effect.forkChild(
          linux.run(linux.checkpoints.prebuild(prebuild()))
        );

        yield* eventually(
          Effect.sync(() =>
            linux.fake.calls.filter((call) => call.startsWith("exec"))
          ),
          (execs) => execs.length === 2
        );
        yield* pause;

        expect(
          linux.fake.calls.filter((call) => call.startsWith("deleteCheckpoint"))
        ).toStrictEqual([]);

        yield* release;

        const copy = yield* Fiber.join(restoring);
        const again = yield* Fiber.join(rebuilding);
        const restored = linux.fake.calls.indexOf("restore linux_copy");

        expect(copy.id).toBe("linux_copy");
        expect(again.machine).not.toBe(first.machine);
        expect(
          linux.fake.calls.indexOf(`deleteCheckpoint ${first.id}`)
        ).toBeGreaterThan(restored);
      })
  );

  it.effect("a mac prebuild stops its builder before the capture", () =>
    Effect.gen(function* () {
      const mac = yield* host({ kind: "mac" });

      yield* mac.run(
        mac.checkpoints.prebuild(prebuild({ id: "mac_prebuilt-0123456789ab" }))
      );

      const ops = mac.fake.calls.map((call) => call.split(" ")[0]);

      expect(ops.indexOf("stop")).toBeGreaterThan(-1);
      expect(ops.indexOf("stop")).toBeLessThan(ops.indexOf("capture"));
    })
  );

  it.effect(
    "a prebuild whose setup fails deletes its builder and makes no checkpoint",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();

        const error = yield* failure(
          linux,
          linux.checkpoints.prebuild(
            prebuild({ setup: { script: "#!/bin/sh\nexit 4\n" } })
          )
        );

        expect(error._tag).toBe("ScriptFailed");
        expect(yield* names(linux)).toStrictEqual([]);
        expect(yield* checkpointNames(linux)).toStrictEqual([]);
        expect(linux.fake.calls.at(-1)).toMatch(/^delete linux_prebuilding-/u);
      })
  );

  it.effect("a builder a crash left behind is deleted by the next host", () =>
    Effect.gen(function* () {
      const linux = yield* host();

      yield* linux.run(
        linux.machines.create(request("prebuilding-0123456789abcdef"))
      );
      yield* linux.dispose;
      yield* seeded(linux, (store) =>
        Effect.flatMap(
          store.findMachine("prebuilding-0123456789abcdef"),
          (found) =>
            Effect.gen(function* () {
              const builder = Option.getOrThrow(found);

              yield* store.removeMachine(builder.name);
              yield* store.insertMachine({ ...builder, ephemeral: true });
            })
        )
      );
      linux.fake.calls.length = 0;

      const restarted = yield* host({ fake: linux.fake, dir: linux.dir });

      for (
        let tries = 0;
        tries < 100 && (yield* names(restarted)).length > 0;
        tries += 1
      ) {
        yield* pause;
      }

      expect(yield* names(restarted)).toStrictEqual([]);
      expect(linux.fake.calls).toStrictEqual([
        "startup",
        "delete linux_prebuilding-0123456789abcdef",
      ]);
    })
  );
});
