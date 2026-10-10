import { readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Capacity, Conflict, type HostError, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Fiber, Option, Result } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, test } from "vite-plus/test";
import * as Machines from "../src/machines.ts";
import { Refusal } from "../src/runtime.ts";
import * as Store from "../src/store.ts";
import { scratch } from "./scratch.ts";
import { cleanup, hostConfig, request, startHost, type TestHost } from "./support.ts";

const owned: Array<string> = [];

const hosts: Array<TestHost> = [];

const servers: Array<Server> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
        }),
    ),
  );
  await cleanup(owned, hosts);
});

/** This file's machine ports, which no other test file's host gives out. */
const ports = { first: 21_100, last: 21_109 };

/** A host in a fresh scratch directory, or, after a restart, in its predecessor's. */
const host = async (options?: Parameters<typeof startHost>[1] & { readonly dir?: string }) => {
  const started = await startHost(options?.dir ?? (await scratch(owned)), { ports, ...options });

  hosts.push(started);

  return started;
};

const failure = <A, E>(host: TestHost, effect: Effect.Effect<A, E>) =>
  host.run(Effect.flip(effect));

const rows = (host: TestHost) => host.run(host.store.list);

/** Between polls of a row. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 50));

/** A setup that installs a `start` hook into the guest root, as a profile's setup would. */
const installsStart = {
  script: [
    "#!/bin/sh",
    'mkdir -p "$CLANKERBOX_ROOT/etc/clankerbox" "$CLANKERBOX_ROOT/etc/ssh"',
    'printf "#!/bin/sh\\necho start >>\\"\\$CLANKERBOX_ROOT/starts\\"\\n" >"$CLANKERBOX_ROOT/etc/clankerbox/start"',
    'chmod 755 "$CLANKERBOX_ROOT/etc/clankerbox/start"',
    ': >"$CLANKERBOX_ROOT/etc/ssh/ssh_host_ed25519_key"',
    'echo "ssh-ed25519 AAAAimage root@image" >"$CLANKERBOX_ROOT/etc/ssh/ssh_host_ed25519_key.pub"',
    "echo set up",
  ].join("\n"),
  timeoutSeconds: 30,
};

test("create runs setup once, then preparation, and reports the machine as the runtime sees it", async () => {
  const linux = await host();
  const made = await linux.run(linux.machines.create(request("dev", { setup: installsStart })));
  const root = linux.fake.root("dev") ?? "";

  expect(made).toMatchObject({
    id: "linux_dev",
    runtime: "smolvm",
    base: "ubuntu",
    state: "running",
    action: { name: "create", status: "done" },
    ssh: { host: "127.0.0.1", port: ports.first },
  });
  expect(made.hostKey).toMatch(/^ssh-ed25519 AAAA[0-9a-f]+$/u);
  expect(await readFile(join(root, "var/lib/clankerbox/machine-id"), "utf8")).toBe("linux_dev\n");
  expect(await readFile(join(root, "starts"), "utf8")).toBe("start\n");
  expect(linux.fake.calls).toEqual([
    "startup",
    "admit linux_dev",
    "create linux_dev",
    "exec linux_dev",
    "exec linux_dev",
  ]);
});

test("start on a running machine is admitted, calls the runtime's start and runs preparation again; setup never runs again", async () => {
  const linux = await host();

  await linux.run(linux.machines.create(request("dev", { setup: installsStart })));
  linux.fake.calls.length = 0;

  const started = await linux.run(linux.machines.start("linux_dev"));

  expect(started).toMatchObject({ state: "running", action: { name: "start", status: "done" } });
  expect(linux.fake.calls).toEqual(["admit linux_dev", "start linux_dev", "exec linux_dev"]);
  expect(await readFile(join(linux.fake.root("dev") ?? "", "starts"), "utf8")).toBe(
    "start\nstart\n",
  );
});

test("stop, start and delete run the runtime's calls in turn", async () => {
  const linux = await host();

  await linux.run(linux.machines.create(request("dev")));
  linux.fake.calls.length = 0;

  const stopped = await linux.run(linux.machines.stop("linux_dev"));
  const started = await linux.run(linux.machines.start("linux_dev"));

  await linux.run(linux.machines.delete("linux_dev"));

  expect(stopped).toMatchObject({ state: "stopped", action: { name: "stop", status: "done" } });
  expect(started).toMatchObject({ state: "running", action: { name: "start", status: "done" } });
  expect(linux.fake.calls).toEqual([
    "stop linux_dev",
    "admit linux_dev",
    "start linux_dev",
    "exec linux_dev",
    "delete linux_dev",
  ]);
  expect(await rows(linux)).toEqual([]);
  expect(linux.fake.machines.size).toBe(0);
});

