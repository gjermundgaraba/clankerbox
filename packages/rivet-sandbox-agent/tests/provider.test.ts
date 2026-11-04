import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  Conflict,
  Invalid,
  NotFound,
  NotOffered,
  ScriptFailed,
  Superseded,
  Unavailable,
} from "@gjermundgaraba/clankerbox-sdk";
import { checkpoint } from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import { Effect, Schema } from "effect";
import { SandboxAgent, SandboxDestroyedError } from "sandbox-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { clankerbox } from "../src/index.ts";
import {
  cleanUp,
  cleanups,
  fakeSsh,
  listening,
  login,
  reachable,
  recording,
  requests,
  setup,
  until,
} from "./support.ts";

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

    expect(sdk.sandboxId).toMatch(/^clankerbox\/agent-[0-9a-f]{8}$/u);
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
      { machines: [reachable("warm")] },
      { from: { machine: "warm" } }
    );

    await expect(forked.sandbox.create()).resolves.toMatch(
      /^sandbox-[0-9a-f]{8}$/u
    );
    expect(requests(forked.stub)).toStrictEqual(["machine.fork"]);

    const restored = await setup(
      { checkpoints: [checkpoint("base")] },
      { from: { checkpoint: "base" } }
    );

    await expect(restored.sandbox.create()).resolves.toMatch(
      /^sandbox-[0-9a-f]{8}$/u
    );
    expect(requests(restored.stub)).toStrictEqual(["machine.restore"]);

    const missing = await setup({}, { from: { checkpoint: "gone" } });

    const restoring = missing.sandbox.create();

    await expect(restoring).rejects.toBeInstanceOf(NotFound);
    await expect(restoring).rejects.toMatchObject({
      message: "no checkpoint gone",
      action: "restoreMachine",
    });
    expect(requests(missing.stub)).toStrictEqual([
      "machine.restore",
      "machine.delete",
    ]);
    expect(missing.stub.held()).toStrictEqual([]);
  });

  it("a create from a profile with a setup sends it with no keys, and asks for a fresh setup only when told to", async () => {
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
        setup: { path: "setup.sh", timeoutSeconds: 300 },
      })
    );

    const from = { profile };
    const setUp = { script: "echo set up\n", timeoutSeconds: 300 };

    const plain = await setup({}, { from });

    await plain.sandbox.create();
    expect(plain.stub.creates.map((sent) => sent.setup)).toStrictEqual([setUp]);
    expect(plain.stub.creates[0]).not.toHaveProperty("fresh");

    const fresh = await setup({}, { from, fresh: true });

    await fresh.sandbox.create();
    expect(fresh.stub.creates).toMatchObject([{ setup: setUp, fresh: true }]);
  });

  it("a create that fails after it was recorded, as a failed preparation, deletes its machine", async () => {
    const failure = new ScriptFailed({
      message: "preparation exited 1: no network",
      script: "preparation",
    });

    const { stub, sandbox } = await setup({
      created: [{ phase: "failed", error: failure }],
      machines: [reachable("other")],
    });

    const creating = sandbox.create();

    await expect(creating).rejects.toBeInstanceOf(ScriptFailed);
    await expect(creating).rejects.toMatchObject({
      message: failure.message,
      action: "createMachine",
    });
    await expect(creating).rejects.toHaveProperty(
      "id",
      expect.stringMatching(/^sandbox-[0-9a-f]{8}$/u)
    );

    expect(requests(stub)).toStrictEqual(["machine.create", "machine.delete"]);
    expect(stub.held()).toStrictEqual(["other"]);
  });

  it("a create a later request superseded keeps the machine that request asked for", async () => {
    const { stub, sandbox } = await setup({
      created: [{ desired: "stopped", state: "stopped", phase: "settled" }],
    });

    await expect(sandbox.create()).rejects.toBeInstanceOf(Superseded);
    expect(requests(stub)).toStrictEqual(["machine.create"]);
    expect(stub.held()).toStrictEqual([
      expect.stringMatching(/^sandbox-[0-9a-f]{8}$/u),
    ]);
  });

  it("a create whose wait ended with its request saved, or whose answer was lost, keeps the machine, as the server may act on it", async () => {
    const { stub, sandbox } = await setup({}, {}, undefined, (client) => ({
      ...client,
      create: (name, spec, options) =>
        Effect.andThen(
          client.create(name, spec, options),
          Effect.fail(
            new Unavailable({
              message: "no reply",
              readOnly: false,
              action: "createMachine",
              made: name,
            })
          )
        ),
    }));

    await expect(sandbox.create()).rejects.toBeInstanceOf(Unavailable);
    expect(requests(stub)).toStrictEqual(["machine.create"]);
    expect(stub.held()).toStrictEqual([
      expect.stringMatching(/^sandbox-[0-9a-f]{8}$/u),
    ]);
  });

  it("a sandbox is handed out once its machine rests, through a moment its host can't be read", async () => {
    const { stub, sandbox } = await setup({
      created: ["creating", "waiting", "settled"],
    });

    const id = await sandbox.create();

    expect(stub.row(id)).toMatchObject({ phase: "settled", state: "running" });
    expect(requests(stub)).toStrictEqual(["machine.create"]);
  });

  it("a sandbox is handed out once its machine rests, through a short outage of the control plane", async () => {
    const { stub, sandbox } = await setup({
      created: ["creating", "down", "settled"],
    });

    const id = await sandbox.create();

    expect(stub.row(id)).toMatchObject({ phase: "settled", state: "running" });
    expect(requests(stub)).toStrictEqual(["machine.create"]);
  });

  it("a create refused because no host offers its base sends nothing after it, and leaves the machines as they are", async () => {
    const { stub, sandbox } = await setup({
      machines: [reachable("other")],
      refuse: {
        createMachine: new NotOffered({
          message: "no host offers base ubuntu",
          base: "ubuntu",
        }),
      },
    });

    await expect(sandbox.create()).rejects.toBeInstanceOf(NotOffered);
    expect(requests(stub)).toStrictEqual(["machine.create"]);
    expect(stub.held()).toStrictEqual(["other"]);
  });

  it("a create refused with Conflict, as a name already taken is, deletes nothing", async () => {
    const refusal = new Conflict({ message: "taken already exists" });

    const { stub, sandbox } = await setup({
      refuse: { createMachine: refusal },
    });

    const creating = sandbox.create();

    await expect(creating).rejects.toBeInstanceOf(Conflict);
    await expect(creating).rejects.toMatchObject({ message: refusal.message });
    expect(requests(stub)).toStrictEqual(["machine.create"]);
  });

  it("a source's sizes go to the restore or fork with the copy's name, or override a profile's", async () => {
    const sent: unknown[] = [];

    const forked = await setup(
      { machines: [reachable("warm")] },
      { from: { machine: "warm", ramMib: 4096 } },
      undefined,
      recording(sent)
    );

    const restored = await setup(
      { checkpoints: [checkpoint("base")] },
      { from: { checkpoint: "base", cpu: 4, diskGib: 40 } },
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
    ];

    await sized.sandbox.create();

    expect(sent).toStrictEqual([
      { machine: "warm", ramMib: 4096, name: names[0] },
      { checkpoint: "base", cpu: 4, diskGib: 40, name: names[1] },
    ]);
    expect(sized.stub.creates).toMatchObject([
      { cpu: 2, ramMib: 8192, diskGib: 20 },
    ]);
  });

  it("resize sends the sandbox's machine its sizes, whatever id they carry, and answers those it then has, and a machine that is gone is the SDK's SandboxDestroyedError", async () => {
    const sent: unknown[] = [];

    const { stub, sandbox } = await setup(
      { machines: [reachable("kept")] },
      {},
      undefined,
      recording(sent)
    );

    const resized = await sandbox.resize("kept", {
      cpu: 4,
      ramMib: 8192,
    });

    const reused = { id: "other", diskGib: 20 };

    await sandbox.resize("kept", reused);

    await expect(sandbox.resize("gone", { cpu: 4 })).rejects.toBeInstanceOf(
      SandboxDestroyedError
    );
    expect(resized).toStrictEqual({ cpu: 4, ramMib: 8192, diskGib: 10 });
    expect(sent).toStrictEqual([
      { id: "kept", cpu: 4, ramMib: 8192 },
      { id: "kept", diskGib: 20 },
      { id: "gone", cpu: 4 },
    ]);
    expect(requests(stub)).toStrictEqual([
      "machine.resize",
      "machine.resize",
      "machine.resize",
    ]);
  });

  it("reconnecting to a machine that is gone, or ensuring its server, is the SDK's SandboxDestroyedError", async () => {
    const { sandbox } = await setup({});

    await expect(sandbox.reconnect("gone")).rejects.toBeInstanceOf(
      SandboxDestroyedError
    );
    await expect(sandbox.ensureServer("gone")).rejects.toBeInstanceOf(
      SandboxDestroyedError
    );

    await expect(
      SandboxAgent.start({ sandbox, sandboxId: "clankerbox/gone" })
    ).rejects.toThrow("Sandbox 'clankerbox/gone' no longer exists");
  });

  it("a machine deleted while a call waits on it is the SDK's SandboxDestroyedError, as one already being deleted is", async () => {
    const { stub, sandbox } = await setup({
      machines: [
        reachable("kept"),
        reachable("sized"),
        reachable("leaving", { desired: "deleted" }),
      ],
    });

    stub.script("kept", ["gone"]);
    stub.script("sized", ["gone"]);

    await expect(sandbox.reconnect("kept")).rejects.toBeInstanceOf(
      SandboxDestroyedError
    );
    await expect(sandbox.resize("sized", { cpu: 4 })).rejects.toBeInstanceOf(
      SandboxDestroyedError
    );
    await expect(sandbox.reconnect("leaving")).rejects.toBeInstanceOf(
      SandboxDestroyedError
    );
  });

  it("the SDK reconnects to a machine by its ID, started and its tunnel opened, and pauses it with a stop that the next reconnect starts", async () => {
    const { stub, sandbox, calls } = await setup({
      machines: [reachable("kept")],
    });

    const sdk = await SandboxAgent.start({
      sandbox,
      sandboxId: "clankerbox/kept",
    });

    await expect(sdk.getHealth()).resolves.toStrictEqual({ status: "ok" });
    expect(requests(stub)).toStrictEqual(["machine.start"]);
    await expect(calls()).resolves.toHaveLength(1);

    await sdk.pauseSandbox();

    expect(requests(stub)).toStrictEqual(["machine.start", "machine.stop"]);

    const resumed = await SandboxAgent.start({
      sandbox,
      sandboxId: "clankerbox/kept",
    });

    await expect(resumed.getHealth()).resolves.toStrictEqual({ status: "ok" });
    expect(requests(stub)).toStrictEqual([
      "machine.start",
      "machine.stop",
      "machine.start",
    ]);
  });

  it("one sandbox's calls take turns: two reconnects never start its machine at the same time", async () => {
    let running = 0;
    let most = 0;

    const { sandbox } = await setup(
      { machines: [reachable("kept")] },
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

    await Promise.all([sandbox.reconnect("kept"), sandbox.reconnect("kept")]);

    expect(most).toBe(1);
  });

  it("clankerbox() builds its client over the server URL it is given", async () => {
    const creating = clankerbox({
      server: "not a url",
      from: { machine: "warm" },
    }).create();

    await expect(creating).rejects.toBeInstanceOf(Invalid);
    await expect(creating).rejects.toThrow("the server URL");
  });

  it("the provider's version is the SDK's, which it is published with", async () => {
    await expect(version("../package.json")).resolves.toBe(
      await version("../../sdk/package.json")
    );
  });
});
