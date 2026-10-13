import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type Checkpoint,
  Client,
  Conflict,
  type HostError,
  Internal,
  type Machine,
  NotFound,
  Prebuild,
  Precondition,
} from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Effect, Layer } from "effect";
import { SandboxAgent, SandboxDestroyedError } from "sandbox-agent";
import { afterEach, expect, test } from "vite-plus/test";
import {
  machine,
  type StubHost,
  stubHost,
  transport,
} from "@gjermundgaraba/clankerbox-sdk/testing";
import { provider } from "../src/provider.ts";
import { LocalTunnelError } from "../src/tunnel.ts";
import type { Options } from "../src/options.ts";

const fakeSsh = fileURLToPath(new URL("fake-ssh.mjs", import.meta.url));

const url = "http://linux.test";

const login = { user: "root", host: "100.64.0.7", port: 10_022 };

/** The stub host's runtime version, which a prebuild's name is of. */
const runtimeVersion = "0.0.0-test";

const hostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample root@linux";

const checkpoint = (id: string): Checkpoint => ({
  id,
  createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
  machine: "linux_source",
  kind: "disk",
  base: "ubuntu",
  cpu: 2,
  ramMib: 2048,
  diskGib: 20,
  action: { name: "capture", status: "done" },
});

/** A machine the tunnel can reach: running, with an endpoint and a host key. */
const reachable = (id: string, fields?: Partial<Machine>) =>
  machine(id, { ssh: login, hostKey, ...fields });

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

interface Call {
  readonly pid: number;
  readonly port: number;
  readonly args: ReadonlyArray<string>;
}

/**
 * A provider over one stub host, `linux`, whose tunnels run the stand-in ssh. `dir` holds the
 * files that steer the stand-in, and `calls` reads what it was run with.
 */
const setup = async (
  host: {
    readonly machines?: ReadonlyArray<Machine>;
    readonly checkpoints?: ReadonlyArray<Checkpoint>;
    /** What a create fails with, after it has left its machine on the host, unmade. */
    readonly createFails?: HostError;
    /** What a create is refused with, leaving nothing. */
    readonly createRefused?: HostError;
  },
  options: Omit<Options, "hosts" | "from"> & { readonly from?: Options["from"] } = {},
  ssh = fakeSsh,
  /** Wraps the client the provider uses, to watch or slow its calls. */
  wrap: (client: Client.Interface) => Client.Interface = (client) => client,
) => {
  const dir = await mkdtemp(join(tmpdir(), "clankerbox-provider-"));

  const stub: StubHost = stubHost({
    id: "linux",
    bases: ["ubuntu"],
    machines: host.machines ?? [],
    checkpoints: host.checkpoints ?? [],
    runtimeVersion,
    create: ({ id }) => {
      if (host.createRefused !== undefined) {
        return Effect.fail(host.createRefused);
      }

      const made = reachable(id, { made: host.createFails === undefined });

      stub.hold(made);

      return host.createFails === undefined ? Effect.succeed(made) : Effect.fail(host.createFails);
    },
  });

  const profile = join(dir, "agent.json");

  await writeFile(profile, JSON.stringify({ base: "ubuntu", cpu: 2, ramMib: 2048, diskGib: 20 }));
  process.env["FAKE_SSH_DIR"] = dir;

  const hosts = [{ id: "linux", url }];

  const sandbox = provider(
    { hosts, from: { profile }, ...options },
    Layer.mergeAll(
      Layer.effect(Client.Client, Effect.map(Client.make(hosts), wrap)).pipe(
        Layer.provide(transport(new Map([[new URL(url).origin, stub]]))),
      ),
      NodeServices.layer,
    ),
    ssh,
  );

  cleanups.push(async () => {
    await sandbox.dispose();
    await stub.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  const calls = async (): Promise<Array<Call>> =>
    (await readFile(join(dir, "calls"), "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));

  return { dir, stub, sandbox, calls };
};

/** Whether something accepts a connection on the loopback port. */
const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });

    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.once("error", () => resolve(false));
  });