test("stop on a stopped machine calls the runtime's stop, which leaves it stopped", async () => {
  const linux = await host();

  await linux.run(linux.machines.create(request("dev")));
  await linux.run(linux.machines.stop("linux_dev"));
  linux.fake.calls.length = 0;

  const again = await linux.run(linux.machines.stop("linux_dev"));

  expect(again).toMatchObject({ state: "stopped", action: { name: "stop", status: "done" } });
  expect(linux.fake.calls).toEqual(["stop linux_dev"]);
});

test("a machine's state is read from the runtime every time", async () => {
  const linux = await host();

  await linux.run(linux.machines.create(request("dev")));
  linux.fake.machines.clear();

  const [got, listed] = await linux.run(
    Effect.all([linux.machines.get("linux_dev"), linux.machines.list]),
  );

  expect(got.state).toBe("missing");
  expect(listed.map(({ id, state }) => [id, state])).toEqual([["linux_dev", "missing"]]);
});

test("a list reads every machine's state in one observe", async () => {
  const linux = await host();

  await linux.run(linux.machines.create(request("a")));
  await linux.run(linux.machines.create(request("b")));
  linux.fake.observed.length = 0;

  const listed = await linux.run(linux.machines.list);

  expect(listed.map(({ id, state }) => [id, state])).toEqual([
    ["linux_a", "running"],
    ["linux_b", "running"],
  ]);
  expect(linux.fake.observed).toEqual([["linux_a", "linux_b"]]);
});

test("a read of every machine that fails reads them all unknown, and never fails the action it follows", async () => {
  const linux = await host();

  await linux.run(linux.machines.create(request("a")));
  linux.fake.failNextObserve(new Internal({ message: "tart list exited 1" }));

  // The create's own read, after it is done, is the one that fails.
  const made = await linux.run(linux.machines.create(request("b")));

  linux.fake.failNextObserve(new Internal({ message: "tart list exited 1" }));

  const listed = await linux.run(linux.machines.list);

  expect(made).toMatchObject({ state: "unknown", action: { name: "create", status: "done" } });
  expect(made.ssh).toBeUndefined();
  expect(listed.map(({ id, state }) => [id, state])).toEqual([
    ["linux_a", "unknown"],
    ["linux_b", "unknown"],
  ]);
  expect(await linux.run(linux.machines.get("linux_b"))).toMatchObject({ state: "running" });
});

/**
 * Runs `use` on the host's actions, built again over its store and fake on a test clock, and
 * moves the clock a second at a time until `use` ends: its result, and how long it waited.
 */
const onTestClock = <A>(
  linux: TestHost,
  use: (machines: Machines.Interface) => Effect.Effect<A, HostError>,
) =>
  linux.run(
    Effect.gen(function* () {
      const machines = yield* Machines.make(hostConfig(linux.stateDir, ports)).pipe(
        Effect.provideService(Store.Store, linux.store),
        Effect.provide(linux.fake.layer),
      );

      const fiber = yield* Effect.forkChild(Effect.result(use(machines)));
      let waited = Duration.zero;

      while (fiber.pollUnsafe() === undefined) {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)));
        yield* TestClock.adjust(Duration.seconds(1));
        waited = Duration.sum(waited, Duration.seconds(1));
      }

      return { result: yield* Fiber.join(fiber), waited: Duration.format(waited) };
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.provide(NodeServices.layer)),
  );

test("a read of runtime state that doesn't answer within 9 s reads every machine unknown", async () => {
  const linux = await host();

  await linux.run(linux.machines.create(request("dev")));
  linux.fake.hangNextObserve();

  const { result, waited } = await onTestClock(linux, (machines) => machines.get("linux_dev"));

  expect(waited).toBe("9s");
  expect(Result.getOrThrow(result)).toMatchObject({
    state: "unknown",
    action: { name: "create", status: "done" },
  });
});

test("an admit whose reads don't answer within 9 s fails the check with Internal, writing nothing", async () => {
  const linux = await host();

  await linux.run(linux.machines.create(request("dev")));
  await linux.run(linux.machines.stop("linux_dev"));
  linux.fake.calls.length = 0;

  const { release } = linux.fake.holdNext("admit");
  const { result, waited } = await onTestClock(linux, (machines) => machines.start("linux_dev"));

  release();

  const [row] = await rows(linux);

  expect(waited).toBe("9s");
  expect(Result.isFailure(result) && [result.failure._tag, result.failure.message]).toEqual([
    "Internal",
    "start linux_dev: the smolvm runtime's admission check didn't answer within 9s",
  ]);
  expect(row?.action).toEqual({ name: "stop", status: "done" });
  expect(linux.fake.calls).toEqual(["admit linux_dev"]);
});

