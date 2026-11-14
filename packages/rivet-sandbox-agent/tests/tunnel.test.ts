import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import http, { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { Internal, WrongState } from "@gjermundgaraba/clankerbox-sdk";
import { machine } from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import { Schema } from "effect";
import { SandboxDestroyedError } from "sandbox-agent";
import {
  afterEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vite-plus/test";

import { healthPath } from "../src/agent.ts";
import { forwarding, LocalTunnelError } from "../src/tunnel.ts";
import { run, testLimit } from "./child.ts";
import {
  callsIn,
  cleanUp,
  aged,
  cleanups,
  gone,
  hostKey,
  free,
  leftIn,
  liveTunnel,
  login,
  portOf,
  prompted,
  promptFor,
  reachable,
  requests,
  scratch,
  setup,
  stranger,
  until,
} from "./support.ts";

const Killed = Schema.Struct({
  dir: Schema.String,
  pid: Schema.Finite,
  socket: Schema.String,
});

const decodeKilled = Schema.decodeSync(Schema.fromJsonString(Killed));

const Left = Schema.Struct({ url: Schema.String, dir: Schema.String });

const decodeLeft = Schema.decodeSync(Schema.fromJsonString(Left));

const temporaryDirectory = async (length: number) => {
  const base = await mkdtemp("/tmp/cb-");

  cleanups.push(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const padded = path.join(base, "d".repeat(length - base.length - 1));

  await mkdir(padded);

  return padded;
};

const halfClosed = async (port: number, request: string) => {
  const replied = Promise.withResolvers<string>();
  const socket = connect({ port, host: "127.0.0.1" });
  let reply = "";

  socket.setEncoding("utf-8");
  socket.on("data", (chunk: string) => {
    reply += chunk;
  });
  socket.once("end", () => {
    replied.resolve(reply);
  });
  socket.once("error", replied.reject);
  socket.end(request);

  return await replied.promise;
};

const withTmpdir = async <A>(directory: string, use: () => Promise<A>) => {
  const was = process.env["TMPDIR"];

  process.env["TMPDIR"] = directory;

  try {
    return await use();
  } finally {
    if (was === undefined) {
      delete process.env["TMPDIR"];
    } else {
      process.env["TMPDIR"] = was;
    }
  }
};

const socketBeyondTmpdir = "/clankerbox-tunnel-XXXXXX/agent.sock".length;

describe("tunnel", () => {
  afterEach(cleanUp);

  it("ensureServer opens a tunnel that ended behind the same port, and starts the machine only when its agent doesn't answer", async () => {
    const { dir, stub, sandbox, calls } = await setup({
      machines: [reachable("kept")],
    });

    const opened = await sandbox.getUrl("kept");
    const first = liveTunnel(await calls());

    process.kill(first.pid);
    await until("the tunnel's ssh to end", async () => gone(first.pid));
    stub.calls.length = 0;

    await sandbox.ensureServer("kept");

    const second = liveTunnel(await calls());

    expect(second.pid).not.toBe(first.pid);
    await expect(sandbox.getUrl("kept")).resolves.toBe(opened);
    expect(requests(stub)).toStrictEqual([]);

    await writeFile(path.join(dir, "unhealthy"), "");
    stub.hold(reachable("kept", { ssh: { ...login, port: 20_022 } }));
    stub.calls.length = 0;

    await sandbox.ensureServer("kept");

    const third = liveTunnel(await calls());

    expect(requests(stub)).toStrictEqual(["machine.start"]);
    expect(third.args).toContain("Port=20022");
    await expect(sandbox.getUrl("kept")).resolves.toBe(opened);
  });

  it("ensureServer checks a sandbox's health through the provider's own agent, so a proxy Node's global agent takes never hears it, and a healthy sandbox's machine isn't started for it", async () => {
    const proxied: string[] = [];

    const proxy = createServer((request, reply) => {
      proxied.push(`${request.method} ${request.url}`);
      reply.writeHead(502).end("the proxy");
    });

    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    cleanups.push(async () => {
      proxy.close();
    });

    const { stub, sandbox, calls } = await setup({
      machines: [reachable("kept")],
    });

    await sandbox.getUrl("kept");

    const { pid } = liveTunnel(await calls());

    const { port } = Schema.decodeUnknownSync(
      Schema.Struct({ port: Schema.Finite })
    )(proxy.address(), { onExcessProperty: "ignore" });

    onTestFinished(
      http.setGlobalProxyFromEnv({ HTTP_PROXY: `http://127.0.0.1:${port}` })
    );
    stub.calls.length = 0;

    await sandbox.ensureServer("kept");
    await sandbox.ensureServer("kept");

    expect({
      requests: requests(stub),
      proxied,
      tunnel: liveTunnel(await calls()).pid,
    }).toStrictEqual({ requests: [], proxied: [], tunnel: pid });
  });

  it("the provider's own ssh options hold against sshArguments and ssh config that would change the forward or its session, as OpenSSH resolves them", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "clankerbox-resolved-"));

    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const config = path.join(dir, "config");
    const socket = path.join(dir, "agent.sock");

    await writeFile(
      config,
      [
        "Host *",
        "  SessionType none",
        "  StdinNull yes",
        "  ForkAfterAuthentication yes",
        "  RemoteCommand echo config",
        "  RequestTTY force",
        "  ClearAllForwardings yes",
        "  ExitOnForwardFailure no",
        "  ControlMaster auto",
        "  ControlPath /tmp/config-master",
        "  BatchMode no",
        "",
      ].join("\n")
    );

    const stdout = execFileSync(
      "ssh",
      [
        "-G",
        "-F",
        config,
        "127.0.0.1",
        ...forwarding(socket, [
          "-o",
          "SessionType=none",
          "-o",
          "StdinNull=yes",
          "-o",
          "RemoteCommand=echo arguments",
          "-o",
          "ClearAllForwardings=yes",
          "-o",
          "ControlPath=/tmp/arguments-master",
        ]),
      ],
      { encoding: "utf-8" }
    );

    const resolved = new Map(
      stdout
        .split("\n")
        .map((line) => line.split(" "))
        .map(([name = "", ...value]) => [name, value.join(" ")])
    );

    expect(
      Object.fromEntries(
        [
          "batchmode",
          "clearallforwardings",
          "controlmaster",
          "controlpath",
          "exitonforwardfailure",
          "forkafterauthentication",
          "localforward",
          "remotecommand",
          "requesttty",
          "sessiontype",
          "stdinnull",
        ].map((name) => [name, resolved.get(name)])
      )
    ).toStrictEqual({
      batchmode: "yes",
      clearallforwardings: "no",
      controlmaster: "false",
      controlpath: undefined,
      exitonforwardfailure: "yes",
      forkafterauthentication: "no",
      localforward: `${socket} [127.0.0.1]:2468`,
      remotecommand: undefined,
      requesttty: "false",
      sessiontype: "default",
      stdinnull: "no",
    });
  });

  it("a tunnel whose ssh fails says what ssh printed or why it couldn't run, and a machine without an endpoint is WrongState", async () => {
    const { dir, sandbox } = await setup({
      machines: [
        reachable("kept"),
        machine("stopped", { state: "stopped", hostKey }),
      ],
    });

    await writeFile(path.join(dir, "refuse"), "");

    await expect(sandbox.getUrl("kept")).rejects.toStrictEqual(
      new Internal({
        message:
          "the tunnel to kept ended before it opened: admin@100.64.0.7: Permission denied (publickey).",
      })
    );

    const unrun = await setup(
      { machines: [reachable("kept")] },
      {},
      "/nonexistent/ssh"
    );

    await expect(unrun.sandbox.getUrl("kept")).rejects.toStrictEqual(
      new LocalTunnelError({
        message:
          "the tunnel to kept ended before it opened: couldn't run /nonexistent/ssh: spawn /nonexistent/ssh ENOENT",
      })
    );

    const stopped = sandbox.getUrl("stopped");

    await expect(stopped).rejects.toBeInstanceOf(WrongState);
    await expect(stopped).rejects.toMatchObject({
      machine: "stopped",
      state: "stopped",
    });
  });

  it("a tunnel opens on the line that ends in its echo, whatever the guest's login printed before it, and however the line comes in pieces", async () => {
    const { dir, sandbox } = await setup({
      machines: [reachable("chatty"), reachable("slow")],
    });

    await writeFile(
      path.join(dir, "login-prints"),
      "Welcome to the guest\nno newline here "
    );

    await expect(sandbox.getUrl("chatty")).resolves.toMatch(
      /^http:\/\/127\.0\.0\.1:\d+$/u
    );

    await rm(path.join(dir, "login-prints"));
    await writeFile(path.join(dir, "slow-echo"), "");

    await expect(sandbox.getUrl("slow")).resolves.toMatch(
      /^http:\/\/127\.0\.0\.1:\d+$/u
    );
  });

  it("a tunnel whose guest's login ends before its echo fails with the last of what it printed, as nologin's refusal or a line that only starts like the echo", async () => {
    const { dir, sandbox } = await setup({
      machines: [reachable("kept")],
    });

    const printed = async (text: string) => {
      await writeFile(path.join(dir, "login-prints"), text);

      return await sandbox.getUrl("kept").then(
        () => "opened",
        (error: unknown) =>
          error instanceof Internal ? error.message : String(error)
      );
    };

    await writeFile(path.join(dir, "login-refuses"), "");

    const long = `${"x".repeat(5000)} the end`;

    const refusal = await printed("This account is currently not available.\n");
    const likeTheEcho = await printed("clankerbox-tunnel-opened\n");
    const chatty = await printed(`${long}\n`);

    expect([refusal, likeTheEcho, chatty]).toStrictEqual([
      'the tunnel to kept ended before it opened: the guest printed "This account is currently not available."',
      'the tunnel to kept ended before it opened: the guest printed "clankerbox-tunnel-opened"',
      `the tunnel to kept ended before it opened: the guest printed "${`${long}\n`.slice(-600).trim()}"`,
    ]);
  });

  it("a URL given out reaches its sandbox's agent alone: while the tunnel is down no other program can take its port and a prompt sent there reaches nothing, and ensureServer opens the tunnel again behind it", async () => {
    const { stub, sandbox, calls } = await setup({
      machines: [reachable("kept")],
    });

    const url = await sandbox.getUrl("kept");
    const sent = await sandbox.getFetch("kept");
    const { pid } = liveTunnel(await calls());

    process.kill(pid);
    await until("the tunnel's ssh to end", async () => gone(pid));

    const { bound, heard } = await stranger(portOf(url));

    const health = await sent(`${url}${healthPath}`).then(
      (reply) => reply.status,
      () => "refused"
    );

    const prompt: unknown = await sent(`${url}/v1/acp/kept`, promptFor(1)).then(
      async (reply) => await reply.json()
    );

    expect({ bound, health, heard }).toStrictEqual({
      bound: "EADDRINUSE",
      health: "refused",
      heard: [],
    });
    expect(prompt).toMatchObject({ id: 1, error: { code: -32_603 } });

    stub.calls.length = 0;
    await sandbox.ensureServer("kept");

    await expect(sandbox.getUrl("kept")).resolves.toBe(url);
    await expect(
      sent(`${url}${healthPath}`).then(async (reply) => await reply.json())
    ).resolves.toStrictEqual({ status: "ok" });
    expect(requests(stub)).toStrictEqual([]);
  });

  it("a client that ends its side of a connection once it has sent its request still gets the whole reply through the relay", async () => {
    const { sandbox } = await setup({ machines: [reachable("kept")] });

    const url = await sandbox.getUrl("kept");

    await expect(
      halfClosed(portOf(url), `GET ${healthPath} HTTP/1.0\r\n\r\n`)
    ).resolves.toMatch(/^HTTP\/1\.1 200 OK\r\n[^]*\r\n\r\n\{"status":"ok"\}$/u);
  });

  it("a prompt in flight when its tunnel's ssh ends fails as that prompt's error", async () => {
    const { dir, sandbox, calls } = await setup({
      machines: [reachable("kept")],
    });

    await writeFile(path.join(dir, "hold-prompts"), "");

    const url = await sandbox.getUrl("kept");
    const sent = await sandbox.getFetch("kept");

    const prompt = sent(`${url}/v1/acp/kept`, promptFor(2)).then(
      async (reply): Promise<unknown> => await reply.json()
    );

    await prompted(dir);
    process.kill(liveTunnel(await calls()).pid);

    await expect(prompt).resolves.toMatchObject({
      id: 2,
      error: { code: -32_603 },
    });
  });

  it("a sandbox's port is its own until its consumer lets it go: a pause keeps it, a machine found gone keeps it, and a destroy and dispose let it go, dispose with its ssh and socket", async () => {
    const { dir, stub, sandbox, calls, dispose } = await setup({
      machines: [reachable("kept"), reachable("lost"), reachable("left")],
    });

    const kept = await sandbox.getUrl("kept");

    await sandbox.pause("kept");

    await expect(free(portOf(kept))).resolves.toBe(false);

    await sandbox.reconnect("kept");

    await expect(sandbox.getUrl("kept")).resolves.toBe(kept);

    const destroyed = liveTunnel(await calls());

    await sandbox.destroy("kept");

    await expect(free(portOf(kept))).resolves.toBe(true);
    expect(gone(destroyed.pid)).toBe(true);
    expect(existsSync(path.dirname(destroyed.socket))).toBe(false);

    const lost = await sandbox.getUrl("lost");

    await writeFile(path.join(dir, "unhealthy"), "");
    stub.script("lost", ["gone"]);

    await expect(sandbox.ensureServer("lost")).rejects.toBeInstanceOf(
      SandboxDestroyedError
    );
    await expect(free(portOf(lost))).resolves.toBe(false);

    const left = await sandbox.getUrl("left");
    const tunnel = liveTunnel(await calls());

    await dispose();

    await expect(free(portOf(left))).resolves.toBe(true);
    expect(gone(tunnel.pid)).toBe(true);
    expect(existsSync(path.dirname(tunnel.socket))).toBe(false);
  });

  it(
    "a getUrl whose port can't be listened on, as when the process holds every descriptor it may, fails so",
    async () => {
      const { code, stdout } = await run("no-files.ts", [], 256);

      expect({ code, stdout }).toStrictEqual({
        code: 0,
        stdout: `${JSON.stringify({
          outcome:
            "couldn't take a port for the tunnel to kept: listen EMFILE: too many open files 127.0.0.1",
        })}\n`,
      });
    },
    testLimit
  );

  it("a tunnel's socket path may be as long as the 103 bytes macOS takes and hold no ':', and one that breaks either fails before ssh runs", async () => {
    const { sandbox, calls } = await setup({
      machines: [reachable("kept")],
    });

    const most = await temporaryDirectory(103 - socketBeyondTmpdir);
    const over = await temporaryDirectory(104 - socketBeyondTmpdir);
    const colon = await temporaryDirectory(40);
    const separated = path.join(colon, "a:b");

    await mkdir(separated);

    const refused = async (directory: string) =>
      await withTmpdir(
        directory,
        async () =>
          await sandbox.getUrl("kept").then(
            () => "opened",
            (error: unknown) =>
              error instanceof LocalTunnelError ? error.message : String(error)
          )
      );

    await expect(refused(over)).resolves.toMatch(
      /^the tunnel to kept can't listen on .+: its path is 104 bytes, over the 103 a unix socket takes; set TMPDIR to a shorter directory$/u
    );
    await expect(refused(separated)).resolves.toMatch(
      /^the tunnel to kept can't listen on .+: ssh reads a ':' in a forward's path as a separator; set TMPDIR to a directory without one$/u
    );
    await expect(calls()).resolves.toStrictEqual([]);

    await expect(refused(most)).resolves.toBe("opened");
    expect(Buffer.byteLength(liveTunnel(await calls()).socket)).toBe(103);
  });

  it(
    "a sandbox's port and tunnel, a request through them done, don't keep its program running, and leave no ssh, listener or socket file once it ends",
    async () => {
      const { code, stdout } = await run("leave-tunnel.ts", []);
      const { url, dir } = decodeLeft(stdout);

      cleanups.push(async () => {
        await rm(dir, { recursive: true, force: true });
      });

      expect(code).toBe(0);

      const made = await callsIn(dir);
      const tunnel = made.at(-1);

      if (tunnel === undefined) {
        throw new Error("leave-tunnel.ts started no ssh");
      }

      await until("the tunnel's ssh to end", async () => gone(tunnel.pid));
      expect(existsSync(path.dirname(tunnel.socket))).toBe(false);
      await expect(free(portOf(url))).resolves.toBe(true);
    },
    testLimit
  );
});

