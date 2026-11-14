import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Unavailable } from "@gjermundgaraba/clankerbox-sdk";
import type { Client } from "@gjermundgaraba/clankerbox-sdk";
import { Deferred, Effect } from "effect";
import { SandboxAgent } from "sandbox-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { healthPath } from "../src/agent.ts";
import { ProviderDisposedError } from "../src/index.ts";
import type { ClankerboxProvider } from "../src/options.ts";
import { LocalTunnelError } from "../src/tunnel.ts";
import { testLimit } from "./child.ts";
import {
  cleanUp,
  free,
  gone,
  live,
  liveTunnel,
  portOf,
  promptFor,
  reachable,
  requests,
  setup,
  stranger,
  until,
} from "./support.ts";

type Opened = Awaited<ReturnType<typeof setup>>;

const disposed = {
  _tag: "ProviderDisposedError",
  message: "the clankerbox provider was disposed",
};

const outcome = async (promise: Promise<unknown>) =>
  await promise.then(
    () => "resolved",
    (error: unknown) =>
      error instanceof Error ? error.constructor.name : String(error)
  );

type Finding = (
  set: Opened,
  tunnel: { readonly pid: number }
) => Promise<unknown>;

const findsGone: ReadonlyArray<readonly [string, Finding]> = Object.entries({
  pause: async ({ sandbox }) => {
    await sandbox.pause("kept");
  },
  resize: async ({ sandbox }) => await sandbox.resize("kept", { cpu: 4 }),
  reconnect: async ({ sandbox }) => {
    await sandbox.reconnect("kept");
  },
  ensureServer: async ({ dir, sandbox }) => {
    await writeFile(path.join(dir, "unhealthy"), "");

    await sandbox.ensureServer("kept");
  },
  getUrl: async ({ sandbox }, { pid }) => {
    process.kill(pid);
    await until("the tunnel's ssh to end", async () => gone(pid));

    return await sandbox.getUrl("kept");
  },
} satisfies Record<string, Finding>);

const awaited: ReadonlyArray<
  readonly [string, (sandbox: ClankerboxProvider) => Promise<unknown>]
> = Object.entries({
  pause: async (sandbox) => {
    await sandbox.pause("kept");
  },
  resize: async (sandbox) => await sandbox.resize("kept", { cpu: 4 }),
  reconnect: async (sandbox) => {
    await sandbox.reconnect("kept");
  },
  destroy: async (sandbox) => {
    await sandbox.destroy("kept");
  },
} satisfies Record<string, (sandbox: ClankerboxProvider) => Promise<unknown>>);

const heldFor = 200;

const gated = () => {
  let armed = false;
  let entered = false;
  const opened = Deferred.makeUnsafe<undefined>();

  const held = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      if (!armed) {
        return effect;
      }

      entered = true;

      return Effect.andThen(Deferred.await(opened), effect);
    });

  return {
    wrap: (client: Client.Interface): Client.Interface => ({
      ...client,
      stopMachine: (input) => held(client.stopMachine(input)),
      resizeMachine: (input) => held(client.resizeMachine(input)),
      startMachine: (input) => held(client.startMachine(input)),
      deleteMachine: (input) => held(client.deleteMachine(input)),
    }),
    arm: () => {
      armed = true;
    },
    entered: () => entered,
    release: () => {
      Deferred.doneUnsafe(opened, Effect.undefined);
    },
  };
};

const prompted = async (
  sent: typeof globalThis.fetch,
  url: string
): Promise<unknown> =>
  await sent(`${url}/v1/acp/kept`, promptFor(1)).then(
    async (reply) => await reply.json()
  );