test("one machine the runtime can't read is unknown, and the list still reads the rest", async () => {
  const linux = await host();

  await linux.run(linux.machines.create(request("a")));
  await linux.run(linux.machines.create(request("b")));
  linux.fake.machines.set("a", { state: "unknown", root: linux.fake.root("a") ?? "" });

  const listed = await linux.run(linux.machines.list);

  expect(listed.map(({ id, state }) => [id, state])).toEqual([
    ["linux_a", "unknown"],
    ["linux_b", "running"],
  ]);
});

test("stop on a machine the runtime can't read calls the runtime's stop", async () => {
  const linux = await host();

  await linux.run(linux.machines.create(request("dev")));
  linux.fake.machines.set("dev", { state: "unknown", root: linux.fake.root("dev") ?? "" });
  linux.fake.calls.length = 0;

  const stopped = await linux.run(linux.machines.stop("linux_dev"));

  expect(stopped).toMatchObject({ state: "stopped", action: { name: "stop", status: "done" } });
  expect(linux.fake.calls).toEqual(["stop linux_dev"]);
});

test("a machine has an SSH endpoint, as the runtime's user on its port of the publish address, only while it runs", async () => {
  const linux = await host();

  // With no setup, nothing installs sshd, so preparation records no host key.
  const made = await linux.run(linux.machines.create(request("dev")));
  const stopped = await linux.run(linux.machines.stop("linux_dev"));

  linux.fake.machines.clear();

  const missing = await linux.run(linux.machines.get("linux_dev"));
  const [row] = await rows(linux);

  expect(made.ssh).toEqual({ user: "root", host: "127.0.0.1", port: row?.port });
  expect(made.hostKey).toBeUndefined();
  expect([stopped, missing].map(({ state, ssh }) => [state, ssh])).toEqual([
    ["stopped", undefined],
    ["missing", undefined],
  ]);
});

test("start on a machine the runtime can't read admits it and calls the runtime's start", async () => {
  const linux = await host();

  await linux.run(linux.machines.create(request("dev")));
  linux.fake.machines.set("dev", { state: "unknown", root: linux.fake.root("dev") ?? "" });
  linux.fake.calls.length = 0;

  const started = await linux.run(linux.machines.start("linux_dev"));

  expect(started).toMatchObject({ state: "running", action: { name: "start", status: "done" } });
  expect(linux.fake.calls).toEqual(["admit linux_dev", "start linux_dev", "exec linux_dev"]);
});

test("a duplicate name is Conflict{exists}, and the runtime is never called", async () => {
  const linux = await host();

  await linux.run(linux.machines.create(request("dev")));
  linux.fake.calls.length = 0;

  const error = await failure(linux, linux.machines.create(request("dev")));

  expect(error).toEqual(new Conflict({ message: "machine linux_dev exists", kind: "exists" }));
  expect(linux.fake.calls).toEqual([]);
});

test("a base the host doesn't offer is Precondition, before anything is written", async () => {
  const linux = await host();
  const error = await failure(linux, linux.machines.create(request("dev", { base: "fedora" })));

  expect(error._tag).toBe("Precondition");
  expect(error.message).toContain("offers ubuntu");
  expect(await rows(linux)).toEqual([]);
});

test("an error before the first runtime call writes nothing", async () => {
  const linux = await host();

  linux.fake.failNext("admit", new Capacity({ message: "no room" }));

  const error = await failure(linux, linux.machines.create(request("dev")));

  expect(error).toEqual(new Capacity({ message: "no room" }));
  expect(await rows(linux)).toEqual([]);
  expect(linux.fake.calls).toEqual(["startup", "admit linux_dev"]);
});

test("a check that fails on an existing row puts its last action back", async () => {
  const linux = await host();

  await linux.run(linux.machines.create(request("dev")));
  await linux.run(linux.machines.stop("linux_dev"));
  linux.fake.failNext("admit", new Capacity({ message: "no room" }));

  const error = await failure(linux, linux.machines.start("linux_dev"));
  const [row] = await rows(linux);

  expect(error._tag).toBe("Capacity");
  expect(row?.action).toEqual({ name: "stop", status: "done" });
});