describe("a tunnel's directory", () => {
  afterEach(cleanUp);

  it("holds only the tunnel's socket", async () => {
    const { sandbox, calls } = await setup({ machines: [reachable("kept")] });

    await sandbox.getUrl("kept");

    const { socket } = liveTunnel(await calls());
    const held = await readdir(path.dirname(socket));

    expect(held).toStrictEqual(["agent.sock"]);
  });

  it("a tunnel whose ssh fails quotes the last 600 characters ssh printed", async () => {
    const { dir, sandbox } = await setup({ machines: [reachable("kept")] });
    const printed = `${"y".repeat(300_000)} the end`;

    await writeFile(path.join(dir, "refuse"), "");
    await writeFile(path.join(dir, "refuse-says"), printed);

    await expect(sandbox.getUrl("kept")).rejects.toStrictEqual(
      new Internal({
        message: `the tunnel to kept ended before it opened: ${`${printed}\n`.slice(-600).trim()}`,
      })
    );
  });

  it("a tunnel whose ssh fails quotes what its ProxyCommand, which shares ssh's stderr, prints once ssh has ended", async () => {
    const { dir, sandbox } = await setup({ machines: [reachable("kept")] });

    await writeFile(path.join(dir, "refuse"), "");
    await writeFile(
      path.join(dir, "refuse-says"),
      "Connection closed by UNKNOWN port 65535"
    );
    await writeFile(path.join(dir, "proxy-says"), "proxy: the tailnet refused");

    await expect(sandbox.getUrl("kept")).rejects.toStrictEqual(
      new Internal({
        message:
          "the tunnel to kept ended before it opened: Connection closed by UNKNOWN port 65535\nproxy: the tailnet refused",
      })
    );
  });

  it("a tunnel whose ssh goes on printing once it is open still carries its requests", async () => {
    const { dir, sandbox } = await setup({ machines: [reachable("kept")] });

    await writeFile(path.join(dir, "stderr-after-open"), "100000");

    const url = await sandbox.getUrl("kept");
    const sent = await sandbox.getFetch("kept");

    await expect(
      sent(`${url}${healthPath}`).then(async (reply) => await reply.json())
    ).resolves.toStrictEqual({ status: "ok" });
  });

  it(
    "a program ended by a signal leaves its tunnel's directory, which the next provider's first tunnel removes once it is older than a minute, and its second leaves",
    async () => {
      const under = await scratch();

      const ended = await withTmpdir(
        under,
        async () => await run("killed.ts", [])
      );

      const { dir, pid, socket } = decodeKilled(ended.stdout);
      const left = path.dirname(socket);

      cleanups.push(async () => {
        await rm(dir, { recursive: true, force: true });
      });

      await until("the killed program's ssh to end", async () => gone(pid));
      expect(existsSync(left)).toBe(true);
      await aged(left);

      const later = await leftIn(under, "clankerbox-tunnel-Later1");

      await withTmpdir(under, async () => {
        const { sandbox } = await setup({
          machines: [reachable("kept"), reachable("other")],
        });

        await sandbox.getUrl("kept");
        expect(existsSync(left)).toBe(false);

        await aged(later);
        await sandbox.getUrl("other");
      });

      expect(existsSync(later)).toBe(true);
    },
    testLimit
  );
});
