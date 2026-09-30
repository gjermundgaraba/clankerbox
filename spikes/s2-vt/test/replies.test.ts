// Criteria 2 and 4: synchronous replies, their order relative to output
// fan-out, and the terminal profile colours reported by OSC 10/11.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule, GuestVt, bytes, str } from "../src/guest-vt.ts";
import { QueryFilter } from "../src/query-filter.ts";

let module: WebAssembly.Module;
before(async () => {
  module = await loadModule();
});

test("DA, CPR and OSC colour queries reply synchronously, in query order", () => {
  const replies: string[] = [];
  const vt = new GuestVt(module, 80, 24, (b) => replies.push(str(b)));
  try {
    const count = vt.write(bytes("ab\x1b[c\x1b[>c\x1b[6n\x1b[5n\x1b]10;?\x07\x1b]11;?\x1b\\"));
    // The reply callback ran inside write(): nothing is awaited.
    assert.equal(count, 6);
    assert.deepEqual(replies, [
      "\x1b[?62;22;28c",
      "\x1b[>1;0;0c",
      "\x1b[1;3R",
      "\x1b[0n",
      "\x1b]10;rgb:d4d4/dede/dbdb\x07",
      // The reply's terminator follows the query's (ST here).
      "\x1b]11;rgb:1515/1919/1c1c\x1b\\",
    ]);
  } finally {
    vt.dispose();
  }
});

test("replies are enqueued before the chunk that caused them is fanned out", () => {
  // The session pipeline: engine write (replies enqueue to the PTY writer),
  // then fan-out to the attachment. One synchronous block per PTY read.
  const log: string[] = [];
  const vt = new GuestVt(module, 80, 24, (b) => log.push(`reply ${JSON.stringify(str(b))}`));
  const filter = new QueryFilter();
  const onPtyRead = (chunk: Uint8Array) => {
    const filtered = filter.ingest(chunk, (b) => vt.write(b) > 0);
    log.push(`fanout ${JSON.stringify(str(filtered))}`);
  };
  try {
    onPtyRead(bytes("one\x1b[6n"));
    onPtyRead(bytes("two\x1b["));
    onPtyRead(bytes("c three"));
    assert.deepEqual(log, [
      'reply "\\u001b[1;4R"',
      'fanout "one"',
      // An unfinished sequence is withheld; nothing replies yet.
      'fanout "two"',
      'reply "\\u001b[?62;22;28c"',
      'fanout " three"',
    ]);
  } finally {
    vt.dispose();
  }
});

test("terminal profile colours are what OSC 10/11 report, before and after a change", () => {
  const replies: string[] = [];
  const vt = new GuestVt(module, 80, 24, (b) => replies.push(str(b)));
  try {
    vt.setColors({ foreground: 0x112233, background: 0xaabbcc });
    vt.write(bytes("\x1b]10;?\x07\x1b]11;?\x07"));
    vt.setColors({ background: 0x010203 });
    vt.write(bytes("\x1b]10;?\x07\x1b]11;?\x07"));
    assert.deepEqual(replies, [
      "\x1b]10;rgb:1111/2222/3333\x07",
      "\x1b]11;rgb:aaaa/bbbb/cccc\x07",
      "\x1b]10;rgb:1111/2222/3333\x07",
      "\x1b]11;rgb:0101/0202/0303\x07",
    ]);
  } finally {
    vt.dispose();
  }
});

test("restoring a snapshot emits no replies and keeps the reply callback bound", () => {
  const replies: string[] = [];
  const vt = new GuestVt(module, 80, 24, (b) => replies.push(str(b)));
  try {
    vt.write(bytes("x\x1b[6n"));
    vt.restore(vt.snapshot());
    assert.equal(replies.length, 1);
    vt.write(bytes("\x1b[6n"));
    assert.deepEqual(replies, ["\x1b[1;2R", "\x1b[1;2R"]);
  } finally {
    vt.dispose();
  }
});

test("linear memory growth detaches old views; later calls still work", () => {
  const vt = new GuestVt(module, 80, 24);
  try {
    const buffer = vt.wasm.memory.buffer;
    vt.write(bytes("x\r\n".repeat(20_000)));
    assert.equal(buffer.byteLength, 0, "the pre-growth ArrayBuffer is detached");
    assert.ok(vt.memoryBytes() > 4 * 1024 * 1024);
    assert.deepEqual(vt.cursor(), { x: 0, y: 23 });
    assert.ok(vt.snapshot().length > 0);
  } finally {
    vt.dispose();
  }
});
