import * as NodeServices from "@effect/platform-node/NodeServices";
import { join } from "node:path";
import {
  Capacity,
  Conflict,
  type HostError,
  Internal,
  Precondition,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Fiber } from "effect";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { fakeRuntime } from "./fake-runtime.ts";
import { read, scratch } from "@gjermundgaraba/clankerbox-sdk/testing";
import { request, startHost, type TestHost } from "./support.ts";

/** No other test file's host gives out these ports. */
const ports = { first: 21_110, last: 21_119 };

const host = (options?: Parameters<typeof startHost>[1] & { readonly dir?: string }) =>
  Effect.gen(function* () {
    return yield* startHost(options?.dir ?? (yield* scratch), { ports, ...options });
  });

const failure = <A, E>(host: TestHost, effect: Effect.Effect<A, E>) =>
  host.run(Effect.flip(effect));

const actions = (host: TestHost) =>
  Effect.map(host.run(host.store.list), (rows) =>
    Object.fromEntries(rows.map(({ name, action }) => [name, action])),
  );

const checkpointActions = (host: TestHost) =>
  Effect.map(host.run(host.store.checkpoints), (rows) =>
    Object.fromEntries(rows.map(({ name, action }) => [name, action])),
  );

/** What a refused action records on the rows it held. */
const refused = (name: string, error: HostError) => ({ name, status: "failed", error });

const machineId = (host: TestHost, name: string) =>
  read(join(host.fake.root(name) ?? "", "var/lib/clankerbox/machine-id"));

const withSource = (options?: Parameters<typeof host>[0]) =>
  Effect.gen(function* () {
    const linux = yield* host(options);

    yield* linux.run(
      linux.machines.create(
        request("dev", {
          profile: "small",
          setup: {
            script: [
              "#!/bin/sh",
              'mkdir -p "$CLANKERBOX_ROOT/etc/ssh"',
              ': >"$CLANKERBOX_ROOT/etc/ssh/ssh_host_ed25519_key"',
              'echo "ssh-ed25519 AAAAimage root@image" >"$CLANKERBOX_ROOT/etc/ssh/ssh_host_ed25519_key.pub"',
            ].join("\n"),
            timeoutSeconds: 30,
          },
        }),
      ),
    );
    linux.fake.calls.length = 0;

    return linux;
  });

