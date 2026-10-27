import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  Conflict,
  Invalid,
  NotFound,
  NotOffered,
  Prebuild,
  ScriptFailed,
  Superseded,
  Unavailable,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Checkpoint } from "@gjermundgaraba/clankerbox-sdk";
import { operatorKey } from "@gjermundgaraba/clankerbox-sdk/testing/keys";
import { DateTime, Effect, Schema } from "effect";
import { SandboxAgent, SandboxDestroyedError } from "sandbox-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  cleanUp,
  cleanups,
  fakeSsh,
  listening,
  login,
  reachable,
  recording,
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

const decodeManifest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String }))
);

const version = async (manifest: string) => {
  const text = await readFile(new URL(manifest, import.meta.url), "utf-8");

  return decodeManifest(text).version;
};

describe("provider", () => {
  afterEach(cleanUp);

  it("the SDK starts a sandbox from a profile and reaches its agent through a tunnel pinned to the machine's host key", async () => {
    const { stub, sandbox, calls } = await setup(
      {},
      {
        namePrefix: "agent",
        sshArguments: ["-i", "/keys/agent"],
      }
    );

    const sdk = await SandboxAgent.start({ sandbox });
    const [id = ""] = (sdk.sandboxId ?? "").split("/").slice(1);

    expect(sdk.sandboxId).toMatch(/^clankerbox\/linux_agent-[0-9a-f]{8}$/u);
    expect(stub.creates).toMatchObject([
      {
        id,
        base: "ubuntu",
        cpu: 2,
        ramMib: 2048,
        diskGib: 20,
        profile: "agent",
      },
    ]);
    await expect(sdk.getHealth()).resolves.toStrictEqual({ status: "ok" });

    const [call, ...more] = await calls();
    const args = call?.args ?? [];

    expect(more).toStrictEqual([]);
    expect(args.slice(0, 2)).toStrictEqual(["-l", "admin"]);
    expect(args).toContain(`HostKeyAlias=${id}`);
    expect(args.slice(args.indexOf(login.host))).toStrictEqual([
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
    await until(
      "the tunnel to end",
      async () => !(await listening(call?.port ?? 0))
    );
  });

  it("a sandbox is a fork of a machine or a restore of a checkpoint when the provider is given one", async () => {
    const forked = await setup(
      { machines: [reachable("linux_warm")] },
      { from: { machine: "linux_warm" } }
    );

    await expect(forked.sandbox.create()).resolves.toMatch(
      /^linux_sandbox-[0-9a-f]{8}$/u
    );
    expect(forked.stub.calls).toStrictEqual(["machine.fork"]);

    const restored = await setup(
      { checkpoints: [checkpoint("linux_base")] },
      { from: { checkpoint: "linux_base" } }
    );

    await expect(restored.sandbox.create()).resolves.toMatch(
      /^linux_sandbox-[0-9a-f]{8}$/u
    );
    expect(restored.stub.calls).toStrictEqual(["machine.restore"]);

    const missing = await setup({}, { from: { checkpoint: "linux_gone" } });

    const restoring = missing.sandbox.create();

    await expect(restoring).rejects.toBeInstanceOf(NotFound);
    await expect(restoring).rejects.toMatchObject({
      message: "no checkpoint linux_gone",
      host: "linux",
      action: "restoreMachine",
    });
    expect(missing.stub.calls).toStrictEqual([
      "machine.restore",
      "machine.delete",
    ]);
    expect(missing.stub.held()).toStrictEqual([]);
  });

  it("a create from a profile with a setup and authorizedKeys restores its host's prebuild of both, unless fresh, and runs the setup without one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "clankerbox-profile-"));

    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const sizes = { base: "ubuntu", cpu: 2, ramMib: 2048, diskGib: 20 };
    const profile = path.join(dir, "agent.json");

    await writeFile(path.join(dir, "setup.sh"), "echo set up\n");
    await writeFile(path.join(dir, "id.pub"), keys);
    await writeFile(
      profile,
      JSON.stringify({
        ...sizes,
        setup: { path: "setup.sh", timeoutSeconds: 300 },
      })
    );

    const sent = {
      script: "echo set up\n",
      timeoutSeconds: 300,
      authorizedKeys: keys,
    };

    const from = { profile };
    const authorizedKeys = path.join(dir, "id.pub");

    const name = await Effect.runPromise(
      Prebuild.nameOf(
        { ...sizes, profile: "agent", setup: sent },
        { runtimeVersion }
      )
    );

    const prebuilt = { checkpoints: [checkpoint(`linux_${name}`)] };

    const restored = await setup(prebuilt, { from, authorizedKeys });

    await expect(restored.sandbox.create()).resolves.toMatch(
      /^linux_sandbox-[0-9a-f]{8}$/u
    );
    expect(restored.stub.calls).toStrictEqual([
      "host.get",
      "checkpoint.get",
      "machine.restore",
    ]);

    const fresh = await setup(prebuilt, { from, authorizedKeys, fresh: true });

    await fresh.sandbox.create();
    expect(fresh.stub.calls).toStrictEqual(["host.get", "machine.create"]);
    expect(fresh.stub.creates.map((request) => request.setup)).toStrictEqual([
      sent,
    ]);

    const unbuilt = await setup({}, { from, authorizedKeys });

    await unbuilt.sandbox.create();
    expect(unbuilt.stub.calls).toStrictEqual([
      "host.get",
      "checkpoint.get",
      "machine.create",
    ]);
    expect(unbuilt.stub.creates.map((request) => request.setup)).toStrictEqual([
      sent,
    ]);
  });

  it("a create from a profile with a setup and no authorizedKeys is Invalid, and asks no host", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "clankerbox-profile-"));

    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const profile = path.join(dir, "agent.json");

    await writeFile(path.join(dir, "setup.sh"), "echo set up\n");
    await writeFile(
      profile,
      JSON.stringify({
        base: "ubuntu",
        cpu: 2,
        ramMib: 2048,
        diskGib: 20,
        setup: { path: "setup.sh" },
      })
    );

    const { stub, sandbox } = await setup({}, { from: { profile } });

    const creating = sandbox.create();

    await expect(creating).rejects.toBeInstanceOf(Invalid);
    await expect(creating).rejects.toMatchObject({
      message:
        "create: a setup needs authorizedKeys, the public keys the host installs for the login user after it",
    });
    expect(stub.calls).toStrictEqual([]);
  });

  it("a create the host fails, as a preparation the host keeps the machine for, deletes the machine", async () => {
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
    });
    await expect(creating).rejects.toHaveProperty(
      "id",
      expect.stringMatching(/^linux_sandbox-[0-9a-f]{8}$/u)
    );

    expect(stub.calls).toStrictEqual([
      "host.get",
      "machine.create",
      "machine.delete",
    ]);
    expect(stub.held()).toStrictEqual(["linux_other"]);
  });

  it("a create a later request superseded keeps the machine that request asked for", async () => {
    const { stub, sandbox } = await setup({
      createFails: new Superseded({
        message: "asked to be stopped",
        by: "stopped",
      }),
    });

    await expect(sandbox.create()).rejects.toBeInstanceOf(Superseded);
    expect(stub.calls).toStrictEqual(["host.get", "machine.create"]);
    expect(stub.held()).toStrictEqual([
      expect.stringMatching(/^linux_sandbox-[0-9a-f]{8}$/u),
    ]);
  });

  it("a create whose answer was lost deletes the machine it may have made", async () => {
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
            })
          )
        ),
    }));

    await expect(sandbox.create()).rejects.toBeInstanceOf(Unavailable);
    expect(stub.calls).toStrictEqual([
      "host.get",
      "machine.create",
      "machine.delete",
    ]);
    expect(stub.held()).toStrictEqual([]);
  });

  it("a create that fails before any host makes a machine, as a placement no host takes, deletes nothing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "clankerbox-profile-"));

    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const profile = path.join(dir, "elsewhere.json");

    await writeFile(
      profile,
      JSON.stringify({ base: "debian", cpu: 2, ramMib: 2048, diskGib: 20 })
    );

    const { stub, sandbox } = await setup(
      { machines: [reachable("linux_other")] },
      { from: { profile } }
    );

    const creating = sandbox.create();

    await expect(creating).rejects.toBeInstanceOf(NotOffered);
    await expect(creating).rejects.not.toHaveProperty("id");
    expect(stub.calls).toStrictEqual(["host.get"]);
    expect(stub.held()).toStrictEqual(["linux_other"]);
  });

  it("a create whose prebuild read fails deletes nothing, though the error names the prebuild", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "clankerbox-profile-"));

    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const profile = path.join(dir, "agent.json");

    await writeFile(path.join(dir, "setup.sh"), "echo set up\n");
    await writeFile(
      profile,
      JSON.stringify({
        base: "ubuntu",
        cpu: 2,
        ramMib: 2048,
        diskGib: 20,
        setup: { path: "setup.sh" },
      })
    );
    await writeFile(path.join(dir, "id.pub"), keys);

    const lost = new Unavailable({
      message: "no reply",
      readOnly: true,
      host: "linux",
      action: "getCheckpoint",
      id: "linux_prebuilt-000000000000",
    });

    const options = {
      from: { profile },
      authorizedKeys: path.join(dir, "id.pub"),
    };

    const { stub, sandbox } = await setup({}, options, undefined, (client) => ({
      ...client,
      getCheckpoint: () => Effect.fail(lost),
    }));

    await expect(sandbox.create()).rejects.toBeInstanceOf(Unavailable);
    expect(stub.calls).toStrictEqual(["host.get"]);
    expect(stub.held()).toStrictEqual([]);
  });

  it("a create refused with Conflict, as a name already taken is, deletes nothing", async () => {
    const refusal = new Conflict({ message: "linux_taken already exists" });
    const { stub, sandbox } = await setup({ createRefused: refusal });

    const creating = sandbox.create();

    await expect(creating).rejects.toBeInstanceOf(Conflict);
    await expect(creating).rejects.toMatchObject({ message: refusal.message });
    expect(stub.calls).toStrictEqual(["host.get", "machine.create"]);
  });

  it("a source's sizes go to the restore or fork with the copy's name, or override a profile's", async () => {
    const sent: unknown[] = [];

    const forked = await setup(
      { machines: [reachable("linux_warm")] },
      { from: { machine: "linux_warm", ramMib: 4096 } },
      undefined,
      recording(sent)
    );

    const restored = await setup(
      { checkpoints: [checkpoint("linux_base")] },
      { from: { checkpoint: "linux_base", cpu: 4, diskGib: 40 } },
      undefined,
      recording(sent)
    );

    const dir = await mkdtemp(path.join(tmpdir(), "clankerbox-profile-"));
    const profile = path.join(dir, "big.json");

    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    await writeFile(
      profile,
      JSON.stringify({ base: "ubuntu", cpu: 2, ramMib: 2048, diskGib: 20 })
    );

    const sized = await setup({}, { from: { profile, ramMib: 8192 } });

    const names = [
      await forked.sandbox.create(),
      await restored.sandbox.create(),
    ].map((id) => id.split("_")[1]);

    await sized.sandbox.create();

    expect(sent).toStrictEqual([
      { machine: "linux_warm", ramMib: 4096, name: names[0] },
      { checkpoint: "linux_base", cpu: 4, diskGib: 40, name: names[1] },
    ]);
    expect(sized.stub.creates).toMatchObject([
      { cpu: 2, ramMib: 8192, diskGib: 20 },
    ]);
  });

  it("resize sends the sandbox's machine its sizes, whatever id they carry, and answers those it then has, and a machine that is gone is the SDK's SandboxDestroyedError", async () => {
    const sent: unknown[] = [];

    const { stub, sandbox } = await setup(
      { machines: [reachable("linux_kept")] },
      {},
      undefined,
      recording(sent)
    );

    const resized = await sandbox.resize("linux_kept", {
      cpu: 4,
      ramMib: 8192,
    });

    const reused = { id: "linux_other", diskGib: 20 };

    await sandbox.resize("linux_kept", reused);

    await expect(
      sandbox.resize("linux_gone", { cpu: 4 })
    ).rejects.toBeInstanceOf(SandboxDestroyedError);
    expect(resized).toStrictEqual({ cpu: 4, ramMib: 8192, diskGib: 10 });
    expect(sent).toStrictEqual([
      { id: "linux_kept", cpu: 4, ramMib: 8192 },
      { id: "linux_kept", diskGib: 20 },
      { id: "linux_gone", cpu: 4 },
    ]);
    expect(stub.calls).toStrictEqual([
      "machine.resize",
      "machine.resize",
      "machine.resize",
    ]);
  });

  it("reconnecting to a machine that is gone, or ensuring its server, is the SDK's SandboxDestroyedError", async () => {
    const { sandbox } = await setup({});

    await expect(sandbox.reconnect("linux_gone")).rejects.toBeInstanceOf(
      SandboxDestroyedError
    );
    await expect(sandbox.ensureServer("linux_gone")).rejects.toBeInstanceOf(
      SandboxDestroyedError
    );

    await expect(
      SandboxAgent.start({ sandbox, sandboxId: "clankerbox/linux_gone" })
    ).rejects.toThrow("Sandbox 'clankerbox/linux_gone' no longer exists");
  });

  it("the SDK reconnects to a machine by its ID, started and its tunnel opened, and pauses it with a stop that the next reconnect starts", async () => {
    const { stub, sandbox, calls } = await setup({
      machines: [reachable("linux_kept")],
    });

    const sdk = await SandboxAgent.start({
      sandbox,
      sandboxId: "clankerbox/linux_kept",
    });

    await expect(sdk.getHealth()).resolves.toStrictEqual({ status: "ok" });
    expect(stub.calls).toStrictEqual(["machine.start", "machine.get"]);
    await expect(calls()).resolves.toHaveLength(1);

    await sdk.pauseSandbox();

    expect(stub.calls).toStrictEqual([
      "machine.start",
      "machine.get",
      "machine.stop",
    ]);

    const resumed = await SandboxAgent.start({
      sandbox,
      sandboxId: "clankerbox/linux_kept",
    });

    await expect(resumed.getHealth()).resolves.toStrictEqual({ status: "ok" });
    expect(stub.calls).toStrictEqual([
      "machine.start",
      "machine.get",
      "machine.stop",
      "machine.start",
      "machine.get",
    ]);
  });

  it("one sandbox's calls take turns: two reconnects never start its machine at the same time", async () => {
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
            () =>
              Effect.andThen(
                Effect.sleep("50 millis"),
                client.startMachine(input)
              ),
            () => Effect.sync(() => (running -= 1))
          ),
      })
    );

    await Promise.all([
      sandbox.reconnect("linux_kept"),
      sandbox.reconnect("linux_kept"),
    ]);

    expect(most).toBe(1);
  });

  it("the provider's version is the SDK's, which it is published with", async () => {
    await expect(version("../package.json")).resolves.toBe(
      await version("../../sdk/package.json")
    );
  });
});
