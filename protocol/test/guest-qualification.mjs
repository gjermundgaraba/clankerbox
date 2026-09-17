// Maintained live-VM checks. Every probe uses ordinary SessionService authority,
// creates only its own session and temporary executable; daemon files are untouched.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenMode, SessionStatus } from '../dist/gen/clankerbox/v1/session_pb.js';

export const inheritedEnvironmentCheck = String.raw`allowed={'PATH','HOME','USER','LOGNAME','SHELL','TERM','LANG','PWD','SHLVL','_','LC_CTYPE'}
assert not set(sys.argv[1].splitlines()).difference(allowed), 'unexpected inherited daemon environment keys'
`;

export const rootScript = String.raw`import json,os,platform,pwd,subprocess,sys,tempfile
uid=os.geteuid()
assert uid==0 and os.getuid()==0 and os.getegid()==0 and os.getgid()==0, 'PTY requires root identity'
account=pwd.getpwuid(uid)
assert account.pw_name=='root', 'wrong root account'
home='/var/root' if platform.system()=='Darwin' else '/root'
assert os.path.realpath(account.pw_dir)==os.path.realpath(home), 'wrong root account home'
assert os.path.realpath(os.getcwd())==os.path.realpath(home), 'wrong default cwd'
assert os.environ['HOME']==home, 'wrong HOME'
assert os.environ['USER']==os.environ['LOGNAME']=='root', 'wrong root environment identity'
assert os.environ['SHELL']=='/bin/sh', 'wrong default shell'
assert os.environ['TERM']=='xterm-256color' and os.environ['LANG']=='C.UTF-8', 'wrong terminal environment'
assert '/usr/local/bin' in os.environ['PATH'].split(':'), 'local executable directory missing from PATH'
${inheritedEnvironmentCheck}
fd,path=tempfile.mkstemp(prefix='clankerbox-root-qualification-',dir='/usr/local/bin')
try:
    with os.fdopen(fd,'w') as script:
        script.write('#!/bin/sh\nprintf "CLANKERBOX_ROOT_EXECUTABLE_OK\\n"\n')
    os.chmod(path,0o755)
    result=subprocess.run([os.path.basename(path)],capture_output=True,text=True,timeout=5,check=True)
    assert result.stdout=='CLANKERBOX_ROOT_EXECUTABLE_OK\n', 'installed executable failed'
finally:
    os.unlink(path)
print('GUEST_ROOT_RESULT='+json.dumps({'uid':uid,'user':account.pw_name,'home':home,'cwd':os.getcwd(),'os':platform.system(),'architecture':platform.machine(),'checks':['root session identity','root home and cwd','root session environment','daemon environment filtered','system executable install and execution','temporary executable removed']}),flush=True)
`;

const quote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
// Apple's python3 launcher adds developer-tool variables. Capture only key
// names before invoking it so the check measures the guest's actual environment.
export const rootCommand = `stty -echo -onlcr; read gate; exec python3 -c ${quote(rootScript)} "$(/usr/bin/env | /usr/bin/cut -d= -f1)"`;
export const prefixBytes = 8 * 1024 * 1024;
export const prefixCommand = `stty -echo -onlcr; python3 -c 'import base64,os,sys; [(sys.stdout.buffer.write(base64.b64encode(os.urandom(12288))),sys.stdout.buffer.flush()) for _ in range(512)]'; exec cat`;

const deferred = () => Promise.withResolvers();
const waitSignal = (signal) => new Promise((resolve) => {
  if (signal.aborted) resolve();
  else signal.addEventListener('abort', resolve, { once: true });
});
const sessionRecord = async (client, machineId, sessionId, signal) => {
  const listed = await client.listSessions({ machineId }, { signal });
  const record = listed.sessions.find((session) => session.id === sessionId);
  assert(record, 'qualification session disappeared');
  return record;
};
const waitForOffset = async (client, machineId, sessionId, minimum, signal) => {
  while (true) {
    const record = await sessionRecord(client, machineId, sessionId, signal);
    assert.equal(record.status, SessionStatus.RUNNING, 'qualification process exited early');
    if (record.offset >= minimum) return record;
    await delay(20, undefined, { signal });
  }
};