test("a runtime refusal is handled like a failed check: the new row is removed", async () => {
  const linux = await host();

  linux.fake.refuseNext(
    "create",
    new Refusal({ error: new Capacity({ message: "account full" }) }),
  );

  const error = await failure(linux, linux.machines.create(request("dev")));

  expect(error).toEqual(new Capacity({ message: "account full" }));
  expect(await rows(linux)).toEqual([]);
});

test("a native failure leaves the row failed with the reply's error, and delete cleans up", async () => {
  const linux = await host();

  linux.fake.failNext("create", new Internal({ message: "krun EINVAL" }));

  const error = await failure(linux, linux.machines.create(request("dev")));
  const got = await linux.run(linux.machines.get("linux_dev"));

  await linux.run(linux.machines.delete("linux_dev"));

  expect(error).toEqual(new Internal({ message: "krun EINVAL" }));
  expect(got.action).toEqual({
    name: "create",
    status: "failed",
    error: { tag: "Internal", message: "krun EINVAL" },
  });
  expect(linux.fake.calls).toContain("delete linux_dev");
  expect(await rows(linux)).toEqual([]);
});

test("stop and delete of a made machine are never refused for an earlier failure", async () => {
  const linux = await host();

  await linux.run(linux.machines.create(request("dev")));
  await linux.run(linux.machines.stop("linux_dev"));
  linux.fake.failNext("start", new Internal({ message: "crun create failed" }));
  await failure(linux, linux.machines.start("linux_dev"));

  const stopped = await linux.run(linux.machines.stop("linux_dev"));

  linux.fake.failNext("stop", new Internal({ message: "guest didn't flush" }));
  linux.fake.machines.forEach((machine) => {
    machine.state = "running";
  });

  const stopFailed = await failure(linux, linux.machines.stop("linux_dev"));

  await linux.run(linux.machines.delete("linux_dev"));

  expect(stopped.action).toEqual({ name: "stop", status: "done" });
  expect(stopFailed.message).toBe("guest didn't flush");
  expect(await rows(linux)).toEqual([]);
});

test("delete removes a row whose create never reached the runtime", async () => {
  const linux = await host();
  await linux.run(linux.machines.create(request("dev")));

  const row = Option.getOrThrow(await linux.run(linux.store.find("dev")));

  // A crash between inserting the row and the first runtime call leaves this row and nothing
  // native.
  await linux.run(linux.machines.delete("linux_dev"));
  await linux.run(linux.store.insert("create", { table: "machines", record: row }));
  await linux.dispose();
  linux.fake.calls.length = 0;

  const restarted = await host({ fake: linux.fake, dir: linux.dir });

  await restarted.run(restarted.machines.delete("linux_dev"));

  expect(linux.fake.calls).toEqual(["startup", "delete linux_dev"]);
  expect(await rows(restarted)).toEqual([]);
});

test("delete of a machine that doesn't exist is NotFound", async () => {
  const linux = await host();
  const error = await failure(linux, linux.machines.delete("linux_gone"));

  expect(error._tag).toBe("NotFound");
});

test("an ID for another host is Invalid", async () => {
  const linux = await host();
  const error = await failure(linux, linux.machines.get("mac_dev"));

  expect(error._tag).toBe("Invalid");
  expect(error.message).toContain("this is host linux");
});

test("start of a machine the runtime no longer has is Precondition and writes nothing", async () => {
  const linux = await host();

  await linux.run(linux.machines.create(request("dev")));
  linux.fake.machines.clear();

  const error = await failure(linux, linux.machines.start("linux_dev"));
  const [row] = await rows(linux);

  expect([error._tag, error.message]).toEqual([
    "Precondition",
    "machine linux_dev is missing from the smolvm runtime; delete it",
  ]);
  expect(row?.action).toEqual({ name: "create", status: "done" });
});

test("a second action on a claimed machine is Conflict{busy}", async () => {
  const linux = await host();
  const { release, entered } = linux.fake.holdNext("create");
  const create = Effect.runFork(linux.machines.create(request("dev")));

  await entered;

  const [start, remove] = await Promise.all([
    failure(linux, linux.machines.start("linux_dev")),
    failure(linux, linux.machines.delete("linux_dev")),
  ]);

  release();
  await Effect.runPromise(Fiber.join(create));

  const busy = new Conflict({
    message: "machine linux_dev is busy: create is running",
    kind: "busy",
  });

  expect(start).toEqual(busy);
  expect(remove).toEqual(busy);
});