/**
 * Whether the process `pid` is gone. Node reaps a child and records its exit in one step, so a
 * tunnel whose ssh is gone is one the provider knows has ended; a closed port alone may come first.
 */
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);

    return false;
  } catch {
    return true;
  }
};

const until = async (what: string, check: () => Promise<boolean>) => {
  const deadline = performance.now() + 5000;

  while (!(await check())) {
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("the SDK starts a sandbox from a profile and reaches its agent through a tunnel pinned to the machine's host key", async () => {
  const { stub, sandbox, calls } = await setup(
    {},
    {
      namePrefix: "agent",
      sshArguments: ["-i", "/keys/agent"],
    },
  );

  const sdk = await SandboxAgent.start({ sandbox });
  const [id = ""] = (sdk.sandboxId ?? "").split("/").slice(1);

  expect(sdk.sandboxId).toMatch(/^clankerbox\/linux_agent-[0-9a-f]{8}$/u);
  expect(stub.creates).toMatchObject([
    { id, base: "ubuntu", cpu: 2, ramMib: 2048, diskGib: 20, profile: "agent" },
  ]);
  expect(await sdk.getHealth()).toEqual({ status: "ok" });

  const [call, ...more] = await calls();
  const args = call?.args ?? [];

  // The SDK's pinnedSsh makes everything up to the destination, the machine's ID; the provider
  // adds the login user, the tunnel's options, then the caller's (OpenSSH keeps an option's first
  // value, so the caller's can't override the tunnel's), and the forward.
  expect(more).toEqual([]);
  expect(args.slice(0, 2)).toEqual(["-l", "root"]);
  expect(args.slice(args.indexOf(id))).toEqual([
    id,
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-i",
    "/keys/agent",
    "-L",
    `127.0.0.1:${call?.port}:127.0.0.1:2468`,
    "cat",
  ]);

  await sdk.destroySandbox();

  expect(stub.calls).toContain("machine.delete");
  await until("the tunnel to end", async () => !(await listening(call?.port ?? 0)));
});

test("a sandbox is a fork of a machine or a restore of a checkpoint when the provider is given one", async () => {
  const forked = await setup(
    { machines: [reachable("linux_warm")] },
    { from: { machine: "linux_warm" } },
  );

  expect(await forked.sandbox.create()).toMatch(/^linux_sandbox-[0-9a-f]{8}$/u);
  expect(forked.stub.calls).toEqual(["machine.fork"]);

  const restored = await setup(
    { checkpoints: [checkpoint("linux_base")] },
    { from: { checkpoint: "linux_base" } },
  );

  expect(await restored.sandbox.create()).toMatch(/^linux_sandbox-[0-9a-f]{8}$/u);
  expect(restored.stub.calls).toEqual(["machine.restore"]);

  const missing = await setup({}, { from: { checkpoint: "linux_gone" } });

  await expect(missing.sandbox.create()).rejects.toEqual(
    new NotFound({ message: "no checkpoint linux_gone" }),
  );
  expect(missing.stub.calls).toEqual(["machine.restore"]);
});

test("a create from a profile with a setup restores its host's prebuild of it, unless fresh, and runs the setup without one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clankerbox-profile-"));

  cleanups.push(() => rm(dir, { recursive: true, force: true }));

  const sizes = { base: "ubuntu", cpu: 2, ramMib: 2048, diskGib: 20 };
  const profile = join(dir, "agent.json");

  await writeFile(join(dir, "setup.sh"), "echo set up\n");
  await writeFile(
    profile,
    JSON.stringify({ ...sizes, setup: { path: "setup.sh", timeoutSeconds: 300 } }),
  );

  const sent = { script: "echo set up\n", timeoutSeconds: 300 };

  const name = await Effect.runPromise(
    Prebuild.nameOf({ ...sizes, profile: "agent", setup: sent }, { runtimeVersion }),
  );

  const prebuilt = { checkpoints: [checkpoint(`linux_${name}`)] };

  const restored = await setup(prebuilt, { from: { profile } });

  expect(await restored.sandbox.create()).toMatch(/^linux_sandbox-[0-9a-f]{8}$/u);
  expect(restored.stub.calls).toEqual(["host.get", "checkpoint.get", "machine.restore"]);

  const fresh = await setup(prebuilt, { from: { profile }, fresh: true });

  await fresh.sandbox.create();
  expect(fresh.stub.calls).toEqual(["host.get", "machine.create"]);
  expect(fresh.stub.creates.map((request) => request.setup)).toEqual([sent]);

  const unbuilt = await setup({}, { from: { profile } });

  await unbuilt.sandbox.create();
  expect(unbuilt.stub.calls).toEqual(["host.get", "checkpoint.get", "machine.create"]);
  expect(unbuilt.stub.creates.map((request) => request.setup)).toEqual([sent]);
});