describe("a sandbox's port", () => {
  afterEach(cleanUp);

  it.each(findsGone)(
    "a %s that finds its machine deleted elsewhere is SandboxDestroyedError, ends its tunnel and keeps its port, so no other program can take it and a prompt the provider's fetch sends there reaches nothing",
    async (_method, finding) => {
      const set = await setup({ machines: [reachable("kept")] });
      const url = await set.sandbox.getUrl("kept");
      const sent = await set.sandbox.getFetch("kept");
      const tunnel = liveTunnel(await set.calls());

      set.stub.script("kept", ["gone"]);

      const call = await outcome(finding(set, tunnel));

      await until("the tunnel's ssh to end", async () => gone(tunnel.pid));

      const { bound, heard } = await stranger(portOf(url));
      const prompt = await prompted(sent, url);

      expect({ call, bound, heard }).toStrictEqual({
        call: "SandboxDestroyedError",
        bound: "EADDRINUSE",
        heard: [],
      });
      expect(prompt).toMatchObject({ id: 1, error: { code: -32_603 } });
    }
  );

  it.each(["destroy", "dispose"])(
    "after a %s the port is free, and the fetch the provider gave out sends nothing to a program that takes it",
    async (end) => {
      const { sandbox, dispose } = await setup({
        machines: [reachable("kept")],
      });

      const url = await sandbox.getUrl("kept");
      const sent = await sandbox.getFetch("kept");

      await (end === "destroy" ? sandbox.destroy("kept") : dispose());

      const { heard } = await stranger(portOf(url));

      const health = await sent(`${url}${healthPath}`).then(
        (reply) => `answered ${reply.status}`,
        (error: unknown) => (error instanceof Error ? error.message : "")
      );

      expect({
        health,
        prompt: await prompted(sent, url),
        heard,
      }).toStrictEqual({
        health: `the provider holds no port for sandbox kept at ${url}`,
        prompt: {
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32_603,
            message: `sandbox kept's agent: the provider holds no port for sandbox kept at ${url}`,
          },
        },
        heard: [],
      });
    }
  );

  it("a fetch kept from a sandbox destroyed and opened again sends only to the port it holds now", async () => {
    const { stub, sandbox } = await setup({ machines: [reachable("kept")] });

    const before = await sandbox.getUrl("kept");
    const sent = await sandbox.getFetch("kept");

    await sandbox.destroy("kept");

    const { heard } = await stranger(portOf(before));

    stub.hold(reachable("kept"));

    const after = await sandbox.getUrl("kept");

    const replies = await Promise.all(
      [before, after].map(
        async (url) =>
          await sent(`${url}${healthPath}`).then(
            async (reply): Promise<unknown> => await reply.json(),
            (error: unknown) => (error instanceof Error ? error.message : "")
          )
      )
    );

    expect(after).not.toBe(before);
    expect({ replies, heard }).toStrictEqual({
      replies: [
        `the provider holds no port for sandbox kept at ${before}`,
        { status: "ok" },
      ],
      heard: [],
    });
  });

  it("a destroy of a machine already gone resolves, and lets the port go", async () => {
    const { stub, sandbox } = await setup({ machines: [reachable("kept")] });
    const url = await sandbox.getUrl("kept");

    stub.script("kept", ["gone"]);

    await expect(sandbox.destroy("kept")).resolves.toBeUndefined();
    await expect(free(portOf(url))).resolves.toBe(true);
  });

  it("a destroy whose delete fails keeps the port", async () => {
    const { sandbox } = await setup(
      { machines: [reachable("kept")] },
      {},
      undefined,
      (client) => ({
        ...client,
        deleteMachine: () =>
          Effect.fail(
            new Unavailable({ message: "no reply", readOnly: false })
          ),
      })
    );

    const url = await sandbox.getUrl("kept");

    await expect(sandbox.destroy("kept")).rejects.toBeInstanceOf(Unavailable);
    await expect(free(portOf(url))).resolves.toBe(false);
  });

  it(
    "ensureServer starts the machine when its agent holds the health check past its wait",
    async () => {
      const { dir, stub, sandbox } = await setup({
        machines: [reachable("kept")],
      });

      await sandbox.getUrl("kept");
      await writeFile(path.join(dir, "hold-health"), "");
      stub.calls.length = 0;

      await sandbox.ensureServer("kept");

      expect(requests(stub)).toStrictEqual(["machine.start"]);
    },
    testLimit
  );

  it("ensureServer whose tunnel fails on this side, as when ssh can't run, fails so and leaves the machine as it is", async () => {
    const { stub, sandbox } = await setup(
      { machines: [reachable("kept")] },
      {},
      "/nonexistent/ssh"
    );

    await expect(sandbox.ensureServer("kept")).rejects.toBeInstanceOf(
      LocalTunnelError
    );
    expect(requests(stub)).toStrictEqual([]);
  });
});

