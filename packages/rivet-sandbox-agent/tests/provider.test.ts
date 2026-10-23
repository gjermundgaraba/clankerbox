import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Checkpoint,
  Conflict,
  Invalid,
  NotFound,
  NotOffered,
  Prebuild,
  ScriptFailed,
  Superseded,
  Unavailable,
} from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Effect } from "effect";
import { SandboxAgent, SandboxDestroyedError } from "sandbox-agent";
import { operatorKey } from "@gjermundgaraba/clankerbox-sdk/testing";
import { afterEach, expect, test } from "vite-plus/test";
import {
  cleanUp,
  cleanups,
  fakeSsh,
  listening,
  login,
  reachable,
  runtimeVersion,
  setup,
  until,
} from "./support.ts";

const keys = `${operatorKey}\n`;

const checkpoint = (id: string): Checkpoint => ({
  id,
  createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
  machine: "linux_source",
  kind: "disk",
  base: "ubuntu",
  cpu: 2,
  ramMib: 2048,
  diskGib: 20,
});

afterEach(cleanUp);

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

  expect(more).toEqual([]);
  expect(args.slice(0, 2)).toEqual(["-l", "admin"]);
  expect(args).toContain(`HostKeyAlias=${id}`);
  expect(args.slice(args.indexOf(login.host))).toEqual([
    login.host,
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

  const restoring = missing.sandbox.create();

  await expect(restoring).rejects.toBeInstanceOf(NotFound);
  await expect(restoring).rejects.toMatchObject({
    message: "no checkpoint linux_gone",
    host: "linux",
    action: "restoreMachine",
  });
  expect(missing.stub.calls).toEqual(["machine.restore", "machine.delete"]);
  expect(missing.stub.held()).toEqual([]);
});

test("a create from a profile with a setup and authorizedKeys restores its host's prebuild of both, unless fresh, and runs the setup without one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clankerbox-profile-"));

  cleanups.push(() => rm(dir, { recursive: true, force: true }));

  const sizes = { base: "ubuntu", cpu: 2, ramMib: 2048, diskGib: 20 };
  const profile = join(dir, "agent.json");

  await writeFile(join(dir, "setup.sh"), "echo set up\n");
  await writeFile(join(dir, "id.pub"), keys);
  await writeFile(
    profile,
    JSON.stringify({ ...sizes, setup: { path: "setup.sh", timeoutSeconds: 300 } }),
  );

  const sent = { script: "echo set up\n", timeoutSeconds: 300, authorizedKeys: keys };
  const from = { profile };
  const authorizedKeys = join(dir, "id.pub");

  const name = await Effect.runPromise(
    Prebuild.nameOf({ ...sizes, profile: "agent", setup: sent }, { runtimeVersion }),
  );

  const prebuilt = { checkpoints: [checkpoint(`linux_${name}`)] };

  const restored = await setup(prebuilt, { from, authorizedKeys });

  expect(await restored.sandbox.create()).toMatch(/^linux_sandbox-[0-9a-f]{8}$/u);
  expect(restored.stub.calls).toEqual(["host.get", "checkpoint.get", "machine.restore"]);

  const fresh = await setup(prebuilt, { from, authorizedKeys, fresh: true });

  await fresh.sandbox.create();
  expect(fresh.stub.calls).toEqual(["host.get", "machine.create"]);
  expect(fresh.stub.creates.map((request) => request.setup)).toEqual([sent]);

  const unbuilt = await setup({}, { from, authorizedKeys });

  await unbuilt.sandbox.create();
  expect(unbuilt.stub.calls).toEqual(["host.get", "checkpoint.get", "machine.create"]);
  expect(unbuilt.stub.creates.map((request) => request.setup)).toEqual([sent]);
});

test("a create from a profile with a setup and no authorizedKeys is Invalid, and asks no host", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clankerbox-profile-"));

  cleanups.push(() => rm(dir, { recursive: true, force: true }));

  const profile = join(dir, "agent.json");

  await writeFile(join(dir, "setup.sh"), "echo set up\n");
  await writeFile(
    profile,
    JSON.stringify({
      base: "ubuntu",
      cpu: 2,
      ramMib: 2048,
      diskGib: 20,
      setup: { path: "setup.sh" },
    }),
  );

  const { stub, sandbox } = await setup({}, { from: { profile } });

  const creating = sandbox.create();

  await expect(creating).rejects.toBeInstanceOf(Invalid);
  await expect(creating).rejects.toMatchObject({
    message:
      "create: a setup needs authorizedKeys, the public keys the host installs for the login user after it",
  });
  expect(stub.calls).toEqual([]);
});

