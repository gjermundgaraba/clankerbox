import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Checkpoint,
  Conflict,
  NotFound,
  NotOffered,
  Prebuild,
  ScriptFailed,
  Unavailable,
} from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Effect } from "effect";
import { SandboxAgent, SandboxDestroyedError } from "sandbox-agent";
import { afterEach, expect, test } from "vite-plus/test";
import {
  cleanUp,
  cleanups,
  fakeSsh,
  listening,
  reachable,
  runtimeVersion,
  setup,
  until,
} from "./support.ts";

const checkpoint = (id: string): Checkpoint => ({
  id,
  createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
  machine: "linux_source",
  kind: "disk",
  base: "ubuntu",
  cpu: 2,
  ramMib: 2048,
  diskGib: 20,
  action: { name: "captureCheckpoint", status: "done" },
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

  const restoring = missing.sandbox.create();

  await expect(restoring).rejects.toBeInstanceOf(NotFound);
  await expect(restoring).rejects.toMatchObject({
    message: "no checkpoint linux_gone",
    host: "linux",
    action: "restoreMachine",
  });
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
  const failure = new ScriptFailed({
    message: "setup exited 1: no network",
    script: "setup",
    exitCode: 1,
    timedOut: false,
    output: "no network",
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

  const lost = new Unavailable({
    message: "no reply",
    readOnly: true,
    host: "linux",
    action: "getCheckpoint",
    id: "linux_prebuilt-000000000000",
  });

  const { stub, sandbox } = await setup({}, { from: { profile } }, undefined, (client) => ({
    ...client,
    getCheckpoint: () => Effect.fail(lost),
  }));

  await expect(sandbox.create()).rejects.toBeInstanceOf(Unavailable);
  expect(stub.calls).toEqual(["host.get"]);
  expect(stub.held()).toEqual([]);
});

test("a create refused with Conflict, as a name already taken is, deletes nothing", async () => {
  const refusal = new Conflict({ kind: "exists", message: "linux_taken already exists" });
  const { stub, sandbox } = await setup({ createRefused: refusal });

  const creating = sandbox.create();

  await expect(creating).rejects.toBeInstanceOf(Conflict);
  await expect(creating).rejects.toMatchObject({
    kind: "exists",
    message: refusal.message,
  });
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