describe("dispose", () => {
  afterEach(cleanUp);

  it("ends a getUrl or ensureServer still opening a tunnel at once, as ProviderDisposedError, with the tunnel's ssh, directory and port", async () => {
    const { dir, sandbox, calls, dispose } = await setup({
      machines: [reachable("kept"), reachable("held")],
    });

    const url = await sandbox.getUrl("held");
    const held = liveTunnel(await calls());

    process.kill(held.pid);
    await until("the tunnel's ssh to end", async () => gone(held.pid));
    await writeFile(path.join(dir, "never-opens"), "");

    const opening = Promise.all(
      [sandbox.getUrl("kept"), sandbox.ensureServer("held")].map(
        async (each): Promise<unknown> =>
          await each.then(
            () => "resolved",
            (error: unknown) => error
          )
      )
    );

    await until("both tunnels' ssh to start", async () => {
      const made = await calls();

      return made.filter(({ pid }) => !gone(pid)).length === 2;
    });

    const before = performance.now();

    await dispose();

    const took = performance.now() - before;
    const [, ...tunnels] = await calls();

    await expect(opening).resolves.toMatchObject([disposed, disposed]);
    expect(took).toBeLessThan(5000);
    expect(
      tunnels.map(({ pid, socket }) => [
        gone(pid),
        existsSync(path.dirname(socket)),
      ])
    ).toStrictEqual([
      [true, false],
      [true, false],
    ]);
    await expect(free(portOf(url))).resolves.toBe(true);
  });

  it("waits for a create still waiting on its machine, which then deletes it and rejects as ProviderDisposedError with its name as made", async () => {
    const { stub, sandbox, dispose } = await setup({
      created: ["creating", "down", "down", "settled"],
    });

    const settled: string[] = [];

    const creating = sandbox.create().then(
      () => "resolved",
      (error: unknown) => {
        settled.push("create");

        return error;
      }
    );

    await until(
      "the create to be recorded",
      async () => stub.held().length > 0
    );

    const [named] = stub.held();

    await dispose();
    settled.push("dispose");

    await expect(creating).resolves.toMatchObject({ ...disposed, made: named });
    expect(settled).toStrictEqual(["create", "dispose"]);
    expect(requests(stub)).toStrictEqual(["machine.create", "machine.delete"]);
    expect(stub.held()).toStrictEqual([]);
  });

  it("deletes the machine of a SandboxAgent.start whose create it waits for, and the start rejects with its name as made", async () => {
    const { stub, sandbox, dispose } = await setup({
      created: ["creating", "down", "down", "settled"],
    });

    const starting = SandboxAgent.start({ sandbox }).then(
      () => "resolved",
      (error: unknown) => error
    );

    await until(
      "the create to be recorded",
      async () => stub.held().length > 0
    );

    const [named] = stub.held();

    await dispose();

    await expect(starting).resolves.toMatchObject({ ...disposed, made: named });
    expect(requests(stub)).toStrictEqual(["machine.create", "machine.delete"]);
    expect(stub.held()).toStrictEqual([]);
  });

  it("deletes the machine of a SandboxAgent.start whose getUrl it ends, through the destroy the start then sends", async () => {
    const { dir, stub, sandbox, calls, dispose } = await setup();

    await writeFile(path.join(dir, "never-opens"), "");

    const starting = SandboxAgent.start({ sandbox }).then(
      () => "resolved",
      (error: unknown) => error
    );

    await until(
      "the tunnel's ssh to start",
      async () => live(await calls()).length === 1
    );
    await dispose();

    await expect(starting).resolves.toMatchObject(disposed);
    expect(requests(stub)).toStrictEqual(["machine.create", "machine.delete"]);
    expect(stub.held()).toStrictEqual([]);
  });

  it.each(awaited)(
    "waits for a %s in flight, then ends the sandbox's tunnel",
    async (method, asked) => {
      const settled: string[] = [];
      const gate = gated();

      const { sandbox, calls, dispose } = await setup(
        { machines: [reachable("kept")] },
        {},
        undefined,
        gate.wrap
      );

      await sandbox.getUrl("kept");

      const tunnel = liveTunnel(await calls());

      gate.arm();

      const calling = asked(sandbox).then(() => settled.push(method));

      await until("the call to reach its machine", async () => gate.entered());

      const disposing = dispose().then(() => settled.push("dispose"));

      await sleep(heldFor);

      expect({ settled, tunnel: gone(tunnel.pid) }).toStrictEqual({
        settled: [],
        tunnel: false,
      });

      gate.release();
      await Promise.all([calling, disposing]);

      expect(settled).toStrictEqual([method, "dispose"]);
      expect(gone(tunnel.pid)).toBe(true);
    }
  );

  it("refuses at once each call but destroy issued while it waits for a call in flight, and a destroy then deletes its machine once dispose is done, as a second dispose waits on the first", async () => {
    const settled: string[] = [];
    const gate = gated();

    const { stub, sandbox, dispose } = await setup(
      { machines: [reachable("kept"), reachable("other")] },
      {},
      undefined,
      gate.wrap
    );

    await sandbox.getUrl("kept");
    gate.arm();

    const pausing = sandbox.pause("kept");

    await until("the pause to reach its machine", async () => gate.entered());

    const disposing = dispose().then(() => settled.push("dispose"));
    const again = sandbox.dispose().then(() => settled.push("second dispose"));

    const destroying = sandbox
      .destroy("other")
      .then(() => settled.push("destroy"));

    for (const call of [
      sandbox.create(),
      sandbox.pause("kept"),
      sandbox.resize("kept", { cpu: 4 }),
      sandbox.reconnect("kept"),
      sandbox.ensureServer("kept"),
      sandbox.getUrl("kept"),
      sandbox.getFetch("kept"),
    ]) {
      await expect(call).rejects.toMatchObject(disposed);
    }

    expect(settled).toStrictEqual([]);

    gate.release();
    await Promise.all([pausing, disposing, again, destroying]);

    expect({
      disposes: settled.slice(0, 2).toSorted(),
      last: settled.at(-1),
    }).toStrictEqual({
      disposes: ["dispose", "second dispose"],
      last: "destroy",
    });
    expect(stub.held()).toStrictEqual(["kept"]);
  });

  it("refuses each call after it but destroy as ProviderDisposedError, a destroy still deletes its machine, and a second dispose resolves", async () => {
    const { stub, sandbox, dispose } = await setup({
      machines: [reachable("kept")],
    });

    await sandbox.getUrl("kept");
    await dispose();

    await expect(sandbox.destroy("kept")).resolves.toBeUndefined();
    expect(requests(stub)).toStrictEqual(["machine.delete"]);

    const calls = [
      sandbox.create(),
      sandbox.pause("kept"),
      sandbox.resize("kept", { cpu: 4 }),
      sandbox.reconnect("kept"),
      sandbox.ensureServer("kept"),
      sandbox.getUrl("kept"),
      sandbox.getFetch("kept"),
    ];

    for (const call of calls) {
      await expect(call).rejects.toMatchObject(disposed);
      await expect(call).rejects.toBeInstanceOf(ProviderDisposedError);
    }

    await expect(sandbox.dispose()).resolves.toBeUndefined();
  });

  it(
    "kills a tunnel's ssh that ignores SIGTERM once the close wait passes, so a destroy leaves none",
    async () => {
      const { dir, sandbox, calls } = await setup({
        machines: [reachable("kept")],
      });

      await writeFile(path.join(dir, "ignore-sigterm"), "");
      await sandbox.getUrl("kept");

      const tunnel = liveTunnel(await calls());

      await sandbox.destroy("kept");

      expect(gone(tunnel.pid)).toBe(true);
    },
    testLimit
  );
});
