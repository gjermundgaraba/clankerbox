#!/usr/bin/env python3
"""Persistent real Codex app-server owner; never resumes, forks, or reconnects."""
import argparse
from collections import Counter, deque
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import resource
import socket
import subprocess
import sys
import threading
import time

BRANCHES = {'parent': (2, 11), 'child-a': (3, 17), 'child-b': (5, 23)}
MAX_LINE = 2 * 1024 * 1024
TIMEOUT = 180
ALLOWED_METHODS = {'initialize', 'initialized', 'account/read', 'thread/start',
                   'turn/start', 'turn/interrupt'}


class HarnessError(Exception):
    pass


def proc_identity(pid):
    fields = Path('/proc/%s/stat' % pid).read_text().rsplit(')', 1)[1].split()
    return {'pid': pid, 'startTicks': int(fields[19])}


def category(value):
    """Classify in memory. Never return provider text, account data or tokens."""
    text = json.dumps(value).lower()
    if any(x in text for x in ('unauthorized', '401', 'not authenticated',
                               'authentication failed', 'authentication error',
                               'refresh failed', 'refresh_token_reused', 'login required')):
        return 'NeedsLogin'
    if any(x in text for x in ('usagelimit', 'rate_limit', 'rate limit', 'credits')):
        return 'UsageLimit'
    if any(x in text for x in ('reconnect', 'streamdisconnected', 'connectionfailed',
                               'stream disconnected', 'retrying', 'websocket', 'collision')):
        return 'TransportRecoveryObserved'
    return 'ProviderError'


def text_input(prompt):
    return [{'type': 'text', 'text': prompt, 'text_elements': []}]


def marker_match(messages, *markers):
    # Markdown/code formatting and line breaks do not invalidate remembered data.
    text = '\n'.join(messages)
    return all(re.search(r'(?<![A-Za-z0-9_-])' + re.escape(marker) +
                         r'(?![A-Za-z0-9_-])', text) for marker in markers)


