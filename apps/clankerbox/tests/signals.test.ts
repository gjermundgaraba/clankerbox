import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, expect, test } from "vite-plus/test";

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
  await Promise.all(owned.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "clankerbox-signals-"));

  owned.push(dir);

  return dir;
};

const run = (file: string, args: ReadonlyArray<string>) => {
  const child = spawn(process.execPath, [file, ...args], { stdio: "ignore" });

  children.push(child);

  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });

  return { child, exited };
};

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
    const dir = await scratch();
    const { port, accepted } = await silent();
    const config = join(dir, "config.json");

    await writeFile(
      config,
      JSON.stringify({
        hosts: [{ id: "linux", url: `http://127.0.0.1:${port}`, sshUser: "user" }],
      }),
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