test("a caller that goes away doesn't interrupt the action, and its outcome is recorded", async () => {
  const linux = await host();
  const { release, entered } = linux.fake.holdNext("create");
  const caller = Effect.runFork(linux.machines.create(request("dev")));

  await entered;
  await Effect.runPromise(Fiber.interrupt(caller));
  release();

  for (let tries = 0; tries < 50; tries++) {
    const [row] = await rows(linux);

    if (row?.action.status === "done") {
      break;
    }

    await pause();
  }

  const [row] = await rows(linux);

  expect(row?.action).toEqual({ name: "create", status: "done" });
  expect(linux.fake.calls).toContain("exec linux_dev");
});

test("host startup fails every action the last host process left running", async () => {
  const linux = await host();

  const { entered } = linux.fake.holdNext("create");

  Effect.runFork(linux.machines.create(request("dev")));
  await entered;
  await linux.dispose();

  const restarted = await host({ fake: linux.fake, dir: linux.dir });
  const got = await restarted.run(restarted.machines.get("linux_dev"));

  expect(got.action).toEqual({
    name: "create",
    status: "failed",
    error: { tag: "Internal", message: "host restarted during create" },
  });
  expect(linux.fake.calls.filter((call) => call === "startup")).toHaveLength(2);
});

const restartedDuringCreate = {
  name: "create",
  status: "failed",
  error: { tag: "Internal", message: "host restarted during create" },
} as const;

test("a machine whose create failed is only read, stopped or deleted: start, fork and capture refuse it", async () => {
  const linux = await host();

  const neverMade = [
    "Precondition",
    "machine linux_dev was never made: its create, fork or restore failed; delete it",
  ];

  // A setup that fails after the runtime's create leaves its VM running.
  const error = await failure(
    linux,
    linux.machines.create(
      request("dev", { setup: { script: "#!/bin/sh\nexit 3\n", timeoutSeconds: 30 } }),
    ),
  );

  linux.fake.calls.length = 0;

  const refused = await Promise.all([
    failure(linux, linux.machines.start("linux_dev")),
    failure(linux, linux.machines.fork("linux_dev", "copy")),
    failure(linux, linux.checkpoints.capture("linux_dev", "snap")),
  ]);

  const got = await linux.run(linux.machines.get("linux_dev"));
  const stopped = await linux.run(linux.machines.stop("linux_dev"));

  // Still never made once stopped: the check runs before the runtime's own state checks.
  const refusedStopped = await Promise.all([
    failure(linux, linux.machines.start("linux_dev")),
    failure(linux, linux.machines.fork("linux_dev", "copy")),
    failure(linux, linux.checkpoints.capture("linux_dev", "snap")),
  ]);

  await linux.run(linux.machines.delete("linux_dev"));

  expect(error._tag).toBe("Precondition");
  expect([...refused, ...refusedStopped].map(({ _tag, message }) => [_tag, message])).toEqual(
    Array.from({ length: 6 }, () => neverMade),
  );
  expect(got).toMatchObject({
    state: "running",
    made: false,
    action: { name: "create", status: "failed" },
  });
  expect(stopped).toMatchObject({
    state: "stopped",
    made: false,
    action: { name: "stop", status: "done" },
  });
  expect(linux.fake.calls).toEqual(["stop linux_dev", "delete linux_dev"]);
  expect(await rows(linux)).toEqual([]);
  expect(await linux.run(linux.store.checkpoints)).toEqual([]);
});

test("after a restart during create's setup, the machine is never made: stop stops its VM, start refuses it and delete removes it", async () => {
  const linux = await host();

  // Held in setup's exec: the runtime's create has made and booted the machine.
  const { entered } = linux.fake.holdNext("exec");

  Effect.runFork(
    linux.machines.create(request("dev", { setup: { script: "#!/bin/sh\n", timeoutSeconds: 30 } })),
  );
  await entered;
  await linux.dispose();

  const restarted = await host({ fake: linux.fake, dir: linux.dir });
  const before = await restarted.run(restarted.machines.get("linux_dev"));

  linux.fake.calls.length = 0;

  const stopped = await restarted.run(restarted.machines.stop("linux_dev"));
  const start = await failure(restarted, restarted.machines.start("linux_dev"));

  await restarted.run(restarted.machines.delete("linux_dev"));

  expect(before).toMatchObject({ state: "running", action: restartedDuringCreate });
  expect(stopped).toMatchObject({ state: "stopped", action: { name: "stop", status: "done" } });
  expect([start._tag, start.message]).toEqual([
    "Precondition",
    "machine linux_dev was never made: its create, fork or restore failed; delete it",
  ]);
  expect(linux.fake.calls).toEqual(["stop linux_dev", "delete linux_dev"]);
  expect(await rows(restarted)).toEqual([]);
});

