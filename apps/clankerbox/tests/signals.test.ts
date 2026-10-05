/**
 * The exit code when SIGINT or SIGTERM stops the process mid-call: 130, runMain's default
 * teardown, which the host role shares. The live drivers check the host's own.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
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

  const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
    server.address(),
    { onExcessProperty: "ignore" },
  );

  return { port, accepted: accepted.promise };
};

test.each(["SIGINT", "SIGTERM"] as const)(
  "the CLI exits 130 when %s stops it mid-call",
  async (signal) => {
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
    child.kill(signal);

    expect(await exited).toBe(130);
  },
);
