#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const dir = process.env.FAKE_SSH_DIR ?? "";

const args = process.argv.slice(2);

const port = Number((args[args.indexOf("-L") + 1] ?? "").split(":")[1]);

appendFileSync(join(dir, "calls"), `${JSON.stringify({ pid: process.pid, port, args })}\n`);

if (existsSync(join(dir, "refuse"))) {
  console.error("admin@100.64.0.7: Permission denied (publickey).");
  process.exit(255);
}

createServer((_request, reply) => {
  const healthy = !existsSync(join(dir, "unhealthy"));

  reply.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
  reply.end(JSON.stringify({ status: healthy ? "ok" : "down" }));
}).listen(port, "127.0.0.1");

process.stdin.on("end", () => process.exit(0));

process.stdin.resume();
