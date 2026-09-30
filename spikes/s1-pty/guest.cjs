// Spike S1: load node-pty's native addon from SEA assets and drive a PTY with
// raw bytes. Uses only the addon's `fork` and `resize`; node-pty's JS wrapper is
// not bundled. Prints one JSON report and exits 0 only if every check passes.
"use strict";

const fs = require("node:fs");
const tty = require("node:tty");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

let sea;
try {
  sea = require("node:sea");
} catch {
  sea = undefined;
}

const results = [];
const record = (name, pass, detail) => results.push({ name, pass, detail });

function extractAssets() {
  // Assets come from the SEA blob, or from argv[2] when run under plain node.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s1-pty-"));
  fs.chmodSync(dir, 0o700);
  const write = (name, mode) => {
    const bytes =
      sea && sea.isSea()
        ? Buffer.from(sea.getRawAsset(name))
        : fs.readFileSync(path.join(process.argv[2], name));
    const target = path.join(dir, name);
    fs.writeFileSync(target, bytes, { mode });
    return target;
  };
  const addon = write("pty.node", 0o600);
  const helper = process.platform === "darwin" ? write("spawn-helper", 0o700) : "";
  return { dir, addon, helper };
}

function loadAddon(file) {
  const mod = { exports: {} };
  process.dlopen(mod, file);
  return mod.exports;
}

// One PTY: a master socket for reads and writes plus an exit promise.
function spawn(pty, helper, file, args, { cols = 80, rows = 24, env } = {}) {
  let resolveExit;
  const exited = new Promise((resolve) => (resolveExit = resolve));
  const envList = Object.entries(env ?? { PATH: "/usr/bin:/bin", TERM: "xterm-256color" }).map(
    ([k, v]) => `${k}=${v}`,
  );
  const term = pty.fork(file, args, envList, "/", cols, rows, -1, -1, true, helper, (code, signal) =>
    resolveExit({ code, signal }),
  );
  // Reads: a read-only tty.ReadStream (libuv polls the master). Writes: our own
  // writer. libuv marks a pty master TTY handle as blocking-writes (it cannot
  // reopen a master), so writing through a tty stream spins inside the event
  // loop once the pty input queue is full.
  const socket = new tty.ReadStream(term.fd);
  const writer = makeWriter(term.fd);
  const chunks = [];
  let readError = null;
  const listeners = new Set();
  socket.on("data", (chunk) => {
    chunks.push(chunk);
    for (const l of listeners) l();
  });
  socket.on("error", (err) => {
    // Linux reports EIO on the master once the slave side is closed.
    readError = err.code;
    for (const l of listeners) l();
  });
  const output = () => Buffer.concat(chunks);
  const waitFor = (predicate, ms = 10_000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (predicate(output())) {
          listeners.delete(check);
          clearTimeout(timer);
          resolve(output());
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`timeout; have ${JSON.stringify(output().toString("latin1").slice(-200))}`));
      }, ms);
      listeners.add(check);
      check();
    });
  return { term, socket, writer, exited, output, waitFor, readErrorCode: () => readError, reset: () => (chunks.length = 0) };
}

// Writes to the non-blocking master with writeSync; EAGAIN retries on a timer
// with backoff instead of spinning. Each write resolves once all its bytes are
// accepted by the pty, which gives an exact byte count for admission budgets.
function makeWriter(fd) {
  const queue = [];
  const stats = { written: 0, eagain: 0, retries: 0 };
  let timer = null;
  let delay = 1;
  const pump = () => {
    timer = null;
    while (queue.length) {
      const item = queue[0];
      let n;
      try {
        n = fs.writeSync(fd, item.buf, item.off, item.buf.length - item.off);
      } catch (err) {
        if (err.code === "EAGAIN") {
          stats.eagain++;
          stats.retries++;
          timer = setTimeout(pump, delay);
          delay = Math.min(delay * 2, 20);
          return;
        }
        queue.shift();
        item.reject(err);
        continue;
      }
      delay = 1;
      item.off += n;
      stats.written += n;
      if (item.off === item.buf.length) {
        queue.shift();
        item.resolve();
      }
    }
  };
  return {
    stats,
    write(buf) {
      return new Promise((resolve, reject) => {
        queue.push({ buf, off: 0, resolve, reject });
        if (queue.length === 1 && timer === null) pump();
      });
    },
  };
}

const includes = (needle) => (buf) => buf.includes(needle);