test("a create that fails deletes the machine it left, and fails with the host's error", async () => {
  const failure = new Precondition({ message: "setup exited 1: no network" });

  const { stub, sandbox } = await setup({
    createFails: failure,
    machines: [reachable("linux_other")],
  });

  await expect(sandbox.create()).rejects.toEqual(failure);

  // The machine the create left is gone, and nothing else is.
  expect(stub.calls).toEqual(["host.get", "machine.create", "machine.list", "machine.delete"]);
  expect(stub.held()).toEqual(["linux_other"]);
});

test("a create refused with Conflict, as a name already taken is, deletes nothing", async () => {
  const refusal = new Conflict({ kind: "exists", message: "linux_taken already exists" });
  const { stub, sandbox } = await setup({ createRefused: refusal });

  await expect(sandbox.create()).rejects.toEqual(refusal);
  expect(stub.calls).toEqual(["host.get", "machine.create"]);
});

test("reconnecting to a machine that is gone, or ensuring its server, is the SDK's SandboxDestroyedError", async () => {
  const { sandbox } = await setup({});

  await expect(sandbox.reconnect("linux_gone")).rejects.toBeInstanceOf(SandboxDestroyedError);
  await expect(sandbox.ensureServer("linux_gone")).rejects.toBeInstanceOf(SandboxDestroyedError);

  await expect(SandboxAgent.start({ sandbox, sandboxId: "clankerbox/linux_gone" })).rejects.toThrow(
    "Sandbox 'clankerbox/linux_gone' no longer exists",
  );
});

test("the SDK reconnects to a machine by its ID: the machine is started and its tunnel opened", async () => {
  const { stub, sandbox, calls } = await setup({ machines: [reachable("linux_kept")] });
  const sdk = await SandboxAgent.start({ sandbox, sandboxId: "clankerbox/linux_kept" });

  expect(await sdk.getHealth()).toEqual({ status: "ok" });
  expect(stub.calls).toEqual(["machine.start", "machine.get"]);
  expect(await calls()).toHaveLength(1);

  await sdk.pauseSandbox();

  expect(stub.calls).toEqual(["machine.start", "machine.get", "machine.stop"]);
});

test("ensureServer opens a tunnel that ended on the same port, and starts the machine only when its agent doesn't answer", async () => {
  const { dir, stub, sandbox, calls } = await setup({ machines: [reachable("linux_kept")] });
  const opened = await sandbox.getUrl("linux_kept");
  const [first] = await calls();

  process.kill(first?.pid ?? 0);
  await until(
    "the tunnel to end",
    async () => gone(first?.pid ?? 0) && !(await listening(first?.port ?? 0)),
  );
  stub.calls.length = 0;

  await sandbox.ensureServer("linux_kept");

  const [, second] = await calls();

  expect(second?.port).toBe(first?.port);
  expect(await sandbox.getUrl("linux_kept")).toBe(opened);
  expect(stub.calls).toEqual(["machine.get"]);

  // A running tunnel whose agent fails its health check: the machine's start relaunches it, and
  // the tunnel is opened anew, to the endpoint the machine has now.
  await writeFile(join(dir, "unhealthy"), "");
  stub.hold(reachable("linux_kept", { ssh: { ...login, port: 20_022 } }));
  stub.calls.length = 0;

  await sandbox.ensureServer("linux_kept");

  const [, , third] = await calls();

  expect(stub.calls).toEqual(["machine.start", "machine.get"]);
  expect(third?.port).toBe(first?.port);
  expect(third?.args).toContain("Port=20022");
});

