import { readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { Capacity, Conflict, type HostError, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Fiber, Option, Result } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { Refusal } from "../src/runtime.ts";
import { scratch } from "./scratch.ts";
import { cleanup, request, startHost, type TestHost } from "./support.ts";

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

/** A host in a fresh scratch directory, or, after a restart, in its predecessor's. */
const host = async (options?: Parameters<typeof startHost>[1] & { readonly dir?: string }) => {
  const started = await startHost(options?.dir ?? (await scratch(owned)), options);

  hosts.push(started);

  return started;
};

const failure = <A, E>(host: TestHost, effect: Effect.Effect<A, E>) =>
  host.run(Effect.flip(effect));

const rows = (host: TestHost) => host.run(host.store.list);

/** Between polls of a row. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 50));

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

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
    ssh: { host: "127.0.0.1" },
  });
  expect(made.ssh?.port).toBeGreaterThanOrEqual(10_000);
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

test("start on a running machine boots nothing and runs preparation again; setup never runs again", async () => {
  const linux = await host();

  await linux.run(linux.machines.create(request("dev", { setup: installsStart })));
  linux.fake.calls.length = 0;

  const started = await linux.run(linux.machines.start("linux_dev"));

  expect(started).toMatchObject({ state: "running", action: { name: "start", status: "done" } });
  expect(linux.fake.calls).toEqual(["exec linux_dev"]);
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

test("stop on a stopped machine does nothing and writes nothing", async () => {
  const linux = await host();

  await linux.run(linux.machines.create(request("dev")));
  await linux.run(linux.machines.stop("linux_dev"));
  linux.fake.calls.length = 0;

  const again = await linux.run(linux.machines.stop("linux_dev"));

  expect(again).toMatchObject({ state: "stopped", action: { name: "stop", status: "done" } });
  expect(linux.fake.calls).toEqual([]);
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

test("stop and delete are never refused for an earlier failure", async () => {
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

  expect(stopped.action).toMatchObject({ name: "start", status: "failed" });
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
  await linux.run(linux.store.insert({ ...row, action: "create" }));
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

  expect(error._tag).toBe("Precondition");
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

test("stop after a restart during create stops the VM the create left running", async () => {
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
  const stopped = await restarted.run(restarted.machines.stop("linux_dev"));

  expect(before).toMatchObject({ state: "running", action: restartedDuringCreate });
  expect(stopped).toMatchObject({ state: "stopped", action: { name: "stop", status: "done" } });
  expect(linux.fake.calls).toContain("stop linux_dev");
});

test("stop after a crash before the runtime's create does nothing and writes nothing", async () => {
  const linux = await host();

  await linux.run(linux.machines.create(request("dev")));

  const row = Option.getOrThrow(await linux.run(linux.store.find("dev")));

  // As in the delete test above: the row a crash leaves before the first runtime call.
  await linux.run(linux.machines.delete("linux_dev"));
  await linux.run(linux.store.insert({ ...row, action: "create" }));
  await linux.dispose();
  linux.fake.calls.length = 0;

  const restarted = await host({ fake: linux.fake, dir: linux.dir });
  const stopped = await restarted.run(restarted.machines.stop("linux_dev"));

  await restarted.run(restarted.machines.delete("linux_dev"));

  expect(stopped).toMatchObject({ state: "missing", action: restartedDuringCreate });
  expect(linux.fake.calls).toEqual(["startup", "delete linux_dev"]);
  expect(await rows(restarted)).toEqual([]);
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

test("a setup that runs past its timeout fails the create with the output so far, and its file goes", async () => {
  const linux = await host();
  const script = `#!/bin/sh\n# ${marker}\necho "running as $0"\nsleep 30\n`;

  const error = await failure(
    linux,
    linux.machines.create(request("dev", { setup: { script, timeoutSeconds: 1 } })),
  );

  const file = /running as (\S+)/u.exec(error.message)?.[1] ?? "";

  // The guard polls once a second for the killed shell.
  for (let waited = 0; waited < 3000 && (await exists(file)); waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  expect(error._tag).toBe("Precondition");
  expect(error.message).toContain("setup ran past its 1s timeout");
  expect(error.message.includes(marker)).toBe(false);
  expect(file).toMatch(/^\/var\/tmp\/clankerbox-setup\./u);
  await expect(stat(file)).rejects.toThrow();
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

/** Listens on the first port from 10000 that is free on 127.0.0.1, and returns it. */
const occupy = async (): Promise<number> => {
  for (let port = 10_000; ; port++) {
    const server = createServer();

    const bound = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve(true));
    });

    if (bound) {
      servers.push(server);

      return port;
    }
  }
};

test("ports skip one that something else listens on, and concurrent creates get distinct ones", async () => {
  const taken = await occupy();
  const linux = await host();

  const made = await linux.run(
    Effect.all(
      ["a", "b", "c"].map((name) => linux.machines.create(request(name))),
      { concurrency: "unbounded" },
    ),
  );

  const ports = made.map(({ ssh }) => ssh?.port);

  expect(new Set(ports).size).toBe(3);
  expect(ports).not.toContain(taken);
  expect(ports.every((port) => port !== undefined && port >= 10_000 && port <= 19_999)).toBe(true);
});

test("a runtime without a publish address gives machines no port", async () => {
  const linux = await host({ runtime: { publishAddress: undefined } });
  const made = await linux.run(linux.machines.create(request("dev")));
  const row = await linux.run(linux.store.find("dev"));

  expect(made.ssh).toBeUndefined();
  expect(Option.getOrUndefined(row)?.port).toBeUndefined();
});
