// Explicit deployed public-HTTPS acceptance; creates/ends only its own session.
// node protocol/test/public-session.mjs CONFIG MACHINE
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createClient, Code } from '@connectrpc/connect';
import { createConnectTransport, Http2SessionManager } from '@connectrpc/connect-node';
import { SessionService } from '../dist/gen/clankerbox/v1/session_pb.js';
const [path, machineId] = process.argv.slice(2);
const config = JSON.parse(await readFile(path, 'utf8'));
assert.equal(new URL(config.url).protocol, 'https:');
const token = (await readFile(config.token_file, 'utf8')).trim();
const manager = new Http2SessionManager(config.url);
const connect = (credential) => createClient(SessionService, createConnectTransport({
  httpVersion: '2', baseUrl: config.url, sessionManager: manager, acceptCompression: [],
  interceptors: [(next) => async (request) => {
    request.header.set('Authorization', `Bearer ${credential}`); return next(request);
  }],
}));
const client = connect(token);
const sessionId = randomUUID();
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error('public acceptance timeout')), 180_000);
const options = { signal: controller.signal };
const report = { topology: config.url, machineId, sessionId, compression: 'disabled', checks: [] };
const waitAbort = (signal) => new Promise((resolve) => {
  if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true });
});
let created = false;
let slowAbort;
let fastAbort;
try {
  await assert.rejects(connect('invalid-' + randomUUID()).describeGuest({ machineId }, options), (e) => e.code === Code.Unauthenticated);
  report.checks.push('invalid bearer rejected');
  const guest = await client.describeGuest({ machineId }, options);
  const session = await client.createSession({ machineId, sessionId, label: 'public-transport-acceptance',
    createdAt: new Date().toISOString(), cols: 80, rows: 24,
    argv: ['/bin/sh', '-c', 'stty -echo; exec /bin/sh'] }, options);
  created = true;
  const open = { machineId, sessionId, expectedEngineDigest: guest.engineDigest };
  slowAbort = new AbortController();
  const slowSignal = AbortSignal.any([controller.signal, slowAbort.signal]);
  async function* slowCommands() {
    yield { command: { case: 'open', value: open } };
    await waitAbort(slowSignal);
  }
  const slow = client.attachSession(slowCommands(), { signal: slowSignal })[Symbol.asyncIterator]();
  let item = await slow.next();
  assert.equal(item.value.event.case, 'opened');
  let remaining = item.value.event.value.snapshotBytes;
  while (remaining > 0n) {
    item = await slow.next();
    assert.equal(item.value.event.case, 'snapshotChunk');
    remaining -= BigInt(item.value.event.value.data.length);
  }
  // Stop consuming through the product's 30s write-stall deadline. Draining
  // earlier can legitimately unblock a live stream and invalidates the test.
  const stalledAt = Date.now();
  const marker = 'PUBLIC_DONE_' + randomUUID().replaceAll('-', '');
  const bytes = 64 * 1024 * 1024;
  // Pace against elapsed time so guest timer coalescing cannot accumulate
  // thousands of delayed sleeps and exhaust the acceptance timeout.
  const script = `python3 -c 'import base64,os,sys,time; chunk=base64.b64encode(os.urandom(12288)); start=time.monotonic(); [(sys.stdout.buffer.write(chunk),sys.stdout.buffer.flush(),time.sleep(max(0,start+(i+1)*.01-time.monotonic()))) for i in range(${bytes / 16384})]'; printf '\\n${marker}\\n'\n`;
  fastAbort = new AbortController();
  const fastSignal = AbortSignal.any([controller.signal, fastAbort.signal]);
  async function* commands() {
    yield { command: { case: 'open', value: open } };
    yield { command: { case: 'resize', value: { sequence: 1n, cols: 101, rows: 31 } } };
    yield { command: { case: 'input', value: { sequence: 2n, data: Buffer.from(script) } } };
    await waitAbort(fastSignal);
  }
  let received = 0;
  let tail = '';
  let offset = 0n;
  const acks = [];
  const fast = client.attachSession(commands(), { signal: fastSignal })[Symbol.asyncIterator]();
  while (true) {
    const next = await fast.next();
    assert.equal(next.done, false, 'healthy stream ended before output marker');
    const event = next.value.event;
    if (event.case === 'ack') { assert.equal(event.value.accepted, true); acks.push(event.value.sequence); }
    if (event.case === 'gap') throw new Error('healthy sibling gapped: ' + event.value.reason);
    if (event.case === 'output') {
      received += event.value.data.length;
      offset = event.value.nextOffset;
      tail = (tail + Buffer.from(event.value.data).toString()).slice(-4096);
      if (tail.includes(marker)) break;
    }
  }
  assert(received >= bytes);
  assert.deepEqual(acks, [1n, 2n]);
  report.checks.push('ordered resize/input acknowledgements', '64MiB public bidi output with unread sibling');
  report.receivedBytes = received;
  report.producerBytes = bytes;
  // High-entropy printable payload also prevents the private relay hops
  // from hiding arbitrary terminal bytes in tiny compressed wire buffers.
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, 45_000 - (Date.now() - stalledAt))));
  report.unreadMilliseconds = Date.now() - stalledAt;
  let slowReceived = 0;
  // Drain buffered output only after the producer has finished. A bounded slow
  // consumer must already have been disconnected without harming its sibling.
  let slowEnded = false;
  const slowDeadline = setTimeout(() => slowAbort.abort(new Error('slow viewer was not bounded')), 10_000);
  try {
    while (true) {
      const next = await slow.next();
      if (next.done) { slowEnded = true; break; }
      if (next.value.event.case === 'output') slowReceived += next.value.event.value.data.length;
      if (next.value.event.case === 'gap') {
        assert.equal(next.value.event.value.reason, 'overflow');
        report.slowViewerGap = next.value.event.value.reason; slowEnded = true; break;
      }
    }
  } catch (error) {
    if (!slowAbort.signal.aborted && !controller.signal.aborted) {
      assert(
        error.code === Code.ResourceExhausted || error.code === Code.DeadlineExceeded ||
        (error.code === Code.Internal && /NGHTTP2_(INTERNAL_ERROR|CANCEL)/.test(error.rawMessage)),
        `unexpected stalled-stream failure: ${error.message}`,
      );
      slowEnded = true; report.slowViewerCode = error.code; report.slowViewerError = error.rawMessage;
    } else throw error;
  } finally { clearTimeout(slowDeadline); slowAbort.abort(); }
  assert(slowEnded);
  // This is a client-visible drain budget, not a measurement of proxy/server
  // heap. The 64MiB producer must overflow the unread stream without allowing
  // more than 8MiB through its buffered response when consumption resumes.
  const slowDrainLimit = 8 * 1024 * 1024;
  assert(slowReceived <= slowDrainLimit, `stalled viewer exceeded drain budget: ${slowReceived} bytes`);
  report.slowDrainLimit = slowDrainLimit;
  report.slowReceivedBytes = slowReceived;
  fastAbort.abort();
  report.checks.push('slow viewer disconnected independently');
  const resumeAbort = new AbortController();
  const resumeSignal = AbortSignal.any([controller.signal, resumeAbort.signal]);
  async function* resumeCommands() {
    yield { command: { case: 'open', value: { ...open, resumeCursor: { offset, incarnation: session.incarnation } } } };
    await waitAbort(resumeSignal);
  }
  try {
    const resumed = client.attachSession(resumeCommands(), { signal: resumeSignal })[Symbol.asyncIterator]();
    const head = (await resumed.next()).value.event;
    assert.equal(head.case, 'opened');
    assert.equal(head.value.mode, 1);
    assert.equal(head.value.session.pid, session.pid);
    assert.equal(head.value.session.incarnation, session.incarnation);
  } finally { resumeAbort.abort(); }
  report.checks.push('cancel and resume preserve shell identity');
  const ended = await client.endSession({ machineId, sessionId }, options);
  assert.equal(ended.status, 3);
  report.checks.push('explicit end');
  report.pid = session.pid.toString();
  report.incarnation = session.incarnation;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message; throw error;
} finally {
  slowAbort?.abort(); fastAbort?.abort();
  try {
    if (created) {
      const cleanup = await client.endSession({ machineId, sessionId }, { timeoutMs: 15_000 });
      assert.equal(cleanup.status, 3);
      report.cleanupConfirmed = true;
    }
  } finally {
    clearTimeout(timeout); controller.abort(); manager.abort();
    if (report.status !== 'passed') console.error(JSON.stringify(report));
  }
}
console.log(JSON.stringify(report, null, 2));