test("a create the host fails, as a preparation the host keeps the machine for, deletes the machine", async () => {
  const failure = new ScriptFailed({
    message: "preparation exited 1: no network",
    script: "preparation",
  });

  const { stub, sandbox } = await setup({
    createFails: failure,
    machines: [reachable("linux_other")],
  });

  const creating = sandbox.create();

  await expect(creating).rejects.toBeInstanceOf(ScriptFailed);
  await expect(creating).rejects.toMatchObject({
    message: failure.message,
    host: "linux",
    action: "createMachine",
    id: expect.stringMatching(/^linux_sandbox-[0-9a-f]{8}$/u),
  });

  expect(stub.calls).toEqual(["host.get", "machine.create", "machine.delete"]);
  expect(stub.held()).toEqual(["linux_other"]);
});

test("a create a later request superseded keeps the machine that request asked for", async () => {
  const { stub, sandbox } = await setup({
    createFails: new Superseded({ message: "asked to be stopped", by: "stopped" }),
  });

  await expect(sandbox.create()).rejects.toBeInstanceOf(Superseded);
  expect(stub.calls).toEqual(["host.get", "machine.create"]);
  expect(stub.held()).toEqual([expect.stringMatching(/^linux_sandbox-[0-9a-f]{8}$/u)]);
});

test("a create whose answer was lost deletes the machine it may have made", async () => {
  const { stub, sandbox } = await setup({}, {}, undefined, (client) => ({
    ...client,
    create: (name, spec, options) =>
      Effect.andThen(
        client.create(name, spec, options),
        Effect.fail(
          new Unavailable({
            message: "no reply",
            readOnly: false,
            host: "linux",
            action: "createMachine",
            made: `linux_${name}`,
          }),
        ),
      ),
  }));

  await expect(sandbox.create()).rejects.toBeInstanceOf(Unavailable);
  expect(stub.calls).toEqual(["host.get", "machine.create", "machine.delete"]);
  expect(stub.held()).toEqual([]);
});

test("a create that fails before any host makes a machine, as a placement no host takes, deletes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clankerbox-profile-"));

  cleanups.push(() => rm(dir, { recursive: true, force: true }));

  const profile = join(dir, "elsewhere.json");

  await writeFile(profile, JSON.stringify({ base: "debian", cpu: 2, ramMib: 2048, diskGib: 20 }));

  const { stub, sandbox } = await setup(
    { machines: [reachable("linux_other")] },
    { from: { profile } },
  );

  const creating = sandbox.create();

  await expect(creating).rejects.toBeInstanceOf(NotOffered);
  await expect(creating).rejects.not.toHaveProperty("id");
  expect(stub.calls).toEqual(["host.get"]);
  expect(stub.held()).toEqual(["linux_other"]);
});

test("a create whose prebuild read fails deletes nothing, though the error names the prebuild", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clankerbox-profile-"));

  cleanups.push(() => rm(dir, { recursive: true, force: true }));

  const profile = join(dir, "agent.json");

  await writeFile(join(dir, "setup.sh"), "echo set up\n");
  await writeFile(
    profile,
    JSON.stringify({
      base: "ubuntu",
      cpu: 2,
      ramMib: 2048,
      diskGib: 20,
      setup: { path: "setup.sh" },
    }),
  );
  await writeFile(join(dir, "id.pub"), keys);

  const lost = new Unavailable({
    message: "no reply",
    readOnly: true,
    host: "linux",
    action: "getCheckpoint",
    id: "linux_prebuilt-000000000000",
  });

  const options = { from: { profile }, authorizedKeys: join(dir, "id.pub") };

  const { stub, sandbox } = await setup({}, options, undefined, (client) => ({
    ...client,
    getCheckpoint: () => Effect.fail(lost),
  }));

  await expect(sandbox.create()).rejects.toBeInstanceOf(Unavailable);
  expect(stub.calls).toEqual(["host.get"]);
  expect(stub.held()).toEqual([]);
});