test("a create, fork or restore that succeeds marks its machine made", async () => {
  const linux = await host();

  await linux.run(linux.machines.create(request("dev")));
  await linux.run(linux.checkpoints.capture("linux_dev", "snap"));
  await linux.run(linux.machines.fork("linux_dev", "forked"));
  await linux.run(linux.machines.restore("linux_snap", "restored"));

  expect((await rows(linux)).map(({ name, made }) => [name, made])).toEqual([
    ["dev", true],
    ["forked", true],
    ["restored", true],
  ]);
});

test("a create that fails only in preparation leaves its machine made, and start prepares it again", async () => {
  const linux = await host();

  // With no setup, the first guest command is preparation's.
  linux.fake.failNext("exec", new Internal({ message: "sshd didn't start" }));

  const error = await failure(linux, linux.machines.create(request("dev")));
  const [row] = await rows(linux);

  linux.fake.calls.length = 0;

  const started = await linux.run(linux.machines.start("linux_dev"));

  expect(error).toEqual(new Internal({ message: "sshd didn't start" }));
  expect(row).toMatchObject({ made: true, action: { name: "create", status: "failed" } });
  expect(started).toMatchObject({ state: "running", action: { name: "start", status: "done" } });
  expect(linux.fake.calls).toEqual(["admit linux_dev", "start linux_dev", "exec linux_dev"]);
});

test("after a restart during create's preparation, the machine is made, and start prepares it again", async () => {
  const linux = await host();

  // Held in preparation's exec: with no setup, the runtime's create is all the work.
  const { entered } = linux.fake.holdNext("exec");

  Effect.runFork(linux.machines.create(request("dev")));
  await entered;
  await linux.dispose();

  const restarted = await host({ fake: linux.fake, dir: linux.dir });
  const [row] = await rows(restarted);
  const started = await restarted.run(restarted.machines.start("linux_dev"));

  expect(row).toMatchObject({ made: true, action: restartedDuringCreate });
  expect(started).toMatchObject({ state: "running", action: { name: "start", status: "done" } });
});

const marker = "setup-text-marker";

test("a failing setup fails the create with its last lines of output, never its text", async () => {
  const linux = await host();

  const script = [
    "#!/bin/sh",
    `# ${marker}`,
    "i=0",
    "while [ $i -lt 30 ]; do echo line $i; i=$((i+1)); done",
    "echo broke >&2",
    "exit 3",
  ].join("\n");

  const error = await failure(
    linux,
    linux.machines.create(request("dev", { setup: { script, timeoutSeconds: 30 } })),
  );

  const got = await linux.run(linux.machines.get("linux_dev"));

  expect(error._tag).toBe("Precondition");
  expect(error.message).toContain("setup exited 3");
  expect(error.message).toContain("line 29\nbroke");
  expect(error.message).not.toContain("line 10\n");
  expect(error.message.includes(marker)).toBe(false);
  expect(got.action).toEqual({
    name: "create",
    status: "failed",
    error: { tag: "Precondition", message: error.message },
  });
});

test("a setup that exits removes its file", async () => {
  const linux = await host();
  const script = `#!/bin/sh\necho "running as $0"\nexit 3\n`;

  const error = await failure(
    linux,
    linux.machines.create(request("dev", { setup: { script, timeoutSeconds: 30 } })),
  );

  const file = /running as (\S+)/u.exec(error.message)?.[1] ?? "";

  expect(file).toMatch(/^\/var\/tmp\/clankerbox-setup\./u);
  await expect(stat(file)).rejects.toThrow("ENOENT");
});

test("create accepts a setup that names no timeout", async () => {
  const linux = await host();

  const made = await linux.run(
    linux.machines.create(request("dev", { setup: { script: installsStart.script } })),
  );

  expect(made.action).toEqual({ name: "create", status: "done" });
});

