import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

const owned: string[] = [];

const children: ChildProcess[] = [];

const servers: Array<{ readonly server: Server; readonly sockets: Socket[] }> =
  [];

const scratch = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "clankerbox-signals-"));

  owned.push(dir);

  return dir;
};

const run = (file: string, args: readonly string[]) => {
  const child = spawn(process.execPath, [file, ...args], { stdio: "ignore" });

  children.push(child);

  const exited = Promise.withResolvers<number | null>();

  child.once("exit", (code) => {
    exited.resolve(code);
  });

  return { child, exited: exited.promise };
};

const silent = async () => {
  const accepted = Promise.withResolvers<undefined>();
  const sockets: Socket[] = [];

  const server = createServer((socket) => {
    sockets.push(socket);
    accepted.resolve(undefined);
  });

  servers.push({ server, sockets });

  const listening = Promise.withResolvers<undefined>();

  server.listen(0, "127.0.0.1", () => {
    listening.resolve(undefined);
  });
  await listening.promise;

  const { port } = Schema.decodeUnknownSync(
    Schema.Struct({ port: Schema.Finite })
  )(server.address(), { onExcessProperty: "ignore" });

  return { port, accepted: accepted.promise };
};

describe("signals", () => {
  afterEach(async () => {
    for (const child of children.splice(0)) {
      child.kill("SIGKILL");
    }

    await Promise.all(
      servers.splice(0).map(async ({ server, sockets }) => {
        const closed = Promise.withResolvers<undefined>();

        for (const socket of sockets) {
          socket.destroy();
        }

        server.close(() => {
          closed.resolve(undefined);
        });
        await closed.promise;
      })
    );
    await Promise.all(
      owned.splice(0).map(async (dir) => {
        await rm(dir, { recursive: true, force: true });
      })
    );
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "the CLI exits 130 when %s stops it mid-call",
    async (signal) => {
      const dir = await scratch();
      const { port, accepted } = await silent();
      const config = path.join(dir, "config.json");

      await writeFile(
        config,
        JSON.stringify({
          hosts: [{ id: "linux", url: `http://127.0.0.1:${port}` }],
        })
      );

      const { child, exited } = run(
        path.join(import.meta.dirname, "../src/main.ts"),
        ["machines", "--config", config]
      );

      await accepted;
      child.kill(signal);

      await expect(exited).resolves.toBe(130);
    }
  );
});
