import { readFile } from "node:fs/promises";

import {
  Conflict,
  Invalid,
  NotBuilt,
  NotFound,
  NotOffered,
  ScriptFailed,
  Superseded,
  Unavailable,
} from "@gjermundgaraba/clankerbox-sdk";
import { checkpoint } from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import { Deferred, Effect, Schema } from "effect";
import { SandboxAgent, SandboxDestroyedError } from "sandbox-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { clankerbox } from "../src/index.ts";
import {
  cleanUp,
  fakeSsh,
  gone,
  live,
  liveTunnel,
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

const made = (sshArguments: readonly string[]) => {
  try {
    clankerbox({
      server: "http://server.test",
      from: { template: "agent" },
      sshArguments,
    });

    return "made";
  } catch (error) {
    return error instanceof Invalid ? error.message : String(error);
  }
};

const gate = () => {
  let entered = false;
  const opened = Deferred.makeUnsafe<undefined>();

  return {
    held: Effect.suspend(() => {
      entered = true;

      return Deferred.await(opened);
    }),
    entered: () => entered,
    open: () => {
      Deferred.doneUnsafe(opened, Effect.undefined);
    },
  };
};

const refused = (arg: string, why: string) => `sshArguments: ${arg} ${why}`;

const holds = (arg: string, flag: string, why: string) =>
  `sshArguments: ${arg} holds -${flag}, which ${why}`;

const command = (word: string) =>
  `sshArguments: ${word} isn't an option, and ssh would run what follows it as the tunnel's command`;

describe("provider", () => {
  afterEach(cleanUp);

  it("the SDK starts a sandbox from a template and reaches its agent through a tunnel pinned to the machine's host key", async () => {
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
    expect(stub.creates).toStrictEqual([{ id, template: "agent" }]);
    await expect(sdk.getHealth()).resolves.toStrictEqual({ status: "ok" });

    const call = liveTunnel(await calls());
    const { args } = call;

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
      "ClearAllForwardings=no",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-o",
      "SessionType=default",
      "-o",
      "StdinNull=no",
      "-o",
      "ForkAfterAuthentication=no",
      "-o",
      "RemoteCommand=none",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-i",
      "/keys/agent",
      "-L",
      `${call.socket}:127.0.0.1:2468`,
      "cat",
    ]);

    await sdk.destroySandbox();

    expect(stub.calls).toContain("machine.delete");
    await until("the tunnel to end", async () => gone(call.pid));
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
    expect(requests(missing.stub)).toStrictEqual(["machine.restore"]);
    expect(missing.stub.held()).toStrictEqual([]);
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

  it("a create from a template with no ready build is NotBuilt, and deletes nothing", async () => {
    const { stub, sandbox } = await setup({
      refuse: {
        createMachine: new NotBuilt({
          message: "template agent has no ready build",
          template: "agent",
        }),
      },
    });

    await expect(sandbox.create()).rejects.toBeInstanceOf(NotBuilt);
    expect(requests(stub)).toStrictEqual(["machine.create"]);
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

  it("a source's sizes go to the restore or fork with the copy's name, or grow a template build's", async () => {
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

    const sized = await setup(
      {},
      { from: { template: "agent", ramMib: 8192 } }
    );

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
      { template: "agent", ramMib: 8192 },
    ]);
    expect(sized.stub.creates[0]).not.toHaveProperty("cpu");
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
    expect(live(await calls())).toHaveLength(1);

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

  it("a destroy and a pause keep the tunnel open until the machine's delete or stop is done, so a reply the agent is still sending arrives", async () => {
    const open: Record<string, boolean> = {};
    let tunnel: number | undefined;

    const { sandbox, calls } = await setup(
      { machines: [reachable("kept"), reachable("held")] },
      {},
      fakeSsh,
      (client) => ({
        ...client,
        deleteMachine: (input) =>
          Effect.andThen(
            Effect.promise(async () => {
              open["delete"] = tunnel !== undefined && !gone(tunnel);
            }),
            client.deleteMachine(input)
          ),
        stopMachine: (input) =>
          Effect.andThen(
            Effect.promise(async () => {
              open["stop"] = tunnel !== undefined && !gone(tunnel);
            }),
            client.stopMachine(input)
          ),
      })
    );

    const kept = await SandboxAgent.start({
      sandbox,
      sandboxId: "clankerbox/kept",
    });

    tunnel = liveTunnel(await calls()).pid;
    await kept.pauseSandbox();

    const held = await SandboxAgent.start({
      sandbox,
      sandboxId: "clankerbox/held",
    });

    tunnel = liveTunnel(await calls()).pid;
    await held.destroySandbox();

    expect(open).toStrictEqual({ stop: true, delete: true });
    const ended = tunnel;

    await until("the tunnel to end", async () => gone(ended));
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

  it("a call that waited for a destroy takes turns with one that comes after the destroy", async () => {
    let running = 0;
    let most = 0;
    const deletes = gate();
    const starts = gate();

    const { stub, sandbox } = await setup(
      { machines: [reachable("kept")] },
      {},
      fakeSsh,
      (client) => ({
        ...client,
        deleteMachine: (input) =>
          Effect.andThen(deletes.held, client.deleteMachine(input)),
        startMachine: (input) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              running += 1;
              most = Math.max(most, running);
            }),
            () => Effect.andThen(starts.held, client.startMachine(input)),
            () => Effect.sync(() => (running -= 1))
          ),
      })
    );

    const destroying = sandbox.destroy("kept");

    await until("the delete to be sent", async () => deletes.entered());

    const waited = sandbox.reconnect("kept");

    deletes.open();
    await destroying;
    stub.hold(reachable("kept"));
    await until("the waiting reconnect's start", async () => starts.entered());

    const after = sandbox.reconnect("kept");

    starts.open();
    await Promise.all([waited, after]);

    expect(most).toBe(1);
  });

  it("clankerbox() takes ssh's options and their values as sshArguments, and refuses as Invalid a flag that would change a tunnel's session or who holds its forward or keep ssh from connecting, a word ssh would run as the command, and an option without its value", () => {
    const asked: ReadonlyArray<readonly string[]> = [
      [],
      ["-i", "/keys/agent"],
      ["-i", "-f"],
      ["-i-N"],
      ["-o", "SessionType=none", "-oStdinNull=yes"],
      ["-vvv", "-4C", "-F", "/dev/null", "-J", "jump", "-T"],
      ["-f"],
      ["-M"],
      ["-N"],
      ["-n"],
      ["-O", "check"],
      ["-S", "/tmp/master"],
      ["-S/tmp/master"],
      ["-s"],
      ["-tt"],
      ["-W", "127.0.0.1:22"],
      ["-G"],
      ["-Q", "cipher"],
      ["-V"],
      ["-vG"],
      ["-v", "-Tn"],
      ["-i", "/keys/agent", "uptime"],
      ["--", "-i"],
      [""],
      ["-i"],
      ["-v", "-l"],
    ];

    expect(asked.map((each) => made(each))).toStrictEqual([
      "made",
      "made",
      "made",
      "made",
      "made",
      "made",
      refused("-f", "forks ssh away from the tunnel"),
      refused(
        "-M",
        "makes ssh a connection master, which can outlive the tunnel"
      ),
      refused("-N", "leaves out the session cat runs in"),
      refused("-n", "takes the session's input"),
      refused("-O", "sends a command to a connection master"),
      refused(
        "-S",
        "hands the forward to a connection master, which outlives the tunnel"
      ),
      holds(
        "-S/tmp/master",
        "S",
        "hands the forward to a connection master, which outlives the tunnel"
      ),
      refused("-s", "replaces the session cat runs in"),
      holds("-tt", "t", "asks for a terminal, which garbles the echo"),
      refused("-W", "replaces the session with a stdio forward"),
      refused("-G", "prints ssh's configuration and exits before it connects"),
      refused("-Q", "prints what ssh supports and exits before it connects"),
      refused("-V", "prints ssh's version and exits before it connects"),
      holds(
        "-vG",
        "G",
        "prints ssh's configuration and exits before it connects"
      ),
      holds("-Tn", "n", "takes the session's input"),
      command("uptime"),
      command("--"),
      command("an empty word"),
      "sshArguments: -i needs a value",
      "sshArguments: -l needs a value",
    ]);
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