test("a setup that runs past its timeout fails the create with the output so far", async () => {
  const linux = await host();
  const script = `#!/bin/sh\n# ${marker}\necho "running as $0"\nsleep 30\n`;

  const error = await failure(
    linux,
    linux.machines.create(request("dev", { setup: { script, timeoutSeconds: 1 } })),
  );

  const file = /running as (\S+)/u.exec(error.message)?.[1] ?? "";

  expect(file).toMatch(/^\/var\/tmp\/clankerbox-setup\./u);

  // The killed setup leaves its file, as on smolvm; the fake's guest shares this host's
  // /var/tmp.
  await rm(file, { force: true });

  expect(error._tag).toBe("Precondition");
  expect(error.message).toContain("setup ran past its 1s timeout");
  expect(error.message.includes(marker)).toBe(false);
});

test("the RAM budget counts running machines and refuses with Capacity, writing nothing", async () => {
  const linux = await host({ runtime: { ramBudgetMib: 2048 } });

  await linux.run(linux.machines.create(request("a")));
  await linux.run(linux.machines.create(request("b")));

  const full = await failure(linux, linux.machines.create(request("c")));

  await linux.run(linux.machines.stop("linux_a"));
  await linux.run(linux.machines.create(request("c")));

  const restart = await failure(linux, linux.machines.start("linux_a"));
  const again = await linux.run(linux.machines.start("linux_b"));

  expect(full._tag).toBe("Capacity");
  expect(full.message).toContain("3072 MiB");
  expect(restart._tag).toBe("Capacity");
  expect(again.action).toEqual({ name: "start", status: "done" });
  expect((await rows(linux)).map(({ name }) => name).sort()).toEqual(["a", "b", "c"]);
});

test("the host's capacity is what step 3 counts: running machines, and one an action is booting", async () => {
  const linux = await host({ runtime: { ramBudgetMib: 4096 } });

  await linux.run(linux.machines.create(request("a")));
  await linux.run(linux.machines.create(request("b")));
  await linux.run(linux.machines.stop("linux_a"));

  const idle = await linux.run(linux.machines.capacity);

  // A create held in the runtime is past its check, and its machine doesn't run yet.
  const { entered, release } = linux.fake.holdNext("create");
  const creating = linux.run(linux.machines.create(request("c", { ramMib: 2048 })));

  await entered;

  const booting = await linux.run(linux.machines.capacity);
  const full = await failure(linux, linux.machines.create(request("d", { ramMib: 2048 })));

  release();
  await creating;

  expect(idle).toEqual([{ host: "linux", resource: "ramMib", limit: 4096, used: 1024 }]);
  expect(booting).toEqual([{ host: "linux", resource: "ramMib", limit: 4096, used: 3072 }]);
  expect(full._tag).toBe("Capacity");
  expect(full.message).toContain("5120 MiB");
});

test("a capacity read that fails, or doesn't answer within 9 s, fails with Internal", async () => {
  const linux = await host({ runtime: { ramBudgetMib: 4096 } });

  linux.fake.failNext("capacity", new Internal({ message: "tart list exited 1" }));

  const failed = await failure(linux, linux.machines.capacity);
  const { release } = linux.fake.holdNext("capacity");
  const { result, waited } = await onTestClock(linux, (machines) => machines.capacity);

  release();

  expect([failed._tag, failed.message]).toEqual(["Internal", "tart list exited 1"]);
  expect(waited).toBe("9s");
  expect(Result.isFailure(result) && [result.failure._tag, result.failure.message]).toEqual([
    "Internal",
    "the smolvm runtime didn't answer within 9s",
  ]);
});

test("the RAM budget counts a machine the runtime can't read as running", async () => {
  const linux = await host({ runtime: { ramBudgetMib: 2048 } });

  await linux.run(linux.machines.create(request("a")));
  linux.fake.machines.set("a", { state: "unknown", root: linux.fake.root("a") ?? "" });

  const full = await failure(linux, linux.machines.create(request("c", { ramMib: 2048 })));

  expect(full._tag).toBe("Capacity");
  expect(full.message).toContain("3072 MiB");
});

test("the RAM budget counts a running machine's start once: it already runs", async () => {
  const linux = await host({ runtime: { ramBudgetMib: 2048 } });

  await linux.run(linux.machines.create(request("a")));
  await linux.run(linux.machines.create(request("b")));

  const started = await linux.run(linux.machines.start("linux_b"));

  expect(started.action).toEqual({ name: "start", status: "done" });
});

test("a start reads state once under the admission permit: the RAM budget's one observe", async () => {
  const linux = await host({ runtime: { ramBudgetMib: 4096 } });

  await linux.run(linux.machines.create(request("a")));
  await linux.run(linux.machines.create(request("b")));
  await linux.run(linux.machines.stop("linux_b"));
  linux.fake.observed.length = 0;

  const { release, entered } = linux.fake.holdNext("start");
  const start = Effect.runFork(linux.machines.start("linux_b"));

  await entered;

  const read = [...linux.fake.observed];

  release();
  await Effect.runPromise(Fiber.join(start));

  expect(read).toEqual([["linux_a"]]);
});