// A session is created by the attachment that opens it. This one leaves as soon
// as the session is open, so the session runs on with nobody attached; repeating
// it with the same identity opens the session that already exists.
export async function createSession(client, machineId, sessionId, create, options = {}) {
  const leave = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, leave.signal]) : leave.signal;
  async function* commands() {
    yield { command: { case: 'open', value: { machineId, sessionId, create } } };
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  }
  try {
    for await (const event of client.attachSession(commands(), { signal })) {
      if (event.event.case === 'opened') return event.event.value.session;
    }
    throw new Error('the attachment closed before the session opened');
  } finally {
    leave.abort();
  }
}

async function withSession(client, machineId, argv, signal, check) {
  const sessionId = randomUUID();
  // Treat a lost create reply as possibly admitted and clean up the same identity.
  try {
    const session = await createSession(client, machineId, sessionId, {
      label: 'guest-contract-qualification', createdAt: new Date().toISOString(),
      cols: 80, rows: 24, argv }, { signal });
    return await check(sessionId, session);
  } finally {
    const ended = await client.endSession({ machineId, sessionId }, { timeoutMs: 15_000 });
    assert.equal(ended.status, SessionStatus.EXITED, 'qualification session cleanup not confirmed');
  }
}

export async function qualifyRoot(client, machineId, guest, signal) {
  return withSession(client, machineId, ['/bin/sh', '-c', rootCommand], signal, async (sessionId) => {
    const stop = new AbortController();
    const streamSignal = AbortSignal.any([signal, stop.signal]);
    async function* commands() {
      yield { command: { case: 'open', value: { machineId, sessionId,
        expectedEngineDigest: guest.engineDigest, resumeCursor: { offset: 0n, incarnation: guest.incarnation } } } };
      yield { command: { case: 'input', value: { sequence: 1n, data: Buffer.from('\n') } } };
      await waitSignal(streamSignal);
    }
    let opened = false;
    let offset = 0n;
    let output = '';
    let report;
    try {
      for await (const message of client.attachSession(commands(), { signal: streamSignal })) {
        const event = message.event;
        if (event.case === 'opened') {
          assert.equal(opened, false);
          assert.equal(event.value.mode, OpenMode.RESUME, 'root qualification requires complete retained output');
          opened = true;
          continue;
        }
        assert(opened, 'Opened must be first');
        if (event.case === 'ack') assert.equal(event.value.accepted, true, 'root qualification gate input refused');
        else if (event.case === 'output') {
          assert.equal(event.value.nextOffset, offset + BigInt(event.value.data.length));
          offset = event.value.nextOffset;
          output += Buffer.from(event.value.data).toString();
          assert(output.length <= 64 * 1024, 'unexpected root qualification output volume');
          const lines = output.split('\n');
          lines.pop(); // A transport chunk may end halfway through the JSON line.
          const line = lines.find((line) => line.startsWith('GUEST_ROOT_RESULT='));
          if (line) report = JSON.parse(line.slice('GUEST_ROOT_RESULT='.length));
        } else if (event.case === 'sessionExited') {
          assert.equal(event.value.session?.exitCode, 0, `guest root qualification failed: ${output}`);
          assert(report, 'guest exited without root qualification evidence');
          return { machineId, sessionId, ...report };
        } else throw new Error(`unexpected root qualification event ${event.case}`);
      }
      throw new Error('root qualification attachment ended without process outcome');
    } finally { stop.abort(); }
  });
}

