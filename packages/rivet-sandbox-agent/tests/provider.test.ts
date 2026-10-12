import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Client,
  type HostError,
  Internal,
  type Machine,
  NotFound,
  Precondition,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Layer } from "effect";
import { SandboxAgent, SandboxDestroyedError } from "sandbox-agent";
import { afterEach, expect, test } from "vite-plus/test";
import { machine, type StubHost, stubHost, transport } from "../../sdk/tests/stub-host.ts";
import { provider } from "../src/provider.ts";
import type { Options } from "../src/options.ts";

const fakeSsh = fileURLToPath(new URL("fake-ssh.mjs", import.meta.url));

const url = "http://linux.test";

const login = { user: "root", host: "100.64.0.7", port: 10_022 };

const hostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample root@linux";

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
    /** What a create fails with, after it has left its machine on the host, unmade. */
    readonly createFails?: HostError;
  },
  options: Omit<Options, "hosts" | "from"> & { readonly from?: Options["from"] } = {},
) => {
  const dir = await mkdtemp(join(tmpdir(), "clankerbox-provider-"));

  const stub: StubHost = stubHost({
    id: "linux",
    bases: ["ubuntu"],
    machines: host.machines ?? [],
    create: ({ id }) => {
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
      Layer.effect(Client.Client, Client.make(hosts)).pipe(
        Layer.provide(transport(new Map([[new URL(url).origin, stub]]))),
      ),
      NodeServices.layer,
    ),
    fakeSsh,
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
  const knownHosts = call?.args.find((arg) => arg.startsWith("UserKnownHostsFile=")) ?? "";

  expect(more).toEqual([]);
  expect(call?.args).toEqual([
    "-l",
    "root",
    "-o",
    "HostName=100.64.0.7",
    "-o",
    "Port=10022",
    "-o",
    `HostKeyAlias=${id}`,
    "-o",
    knownHosts,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "StrictHostKeyChecking=yes",
    id,
    "-i",
    "/keys/agent",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    `127.0.0.1:${call?.port}:127.0.0.1:2468`,
    "cat",
  ]);
  expect(await readFile(knownHosts.slice("UserKnownHostsFile=".length), "utf8")).toBe(
    `${id} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n`,
  );

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

  const restored = await setup({}, { from: { checkpoint: "linux_base" } });

  await expect(restored.sandbox.create()).rejects.toEqual(
    new NotFound({ message: "no checkpoint linux_base" }),
  );
  expect(restored.stub.calls).toEqual(["machine.restore", "machine.list"]);
});

test("a create that fails deletes the machine it left, and fails with the host's error", async () => {
  const refusal = new Precondition({ message: "setup exited 1: no network" });

  const { stub, sandbox } = await setup({
    createFails: refusal,
    machines: [reachable("linux_other")],
  });

  await expect(sandbox.create()).rejects.toEqual(refusal);

  // The machine the create left is gone, and nothing else is.
  expect(stub.calls).toEqual(["host.get", "machine.create", "machine.list", "machine.delete"]);
  await expect(sandbox.reconnect?.("linux_other")).resolves.toBeUndefined();
});

test("reconnecting to a machine that is gone is the SDK's SandboxDestroyedError", async () => {
  const { sandbox } = await setup({});

  await expect(sandbox.reconnect?.("linux_gone")).rejects.toBeInstanceOf(SandboxDestroyedError);

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
  const opened = await sandbox.getUrl?.("linux_kept");
  const [first] = await calls();

  process.kill(first?.pid ?? 0);
  await until("the tunnel to end", async () => !(await listening(first?.port ?? 0)));
  stub.calls.length = 0;

  await sandbox.ensureServer?.("linux_kept");

  const [, second] = await calls();

  expect(second?.port).toBe(first?.port);
  expect(await sandbox.getUrl?.("linux_kept")).toBe(opened);
  expect(stub.calls).toEqual(["machine.get"]);

  // A running tunnel whose agent fails its health check: the machine's start relaunches it.
  await writeFile(join(dir, "unhealthy"), "");
  stub.calls.length = 0;

  await sandbox.ensureServer?.("linux_kept");

  expect(stub.calls).toEqual(["machine.start"]);
  expect(await calls()).toHaveLength(2);
});

test("a tunnel whose ssh fails says what ssh printed, and a machine without an endpoint is Precondition", async () => {
  const { dir, sandbox } = await setup({
    machines: [reachable("linux_kept"), machine("linux_stopped", { state: "stopped", hostKey })],
  });

  await writeFile(join(dir, "refuse"), "");

  await expect(sandbox.getUrl?.("linux_kept")).rejects.toEqual(
    new Internal({
      message:
        "the tunnel to linux_kept ended before it listened: root@100.64.0.7: Permission denied (publickey).",
    }),
  );

  await expect(sandbox.getUrl?.("linux_stopped")).rejects.toEqual(
    new Precondition({
      message:
        "linux_stopped has no SSH endpoint, which its tunnel needs: see clankerbox get linux_stopped",
    }),
  );
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
