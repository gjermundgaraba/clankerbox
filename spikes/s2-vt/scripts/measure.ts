// Criteria 1 and 7, plus event-loop blocking: 48 terminals with full 10k-line
// scrollback, snapshot and formatter sizes, and the longest synchronous calls.
// Run: node --expose-gc scripts/measure.ts > evidence/measure.json
import { performance } from "node:perf_hooks";
import { loadModule, GuestVt, bytes } from "../src/guest-vt.ts";
import { GhosttyVt } from "/Users/gg/ws/pers/clankerdesk/packages/terminal-core/src/index.ts";

const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});
const mib = (n: number) => Math.round((n / 1048576) * 10) / 10;
const rss = () => {
  gc();
  return process.memoryUsage().rss;
};

const compileStart = performance.now();
const module = await loadModule();
const compileMs = performance.now() - compileStart;

// Realistic coloured 80-column output, ~10.1k lines, fed in 64 KiB PTY reads.
const line = (i: number) => `${String(i).padStart(6)} \x1b[3${i % 8}m${"abcdefghij".repeat(5)}\x1b[0m trailing text\r\n`;
const output = bytes(Array.from({ length: 10_100 }, (_, i) => line(i)).join(""));
const reads: Uint8Array[] = [];
for (let o = 0; o < output.length; o += 65536) reads.push(output.subarray(o, o + 65536));

const rssBase = rss();
const terminals: GuestVt[] = [];
const instantiateMs: number[] = [];
const fillMs: number[] = [];
let maxReadMs = 0;
for (let n = 0; n < 48; n++) {
  const t0 = performance.now();
  const vt = new GuestVt(module, 80, 24);
  instantiateMs.push(performance.now() - t0);
  const f0 = performance.now();
  for (const read of reads) {
    const r0 = performance.now();
    vt.write(read);
    maxReadMs = Math.max(maxReadMs, performance.now() - r0);
  }
  fillMs.push(performance.now() - f0);
  terminals.push(vt);
}
const rssFull = rss();
const wasmBytes = terminals.reduce((sum, vt) => sum + vt.memoryBytes(), 0);

const probe = terminals[0];
const scrollbackRows = probe.scrollbackRows();
const time = <T>(fn: () => T): [T, number] => {
  const t0 = performance.now();
  const value = fn();
  return [value, performance.now() - t0];
};
const [snapshot, snapshotMs] = time(() => probe.snapshot());
const [plain, plainMs] = time(() => probe.text());
const [repaint, repaintMs] = time(() => probe.vtRepaint());
const restoreGuest = new GuestVt(module, 1, 1);
const [, restoreGuestMs] = time(() => restoreGuest.restore(snapshot));
const mirror = new GhosttyVt(module, 20, 4);
const [, restoreMirrorMs] = time(() => mirror.restore(snapshot));

// Alternate screen on top of full primary history.
probe.write(bytes("\x1b[?1049h\x1b[H\x1b[2J" + "TUI ".repeat(400)));
const snapshotAlt = probe.snapshot();

// Worst case: 200-column rows with a style change on every cell, until the
// 10k-line / 8 MiB scrollback limits are reached.
const heavy = new GuestVt(module, 200, 50);
const heavyLine = (i: number) =>
  Array.from({ length: 200 }, (_, c) => `\x1b[38;5;${(i + c) % 256};48;5;${(i * 7 + c) % 256}m${String.fromCharCode(33 + ((i + c) % 90))}`).join("") + "\x1b[0m\r\n";
let heavyMaxWriteMs = 0;
for (let i = 0; i < 12_000; i += 100) {
  const chunk = bytes(Array.from({ length: 100 }, (_, k) => heavyLine(i + k)).join(""));
  const w0 = performance.now();
  heavy.write(chunk);
  heavyMaxWriteMs = Math.max(heavyMaxWriteMs, performance.now() - w0);
}
const [heavySnapshot, heavySnapshotMs] = time(() => heavy.snapshot());
const heavyMirror = new GhosttyVt(module, 20, 4);
const [, heavyRestoreMs] = time(() => heavyMirror.restore(heavySnapshot));
const [heavyRepaint, heavyRepaintMs] = time(() => heavy.vtRepaint());
const heavyResult = {
  scrollbackRows: heavy.scrollbackRows(),
  wasmLinearMemoryMiB: mib(heavy.memoryBytes()),
  snapshotBytes: heavySnapshot.length,
  vtRepaintAllExtrasBytes: heavyRepaint.length,
  blockingMs: {
    maxWriteOf100Lines: +heavyMaxWriteMs.toFixed(1),
    snapshotEncode: +heavySnapshotMs.toFixed(1),
    restoreIntoClankerdeskEngine: +heavyRestoreMs.toFixed(1),
    vtRepaintFormat: +heavyRepaintMs.toFixed(1),
  },
};
heavy.dispose();
heavyMirror.dispose();

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const result = {
  node: process.version,
  wasm: { bytes: 813202, compileMs: +compileMs.toFixed(1) },
  terminals: {
    count: 48,
    scrollbackRows,
    outputBytesEach: output.length,
    instantiateMs: { median: +median(instantiateMs).toFixed(2), max: +Math.max(...instantiateMs).toFixed(2) },
    fill10kLinesMs: { median: +median(fillMs).toFixed(1), max: +Math.max(...fillMs).toFixed(1) },
    maxSingle64KiBWriteMs: +maxReadMs.toFixed(2),
    rssMiB: { before: mib(rssBase), after: mib(rssFull), perTerminal: mib((rssFull - rssBase) / 48) },
    wasmLinearMemoryMiB: { total: mib(wasmBytes), perTerminal: mib(wasmBytes / 48) },
  },
  sizes: {
    snapshotBytes: snapshot.length,
    snapshotWithAltScreenBytes: snapshotAlt.length,
    plainTextBytes: plain.length,
    vtRepaintAllExtrasBytes: repaint.length,
  },
  worstCase200ColsStyledEveryCell: heavyResult,
  blockingMs: {
    snapshotEncode: +snapshotMs.toFixed(1),
    plainFormat: +plainMs.toFixed(1),
    vtRepaintFormat: +repaintMs.toFixed(1),
    restoreIntoGuestEngine: +restoreGuestMs.toFixed(1),
    restoreIntoClankerdeskEngine: +restoreMirrorMs.toFixed(1),
  },
};
for (const vt of terminals) vt.dispose();
restoreGuest.dispose();
mirror.dispose();
console.log(JSON.stringify(result, null, 2));