// The host runs on the real clock, as it does in `clankerbox host`.
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
          action: { name: "forkMachine", status: "done" },
        });
        expect([source.ssh?.port, copy.ssh?.port]).toEqual([ports.first, ports.first + 1]);
        expect(copy.hostKey).toMatch(/^ssh-ed25519 AAAA[0-9a-f]+$/u);
        expect(copy.hostKey).not.toBe(source.hostKey);
        expect(yield* machineId(linux, "copy")).toBe("linux_copy\n");
        expect(yield* machineId(linux, "dev")).toBe("linux_dev\n");
        expect(linux.fake.calls).toEqual([
          "admit linux_copy",
          "fork linux_copy",
          "exec linux_copy",
        ]);
        expect(yield* actions(linux)).toEqual({
          dev: { name: "forkMachine", status: "done" },
          copy: { name: "forkMachine", status: "done" },
        });
      }),
  );

  it.effect(
    "a fork claims its source: another action on it is busy, and a fork of a busy one too",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();
        const { release, entered } = linux.fake.holdNext("fork");
        const fork = yield* Effect.forkChild(linux.machines.fork("linux_dev", "copy"));

        yield* entered;

        const [stop, again] = yield* Effect.all(
          [
            failure(linux, linux.machines.stop("linux_dev")),
            failure(linux, linux.machines.fork("linux_dev", "other")),
          ],
          { concurrency: "unbounded" },
        );

        yield* release;
        yield* Fiber.join(fork);

        const busy = new Conflict({
          message: "machine linux_dev is busy: fork is running",
          kind: "busy",
        });

        expect(stop).toEqual(busy);
        expect(again).toEqual(busy);
        expect(Object.keys(yield* actions(linux)).sort()).toEqual(["copy", "dev"]);
      }),
  );

  it.effect(
    "an action admitted during a fork counts the copy as booting, not the source the fork holds",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();
        const { release, entered } = linux.fake.holdNext("fork");
        const fork = yield* Effect.forkChild(linux.machines.fork("linux_dev", "copy"));

        const booting = () =>
          Object.fromEntries(
            (linux.fake.activations.at(-1)?.machines ?? []).map(({ machine, booting }) => [
              machine.name,
              booting,
            ]),
          );

        yield* entered;
        yield* linux.run(linux.machines.create(request("other")));

        const duringFork = booting();

        yield* release;
        yield* Fiber.join(fork);
        yield* linux.run(linux.machines.create(request("later")));

        expect(duringFork).toEqual({ dev: false, copy: true, other: true });
        expect(booting()).toEqual({ dev: false, copy: false, other: false, later: true });
      }),
  );

  it.effect(
    "a fork refused in its check makes no new row, and its source records the refusal",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        linux.fake.failNext("admit", new Capacity({ message: "no room" }));

        const error = yield* failure(linux, linux.machines.fork("linux_dev", "copy"));

        expect(error).toEqual(new Capacity({ message: "no room" }));
        expect(yield* actions(linux)).toEqual({ dev: refused("forkMachine", error) });
      }),
  );

  it.effect("a fork of a source the runtime doesn't copy is refused, and makes no new row", () =>
    Effect.gen(function* () {
      const linux = yield* withSource();

      yield* linux.run(linux.machines.stop("linux_dev"));

      const error = yield* failure(linux, linux.machines.fork("linux_dev", "copy"));

      expect([error._tag, error.message]).toEqual([
        "Precondition",
        "linux_dev is stopped: start it first",
      ]);
      expect(yield* actions(linux)).toEqual({ dev: refused("forkMachine", error) });
      expect(linux.fake.calls.filter((call) => call.startsWith("fork"))).toEqual([
        "fork linux_copy",
      ]);
    }),
  );

  it.effect("a fork that fails natively leaves both rows failed, and the new one deletable", () =>
    Effect.gen(function* () {
      const linux = yield* withSource();

      linux.fake.failNext("fork", new Internal({ message: "captureCheckpoint failed" }));

      const error = yield* failure(linux, linux.machines.fork("linux_dev", "copy"));

      const failed = {
        name: "forkMachine",
        status: "failed",
        error: new Internal({ message: "captureCheckpoint failed" }),
      };

      expect(error).toEqual(new Internal({ message: "captureCheckpoint failed" }));
      expect(yield* actions(linux)).toEqual({ dev: failed, copy: failed });

      yield* linux.run(linux.machines.delete("linux_copy"));
      yield* linux.run(linux.machines.stop("linux_dev"));

      expect(Object.keys(yield* actions(linux))).toEqual(["dev"]);
    }),
  );

  it.effect(
    "after a failed fork or restore, the source starts, and the new machine, never made, is only deleted",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        yield* linux.run(linux.checkpoints.capture("linux_dev", "snap"));

        for (const [name, operation, make] of [
          ["forked", "fork", () => linux.machines.fork("linux_dev", "forked")],
          ["restored", "restore", () => linux.machines.restore("linux_snap", "restored")],
        ] as const) {
          linux.fake.failNext(operation, new Internal({ message: "port swap failed" }));
          yield* failure(linux, make());

          const error = yield* failure(linux, linux.machines.start(`linux_${name}`));

          expect([error._tag, error.message]).toEqual([
            "Precondition",
            `machine linux_${name} was never made: its create, fork or restore failed; delete it`,
          ]);
          expect((yield* actions(linux))[name]).toEqual(refused("startMachine", error));

          yield* linux.run(linux.machines.delete(`linux_${name}`));
        }

        yield* linux.run(linux.machines.stop("linux_dev"));

        const started = yield* linux.run(linux.machines.start("linux_dev"));

        expect(started).toMatchObject({
          state: "running",
          action: { name: "startMachine", status: "done" },
        });
        expect(Object.keys(yield* actions(linux))).toEqual(["dev"]);
      }),
  );

  it.effect(
    "a fork or restore that fails only in preparation leaves its machine made, and start prepares it again",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        yield* linux.run(linux.checkpoints.capture("linux_dev", "snap"));

        for (const [name, operation, make] of [
          ["forked", "forkMachine", () => linux.machines.fork("linux_dev", "forked")],
          ["restored", "restoreMachine", () => linux.machines.restore("linux_snap", "restored")],
        ] as const) {
          linux.fake.failNext("exec", new Internal({ message: "sshd didn't start" }));
          yield* failure(linux, make());

          const [row] = (yield* linux.run(linux.store.list)).filter(
            (record) => record.name === name,
          );

          linux.fake.calls.length = 0;

          const started = yield* linux.run(linux.machines.start(`linux_${name}`));

          expect(row).toMatchObject({ made: true, action: { name: operation, status: "failed" } });
          expect(started).toMatchObject({
            state: "running",
            action: { name: "startMachine", status: "done" },
          });
          expect(linux.fake.calls).toEqual([
            `admit linux_${name}`,
            `start linux_${name}`,
            `exec linux_${name}`,
          ]);
        }
      }),
  );

  it.effect("a fork to a taken name is Conflict{exists}, and the source records it", () =>
    Effect.gen(function* () {
      const linux = yield* withSource();

      yield* linux.run(linux.machines.create(request("copy")));
      linux.fake.calls.length = 0;

      const error = yield* failure(linux, linux.machines.fork("linux_dev", "copy"));

      expect(error).toEqual(new Conflict({ message: "machine linux_copy exists", kind: "exists" }));
      expect((yield* actions(linux))["dev"]).toEqual(refused("forkMachine", error));
      expect(linux.fake.calls).toEqual([]);
    }),
  );

  it.effect("a capture to a taken name is Conflict{exists}, and the source records it", () =>
    Effect.gen(function* () {
      const linux = yield* withSource();

      yield* linux.run(linux.checkpoints.capture("linux_dev", "snap"));

      const error = yield* failure(linux, linux.checkpoints.capture("linux_dev", "snap"));

      expect(error).toEqual(
        new Conflict({ message: "checkpoint linux_snap exists", kind: "exists" }),
      );
      expect((yield* actions(linux))["dev"]).toEqual(refused("captureCheckpoint", error));
      expect(yield* checkpointActions(linux)).toEqual({
        snap: { name: "captureCheckpoint", status: "done" },
      });
    }),
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
          ],
          { concurrency: "unbounded" },
        );

        expect(errors.map(({ _tag }) => _tag)).toEqual(Array.from({ length: 8 }, () => "Invalid"));
        expect(errors[1]?.message).toContain(`linux_${long}`);
        expect(linux.fake.calls).toEqual([]);
      }),
  );

  it.effect(
    "a capture of a running machine is ram, with the source's spec and the runtime's pin",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();
        const ram = yield* linux.run(linux.checkpoints.capture("linux_dev", "hot"));
        const rows = yield* linux.run(linux.store.checkpoints);

        expect(ram).toMatchObject({
          id: "linux_hot",
          machine: "linux_dev",
          kind: "ram",
          base: "ubuntu",
          profile: "small",
          cpu: 1,
          ramMib: 1024,
          diskGib: 10,
          action: { name: "captureCheckpoint", status: "done" },
        });
        expect(rows.map(({ name, pin }) => [name, pin])).toEqual([["hot", "fake 1"]]);
        expect((yield* actions(linux))["dev"]).toEqual({
          name: "captureCheckpoint",
          status: "done",
        });
        expect(yield* linux.run(linux.checkpoints.list)).toEqual([ram]);
      }),
  );

  it.effect(
    "a capture of a stopped machine on a ram runtime is Precondition, and makes no checkpoint",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        yield* linux.run(linux.machines.stop("linux_dev"));

        const error = yield* failure(linux, linux.checkpoints.capture("linux_dev", "cold"));

        expect(error).toEqual(
          new Precondition({ message: "linux_dev is stopped: start it first" }),
        );
        expect(yield* checkpointActions(linux)).toEqual({});
        expect((yield* actions(linux))["dev"]).toEqual(refused("captureCheckpoint", error));
      }),
  );

  it.effect("a disk runtime's capture of a stopped machine is disk, with no pin", () =>
    Effect.gen(function* () {
      const linux = yield* withSource({ runtime: { checkpointKind: "disk" } });

      yield* linux.run(linux.machines.stop("linux_dev"));

      const disk = yield* linux.run(linux.checkpoints.capture("linux_dev", "cold"));
      const rows = yield* linux.run(linux.store.checkpoints);

      expect(disk).toMatchObject({ id: "linux_cold", kind: "disk" });
      expect(rows.map(({ name, pin }) => [name, pin])).toEqual([["cold", undefined]]);
    }),
  );

  it.effect(
    "a capture of a machine another action holds is Conflict{busy}, and writes nothing",
    () =>
      Effect.gen(function* () {
        const linux = yield* host();
        const { release, entered } = linux.fake.holdNext("create");
        const create = yield* Effect.forkChild(linux.machines.create(request("dev")));

        yield* entered;

        const error = yield* failure(linux, linux.checkpoints.capture("linux_dev", "snap"));

        yield* release;
        yield* Fiber.join(create);

        expect(error).toEqual(
          new Conflict({ message: "machine linux_dev is busy: create is running", kind: "busy" }),
        );
        expect(yield* checkpointActions(linux)).toEqual({});
      }),
  );

  it.effect(
    "a capture of a machine the runtime doesn't have is Precondition, and of no row NotFound",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        linux.fake.machines.clear();

        const missing = yield* failure(linux, linux.checkpoints.capture("linux_dev", "snap"));
        const none = yield* failure(linux, linux.checkpoints.capture("linux_gone", "snap"));

        expect(missing._tag).toBe("Precondition");
        expect(none._tag).toBe("NotFound");
        expect(yield* checkpointActions(linux)).toEqual({});
        expect((yield* actions(linux))["dev"]).toEqual(refused("captureCheckpoint", missing));
      }),
  );

  it.effect(
    "a capture that fails natively leaves the checkpoint failed, and delete removes it",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        linux.fake.failNext("capture", new Internal({ message: "ENOTSUP" }));

        const error = yield* failure(linux, linux.checkpoints.capture("linux_dev", "snap"));
        const got = yield* linux.run(linux.checkpoints.get("linux_snap"));

        yield* linux.run(linux.checkpoints.delete("linux_snap"));

        expect(error.message).toBe("ENOTSUP");
        expect(got.action).toEqual({
          name: "captureCheckpoint",
          status: "failed",
          error: new Internal({ message: "ENOTSUP" }),
        });
        expect(linux.fake.calls).toContain("deleteCheckpoint linux_snap");
        expect(yield* checkpointActions(linux)).toEqual({});
      }),
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

        const restored = yield* linux.run(linux.machines.restore("linux_snap", "dev"));

        expect(restored).toMatchObject({
          id: "linux_dev",
          profile: "small",
          state: "running",
          action: { name: "restoreMachine", status: "done" },
          ssh: { host: "127.0.0.1", port: ports.first },
        });
        expect(source.ssh).toEqual({ user: "root", host: "127.0.0.1", port: ports.first });
        expect(restored.hostKey).not.toBe(source.hostKey);
        expect(yield* machineId(linux, "dev")).toBe("linux_dev\n");
        expect(linux.fake.calls).toEqual([
          "admit linux_dev",
          "restore linux_dev",
          "exec linux_dev",
        ]);
        expect(yield* checkpointActions(linux)).toEqual({
          snap: { name: "captureCheckpoint", status: "done" },
        });
      }),
  );

  it.effect("restores of one checkpoint don't claim it, so they run side by side", () =>
    Effect.gen(function* () {
      const linux = yield* withSource();

      yield* linux.run(linux.checkpoints.capture("linux_dev", "snap"));

      const { release, entered } = linux.fake.holdNext("restore");
      const first = yield* Effect.forkChild(linux.machines.restore("linux_snap", "one"));

      yield* entered;

      const second = yield* linux.run(linux.machines.restore("linux_snap", "two"));

      yield* release;

      const one = yield* Fiber.join(first);

      expect([one.state, second.state]).toEqual(["running", "running"]);
      expect([one.ssh?.port, second.ssh?.port]).toEqual([ports.first + 1, ports.first + 2]);
    }),
  );

  it.effect("a restore whose checkpoint is deleted under it fails like any runtime failure", () =>
    Effect.gen(function* () {
      const linux = yield* withSource();

      yield* linux.run(linux.checkpoints.capture("linux_dev", "snap"));

      const { release, entered } = linux.fake.holdNext("restore");

      const restore = yield* Effect.forkChild(
        Effect.flip(linux.machines.restore("linux_snap", "copy")),
      );

      yield* entered;
      yield* linux.run(linux.checkpoints.delete("linux_snap"));
      yield* release;

      const error = yield* Fiber.join(restore);

      expect(error._tag).toBe("Internal");
      expect((yield* actions(linux))["copy"]).toMatchObject({
        name: "restoreMachine",
        status: "failed",
      });
      expect(yield* checkpointActions(linux)).toEqual({});
    }),
  );

  it.effect("a restore of a checkpoint that isn't ready is Precondition; of none, NotFound", () =>
    Effect.gen(function* () {
      const linux = yield* withSource();
      const { release, entered } = linux.fake.holdNext("capture");
      const capture = yield* Effect.forkChild(linux.checkpoints.capture("linux_dev", "snap"));

      yield* entered;

      const capturing = yield* failure(linux, linux.machines.restore("linux_snap", "copy"));

      yield* release;
      yield* Fiber.join(capture);

      const none = yield* failure(linux, linux.machines.restore("linux_gone", "copy"));

      expect(capturing).toEqual(
        new Precondition({
          message: "checkpoint linux_snap isn't ready: its captureCheckpoint is running",
        }),
      );
      expect(none._tag).toBe("NotFound");
      expect(Object.keys(yield* actions(linux))).toEqual(["dev"]);
    }),
  );

  it.effect("a ram checkpoint restores only under its pin, and writes nothing otherwise", () =>
    Effect.gen(function* () {
      const first = yield* withSource();

      yield* first.run(first.checkpoints.capture("linux_dev", "hot"));
      yield* first.dispose;

      const upgraded = yield* host({
        dir: first.dir,
        fake: fakeRuntime({ dir: first.dir, pin: "fake 2" }),
      });

      const refused = yield* failure(upgraded, upgraded.machines.restore("linux_hot", "copy"));

      expect(refused).toEqual(
        new Precondition({
          message:
            "checkpoint linux_hot holds RAM state saved under fake 1, and this host runs fake 2; it restores only under the same one",
        }),
      );
      expect(upgraded.fake.calls).toEqual(["startup"]);
      expect(Object.keys(yield* actions(upgraded))).toEqual(["dev"]);
    }),
  );

  it.effect("a disk checkpoint restores under any pin", () =>
    Effect.gen(function* () {
      const first = yield* withSource({ runtime: { checkpointKind: "disk" } });

      yield* first.run(first.machines.stop("linux_dev"));
      yield* first.run(first.checkpoints.capture("linux_dev", "cold"));
      yield* first.dispose;

      const upgraded = yield* host({
        dir: first.dir,
        fake: fakeRuntime({ dir: first.dir, pin: "fake 2", checkpointKind: "disk" }),
      });

      const restored = yield* upgraded.run(upgraded.machines.restore("linux_cold", "copy"));

      expect(restored.action).toEqual({ name: "restoreMachine", status: "done" });
      expect(upgraded.fake.calls).toEqual([
        "startup",
        "admit linux_copy",
        "restore linux_copy",
        "exec linux_copy",
      ]);
    }),
  );

  it.effect(
    "checkpoint delete removes what the runtime made, and the row; a missing one is NotFound",
    () =>
      Effect.gen(function* () {
        const linux = yield* withSource();

        yield* linux.run(linux.checkpoints.capture("linux_dev", "snap"));
        yield* linux.run(linux.checkpoints.delete("linux_snap"));

        const again = yield* failure(linux, linux.checkpoints.delete("linux_snap"));
        const read = yield* failure(linux, linux.checkpoints.get("linux_snap"));

        expect(again._tag).toBe("NotFound");
        expect(read._tag).toBe("NotFound");
        expect(linux.fake.calls).toContain("deleteCheckpoint linux_snap");
      }),
  );

  it.effect("fork and restore take the admission permit with create and start", () =>
    Effect.gen(function* () {
      const linux = yield* withSource({ runtime: { ramBudgetMib: 2048 } });

      yield* linux.run(linux.checkpoints.capture("linux_dev", "snap"));
      linux.fake.calls.length = 0;

      const { release, entered } = linux.fake.holdNext("admit");
      const fork = yield* Effect.forkChild(Effect.result(linux.machines.fork("linux_dev", "copy")));

      const restore = yield* Effect.forkChild(
        Effect.result(linux.machines.restore("linux_snap", "again")),
      );

      yield* entered;
      // Long enough for the restore to reach the permit, were it free.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));

      const admitsWhileHeld = linux.fake.calls.filter((call) => call.startsWith("admit")).length;

      yield* release;

      const ended = yield* Effect.all(
        [fork, restore].map((fiber) => Fiber.join(fiber)),
        { concurrency: "unbounded" },
      );

      // The budget fits the source and one more: exactly one of the two passes.
      expect(admitsWhileHeld).toBe(1);
      expect(ended.filter(({ _tag }) => _tag === "Success")).toHaveLength(1);
      expect(Object.keys(yield* actions(linux))).toHaveLength(2);
    }),
  );

  it.effect("host startup fails an interrupted capture and its source's claim", () =>
    Effect.gen(function* () {
      const linux = yield* withSource();
      const { entered } = linux.fake.holdNext("capture");

      yield* Effect.forkChild(linux.checkpoints.capture("linux_dev", "snap"));
      yield* entered;
      yield* linux.dispose;

      const restarted = yield* host({ fake: linux.fake, dir: linux.dir });

      const interrupted = {
        name: "captureCheckpoint",
        status: "failed",
        error: new Internal({ message: "the host stopped during captureCheckpoint" }),
      };

      expect(yield* checkpointActions(restarted)).toEqual({ snap: interrupted });
      expect((yield* actions(restarted))["dev"]).toEqual(interrupted);

      yield* restarted.run(restarted.checkpoints.delete("linux_snap"));

      expect(yield* checkpointActions(restarted)).toEqual({});
    }),
  );

  it.effect("a checkpoint whose delete a host restart cut off isn't ready to restore", () =>
    Effect.gen(function* () {
      const linux = yield* withSource();

      yield* linux.run(linux.checkpoints.capture("linux_dev", "snap"));

      const { entered } = linux.fake.holdNext("deleteCheckpoint");

      yield* Effect.forkChild(linux.checkpoints.delete("linux_snap"));
      yield* entered;
      yield* linux.dispose;

      const restarted = yield* host({ fake: linux.fake, dir: linux.dir });
      const refused = yield* failure(restarted, restarted.machines.restore("linux_snap", "copy"));

      expect(refused).toEqual(
        new Precondition({ message: "checkpoint linux_snap isn't ready: its delete is failed" }),
      );
      expect(Object.keys(yield* actions(restarted))).toEqual(["dev"]);
    }),
  );
});
