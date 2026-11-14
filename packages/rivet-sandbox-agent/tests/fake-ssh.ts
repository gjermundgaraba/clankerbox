#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { fakeAgent } from "./fake-agent.ts";

const dir = process.env["FAKE_SSH_DIR"] ?? "";

const flagged = (flag: string) => existsSync(path.join(dir, flag));

const args = process.argv.slice(2);

const socket = (args[args.indexOf("-L") + 1] ?? "").split(":")[0] ?? "";

appendFileSync(
  path.join(dir, "calls"),
  `${JSON.stringify({ pid: process.pid, socket, args })}\n`
);

const early: Buffer[] = [];

let bound = false;

const echo = async (chunk: Buffer) => {
  if (!flagged("slow-echo")) {
    process.stdout.write(chunk);

    return;
  }

  const half = Math.floor(chunk.length / 2);

  process.stdout.write(chunk.subarray(0, half));
  await sleep(50);
  process.stdout.write(chunk.subarray(half));
};

process.stdin.on("data", (chunk: Buffer) => {
  if (bound) {
    void echo(chunk);
  } else {
    early.push(chunk);
  }
});

process.stdin.on("end", () => process.exit(0));

if (flagged("ignore-sigterm")) {
  process.on("SIGTERM", () => undefined);
}

const refused = flagged("refuse");

if (refused) {
  const said = flagged("refuse-says")
    ? readFileSync(path.join(dir, "refuse-says"), "utf-8")
    : "admin@100.64.0.7: Permission denied (publickey).";

  const refuse = () => {
    process.stderr.write(`${said}\n`, () => process.exit(255));
  };

  if (flagged("proxy-says")) {
    const proxy = readFileSync(path.join(dir, "proxy-says"), "utf-8");

    spawn(
      process.execPath,
      [
        "-e",
        `process.stdout.write("up\\n"); process.stdin.on("end", () => process.stderr.write(${JSON.stringify(`${proxy}\n`)})).resume();`,
      ],
      { stdio: ["pipe", "pipe", "inherit"] }
    ).stdout?.once("data", refuse);
  } else {
    refuse();
  }
}

const forward = createServer(fakeAgent(dir));

forward.once("error", (error) => {
  console.error(
    [
      `unix_listener: cannot bind to path ${socket}: ${error.message}`,
      "Could not request local forwarding.",
    ].join("\n")
  );
  process.exit(255);
});

const opened = async () => {
  bound = true;

  const printed = flagged("login-prints")
    ? readFileSync(path.join(dir, "login-prints"))
    : Buffer.alloc(0);

  if (flagged("login-refuses")) {
    process.stdout.write(printed, () => process.exit(1));

    return;
  }

  process.stdout.write(printed);

  for (const chunk of early) {
    await echo(chunk);
  }

  if (flagged("stderr-after-open")) {
    process.stderr.write(
      "debug1: ".repeat(
        Number(readFileSync(path.join(dir, "stderr-after-open"), "utf-8"))
      )
    );
  }
};

if (!refused && !flagged("never-opens")) {
  forward.listen(socket, () => {
    void opened();
  });
}