test("a create refused with Conflict, as a name already taken is, deletes nothing", async () => {
  const refusal = new Conflict({ message: "linux_taken already exists" });
  const { stub, sandbox } = await setup({ createRefused: refusal });

  const creating = sandbox.create();

  await expect(creating).rejects.toBeInstanceOf(Conflict);
  await expect(creating).rejects.toMatchObject({ message: refusal.message });
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

test("the SDK reconnects to a machine by its ID, started and its tunnel opened, and pauses it, its ACP servers closed first", async () => {
  const { stub, sandbox, calls, acp } = await setup({ machines: [reachable("linux_kept")] });
  const sdk = await SandboxAgent.start({ sandbox, sandboxId: "clankerbox/linux_kept" });

  expect(await sdk.getHealth()).toEqual({ status: "ok" });
  expect(stub.calls).toEqual(["machine.start", "machine.get"]);
  expect(await calls()).toHaveLength(1);

  await sdk.pauseSandbox();

  expect(stub.calls).toEqual(["machine.start", "machine.get", "machine.pause"]);
  expect((await acp()).toSorted()).toEqual([
    "DELETE /v1/acp/sdk%20codex%2F2",
    "DELETE /v1/acp/sdk-claude-1",
    "GET /v1/acp",
  ]);

  const resumed = await SandboxAgent.start({ sandbox, sandboxId: "clankerbox/linux_kept" });

  expect(await resumed.getHealth()).toEqual({ status: "ok" });
  expect(stub.calls).toEqual([
    "machine.start",
    "machine.get",
    "machine.pause",
    "machine.start",
    "machine.get",
  ]);
});

test("a pause with no tunnel open opens one to close a running machine's ACP servers first", async () => {
  const { stub, sandbox, calls, acp } = await setup({ machines: [reachable("linux_kept")] });

  await sandbox.pause("linux_kept");

  expect(stub.calls).toEqual(["machine.get", "machine.pause"]);
  expect(await calls()).toHaveLength(1);
  expect((await acp()).toSorted()).toEqual([
    "DELETE /v1/acp/sdk%20codex%2F2",
    "DELETE /v1/acp/sdk-claude-1",
    "GET /v1/acp",
  ]);
});

test("a pause of a machine that isn't running, or whose server doesn't answer, closes nothing", async () => {
  const { dir, stub, sandbox, acp } = await setup({
    machines: [reachable("linux_paused", { state: "paused" }), reachable("linux_down")],
  });

  await writeFile(join(dir, "unhealthy"), "");
  await sandbox.pause("linux_paused");
  await sandbox.pause("linux_down");

  expect(stub.calls).toEqual(["machine.get", "machine.pause", "machine.get", "machine.pause"]);
  expect(await acp()).toEqual([]);
});

test("a pause whose ACP servers won't close leaves the machine running, and says why", async () => {
  const { dir, stub, sandbox } = await setup({ machines: [reachable("linux_kept")] });

  await writeFile(join(dir, "acp-refuses"), "");

  await expect(sandbox.pause("linux_kept")).rejects.toMatchObject({
    message: expect.stringContaining(
      "couldn't close linux_kept's ACP servers, so it isn't paused: DELETE http://127.0.0.1:",
    ),
  });
  expect(stub.calls).toEqual(["machine.get"]);
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
      startMachine: (input) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            running += 1;
            most = Math.max(most, running);
          }),
          () => Effect.andThen(Effect.sleep("50 millis"), client.startMachine(input)),
          () => Effect.sync(() => (running -= 1)),
        ),
    }),
  );

  await Promise.all([sandbox.reconnect("linux_kept"), sandbox.reconnect("linux_kept")]);

  expect(most).toBe(1);
});

test("the provider's version is the SDK's, which it is published with", async () => {
  const version = async (manifest: string) =>
    JSON.parse(await readFile(new URL(manifest, import.meta.url), "utf8")).version;

  expect(await version("../package.json")).toBe(await version("../../sdk/package.json"));
});