async function roundTrip(pty, helper) {
  // Raw mode: no echo, no CR/NL translation, no flow control or LNEXT.
  const p = spawn(pty, helper, "/bin/sh", ["-c", "stty raw -echo -iexten; printf READY; exec cat"]);
  await p.waitFor(includes("READY"));
  p.reset();
  const all = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  const emoji = Buffer.from("😀", "utf8");
  const pieces = [
    all,
    Buffer.from([0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x28, 0xa1, 0xf0, 0x28, 0x8c, 0xbc, 0xff, 0xfe]), // invalid UTF-8
    emoji.subarray(0, 2), // a character split across writes
    emoji.subarray(2),
  ];
  // A megabyte of pseudo-random bytes exercises backpressure.
  const big = Buffer.alloc(1 << 20);
  let x = 0x12345678;
  for (let i = 0; i < big.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    big[i] = x & 0xff;
  }
  pieces.push(big);
  const expected = Buffer.concat(pieces);
  for (const piece of pieces) {
    // Slices of 16 KiB; each resolves once the pty has accepted every byte.
    for (let off = 0; off < piece.length; off += 16384) await p.writer.write(piece.subarray(off, off + 16384));
  }
  await p.waitFor((b) => b.length >= expected.length, 60_000);
  const got = p.output();
  const equal = got.length === expected.length && got.equals(expected);
  let firstDiff = -1;
  if (!equal) for (let i = 0; i < Math.min(got.length, expected.length); i++) if (got[i] !== expected[i]) { firstDiff = i; break; }
  record("binary round trip (all 256 bytes, invalid UTF-8, split char, 1 MiB)", equal, {
    bytes: expected.length,
    got: got.length,
    firstDiff,
    writer: p.writer.stats,
  });
  process.kill(-p.term.pid, "SIGKILL");
  await p.exited;
  p.socket.destroy();
}

async function resize(pty, helper) {
  const p = spawn(pty, helper, "/bin/sh", ["-c", "printf READY; read x; stty size; exit 0"]);
  await p.waitFor(includes("READY"));
  pty.resize(p.term.fd, 100, 40);
  await p.writer.write(Buffer.from("go\n"));
  const out = await p.waitFor(includes("40 100"));
  record("resize to 100x40 seen by stty", out.includes("40 100"), out.toString("latin1").slice(-40));
  await p.exited;
  p.socket.destroy();
}

async function exitCode(pty, helper) {
  const p = spawn(pty, helper, "/bin/sh", ["-c", "exit 42"]);
  const e = await p.exited;
  // Drain until EOF/EIO so the master is fully read before closing.
  await new Promise((r) => setTimeout(r, 200));
  record("exit code 42 reported", e.code === 42 && e.signal === 0, { ...e, readError: p.readErrorCode() });
  p.socket.destroy();
}

async function killGroup(pty, helper) {
  const p = spawn(pty, helper, "/bin/sh", ["-c", "sleep 1000 & sleep 1000 & printf READY; wait"]);
  await p.waitFor(includes("READY"));
  const pid = p.term.pid;
  const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)]).toString().trim());
  const before = execFileSync("ps", ["-A", "-o", "pgid=,pid=,comm="]).toString()
    .split("\n").filter((l) => l.trim().startsWith(`${pgid} `)).length;
  process.kill(-pid, "SIGTERM");
  const e = await p.exited;
  await new Promise((r) => setTimeout(r, 300));
  // Members still running (zombies awaiting their reaper don't count: in a
  // container, orphans are reparented to PID 1, which may reap them late).
  const live = execFileSync("ps", ["-A", "-o", "pgid=,stat=,pid=,comm="]).toString()
    .split("\n").map((l) => l.trim().split(/\s+/))
    .filter((f) => f[0] === String(pgid) && !f[1].startsWith("Z"));
  const zombies = execFileSync("ps", ["-A", "-o", "pgid=,stat="]).toString()
    .split("\n").map((l) => l.trim().split(/\s+/))
    .filter((f) => f[0] === String(pgid) && f[1].startsWith("Z")).length;
  const groupGone = live.length === 0;
  record("kill(-pid) ends the whole process group", pgid === pid && before >= 3 && groupGone && e.signal === 15, {
    pid, pgid, membersBefore: before, groupGone, zombiesAwaitingReap: zombies, exit: e,
  });
  p.socket.destroy();
}

async function environment(pty, helper) {
  // The addon passes env exactly; node-pty's JS wrapper would force TERM and PWD.
  const p = spawn(pty, helper, "/usr/bin/env", [], { env: { PATH: "/usr/bin:/bin", TERM: "dumb", ONLY: "1" } });
  await p.exited;
  await new Promise((r) => setTimeout(r, 200));
  const lines = p.output().toString("latin1").split(/\r?\n/).filter(Boolean).sort();
  const want = ["ONLY=1", "PATH=/usr/bin:/bin", "TERM=dumb"];
  record("environment passed exactly (no TERM/PWD injection)", JSON.stringify(lines) === JSON.stringify(want), lines);
  p.socket.destroy();
}

async function main() {
  const started = Date.now();
  const { dir, addon, helper } = extractAssets();
  const dirMode = (fs.statSync(dir).mode & 0o777).toString(8);
  let pty;
  try {
    pty = loadAddon(addon);
    record("addon loads via process.dlopen from extracted asset", typeof pty.fork === "function", {
      exports: Object.keys(pty), dirMode, sea: Boolean(sea && sea.isSea()),
    });
    for (const test of [roundTrip, resize, exitCode, killGroup, environment]) {
      try {
        await test(pty, helper);
      } catch (err) {
        record(test.name, false, String(err && err.stack || err));
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const report = {
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    glibc: process.report?.getReport().header.glibcVersionRuntime ?? null,
    ms: Date.now() - started,
    pass: results.every((r) => r.pass),
    results,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(report.pass ? 0 : 1);
}

main();