def scrub_diagnostic(text):
    """Only call for bounded assistant final text and configuration warnings."""
    text = str(text)[:4096]
    text = re.sub(r'-----BEGIN [^-]+-----[\s\S]*', '[REDACTED_KEY]', text)
    text = re.sub(r'(?i)bearer\s+\S+', 'Bearer [REDACTED]', text)
    text = re.sub(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?', '[REDACTED_JWT]', text)
    text = re.sub(r'\bsk-[A-Za-z0-9_-]+', '[REDACTED_API_KEY]', text)
    text = re.sub(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '[REDACTED_EMAIL]', text)
    text = re.sub(r'(?i)(access[_ -]?token|refresh[_ -]?token|id[_ -]?token|api[_ -]?key|password|secret)' 
                  r'([\s"\x27]*[:=][\s"\x27]*)[^\s,;"\x27}]+', r'\1=[REDACTED]', text)
    text = re.sub(r'\b[A-Za-z0-9_+/=-]{48,}\b', '[REDACTED_LONG_VALUE]', text)
    return text[:1200]


class Controller:
    def __init__(self, args):
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        account = pwd.getpwuid(os.getuid())
        if account.pw_name != args.isolated_user or os.environ.get('HOME') != account.pw_dir:
            raise HarnessError('IsolatedOSUserRequired')
        if os.environ.get('CODEX_HOME'):
            raise HarnessError('RemoveInheritedCodexHomeOverride')
        self.workdir = Path(args.workdir).resolve()
        if not (self.workdir / 'calculator.py').is_file():
            raise HarnessError('FixtureMissing')
        self.cv = threading.Condition()
        self.write_lock = threading.Lock()
        self.responses = {}
        self.turns = {}
        self.current_turn = None
        self.events = deque(maxlen=128)
        self.counts = Counter()
        self.problems = Counter()
        self.sequence = 0
        self.request_id = 0
        self.thread_id = None
        self.session_id = None
        self.session_source = 'unavailable'
        self.baseline_evidence = None
        self.branch = None
        self.completed = []
        self.turn_limit = 5
        self.auth_mode = None
        self.fatal = None
        self.marker = os.urandom(32)
        self.context_marker = 'RAM_CONTEXT_' + os.urandom(8).hex()
        self.branch_context = None
        self.followup_ok = False
        self.recovery_ok = None
        self.barrier_turn = None
        self.barrier_identity = None
        self.stderr_bytes = 0
        self.stderr_lines = 0
        self.last_turn_diagnostics = None
        self.failure_assistant_text = None
        self.warnings = deque(maxlen=8)
        # HOME is retained unchanged, checked against the isolated OS account.
        env = {k: v for k, v in os.environ.items() if k in
               ('HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL',
                'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR')}
        # The runner may route only model traffic through an owned guest proxy.
        for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
                    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'):
            if key in os.environ:
                env[key] = os.environ[key]
        command = [args.codex, '-c', 'web_search="disabled"',
                   '-c', 'features.plugins=false', '-c', 'features.apps=false',
                   '-c', 'features.multi_agent=false',
                   'app-server', '--listen', 'stdio://']
        self.process = subprocess.Popen(command, cwd=self.workdir, env=env,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, bufsize=0)
        self.identity = {
            'controller': proc_identity(os.getpid()),
            'appServer': proc_identity(self.process.pid),
            'stdinPipe': os.fstat(self.process.stdin.fileno()).st_ino,
            'stdoutPipe': os.fstat(self.process.stdout.fileno()).st_ino,
            'ramSha256': hashlib.sha256(self.marker).hexdigest(),
            'spawnCount': 1, 'initializeCount': 1, 'transport': 'stdio',
        }
        threading.Thread(target=self.read_stdout, daemon=True).start()
        threading.Thread(target=self.read_stderr, daemon=True).start()
        self.rpc('initialize', {'clientInfo': {'name': 'clankerbox_ram_fork',
                                             'version': '0.1.0'}}, timeout=30)
        self.send({'method': 'initialized', 'params': {}})

    def send(self, payload):
        if 'method' in payload and payload['method'] not in ALLOWED_METHODS:
            raise HarnessError('ForbiddenMethod')
        with self.write_lock:
            self.process.stdin.write(json.dumps(payload).encode() + b'\n')
            self.process.stdin.flush()

    def rpc(self, method, params, timeout=TIMEOUT):
        with self.cv:
            self.request_id += 1
            request_id = self.request_id
        self.send({'id': request_id, 'method': method, 'params': params})
        deadline = time.monotonic() + timeout
        with self.cv:
            while request_id not in self.responses:
                if self.fatal:
                    raise HarnessError(self.fatal)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise HarnessError('RPCDeadlineExceeded')
                self.cv.wait(min(remaining, 1))
            result = self.responses.pop(request_id)
        if 'error' in result:
            raise HarnessError(category(result['error']))
        return result['result']

    def read_stdout(self):
        try:
            while True:
                line = self.process.stdout.readline(MAX_LINE + 1)
                if not line:
                    raise HarnessError('AppServerExited')
                if len(line) > MAX_LINE:
                    raise HarnessError('OversizedServerMessage')
                value = json.loads(line)
                with self.cv:
                    self.consume(value)
                    self.cv.notify_all()
        except Exception as error:
            with self.cv:
                self.fatal = str(error) if isinstance(error, HarnessError) else 'ProtocolReadFailed'
                self.cv.notify_all()

    def read_stderr(self):
        # No raw stderr saved: Codex diagnostics can contain auth/account data.
        while True:
            line = self.process.stderr.readline(MAX_LINE + 1)
            if not line:
                return
            with self.cv:
                self.stderr_bytes += len(line)
                self.stderr_lines += 1
                kind = category(line.decode(errors='replace'))
                if kind != 'ProviderError':
                    self.problems[kind] += 1
                    if kind == 'NeedsLogin':
                        self.fatal = kind
                    self.cv.notify_all()

    def consume(self, value):
        if 'id' in value and 'method' not in value:
            self.responses[value['id']] = value
            return
        method = value.get('method', '')
        params = value.get('params') or {}
        if method in ('warning', 'configWarning'):
            self.warnings.append({'method': method,
                'message': scrub_diagnostic(params.get('message') or params.get('summary') or ''),
                'details': scrub_diagnostic(params.get('details') or '')})
        if method == 'thread/started' and (params.get('thread') or {}).get('sessionId'):
            self.session_id = params['thread']['sessionId']
            self.session_source = 'thread/started'
        self.sequence += 1
        self.counts[method] += 1
        event = {'seq': self.sequence, 'method': method}
        # Only deliberately selected metadata leaves this process.
        if params.get('threadId') and self.thread_id and params['threadId'] != self.thread_id:
            self.problems['UnexpectedThread'] += 1
        turn = params.get('turn') or {}
        turn_id = params.get('turnId') or turn.get('id')
        item = params.get('item') or {}
        if turn_id:
            event['turnId'] = turn_id
        if item.get('type'):
            event['itemType'] = item['type']
            event['itemFields'] = sorted(item.keys())[:24]
        if method == 'turn/started':
            self.turns.setdefault(turn_id, {'status': 'inProgress', 'messages': [], 'toolCount': 0})
        if method == 'item/completed' and turn_id:
            record = self.turns.setdefault(turn_id, {'status': 'inProgress', 'messages': [], 'toolCount': 0})
            if item.get('type') == 'agentMessage':
                record['messages'].append((item.get('text') or '')[:8192])
            if item.get('type') in ('commandExecution', 'fileChange', 'dynamicToolCall', 'mcpToolCall',
                                    'functionCall', 'functionCallOutput'):
                record['toolCount'] += 1
        if method == 'turn/completed':
            record = self.turns.setdefault(turn_id, {'messages': [], 'toolCount': 0})
            record['status'] = turn.get('status')
            if turn.get('error'):
                record['error'] = category(turn['error'])
                self.problems[record['error']] += 1
        if method == 'error':
            kind = category(params)
            self.problems[kind] += 1
            if kind == 'NeedsLogin':
                self.fatal = kind
        if 'id' in value and 'method' in value:
            self.problems['UnexpectedServerRequest'] += 1
            if method == 'account/chatgptAuthTokens/refresh':
                self.fatal = 'NeedsLogin'
            self.send({'id': value['id'], 'error': {'code': -32601,
                       'message': 'Harness does not grant approvals or refresh credentials'}})
        self.events.append(event)

    def start_turn(self, prompt):
        if len(self.completed) >= self.turn_limit:
            raise HarnessError('TurnBudgetExceeded')
        result = self.rpc('turn/start', {'threadId': self.thread_id, 'input': text_input(prompt)})
        self.current_turn = result['turn']['id']
        return self.current_turn

    def wait_turn(self, turn_id):
        deadline = time.monotonic() + TIMEOUT
        with self.cv:
            while self.turns.get(turn_id, {}).get('status') in (None, 'inProgress'):
                if self.fatal:
                    raise HarnessError(self.fatal)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    # An active RAM-fork barrier timeout is diagnostic: retain
                    # the exact live inherited turn for scoped transport repair.
                    if turn_id != self.barrier_turn:
                        self.send({'method': 'turn/interrupt', 'id': 900000 + self.request_id,
                                   'params': {'threadId': self.thread_id, 'turnId': turn_id}})
                    raise HarnessError('TurnDeadlineExceeded')
                self.cv.wait(min(remaining, 1))
            record = self.turns[turn_id]
            text = '\n'.join(record['messages'])
            self.last_turn_diagnostics = {
                'turnId': turn_id, 'status': record.get('status'),
                'errorCategory': record.get('error'),
                'messageCount': len(record['messages']),
                'messageCharacters': len(text),
                'messageSha256': hashlib.sha256(text.encode()).hexdigest(),
                'toolCount': record.get('toolCount', 0),
                'baselinePrefixSeen': marker_match(record['messages'], 'BASELINE_OK'),
                'commonMarkerSeen': marker_match(record['messages'], self.context_marker),
                'branchPrefixSeen': marker_match(record['messages'], 'BRANCH_OK'),
                'followupPrefixSeen': marker_match(record['messages'], 'FOLLOWUP_OK'),
                'branchMarkerSeen': bool(self.branch_context) and
                    marker_match(record['messages'], self.branch_context),
            }
            if record.get('status') != 'completed':
                raise HarnessError(record.get('error', 'TurnFailed'))
            if turn_id not in self.completed:
                self.completed.append(turn_id)
            self.current_turn = None
            return record

    def run_turn(self, prompt):
        return self.wait_turn(self.start_turn(prompt))

    def continuity(self):
        try:
            return (proc_identity(self.process.pid) == self.identity['appServer'] and
                    proc_identity(os.getpid()) == self.identity['controller'] and
                    os.fstat(self.process.stdin.fileno()).st_ino == self.identity['stdinPipe'] and
                    os.fstat(self.process.stdout.fileno()).st_ino == self.identity['stdoutPipe'])
        except OSError:
            return False

    def baseline(self):
        if self.baseline_evidence:
            raise HarnessError('BaselineAlreadyExists')
        # Do not force token refresh, start login, read usage, or consume credits.
        auth = self.rpc('account/read', {'refreshToken': False}, timeout=30)
        account = auth.get('account') or {}
        self.auth_mode = account.get('type')
        del auth, account
        if self.auth_mode != 'chatgpt':
            raise HarnessError('NeedsLogin' if not self.auth_mode else 'ChatGPTLoginRequired')
        response = self.rpc('thread/start', {'cwd': str(self.workdir),
            'approvalPolicy': 'never', 'sandbox': 'danger-full-access',
            'developerInstructions': 'Only act inside the disposable fixture cwd. '
            'No network tools, subagents, external services, credentials, or git commits. '
            'Use the builtin shell and file tools only for the requested tiny local task.'})
        self.thread_id = response['thread']['id']
        if response['thread'].get('sessionId'):
            self.session_id = response['thread']['sessionId']
            self.session_source = 'thread/start'
        self.model = response.get('model')
        result = self.run_turn('Run python3 -m unittest -q in this fixture. Do not change files. '
            'Remember this conversation-only marker for future turns: ' + self.context_marker +
            '. Reply exactly BASELINE_OK ' + self.context_marker + ' if tests pass.')
        if not marker_match(result['messages'], 'BASELINE_OK', self.context_marker):
            self.failure_assistant_text = scrub_diagnostic('\n'.join(result['messages']))
            raise HarnessError('BaselineMarkerMissing')
        self.baseline_evidence = {'turnId': self.completed[-1], 'idle': True,
                                 'toolCount': result['toolCount'], 'seq': self.sequence}
        return self.status()

    def branch_write(self, name):
        if not self.baseline_evidence or self.branch or name not in BRANCHES:
            raise HarnessError('InvalidBranchState')
        self.branch = name
        slope, offset = BRANCHES[name]
        self.branch_context = 'BRANCH_CONTEXT_' + os.urandom(8).hex()
        result = self.run_turn('Our branch is ' + name + '. Change only calculator.py so '
            'transform(value) returns ' + str(slope) + ' * value + ' + str(offset) + '. '
            'Run EXPECT_SLOPE=' + str(slope) + ' EXPECT_OFFSET=' + str(offset) +
            ' python3 -m unittest -q. Remember this branch-only conversation marker: ' +
            self.branch_context + '. Never write either conversation marker to disk. '
            'Reply exactly BRANCH_OK ' + name + ' followed by the baseline conversation marker.')
        if not marker_match(result['messages'], 'BRANCH_OK', name, self.context_marker):
            raise HarnessError('BranchContextMismatch')
        self.write_seq = self.sequence
        return {'branch': name, 'writeComplete': True, 'turnId': self.completed[-1],
                'continuity': self.continuity()}

    def followup(self, recovery=False):
        if (not self.branch or not hasattr(self, 'write_seq') or
                (recovery and (not self.followup_ok or self.recovery_ok is not None)) or
                (not recovery and self.followup_ok)):
            raise HarnessError('InvalidFollowupState')
        result = self.run_turn('Do not use tools or read files. Reply with exactly FOLLOWUP_OK '
            'then our branch name, then the baseline conversation marker, then our branch-only '
            'conversation marker. Recall all three from our conversation.')
        success = marker_match(result['messages'], 'FOLLOWUP_OK', self.branch,
                               self.context_marker, self.branch_context)
        if recovery:
            self.recovery_ok = success
        else:
            self.followup_ok = success
        if not success:
            raise HarnessError('FollowupContextMismatch')
        return {'branch': self.branch, 'followupComplete': True, 'recovery': recovery,
                'turnId': self.completed[-1], 'continuity': self.continuity()}

    def status(self):
        waiting = self.workdir / 'barrier-waiting.json'
        barrier_waiting = False
        if self.barrier_turn and waiting.exists():
            candidate = json.loads(waiting.read_text())
            try:
                barrier_waiting = proc_identity(candidate['pid']) == {
                    k: candidate[k] for k in ('pid', 'startTicks')}
            except OSError:
                pass
            if barrier_waiting:
                self.barrier_identity = candidate
        return {'identity': self.identity, 'continuity': self.continuity(),
                'threadId': self.thread_id, 'sessionId': self.session_id,
                'sessionEvidence': self.session_source,
                'authMode': self.auth_mode, 'baseline': self.baseline_evidence,
                'branch': self.branch, 'activeTurn': self.current_turn,
                'barrierWaiting': barrier_waiting, 'barrierIdentity': self.barrier_identity,
                'lastTurnDiagnostics': self.last_turn_diagnostics,
                'failureAssistantText': self.failure_assistant_text,
                'configurationWarnings': list(self.warnings),
                'fatal': self.fatal, 'problems': dict(self.problems)}

    def report(self):
        status = self.status()
        fixture = None
        if self.branch:
            slope, offset = BRANCHES[self.branch]
            env = dict(os.environ, EXPECT_SLOPE=str(slope), EXPECT_OFFSET=str(offset),
                       PYTHONDONTWRITEBYTECODE='1')
            result = subprocess.run([sys.executable, '-m', 'unittest', '-q'],
                cwd=self.workdir, env=env, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=15)
            # Harness-owned checks cannot be weakened by edits to the fixture test.
            expected = [slope * value + offset for value in (-5, 0, 7)]
            independent = subprocess.run([sys.executable, '-I', '-c',
                'import json,runpy; module=runpy.run_path(' +
                repr(str(self.workdir / 'calculator.py')) + '); '
                'print(json.dumps([module["transform"](x) for x in (-5,0,7)]))'],
                cwd=self.workdir, env=env, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, timeout=15)
            try:
                independently_correct = (independent.returncode == 0 and
                                          json.loads(independent.stdout) == expected)
            except (ValueError, UnicodeDecodeError):
                independently_correct = False
            fixture = {'testExitCode': result.returncode,
                       'independentTransformOK': independently_correct,
                       'testScriptSha256': hashlib.sha256((self.workdir / 'test_calculator.py').read_bytes()).hexdigest(),
                       'calculatorSha256': hashlib.sha256((self.workdir / 'calculator.py').read_bytes()).hexdigest()}
        status.update({'schemaVersion': 1, 'kind': 'real-codex-ram-fork',
            'model': getattr(self, 'model', None), 'completedTurnIds': self.completed,
            'followupOK': self.followup_ok, 'recoveryOK': self.recovery_ok, 'fixture': fixture,
            'eventCounts': dict(self.counts), 'events': list(self.events),
            'stderrBytes': self.stderr_bytes, 'stderrLines': self.stderr_lines,
            'writeSeq': getattr(self, 'write_seq', None),
            'readSeq': self.sequence, 'forbiddenMethodsSent': 0,
            'barrierResult': json.loads((self.workdir / 'barrier-result.json').read_text())
              if (self.workdir / 'barrier-result.json').exists() else None})
        return status

    def command(self, request):
        op = request.get('op')
        if op == 'status':
            return self.status()
        if op == 'report':
            return self.report()
        if self.fatal:
            raise HarnessError(self.fatal)
        if not self.continuity():
            raise HarnessError('ProcessContinuityLost')
        if op == 'baseline':
            return self.baseline()
        if op == 'branch':
            return self.branch_write(request.get('name'))
        if op == 'followup':
            return self.followup()
        if op == 'recovery-followup':
            return self.followup(recovery=True)
        if op == 'barrier-start':
            if not self.baseline_evidence or self.branch or self.barrier_turn:
                raise HarnessError('InvalidBarrierState')
            if (self.workdir / 'barrier-waiting.json').exists():
                raise HarnessError('StaleBarrierFile')
            self.barrier_turn = self.start_turn('Run python3 barrier.py using your builtin shell tool. '
                'It intentionally blocks at a VM snapshot barrier. Keep waiting for that SAME '
                'running command until it finishes. Do not restart it, interrupt it, release it, '
                'or modify files. Once it completes, reply BARRIER_OK followed by the branch '
                'printed by that command and our baseline conversation marker.')
            return {'activeTurn': self.barrier_turn}
        if op == 'barrier-release':
            name = request.get('name')
            if name not in BRANCHES or not self.status()['barrierWaiting']:
                raise HarnessError('BarrierNotWaiting')
            with (self.workdir / 'barrier-release.json').open('x') as stream:
                json.dump({'branch': name}, stream)
            return {'released': name, 'barrierIdentity': self.barrier_identity}
        if op == 'barrier-wait':
            if not self.barrier_turn:
                raise HarnessError('NoActiveBarrier')
            result = self.wait_turn(self.barrier_turn)
            branch = json.loads((self.workdir / 'barrier-release.json').read_text())['branch']
            if not marker_match(result['messages'], 'BARRIER_OK', branch, self.context_marker):
                raise HarnessError('BarrierContextMismatch')
            return {'barrierComplete': True, 'branch': branch,
                    'barrierIdentity': self.barrier_identity}
        raise HarnessError('UnknownOperation')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['serve'])
    parser.add_argument('--socket', default='/tmp/real-agent.sock')
    parser.add_argument('--workdir', required=True)
    parser.add_argument('--codex', required=True)
    parser.add_argument('--isolated-user', required=True,
                        help='Fresh Linux OS user, with its normal home and provisioned ChatGPT login')
    args = parser.parse_args()
    try:
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(args.socket)  # Refuse to replace any existing controller.
            os.chmod(args.socket, 0o600)
            state = Controller(args)
            server.listen(8)
            print(json.dumps({'ready': True, 'controllerPid': os.getpid()}), flush=True)
            while True:
                connection, _ = server.accept()
                with connection:
                    connection.settimeout(200)
                    try:
                        with connection.makefile('rb') as stream:
                            raw = stream.readline(4097)
                        if len(raw) > 4096 or not raw.endswith(b'\n'):
                            raise HarnessError('InvalidRequest')
                        result = {'ok': True, 'state': state.command(json.loads(raw))}
                    except HarnessError as error:
                        result = {'ok': False, 'error': str(error),
                                  'diagnostics': state.last_turn_diagnostics,
                                  'failureAssistantText': state.failure_assistant_text,
                                  'configurationWarnings': list(state.warnings),
                                  'eventCounts': dict(state.counts),
                                  'events': list(state.events)[-32:]}
                    except Exception:
                        result = {'ok': False, 'error': 'HarnessInternalError'}
                    try:
                        connection.sendall(json.dumps(result).encode() + b'\n')
                    except OSError:
                        pass
    except HarnessError as error:
        print(json.dumps({'ready': False, 'error': str(error)}), flush=True)
        return 1
    except Exception:
        print(json.dumps({'ready': False, 'error': 'ControllerStartupFailed'}), flush=True)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
