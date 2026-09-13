// Maintained live-VM checks. Every probe uses ordinary SessionService authority,
// creates only its own session, and attempts no writes to protected guest files.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenMode, SessionStatus } from '../dist/gen/clankerbox/v1/session_pb.js';

export const inheritedEnvironmentCheck = String.raw`allowed={'PATH','HOME','USER','LOGNAME','SHELL','TERM','LANG','PWD','SHLVL','_','LC_CTYPE'}
assert not set(sys.argv[1].splitlines()).difference(allowed), 'unexpected inherited daemon environment keys'
`;

export const isolationScript = String.raw`import grp,json,os,platform,pwd,shutil,socket,subprocess,sys
uid=os.geteuid()
assert uid!=0 and os.getuid()==uid, 'PTY retained root identity'
assert pwd.getpwuid(uid).pw_name=='clankerbox', 'wrong workload account'
groups={grp.getgrgid(gid).gr_name for gid in set(os.getgroups()+[os.getegid()])}
assert not groups.intersection({'root','wheel','sudo','admin'}), 'privileged workload groups'
state='/private/var/lib/clankerbox-guest' if platform.system()=='Darwin' else '/var/lib/clankerbox-guest'
def denied(name,action):
    try:
        resource=action()
    except PermissionError:
        return
    if isinstance(resource,int): os.close(resource)
    elif resource is not None: resource.close()
    raise AssertionError(name+' unexpectedly accessible')
denied('binding private key',lambda: open(state+'/binding.json','rb'))
denied('private service directory',lambda: os.open(state,os.O_RDONLY))
with socket.socket(socket.AF_UNIX) as admin:
    admin.settimeout(2)
    denied('admin socket',lambda: admin.connect(state+'/admin.sock'))
binary='/usr/local/bin/clankerbox-guest'
assert os.stat(binary).st_uid==0, 'guest binary not root owned'
denied('guest binary write',lambda: os.open(binary,os.O_WRONLY))
sudo=shutil.which('sudo')
if sudo:
    for command in ('true','id'):
        result=subprocess.run([sudo,'-n',command],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
        assert result.returncode!=0, 'workload can escalate through sudo'
${inheritedEnvironmentCheck}
print('GUEST_ISOLATION_RESULT='+json.dumps({'uid':uid,'user':pwd.getpwuid(uid).pw_name,'groups':sorted(groups),'os':platform.system(),'architecture':platform.machine(),'checks':['nonroot workload identity','no privileged supplementary groups','binding private key unreadable','private state inaccessible','admin socket inaccessible','guest binary not writable','sudo escalation unavailable','daemon environment filtered']}),flush=True)
`;

const quote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
// Apple's python3 launcher adds developer-tool variables. Capture only key
// names before invoking it so the check measures the guest's actual environment.
export const isolationCommand = `stty -echo -onlcr; read gate; exec python3 -c ${quote(isolationScript)} "$(/usr/bin/env | /usr/bin/cut -d= -f1)"`;
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

async function withSession(client, machineId, argv, signal, check) {
  const sessionId = randomUUID();
  // Treat a lost create reply as possibly admitted and clean up the same identity.
  try {
    const session = await client.createSession({ machineId, sessionId,
      label: 'guest-contract-qualification', createdAt: new Date().toISOString(),
      cols: 80, rows: 24, argv }, { signal });
    return await check(sessionId, session);
  } finally {
    const ended = await client.endSession({ machineId, sessionId }, { timeoutMs: 15_000 });
    assert.equal(ended.status, SessionStatus.EXITED, 'qualification session cleanup not confirmed');
  }
}

export async function qualifyIsolation(client, machineId, guest, signal) {
  return withSession(client, machineId, ['/bin/sh', '-c', isolationCommand], signal, async (sessionId) => {
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
          assert.equal(event.value.mode, OpenMode.RESUME, 'isolation requires complete retained output');
          opened = true;
          continue;
        }
        assert(opened, 'Opened must be first');
        if (event.case === 'ack') assert.equal(event.value.accepted, true, 'isolation gate input refused');
        else if (event.case === 'output') {
          assert.equal(event.value.nextOffset, offset + BigInt(event.value.data.length));
          offset = event.value.nextOffset;
          output += Buffer.from(event.value.data).toString();
          assert(output.length <= 64 * 1024, 'unexpected isolation output volume');
          const lines = output.split('\n');
          lines.pop(); // A transport chunk may end halfway through the JSON line.
          const line = lines.find((line) => line.startsWith('GUEST_ISOLATION_RESULT='));
          if (line) report = JSON.parse(line.slice('GUEST_ISOLATION_RESULT='.length));
        } else if (event.case === 'sessionExited') {
          assert.equal(event.value.session?.exitCode, 0, `guest isolation failed: ${output}`);
          assert(report, 'guest exited without isolation evidence');
          return { machineId, sessionId, ...report };
        } else throw new Error(`unexpected isolation event ${event.case}`);
      }
      throw new Error('isolation attachment ended without process outcome');
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
