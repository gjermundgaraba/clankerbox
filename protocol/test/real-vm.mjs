// Explicit live guest qualification. This is never part of the ordinary test glob.
// node protocol/test/real-vm.mjs CONFIG create|list|describe|end|probe|root|prefix|qualify MACHINE [SESSION] [SCRIPT]
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport, Http2SessionManager } from '@connectrpc/connect-node';
import { createSession, qualifyRoot, qualifyPrefix } from './guest-qualification.mjs';
import { SessionService } from '../dist/gen/clankerbox/v1/session_pb.js';

const [configPath, action, machineId, sessionId, script] = process.argv.slice(2);
if (!configPath || !action || !machineId) throw new Error('CONFIG ACTION MACHINE required');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const token = (await readFile(config.token_file, 'utf8')).trim();
const manager = new Http2SessionManager(config.url);
const transport = createConnectTransport({ httpVersion: '2', baseUrl: config.url, sessionManager: manager, acceptCompression: [],
  interceptors: [(next) => async (request) => { request.header.set('Authorization', `Bearer ${token}`); return next(request); }],
});
const client = createClient(SessionService, transport);
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(new Error('live qualification timeout')), 120_000);
const options = { signal: abort.signal };
const print = (value) => console.log(JSON.stringify(value, (_, field) => typeof field === 'bigint' ? field.toString() : field));
try {
  if (action === 'describe') print(await client.describeGuest({ machineId }, options));
  else if (action === 'list') print(await client.listSessions({ machineId }, options));
  else if (action === 'create') print(await createSession(client, machineId, randomUUID(), { createdAt: new Date().toISOString(), cols: 80, rows: 24, argv: ['/bin/sh', '-c', 'stty -echo; exec /bin/sh'] }, options));
  else if (action === 'end') print(await client.endSession({ machineId, sessionId }, options));
  else if (['root', 'prefix', 'qualify'].includes(action)) {
    const guest = await client.describeGuest({ machineId }, options);
    const report = { machineId, guestOS: guest.os, checks: {} };
    if (action !== 'prefix') report.checks.root = await qualifyRoot(client, machineId, guest, abort.signal);
    if (action !== 'root') report.checks.prefix = await qualifyPrefix(client, machineId, guest, abort.signal);
    print({ ...report, status: 'passed' });
  }
  else if (action === 'probe') {
    if (!sessionId) throw new Error('probe requires SESSION');
    const guest = await client.describeGuest({ machineId }, options);
    const marker = `RPC_PROBE_${randomUUID().replaceAll('-', '')}`;
    async function* commands() {
      yield { command: { case: 'open', value: { machineId, sessionId, expectedEngineDigest: guest.engineDigest } } };
      yield { command: { case: 'input', value: { sequence: 1n, data: Buffer.from(`${script ?? 'true'}; printf '\\n${marker}:%s:%s\\n' "$$" "$RPC_TOKEN"\n`) } } };
      await new Promise((resolve) => { if (abort.signal.aborted) resolve(); else abort.signal.addEventListener('abort', resolve, { once: true }); });
    }
    let opened;
    let output = '';
    for await (const message of client.attachSession(commands(), options)) {
      if (message.event.case === 'opened') opened = message.event.value;
      if (message.event.case === 'output') {
        output += Buffer.from(message.event.value.data).toString();
        const match = output.match(new RegExp(`${marker}:([0-9]+):([^\\r\\n]*)`));
        if (match) { print({ guest, session: opened?.session, cut: opened?.cut, pid: match[1], token: match[2], output }); abort.abort(); break; }
      }
    }
    if (!abort.signal.aborted) throw new Error('attachment ended before probe');
  } else throw new Error(`unknown live action ${action}`);
} finally { clearTimeout(timer); abort.abort(); manager.abort(); }
