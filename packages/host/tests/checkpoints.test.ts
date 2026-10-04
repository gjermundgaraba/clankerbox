/**
 * Fork, checkpoints and restore in the host core, over the fake runtime: their claims, the
 * admission permit, the pin, and what each failure leaves.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Capacity, Conflict, Internal, Precondition } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Fiber } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { fakeRuntime } from "./fake-runtime.ts";
import { scratch } from "./scratch.ts";
import { cleanup, request, startHost, type TestHost } from "./support.ts";

const owned: Array<string> = [];

const hosts: Array<TestHost> = [];

afterEach(() => cleanup(owned, hosts));

const host = async (options?: Parameters<typeof startHost>[1] & { readonly dir?: string }) => {
  const started = await startHost(options?.dir ?? (await scratch(owned)), options);

  hosts.push(started);

  return started;
};

const failure = <A, E>(host: TestHost, effect: Effect.Effect<A, E>) =>
  host.run(Effect.flip(effect));

const actions = async (host: TestHost) =>
  Object.fromEntries((await host.run(host.store.list)).map(({ name, action }) => [name, action]));

const checkpointActions = async (host: TestHost) =>
  Object.fromEntries(
    (await host.run(host.store.checkpoints)).map(({ name, action }) => [name, action]),
  );

const machineId = async (host: TestHost, name: string) =>
  readFile(join(host.fake.root(name) ?? "", "var/lib/clankerbox/machine-id"), "utf8");

/** A host with a running machine `dev` that has an SSH host key. */
const withSource = async (options?: Parameters<typeof host>[0]) => {
  const linux = await host(options);

  await linux.run(
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
};

test("a fork copies the running machine to a new one, prepared with its own identity and port", async () => {
  const linux = await withSource();
  const source = await linux.run(linux.machines.get("linux_dev"));
  const copy = await linux.run(linux.machines.fork("linux_dev", "copy"));

  expect(copy).toMatchObject({
    id: "linux_copy",
    base: "ubuntu",
    profile: "small",
    cpu: 1,
    ramMib: 1024,
    diskGib: 10,
    state: "running",
    action: { name: "fork", status: "done" },
  });
  expect(copy.ssh?.port).not.toBe(source.ssh?.port);
  expect(copy.hostKey).toMatch(/^ssh-ed25519 AAAA[0-9a-f]+$/u);
  expect(copy.hostKey).not.toBe(source.hostKey);
  expect(await machineId(linux, "copy")).toBe("linux_copy\n");
  expect(await machineId(linux, "dev")).toBe("linux_dev\n");
  expect(linux.fake.calls).toEqual(["admit linux_copy", "fork linux_copy", "exec linux_copy"]);
  expect(await actions(linux)).toEqual({
    dev: { name: "fork", status: "done" },
    copy: { name: "fork", status: "done" },
  });
});

test("a fork claims its source: another action on it is busy, and a fork of a busy one too", async () => {
  const linux = await withSource();
  const { release, entered } = linux.fake.holdNext("fork");
  const fork = Effect.runFork(linux.machines.fork("linux_dev", "copy"));

  await entered;

  const [stop, again] = await Promise.all([
    failure(linux, linux.machines.stop("linux_dev")),
    failure(linux, linux.machines.fork("linux_dev", "other")),
  ]);

  release();
  await Effect.runPromise(Fiber.join(fork));

  const busy = new Conflict({
    message: "machine linux_dev is busy: fork is running",
    kind: "busy",
  });

  expect(stop).toEqual(busy);
  expect(again).toEqual(busy);
  expect(Object.keys(await actions(linux)).sort()).toEqual(["copy", "dev"]);
});

test("a fork refused in its check writes nothing: no new row, and the source's action is back", async () => {
  const linux = await withSource();

  linux.fake.failNext("admit", new Capacity({ message: "no room" }));

  const error = await failure(linux, linux.machines.fork("linux_dev", "copy"));

  expect(error).toEqual(new Capacity({ message: "no room" }));
  expect(await actions(linux)).toEqual({ dev: { name: "create", status: "done" } });
});

test("a fork that fails natively leaves both rows failed, and the new one deletable", async () => {
  const linux = await withSource();

  linux.fake.failNext("fork", new Internal({ message: "capture failed" }));

  const error = await failure(linux, linux.machines.fork("linux_dev", "copy"));

  const failed = {
    name: "fork",
    status: "failed",
    error: { tag: "Internal", message: "capture failed" },
  };

  expect(error).toEqual(new Internal({ message: "capture failed" }));
  expect(await actions(linux)).toEqual({ dev: failed, copy: failed });

  await linux.run(linux.machines.delete("linux_copy"));
  await linux.run(linux.machines.stop("linux_dev"));

  expect(Object.keys(await actions(linux))).toEqual(["dev"]);
});

test("after a failed fork or restore, the source starts, and the new machine is only deleted", async () => {
  const linux = await withSource();

  await linux.run(linux.checkpoints.capture("linux_dev", "snap"));

  for (const [name, operation, make] of [
    ["forked", "fork", () => linux.machines.fork("linux_dev", "forked")],
    ["restored", "restore", () => linux.machines.restore("linux_snap", "restored")],
  ] as const) {
    // As smolvm leaves it: a VM that failed before its first boot is deleted, so it is missing.
    linux.fake.failNext(operation, new Internal({ message: "port swap failed" }));
    await failure(linux, make());

    const error = await failure(linux, linux.machines.start(`linux_${name}`));

    expect(error).toEqual(
      new Precondition({
        message: `machine linux_${name} is missing from the smolvm runtime; delete it`,
      }),
    );
    expect((await actions(linux))[name]).toMatchObject({ name: operation, status: "failed" });

    await linux.run(linux.machines.delete(`linux_${name}`));
  }

  await linux.run(linux.machines.stop("linux_dev"));

  const started = await linux.run(linux.machines.start("linux_dev"));

  expect(started).toMatchObject({ state: "running", action: { name: "start", status: "done" } });
  expect(Object.keys(await actions(linux))).toEqual(["dev"]);
});

test("a fork to a taken name is Conflict{exists}, and the source isn't claimed", async () => {
  const linux = await withSource();

  await linux.run(linux.machines.create(request("copy")));
  linux.fake.calls.length = 0;

  const error = await failure(linux, linux.machines.fork("linux_dev", "copy"));

  expect(error).toEqual(new Conflict({ message: "machine linux_copy exists", kind: "exists" }));
  expect((await actions(linux))["dev"]).toEqual({ name: "create", status: "done" });
  expect(linux.fake.calls).toEqual([]);
});

test("a capture to a taken name is Conflict{exists}, and the source's action is put back", async () => {
  const linux = await withSource();

  await linux.run(linux.checkpoints.capture("linux_dev", "snap"));

  const before = (await actions(linux))["dev"];
  const error = await failure(linux, linux.checkpoints.capture("linux_dev", "snap"));

  expect(error).toEqual(new Conflict({ message: "checkpoint linux_snap exists", kind: "exists" }));
  expect((await actions(linux))["dev"]).toEqual(before);
  expect(await checkpointActions(linux)).toEqual({ snap: { name: "capture", status: "done" } });
});

test("IDs are checked whole: another host's source or checkpoint, or a new ID too long, is Invalid", async () => {
  const linux = await withSource();
  const long = "a".repeat(57);

  const errors = await Promise.all([
    failure(linux, linux.machines.fork("mac_dev", "copy")),
    failure(linux, linux.machines.fork("linux_dev", long)),
    failure(linux, linux.machines.restore("mac_snap", "copy")),
    failure(linux, linux.machines.restore("linux_snap", long)),
    failure(linux, linux.checkpoints.capture("mac_dev", "snap")),
    failure(linux, linux.checkpoints.capture("linux_dev", long)),
    failure(linux, linux.checkpoints.get("mac_snap")),
    failure(linux, linux.checkpoints.delete("mac_snap")),
  ]);

  expect(errors.map(({ _tag }) => _tag)).toEqual(Array.from({ length: 8 }, () => "Invalid"));
  expect(errors[1]?.message).toContain(`linux_${long}`);
  expect(linux.fake.calls).toEqual([]);
});

test("a capture of a running machine is ram, with the source's spec and the runtime's pin", async () => {
  const linux = await withSource();
  const ram = await linux.run(linux.checkpoints.capture("linux_dev", "hot"));
  const rows = await linux.run(linux.store.checkpoints);

  expect(ram).toMatchObject({
    id: "linux_hot",
    machine: "linux_dev",
    kind: "ram",
    base: "ubuntu",
    profile: "small",
    cpu: 1,
    ramMib: 1024,
    diskGib: 10,
    action: { name: "capture", status: "done" },
  });
  expect(rows.map(({ name, pin }) => [name, pin])).toEqual([["hot", "fake 1"]]);
  expect((await actions(linux))["dev"]).toEqual({ name: "capture", status: "done" });
  expect(await linux.run(linux.checkpoints.list)).toEqual([ram]);
});

test("a capture of a stopped machine on a ram runtime is Precondition, and writes nothing", async () => {
  const linux = await withSource();

  await linux.run(linux.machines.stop("linux_dev"));

  const error = await failure(linux, linux.checkpoints.capture("linux_dev", "cold"));

  expect(error).toEqual(new Precondition({ message: "linux_dev is stopped: start it first" }));
  expect(await checkpointActions(linux)).toEqual({});
  expect((await actions(linux))["dev"]).toEqual({ name: "stop", status: "done" });
});

test("a disk runtime's capture of a stopped machine is disk, with no pin", async () => {
  const linux = await withSource({ runtime: { checkpointKind: "disk" } });

  await linux.run(linux.machines.stop("linux_dev"));

  const disk = await linux.run(linux.checkpoints.capture("linux_dev", "cold"));
  const rows = await linux.run(linux.store.checkpoints);

  expect(disk).toMatchObject({ id: "linux_cold", kind: "disk" });
  expect(rows.map(({ name, pin }) => [name, pin])).toEqual([["cold", undefined]]);
});

test("a capture of a machine another action holds is Conflict{busy}, and writes nothing", async () => {
  const linux = await host();
  const { release, entered } = linux.fake.holdNext("create");
  const create = Effect.runFork(linux.machines.create(request("dev")));

  await entered;

  const error = await failure(linux, linux.checkpoints.capture("linux_dev", "snap"));

  release();
  await Effect.runPromise(Fiber.join(create));

  expect(error).toEqual(
    new Conflict({ message: "machine linux_dev is busy: create is running", kind: "busy" }),
  );
  expect(await checkpointActions(linux)).toEqual({});
});

test("a capture of a machine the runtime doesn't have is Precondition, and of no row NotFound", async () => {
  const linux = await withSource();

  linux.fake.machines.clear();

  const missing = await failure(linux, linux.checkpoints.capture("linux_dev", "snap"));
  const none = await failure(linux, linux.checkpoints.capture("linux_gone", "snap"));

  expect(missing._tag).toBe("Precondition");
  expect(none._tag).toBe("NotFound");
  expect(await checkpointActions(linux)).toEqual({});
  expect((await actions(linux))["dev"]).toEqual({ name: "create", status: "done" });
});

test("a capture that fails natively leaves the checkpoint failed, and delete removes it", async () => {
  const linux = await withSource();

  linux.fake.failNext("capture", new Internal({ message: "ENOTSUP" }));

  const error = await failure(linux, linux.checkpoints.capture("linux_dev", "snap"));
  const got = await linux.run(linux.checkpoints.get("linux_snap"));

  await linux.run(linux.checkpoints.delete("linux_snap"));

  expect(error.message).toBe("ENOTSUP");
  expect(got.action).toEqual({
    name: "capture",
    status: "failed",
    error: { tag: "Internal", message: "ENOTSUP" },
  });
  expect(linux.fake.calls).toContain("deleteCheckpoint linux_snap");
  expect(await checkpointActions(linux)).toEqual({});
});

test("a restore makes a machine with the checkpoint's spec, prepared with a new identity", async () => {
  const linux = await withSource();
  const source = await linux.run(linux.machines.get("linux_dev"));

  await linux.run(linux.checkpoints.capture("linux_dev", "snap"));
  await linux.run(linux.machines.delete("linux_dev"));
  linux.fake.calls.length = 0;

  // The deleted source's name is free again. Its port usually is too, but not always: other
  // test files probe the same loopback ports at the same time, and a probe in flight makes a
  // port briefly unbindable, so either machine may have skipped one.
  const restored = await linux.run(linux.machines.restore("linux_snap", "dev"));

  expect(restored).toMatchObject({
    id: "linux_dev",
    profile: "small",
    state: "running",
    action: { name: "restore", status: "done" },
    ssh: { host: source.ssh?.host },
  });
  expect(restored.hostKey).not.toBe(source.hostKey);
  expect(await machineId(linux, "dev")).toBe("linux_dev\n");
  expect(linux.fake.calls).toEqual(["admit linux_dev", "restore linux_dev", "exec linux_dev"]);
  expect(await checkpointActions(linux)).toEqual({ snap: { name: "capture", status: "done" } });
});

test("restores of one checkpoint don't claim it, so they run side by side", async () => {
  const linux = await withSource();

  await linux.run(linux.checkpoints.capture("linux_dev", "snap"));

  const { release, entered } = linux.fake.holdNext("restore");
  const first = Effect.runFork(linux.machines.restore("linux_snap", "one"));

  await entered;

  const second = await linux.run(linux.machines.restore("linux_snap", "two"));

  release();

  const one = await Effect.runPromise(Fiber.join(first));

  expect([one.state, second.state]).toEqual(["running", "running"]);
  expect(one.ssh?.port).not.toBe(second.ssh?.port);
});

test("a restore whose checkpoint is deleted under it fails like any runtime failure", async () => {
  const linux = await withSource();

  await linux.run(linux.checkpoints.capture("linux_dev", "snap"));

  const { release, entered } = linux.fake.holdNext("restore");
  const restore = Effect.runFork(Effect.flip(linux.machines.restore("linux_snap", "copy")));

  await entered;
  await linux.run(linux.checkpoints.delete("linux_snap"));
  release();

  const error = await Effect.runPromise(Fiber.join(restore));

  expect(error._tag).toBe("Internal");
  expect((await actions(linux))["copy"]).toMatchObject({ name: "restore", status: "failed" });
  expect(await checkpointActions(linux)).toEqual({});
});

test("a restore of a checkpoint that isn't ready is Precondition; of none, NotFound", async () => {
  const linux = await withSource();
  const { release, entered } = linux.fake.holdNext("capture");
  const capture = Effect.runFork(linux.checkpoints.capture("linux_dev", "snap"));

  await entered;

  const capturing = await failure(linux, linux.machines.restore("linux_snap", "copy"));

  release();
  await Effect.runPromise(Fiber.join(capture));

  const none = await failure(linux, linux.machines.restore("linux_gone", "copy"));

  expect(capturing).toEqual(
    new Precondition({ message: "checkpoint linux_snap isn't ready: its capture is running" }),
  );
  expect(none._tag).toBe("NotFound");
  expect(Object.keys(await actions(linux))).toEqual(["dev"]);
});

test("a ram checkpoint restores only under its pin, and writes nothing otherwise", async () => {
  const first = await withSource();

  await first.run(first.checkpoints.capture("linux_dev", "hot"));
  await first.dispose();

  const upgraded = await host({
    dir: first.dir,
    fake: fakeRuntime({ dir: first.dir, pin: "fake 2" }),
  });

  const refused = await failure(upgraded, upgraded.machines.restore("linux_hot", "copy"));

  expect(refused).toEqual(
    new Precondition({
      message:
        "checkpoint linux_hot holds RAM state saved under fake 1, and this host runs fake 2; it restores only under the same one",
    }),
  );
  expect(upgraded.fake.calls).toEqual(["startup"]);
  expect(Object.keys(await actions(upgraded))).toEqual(["dev"]);
});

test("a disk checkpoint restores under any pin", async () => {
  const first = await withSource({ runtime: { checkpointKind: "disk" } });

  await first.run(first.machines.stop("linux_dev"));
  await first.run(first.checkpoints.capture("linux_dev", "cold"));
  await first.dispose();

  const upgraded = await host({
    dir: first.dir,
    fake: fakeRuntime({ dir: first.dir, pin: "fake 2", checkpointKind: "disk" }),
  });

  const restored = await upgraded.run(upgraded.machines.restore("linux_cold", "copy"));

  expect(restored.action).toEqual({ name: "restore", status: "done" });
  expect(upgraded.fake.calls).toEqual([
    "startup",
    "admit linux_copy",
    "restore linux_copy",
    "exec linux_copy",
  ]);
});

test("checkpoint delete removes what the runtime made, and the row; a missing one is NotFound", async () => {
  const linux = await withSource();

  await linux.run(linux.checkpoints.capture("linux_dev", "snap"));
  await linux.run(linux.checkpoints.delete("linux_snap"));

  const again = await failure(linux, linux.checkpoints.delete("linux_snap"));
  const read = await failure(linux, linux.checkpoints.get("linux_snap"));

  expect(again._tag).toBe("NotFound");
  expect(read._tag).toBe("NotFound");
  expect(linux.fake.calls).toContain("deleteCheckpoint linux_snap");
});

test("fork and restore take the admission permit with create and start", async () => {
  const linux = await withSource({ runtime: { ramBudgetMib: 2048 } });

  await linux.run(linux.checkpoints.capture("linux_dev", "snap"));
  linux.fake.calls.length = 0;

  const { release, entered } = linux.fake.holdNext("admit");
  const fork = Effect.runFork(Effect.result(linux.machines.fork("linux_dev", "copy")));
  const restore = Effect.runFork(Effect.result(linux.machines.restore("linux_snap", "again")));

  await entered;
  await new Promise((resolve) => setTimeout(resolve, 50));

  const admitsWhileHeld = linux.fake.calls.filter((call) => call.startsWith("admit")).length;

  release();

  const ended = await Promise.all(
    [fork, restore].map((fiber) => Effect.runPromise(Fiber.join(fiber))),
  );

  // The budget fits the source and one more: exactly one of the two passes.
  expect(admitsWhileHeld).toBe(1);
  expect(ended.filter(({ _tag }) => _tag === "Success")).toHaveLength(1);
  expect(Object.keys(await actions(linux))).toHaveLength(2);
});

test("host startup fails an interrupted capture and its source's claim", async () => {
  const linux = await withSource();
  const { entered } = linux.fake.holdNext("capture");

  Effect.runFork(linux.checkpoints.capture("linux_dev", "snap"));
  await entered;
  await linux.dispose();

  const restarted = await host({ fake: linux.fake, dir: linux.dir });

  const interrupted = {
    name: "capture",
    status: "failed",
    error: { tag: "Internal", message: "host restarted during capture" },
  };

  expect(await checkpointActions(restarted)).toEqual({ snap: interrupted });
  expect((await actions(restarted))["dev"]).toEqual(interrupted);

  await restarted.run(restarted.checkpoints.delete("linux_snap"));

  expect(await checkpointActions(restarted)).toEqual({});
});
