/** Exit codes when a signal stops the process: the CLI's 130 and the host role's 0. */
import { type ChildProcess, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { Exit, Schema } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { teardown } from "../src/roles.ts";
import { cleanup, scratch } from "./support.ts";

const owned: Array<string> = [];

const children: Array<ChildProcess> = [];

const servers: Array<{ readonly server: Server; readonly sockets: Array<Socket> }> = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }

  await Promise.all(
    servers.splice(0).map(
      ({ server, sockets }) =>
        new Promise((resolve) => {
          for (const socket of sockets) {
            socket.destroy();
          }

          server.close(resolve);
        }),
    ),
  );
  await cleanup(owned, []);
});

const codeOf = (exit: Exit.Exit<unknown, unknown>, args: ReadonlyArray<string>) => {
  let code = -1;

  teardown(args)(exit, (exitCode) => {
    code = exitCode;
  });

  return code;
};

test("an interrupt exits 130 for the CLI and 0 for the host role; a failure exits 1 for both", () => {
  const failed = Exit.fail(new Error("broke"));

  expect(codeOf(Exit.interrupt(), ["machines"])).toBe(130);
  expect(codeOf(Exit.interrupt(), ["host", "--config", "host.json"])).toBe(0);
  expect(codeOf(failed, ["machines"])).toBe(1);
  expect(codeOf(failed, ["host", "--config", "host.json"])).toBe(1);
  expect(codeOf(Exit.void, ["host", "--config", "host.json"])).toBe(0);
});

/** Runs `file` under this Node, with `args`, and resolves with its exit code. */
const run = (file: string, args: ReadonlyArray<string>) => {
  const child = spawn(process.execPath, [file, ...args], { stdio: "ignore" });

  children.push(child);

  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });

  return { child, exited };
};

/** A loopback server that accepts connections and never answers. */
const silent = async () => {
  const accepted = Promise.withResolvers<void>();
  const sockets: Array<Socket> = [];

  const server = createServer((socket) => {
    sockets.push(socket);
    accepted.resolve();
  });

  servers.push({ server, sockets });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  return { port: portOf(server), accepted: accepted.promise };
};

const portOf = (server: Server) =>
  Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(server.address(), {
    onExcessProperty: "ignore",
  }).port;

/** A port that was free on loopback a moment ago. */
const freePort = async () => {
  const server = createServer();

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = portOf(server);

  await new Promise((resolve) => {
    server.close(resolve);
  });

  return port;
};

test("the CLI exits 130 when SIGINT stops it mid-call", async () => {
  const dir = await scratch(owned);
  const { port, accepted } = await silent();
  const config = join(dir, "config.json");

  await writeFile(
    config,
    JSON.stringify({ hosts: [{ id: "linux", url: `http://127.0.0.1:${port}` }] }),
  );

  const { child, exited } = run(join(import.meta.dirname, "../src/main.ts"), [
    "machines",
    "--config",
    config,
  ]);

  await accepted;
  child.kill("SIGINT");

  expect(await exited).toBe(130);
});

test("the host role exits 0 when SIGTERM stops it", async () => {
  const dir = await scratch(owned);
  const port = await freePort();
  const { child, exited } = run(join(import.meta.dirname, "host-role.ts"), [dir, String(port)]);

  let served = false;

  for (let tries = 0; tries < 100 && !served; tries++) {
    served = await fetch(`http://127.0.0.1:${port}/api/host/get`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then(
      (response) => response.ok,
      () => false,
    );

    if (!served) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  child.kill("SIGTERM");

  expect(served).toBe(true);
  expect(await exited).toBe(0);
});