export async function qualifyPrefix(client, machineId, guest, signal) {
  return withSession(client, machineId, ['/bin/sh', '-c', prefixCommand], signal, async (sessionId, session) => {
    await waitForOffset(client, machineId, sessionId, BigInt(prefixBytes), signal);
    const inputGate = deferred();
    const eof = deferred();
    const stop = new AbortController();
    const streamSignal = AbortSignal.any([signal, stop.signal]);
    const marker = 'PREFIX_INPUT_' + randomUUID().replaceAll('-', '');
    async function* commands() {
      yield { command: { case: 'open', value: { machineId, sessionId,
        expectedEngineDigest: guest.engineDigest, resumeCursor: { offset: 0n, incarnation: guest.incarnation } } } };
      await Promise.race([inputGate.promise, waitSignal(streamSignal)]);
      if (streamSignal.aborted) return;
      yield { command: { case: 'input', value: { sequence: 1n, data: Buffer.from(marker + '\n') } } };
      await Promise.race([eof.promise, waitSignal(streamSignal)]);
    }
    const stream = client.attachSession(commands(), { signal: streamSignal })[Symbol.asyncIterator]();
    try {
      const first = await stream.next();
      assert.equal(first.done, false);
      assert.equal(first.value.event.case, 'opened');
      const opened = first.value.event.value;
      assert.equal(opened.mode, OpenMode.RESUME);
      assert.equal(opened.startOffset, 0n);
      assert.equal(opened.cut, BigInt(prefixBytes), '8 MiB immutable prefix was not retained');
      // Application response reads stop here. The input must reach the shell
      // while this prefix exceeds both the event queue and transport window.
      inputGate.resolve();
      const pausedAt = Date.now();
      const admissionSignal = AbortSignal.any([streamSignal, AbortSignal.timeout(10_000)]);
      await waitForOffset(client, machineId, sessionId, opened.cut + BigInt(marker.length + 1), admissionSignal);
      const pausedMilliseconds = Date.now() - pausedAt;
      let offset = 0n;
      let ackOffset;
      let tail = '';
      let sawInput = false;
      while (!sawInput || ackOffset === undefined) {
        const next = await stream.next();
        assert.equal(next.done, false, 'prefix ended before admitted input and ACK');
        const event = next.value.event;
        if (event.case === 'ack') {
          assert.equal(event.value.sequence, 1n);
          assert.equal(event.value.accepted, true);
          assert.equal(ackOffset, undefined, 'duplicate ACK');
          ackOffset = offset;
        } else if (event.case === 'output') {
          assert.equal(event.value.nextOffset, offset + BigInt(event.value.data.length));
          if (offset < opened.cut) assert(event.value.nextOffset <= opened.cut, 'live bytes overtook immutable prefix');
          offset = event.value.nextOffset;
          if (offset > opened.cut) {
            tail = (tail + Buffer.from(event.value.data).toString()).slice(-4096);
            sawInput = tail.includes(marker);
          }
        } else throw new Error(`unexpected prefix event ${event.case}`);
      }
      assert(ackOffset < opened.cut, 'ACK did not interleave with retained prefix');
      eof.resolve();
      let drained = 0;
      for (let next = await stream.next(); !next.done; next = await stream.next()) {
        assert.equal(next.value.event.case, 'output');
        drained += next.value.event.value.data.length;
        assert(drained <= prefixBytes, 'EOF drained an unbounded live tail');
      }
      const retained = await sessionRecord(client, machineId, sessionId, signal);
      assert.equal(retained.status, SessionStatus.RUNNING, 'request EOF ended the shell');
      assert.equal(retained.pid, session.pid, 'request EOF replaced the shell');
      return { machineId, sessionId, prefixBytes, ackOffset: ackOffset.toString(), pausedMilliseconds,
        inputObservedWhileResponsePaused: true, finiteEOF: true, shellRetained: true };
    } finally {
      inputGate.resolve(); eof.resolve(); stop.abort();
      await stream.return?.();
    }
  });
}