test("the RAM budget reads the machines no action boots in one observe", async () => {
  const linux = await host({ runtime: { ramBudgetMib: 4096 } });

  await linux.run(linux.machines.create(request("a")));
  await linux.run(linux.machines.create(request("b")));
  linux.fake.observed.length = 0;
  await linux.run(linux.machines.create(request("c")));

  expect(linux.fake.observed[0]).toEqual(["linux_a", "linux_b"]);
});

/** Runs `actions` at once, each to its result. */
const together = <A>(actions: ReadonlyArray<Effect.Effect<A, HostError>>) =>
  actions.map((action) => Effect.runFork(Effect.result(action)));

const results = <A>(fibers: ReadonlyArray<Fiber.Fiber<Result.Result<A, HostError>>>) =>
  Promise.all(fibers.map((fiber) => Effect.runPromise(Fiber.join(fiber))));

test("of two concurrent creates that each fit only alone, exactly one passes", async () => {
  const linux = await host({ runtime: { ramBudgetMib: 1536 } });
  const { release, entered } = linux.fake.holdNext("admit");

  const creates = together([
    linux.machines.create(request("x")),
    linux.machines.create(request("y")),
  ]);

  await entered;
  await pause();

  // The second create waits for the first's check, so only one admit has run.
  const admitsWhileHeld = linux.fake.calls.filter((call) => call.startsWith("admit")).length;

  release();

  const ended = await results(creates);
  const refused = ended.filter(Result.isFailure).map(({ failure }) => failure._tag);

  expect(admitsWhileHeld).toBe(1);
  expect(ended.filter(Result.isSuccess)).toHaveLength(1);
  expect(refused).toEqual(["Capacity"]);
  expect(await rows(linux)).toHaveLength(1);
});

test("of two concurrent starts that each fit only alone, exactly one passes", async () => {
  const linux = await host({ runtime: { ramBudgetMib: 1536 } });

  await linux.run(linux.machines.create(request("x")));
  await linux.run(linux.machines.stop("linux_x"));
  await linux.run(linux.machines.create(request("y")));
  await linux.run(linux.machines.stop("linux_y"));

  const { release, entered } = linux.fake.holdNext("admit");
  linux.fake.calls.length = 0;

  const starts = together([linux.machines.start("linux_x"), linux.machines.start("linux_y")]);

  await entered;
  await pause();

  const admitsWhileHeld = linux.fake.calls.filter((call) => call.startsWith("admit")).length;

  release();

  const ended = await results(starts);
  const refused = ended.filter(Result.isFailure).map(({ failure }) => failure._tag);

  expect(admitsWhileHeld).toBe(1);
  expect(ended.filter(Result.isSuccess)).toHaveLength(1);
  expect(refused).toEqual(["Capacity"]);
});

test("ports skip one that something else listens on, and concurrent creates get distinct ones", async () => {
  const server = createServer();

  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen({ host: "127.0.0.1", port: ports.first, exclusive: true }, resolve);
  });

  const linux = await host();

  const made = await linux.run(
    Effect.all(
      ["a", "b", "c"].map((name) => linux.machines.create(request(name))),
      { concurrency: "unbounded" },
    ),
  );

  const taken = made.map(({ ssh }) => ssh?.port ?? 0).sort((a, b) => a - b);

  expect(taken).toEqual([ports.first + 1, ports.first + 2, ports.first + 3]);
});

test("a host whose ports are all taken refuses a create with Capacity", async () => {
  const linux = await host({ ports: { first: ports.first, last: ports.first + 1 } });

  await linux.run(linux.machines.create(request("a")));
  await linux.run(linux.machines.create(request("b")));

  const full = await failure(linux, linux.machines.create(request("c")));

  expect(full._tag).toBe("Capacity");
  expect(full.message).toBe(`no free port in ${ports.first}-${ports.first + 1} on 127.0.0.1`);
});

test("a runtime without a publish address gives machines no port", async () => {
  const linux = await host({ runtime: { publishAddress: undefined } });
  const made = await linux.run(linux.machines.create(request("dev")));
  const row = await linux.run(linux.store.find("dev"));

  expect(made.ssh).toBeUndefined();
  expect(Option.getOrUndefined(row)?.port).toBeUndefined();
});
