import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { connect as connectUnix } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { create, fromBinary, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import { createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport, Http2SessionManager } from "@connectrpc/connect-node";
import {
  AttachmentRequestSchema, OpenSchema, TerminalProbe,
  type AttachmentRequest, type AttachmentEvent,
} from "../gen-ts/gate/v1/gate_pb.ts";

const largeOffset = 9007199254740993n;
const inputSequence = 9007199254741001n;
const resizeSequence = 18446744073709551615n;
const snapshotSize = 8 * 1024 * 1024 + 113;

class Requests implements AsyncIterable<AttachmentRequest> {
  private items: AttachmentRequest[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  push(value: AttachmentRequest) {
    assert(!this.ended);
    assert(this.items.length < 16, "fixture input queue remains bounded");
    this.items.push(value);
    this.wake?.();
  }
  close() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.items.length) yield this.items.shift()!;
      if (this.ended) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

function open(input: Requests, size: number) {
  input.push(create(AttachmentRequestSchema, {
    command: { case: "open", value: { sessionId: "node-gate", resumeOffset: largeOffset, snapshotBytes: size } },
  }));
}
async function bounded<T>(promise: Promise<T>, label: string, ms = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function event(iterator: AsyncIterator<AttachmentEvent>) {
  const next = await bounded(iterator.next(), "attachment event");
  assert(!next.done, "stream ended before expected event");
  return next.value.event;
}
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error(`${label} timed out`);
}

async function duplex(client: Client<typeof TerminalProbe>, size = snapshotSize) {
  const input = new Requests();
  const abort = new AbortController();
  open(input, size);
  const iterator = client.attach(input, { signal: abort.signal, timeoutMs: 20000 })[Symbol.asyncIterator]();
  try {
    const first = await event(iterator);
    assert.equal(first.case, "opened");
    if (first.case !== "opened") throw new Error("missing Opened");
    assert.equal(first.value.cut, largeOffset);
    assert.equal(typeof first.value.cut, "bigint");
    assert.equal(first.value.snapshotBytes, size);
    // Keep the request stream open and send controls while receiving snapshots.
    // An implementation that waits for request EOF deadlocks this test.
    input.push(create(AttachmentRequestSchema, {
      command: { case: "input", value: { sequence: inputSequence, data: new Uint8Array([97, 98, 99]) } },
    }));
    input.push(create(AttachmentRequestSchema, {
      command: { case: "resize", value: { sequence: resizeSequence, columns: 101, rows: 37 } },
    }));
    let received = 0;
    let final = size === 0;
    while (received < size) {
      const chunk = await event(iterator);
      assert.equal(chunk.case, "snapshotChunk", "bootstrap must precede all control output");
      if (chunk.case !== "snapshotChunk") throw new Error("missing snapshot chunk");
      assert.equal(chunk.value.position, received);
      assert(chunk.value.data.length <= 64 * 1024);
      for (let i = 0; i < chunk.value.data.length; ++i)
        assert.equal(chunk.value.data[i], (received + i) % 251);
      received += chunk.value.data.length;
      assert.equal(chunk.value.final, received === size);
      final = chunk.value.final;
    }
    assert(final);
    const ack1 = await event(iterator);
    assert.equal(ack1.case, "ack");
    if (ack1.case !== "ack") throw new Error("missing input ack");
    assert.equal(ack1.value.sequence, inputSequence);
    assert(ack1.value.accepted);
    const output = await event(iterator);
    assert.equal(output.case, "output");
    if (output.case !== "output") throw new Error("missing output");
    assert.equal(output.value.nextOffset, largeOffset + 3n);
    assert.deepEqual(output.value.data, new Uint8Array([97, 98, 99]));
    const ack2 = await event(iterator);
    assert.equal(ack2.case, "ack");
    if (ack2.case !== "ack") throw new Error("missing resize ack");
    assert.equal(ack2.value.sequence, resizeSequence);
    const resized = await event(iterator);
    assert.equal(resized.case, "resized");
    if (resized.case !== "resized") throw new Error("missing resize");
    assert.equal(resized.value.offset, largeOffset + 3n);
    assert.equal(resized.value.columns, 101);
    assert.equal(resized.value.rows, 37);
    input.close();
    assert((await bounded(iterator.next(), "half-close completion")).done);
  } finally { input.close(); abort.abort(); await iterator.return?.().catch(() => {}); }
}

async function cancellation(client: Client<typeof TerminalProbe>) {
  const before = await client.getStats({});
  const input = new Requests();
  const abort = new AbortController();
  open(input, 0);
  const iterator = client.attach(input, { signal: abort.signal })[Symbol.asyncIterator]();
  assert.equal((await event(iterator)).case, "opened");
  abort.abort();
  input.close();
  await assert.rejects(bounded(iterator.next(), "cancelled client"));
  let observed = before;
  try {
    await until(async () => {
      observed = await client.getStats({});
      // A canceled request may reach the server as clean EOF (not ctx.Err),
      // including across Caddy. Cleanup is the contract, the diagnostic counter is not.
      return observed.active === 0n;
    }, "server cancellation cleanup");
    console.log(JSON.stringify({ target: "cancellation-observation", activeAfter: observed.active.toString(), contextCancelledBefore: before.cancelled.toString(), contextCancelledAfter: observed.cancelled.toString() }));
  } catch (error) {
    throw new Error(`${String(error)}; before=${JSON.stringify(before, (_, value) => typeof value === "bigint" ? value.toString() : value)}; observed=${JSON.stringify(observed, (_, value) => typeof value === "bigint" ? value.toString() : value)}`);
  }
}

async function slowReader(client: Client<typeof TerminalProbe>) {
  const before = await client.getStats({});
  const input = new Requests();
  const abort = new AbortController();
  open(input, 64 * 1024 * 1024);
  const iterator = client.attach(input, { signal: abort.signal, timeoutMs: 15000 })[Symbol.asyncIterator]();
  try {
    assert.equal((await event(iterator)).case, "opened");
    // Do not call next again. A second attachment must still progress on this
    // same HTTP/2 connection, without releasing this stalled reader.
    await duplex(client, 128 * 1024);
    await until(async () => {
      const stats = await client.getStats({});
      assert(stats.maxQueued <= stats.queueCapacity);
      return stats.slowReaders > before.slowReaders && stats.active === 0n;
    }, "bounded slow-reader rejection");
  } finally { abort.abort(); input.close(); await iterator.return?.().catch(() => {}); }
}

// Both binary and protobuf JSON conversions retain the full uint64 domain.
for (const offset of [largeOffset, resizeSequence]) {
  const message = create(OpenSchema, { sessionId: "integer", resumeOffset: offset });
  assert.equal(fromBinary(OpenSchema, toBinary(OpenSchema, message)).resumeOffset, offset);
  const json = toJson(OpenSchema, message);
  assert.equal((json as { resumeOffset: string }).resumeOffset, offset.toString());
  assert.equal(fromJson(OpenSchema, json).resumeOffset, offset);
}

interface Manifest { h2c: string; tls: string; unix: string; ca: string }
const remote = process.env.GATE_REMOTE_ORIGIN;
const manifest = remote ? undefined : JSON.parse(await readFile(process.env.GATE_MANIFEST ?? ".run/endpoints.json", "utf8")) as Manifest;
const ca = await readFile(remote ? process.env.GATE_REMOTE_CA! : manifest!.ca);
const targets = remote
  ? [{ name: "remote-tls-proxy", base: remote, options: { ca } }]
  : [
      { name: "h2c", base: manifest!.h2c, options: {} },
      { name: "unix-h2c", base: "http://localhost", options: { createConnection: () => connectUnix(manifest!.unix) } },
      { name: "verified-tls", base: manifest!.tls, options: { ca } },
    ];
for (const target of targets) {
  const manager = new Http2SessionManager(target.base, { idleConnectionTimeoutMs: 1000 }, target.options);
  const client = createClient(TerminalProbe, createConnectTransport({
    baseUrl: target.base, httpVersion: "2", sessionManager: manager,
    acceptCompression: [], readMaxBytes: 256 * 1024, writeMaxBytes: 256 * 1024,
  }));
  try {
    await duplex(client);
    await cancellation(client);
    await slowReader(client);
    const stats = await client.getStats({});
    console.log(JSON.stringify({ target: target.name, duplexBeforeHalfClose: true, snapshotBytes: snapshotSize,
      cancellation: true, boundedSlowReader: true, uint64Exact: true,
      queueCapacity: stats.queueCapacity, maxQueued: stats.maxQueued, chunkBytes: stats.chunkBytes }));
  } finally { manager.abort(); }
}
// Verification is real: untrusted issuer and wrong hostname must both fail.
for (const [name, options] of [
  ["untrusted-ca", {}], ["wrong-hostname", { ca, servername: "wrong.invalid" }],
] as const) {
  const base = remote ?? manifest!.tls;
  const manager = new Http2SessionManager(base, {}, options);
  try {
    const client = createClient(TerminalProbe, createConnectTransport({ baseUrl: base, httpVersion: "2", sessionManager: manager }));
    await assert.rejects(bounded(client.getStats({}, { timeoutMs: 3000 }), name));
    console.log(JSON.stringify({ target: name, rejected: true }));
  } finally { manager.abort(); }
}
