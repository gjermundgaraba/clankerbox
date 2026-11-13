#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

import { fakeAgent } from "./fake-agent.ts";

const dir = process.env["FAKE_SSH_DIR"] ?? "";

const args = process.argv.slice(2);

const port = Number((args[args.indexOf("-L") + 1] ?? "").split(":")[1]);

appendFileSync(
  path.join(dir, "calls"),
  `${JSON.stringify({ pid: process.pid, port, args })}\n`
);

if (existsSync(path.join(dir, "refuse"))) {
  console.error("admin@100.64.0.7: Permission denied (publickey).");
  process.exit(255);
}

createServer(fakeAgent(dir)).listen(port, "127.0.0.1");

process.stdin.on("end", () => process.exit(0));

process.stdin.resume();
