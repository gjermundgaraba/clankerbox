// Criterion 3: the queries.go technique in Node. Each sequence's terminating
// byte is written alone; a reply during that write omits the sequence.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule, GuestVt, bytes, str } from "../src/guest-vt.ts";
import { QueryFilter } from "../src/query-filter.ts";

let module: WebAssembly.Module;
before(async () => {
  module = await loadModule();
});

function run(chunks: Uint8Array[]) {
  const replies: string[] = [];
  const vt = new GuestVt(module, 80, 24, (b) => replies.push(str(b)));
  const reference = new GuestVt(module, 80, 24);
  const filter = new QueryFilter();
  let out = "";
  try {
    for (const chunk of chunks) {
      out += str(filter.ingest(chunk, (b) => vt.write(b) > 0));
      reference.write(chunk);
    }
    out += str(filter.flush());
    // Writing byte by byte must not change what the engine parsed.
    assert.deepEqual(vt.snapshot(), reference.snapshot());
    return { out, replies, omitted: filter.omitted };
  } finally {
    vt.dispose();
    reference.dispose();
  }
}

test("answered queries are omitted; other sequences pass unchanged", () => {
  const r = run([bytes("a\x1b[6nb\x1b[31mred\x1b[0m\x1b]11;?\x07c\x1b]10;?\x1b\\d\x1b[c\x1b[2;5Hz")]);
  assert.equal(r.out, "ab\x1b[31mred\x1b[0mcd\x1b[2;5Hz");
  assert.deepEqual(r.omitted, ["\x1b[6n", "\x1b]11;?\x07", "\x1b]10;?\x1b\\", "\x1b[c"]);
  assert.equal(r.replies.length, 4);
});

test("a query split across PTY reads is withheld, then omitted", () => {
  const r = run([bytes("x\x1b"), bytes("["), bytes("6"), bytes("ny")]);
  assert.equal(r.out, "xy");
  assert.deepEqual(r.omitted, ["\x1b[6n"]);
});

test("an OSC ended by ST whose ESC arrives in one read and backslash in the next", () => {
  const r = run([bytes("p\x1b]11;?\x1b"), bytes("\\q")]);
  assert.equal(r.out, "pq");
  assert.deepEqual(r.omitted, ["\x1b]11;?\x1b\\"]);
});

test("a string broken by a new sequence decides the string and continues", () => {
  // OSC title (no reply) interrupted by a CSI query.
  const r = run([bytes("\x1b]2;title\x1b[6nZ")]);
  assert.equal(r.out, "\x1b]2;titleZ");
  assert.deepEqual(r.omitted, ["\x1b[6n"]);
});

test("a sequence longer than 4 KiB passes through as it arrives and is never omitted", () => {
  const url = "https://example.com/" + "a".repeat(5000);
  const link = `\x1b]8;;${url}\x1b\\link\x1b]8;;\x1b\\`;
  const r = run([bytes(link.slice(0, 3000)), bytes(link.slice(3000))]);
  assert.equal(r.out, link);
  assert.deepEqual(r.omitted, []);
});

test("CAN aborts a sequence without dispatch; the bytes pass", () => {
  const r = run([bytes("\x1b[6\x18after")]);
  assert.equal(r.out, "\x1b[6\x18after");
  assert.deepEqual(r.replies, []);
});

test("an unfinished sequence at exit is flushed, not lost", () => {
  const r = run([bytes("tail\x1b[3")]);
  assert.equal(r.out, "tail\x1b[3");
});