test("a tunnel whose ssh fails says what ssh printed or why it couldn't run, and a machine without an endpoint is Precondition", async () => {
  const { dir, sandbox } = await setup({
    machines: [reachable("linux_kept"), machine("linux_stopped", { state: "stopped", hostKey })],
  });

  await writeFile(join(dir, "refuse"), "");

  await expect(sandbox.getUrl("linux_kept")).rejects.toEqual(
    new Internal({
      message:
        "the tunnel to linux_kept ended before it listened: root@100.64.0.7: Permission denied (publickey).",
    }),
  );

  const unrun = await setup({ machines: [reachable("linux_kept")] }, {}, "/nonexistent/ssh");

  await expect(unrun.sandbox.getUrl("linux_kept")).rejects.toEqual(
    new LocalTunnelError({
      message:
        "the tunnel to linux_kept ended before it listened: couldn't run /nonexistent/ssh: spawn /nonexistent/ssh ENOENT",
    }),
  );

  await expect(sandbox.getUrl("linux_stopped")).rejects.toEqual(
    new Precondition({
      message:
        "linux_stopped has no SSH endpoint, which its tunnel needs: see clankerbox get linux_stopped",
    }),
  );
});

test("one sandbox's calls take turns: two reconnects never start its machine at the same time", async () => {
  let running = 0;
  let most = 0;

  const { sandbox } = await setup(
    { machines: [reachable("linux_kept")] },
    {},
    fakeSsh,
    (client) => ({
      ...client,
      start: (id) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            running += 1;
            most = Math.max(most, running);
          }),
          () => Effect.andThen(Effect.sleep("50 millis"), client.start(id)),
          () => Effect.sync(() => (running -= 1)),
        ),
    }),
  );

  await Promise.all([sandbox.reconnect("linux_kept"), sandbox.reconnect("linux_kept")]);

  expect(most).toBe(1);
});

test("a tunnel refuses a port another program took while it was down, and ensureServer doesn't start the machine for it", async () => {
  const { stub, sandbox, calls } = await setup({ machines: [reachable("linux_kept")] });

  await sandbox.getUrl("linux_kept");

  const [first] = await calls();
  const port = first?.port ?? 0;

  process.kill(first?.pid ?? 0);
  await until("the tunnel to end", async () => gone(first?.pid ?? 0) && !(await listening(port)));

  const squatter = createServer().listen(port, "127.0.0.1");

  cleanups.push(() => new Promise((resolve) => squatter.close(() => resolve())));
  await once(squatter, "listening");
  stub.calls.length = 0;

  await expect(sandbox.ensureServer("linux_kept")).rejects.toEqual(
    new LocalTunnelError({
      message: `the tunnel to linux_kept can't use port ${port}: another program listens on it`,
    }),
  );
  expect(await calls()).toHaveLength(1);
  expect(stub.calls).toEqual(["machine.get"]);
});

test("a tunnel left open doesn't keep its program running, and ends when the program does", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clankerbox-provider-"));

  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  process.env["FAKE_SSH_DIR"] = dir;

  // The program returns with its tunnel open, and exits on its own.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL("leave-tunnel.ts", import.meta.url)), fakeSsh, dir],
    { timeout: 10_000 },
  );

  const port = Number(stdout);

  expect(port).toBeGreaterThan(0);
  await until("the tunnel to end", async () => !(await listening(port)));
});

test("the provider's version is the SDK's, which it is published with", async () => {
  const version = async (manifest: string) =>
    JSON.parse(await readFile(new URL(manifest, import.meta.url), "utf8")).version;

  expect(await version("../package.json")).toBe(await version("../../sdk/package.json"));
});
