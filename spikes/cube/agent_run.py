#!/usr/bin/env python3
"""Real Codex acceptance adapter; execute only inside the owned Cube outer VM."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time

from cube_spike import ROOT, NAMES, Run, isolated, sdk, write, require
from cube_spike import runtime_mapping, require_same_runtimes, inventory

HARNESS = ROOT.parent / 'real-agent'
sys.path.insert(0, str(HARNESS))
from evaluate import evaluate
from agent_network import call as proxy_call

DIRECTORY = ROOT / '.work/codex-run'
PROXY_CONTROL = str(ROOT / '.work/outer-agent-proxy.sock')


class AgentRun(Run):
    def command(self, name, command, timeout=200):
        start = time.monotonic()
        try:
            result = self.attach(name).commands.run(command, timeout=timeout, user='root')
        except Exception:
            raise RuntimeError('GuestCommandTransportFailed:' + name)
        # No command text/stdout/stderr: commands may be auth injection plumbing.
        with (self.directory / 'command-metadata.jsonl').open('a') as stream:
            stream.write(json.dumps({'branch': name, 'exitCode': result.exit_code,
                                     'durationMs': (time.monotonic() - start) * 1000}) + '\n')
        if result.exit_code:
            # The harness stdout is safe, but general command stderr is not exported.
            try:
                safe = json.loads(result.stdout)
                if isinstance(safe, dict) and safe.get('ok') is False:
                    write(self.directory / 'last-harness-failure.json', safe)
            except (ValueError, TypeError):
                pass
            raise RuntimeError('GuestCommandFailed:' + name + ':' + str(result.exit_code))
        return result.stdout.strip()

    def request(self, name, *args):
        response = json.loads(self.command(name, 'python3 /opt/real-agent/client.py ' +
            ' '.join(shlex.quote(x) for x in args), timeout=210))
        require(response.get('ok'), 'HarnessCommandFailed:' + name)
        return response['state']

    def put(self, name, destination, payload):
        # SDK file transfer, never shell/base64 credentials or command arguments.
        self.attach(name).files.write(destination, payload, user='root')

    def network(self, name):
        self.put(name, '/var/tmp/agent-network-probe.py', (ROOT / 'agent_network_probe.py').read_bytes())
        return json.loads(self.command(name, 'python3 /var/tmp/agent-network-probe.py'))

    def prepare(self):
        status = json.loads((ROOT / '.work/template/status.json').read_text())
        build = json.loads((ROOT / '.work/template/build.json').read_text())
        template = build.get('template_id') or build.get('templateID')
        require(status['status'].lower() in ('ready', 'success', 'succeeded'), 'TemplateNotReady')
        self.create('parent', template)
        self.command('parent', 'useradd --create-home --shell /bin/bash agent; '
            'chmod 700 /home/agent; install -d -m 700 -o agent -g agent /home/agent/.codex; '
            'install -d /opt/real-agent/fixture')
        for path in HARNESS.rglob('*'):
            if (path.is_file() and '__pycache__' not in path.parts and path.suffix != '.pyc'
                    and not path.name.startswith('._')):
                self.put('parent', '/opt/real-agent/' + str(path.relative_to(HARNESS)), path.read_bytes())
        self.command('parent', 'chown -R agent:agent /opt/real-agent')
        self.verify_network()

    def verify_network(self):
        self.configure_proxy_policy('parent')
        network = self.network('parent')
        write(self.directory / 'pre-auth-network.json', network)
        require(all(network.values()), 'PreAuthNetworkContainmentFailed')
        write(self.directory / 'awaiting-root-injection.json', {
            'sandboxID': self.data['instances']['parent'],
            'authDestination': '/home/agent/.codex/auth.json',
            'binaryDestination': '/opt/real-agent/codex', 'network': network})
        print(json.dumps({'awaitingRootInjection': True,
                          'sandboxID': self.data['instances']['parent']}), flush=True)

    def configure_proxy_policy(self, name):
        # Cube's supported L3 exception is /32-only. A guest-local chain narrows
        # that exception to this one proxy port before enabling it in Cube.
        self.command(name, 'set -e; iptables -w -N CUBE_CODEX_ONLY 2>/dev/null || '
            'iptables -w -L CUBE_CODEX_ONLY -n >/dev/null; '
            'iptables -w -C CUBE_CODEX_ONLY -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || '
            'iptables -w -A CUBE_CODEX_ONLY -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT; '
            'iptables -w -C CUBE_CODEX_ONLY -o lo -j ACCEPT 2>/dev/null || '
            'iptables -w -A CUBE_CODEX_ONLY -o lo -j ACCEPT; '
            'iptables -w -C CUBE_CODEX_ONLY -d 10.77.70.15/32 -p tcp --dport 18445 -j ACCEPT 2>/dev/null || '
            'iptables -w -A CUBE_CODEX_ONLY -d 10.77.70.15/32 -p tcp --dport 18445 -j ACCEPT; '
            'iptables -w -C CUBE_CODEX_ONLY -j REJECT 2>/dev/null || iptables -w -A CUBE_CODEX_ONLY -j REJECT; '
            'iptables -w -C OUTPUT -j CUBE_CODEX_ONLY 2>/dev/null || iptables -w -I OUTPUT -j CUBE_CODEX_ONLY')
        self.attach(name).update_network({'allow_internet_access': True,
                                         'allow_out': ['10.77.70.15/32']})

    def inject(self, kind):
        require((self.directory / 'awaiting-root-injection.json').exists(), 'ParentNotPrepared')
        destinations = {'auth': '/home/agent/.codex/auth.json', 'binary': '/opt/real-agent/codex',
                        'runtime': '/var/tmp/real-agent-runtime.tar.gz'}
        require(kind in destinations, 'InvalidInjectionKind')
        self.put('parent', destinations[kind], sys.stdin.buffer.read())
        if kind == 'runtime':
            self.command('parent', 'install -d /opt/real-agent/runtime; '
                'tar -xzf /var/tmp/real-agent-runtime.tar.gz -C /opt/real-agent/runtime; '
                'ln -s runtime/bin/codex /opt/real-agent/codex; '
                'chown -R agent:agent /opt/real-agent/runtime; chmod 600 /var/tmp/real-agent-runtime.tar.gz')
            print(json.dumps({'injected': kind}), flush=True)
            return
        self.command('parent', 'chown agent:agent ' + destinations[kind] + '; chmod ' +
                     ('600 ' if kind == 'auth' else '755 ') + destinations[kind])
        print(json.dumps({'injected': kind}), flush=True)

    def execute(self):
        evidence = {'kind': 'cube-real-codex', 'status': 'running', 'phases': {},
                    'grant': 'cube-codex-20260905', 'scope': 'nested-disposable-outer-vm',
                    'timingContext': 'contended with Cocoon/smolvm; nested KVM', 'metrics': {}}
        def save():
            write(self.directory / 'agent-evidence.json', evidence)
        try:
            # Synchronize the shared controller before its one and only start.
            for filename in ('guest.py', 'client.py', 'relay.py'):
                self.put('parent', '/opt/real-agent/' + filename, (HARNESS / filename).read_bytes())
            self.put('parent', '/opt/real-agent/proxy-upstream', b'10.77.70.15\n')
            self.command('parent', 'chown agent:agent /opt/real-agent/guest.py '
                '/opt/real-agent/client.py /opt/real-agent/relay.py; chmod 644 /opt/real-agent/proxy-upstream')
            version = self.command('parent', '/opt/real-agent/codex --version')
            require(version == 'codex-cli 0.153.4', 'WrongCodexVersion')
            evidence['codexVersion'] = version
            binary_hash = self.command('parent', 'sha256sum /opt/real-agent/codex').split()[0]
            require(binary_hash == '56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da',
                    'WrongCodexBinaryHash')
            evidence['codexSha256'] = binary_hash
            relay_launch = ('exec python3 /opt/real-agent/relay.py serve '
                '--upstream-file /opt/real-agent/proxy-upstream --upstream-port 18445')
            self.command('parent', 'nohup runuser -l agent -c ' + shlex.quote(relay_launch) +
                         ' >/var/tmp/real-agent-relay.log 2>&1 </dev/null &')
            deadline = time.monotonic() + 20
            while True:
                try:
                    evidence['relaySource'] = json.loads(self.command('parent',
                        'python3 /opt/real-agent/relay.py status'))
                    break
                except RuntimeError:
                    require(time.monotonic() < deadline, 'RelayStartupDeadline')
                    time.sleep(.5)
            # Fresh login shell obtains the real OS home, not a CODEX_HOME override.
            launch = ('cd /opt/real-agent/fixture && exec env '
                'HTTPS_PROXY=http://127.0.0.1:8888 HTTP_PROXY=http://127.0.0.1:8888 '
                'ALL_PROXY=http://127.0.0.1:8888 NO_PROXY=localhost,127.0.0.1 '
                'python3 /opt/real-agent/guest.py serve --socket /tmp/real-agent.sock '
                '--workdir /opt/real-agent/fixture --codex /opt/real-agent/codex --isolated-user agent')
            self.command('parent', 'nohup runuser -l agent -c ' + shlex.quote(launch) +
                         ' >/var/tmp/real-agent-startup.log 2>&1 </dev/null &')
            deadline = time.monotonic() + 30
            while True:
                try:
                    evidence['phases']['startup'] = self.request('parent', 'status')
                    break
                except RuntimeError:
                    require(time.monotonic() < deadline, 'ControllerStartupDeadline')
                    time.sleep(.5)
            evidence['phases']['baseline'] = self.request('parent', 'baseline'); save()
            evidence['phases']['barrierStart'] = self.request('parent', 'barrier-start'); save()
            deadline = time.monotonic() + 120
            while True:
                checkpoint = self.request('parent', 'status')
                if checkpoint.get('barrierWaiting'):
                    break
                require(time.monotonic() < deadline, 'ActiveBarrierDeadline')
                time.sleep(.5)
            evidence['phases']['activeCheckpoint'] = checkpoint; save()
            start = time.monotonic()
            snapshot = self.snapshot(self.attach('parent'))
            evidence['snapshotID'] = snapshot
            evidence['metrics']['snapshotRpcMs'] = (time.monotonic() - start) * 1000; save()
            evidence['relayResets'] = {}
            for name in NAMES[1:]:
                start = time.monotonic()
                self.create(name, snapshot)
                reset = json.loads(self.command(name, 'python3 /opt/real-agent/relay.py reset'))
                require(reset.get('ok') and reset.get('oldTunnelsRemaining') == 0 and
                        reset.get('pid') == evidence['relaySource']['pid'], 'CapturedRelayResetFailed')
                evidence['relayResets'][name] = reset; save()
                self.configure_proxy_policy(name)
                evidence['metrics'][name + 'CreateMs'] = (time.monotonic() - start) * 1000; save()
            evidence['phases']['inherited'] = {n: self.request(n, 'status') for n in NAMES}
            evidence['runtimesBefore'] = runtime_mapping(self.data['instances'])
            evidence['hostBefore'] = inventory(); save()
            evidence['network'] = {n: self.network(n) for n in NAMES}
            require(all(all(checks.values()) for checks in evidence['network'].values()), 'CloneNetworkContainmentFailed')
            evidence['phases']['barrierRelease'] = {n: self.request(n, 'barrier-release', '--name', n) for n in NAMES}
            evidence['phases']['barrierComplete'] = {n: self.request(n, 'barrier-wait') for n in NAMES}; save()
            ordering = {'clock': 'host-monotonic', 'ramSnapshotVerified': True,
                        'writesCompleted': {}, 'readsStarted': {}}
            evidence['ordering'] = ordering
            evidence['phases']['branches'] = {}
            def branch_write(name):
                result = self.request(name, 'branch', '--name', name)
                return result, time.monotonic_ns()
            with ThreadPoolExecutor(max_workers=3) as pool:
                futures = {pool.submit(branch_write, name): name for name in NAMES}
                for future in as_completed(futures):
                    name = futures[future]
                    result, completed_at = future.result()
                    evidence['phases']['branches'][name] = result
                    ordering['writesCompleted'][name] = completed_at; save()
            evidence['phases']['followups'] = {}
            for name in NAMES:
                ordering['readsStarted'][name] = time.monotonic_ns()
                evidence['phases']['followups'][name] = self.request(name, 'followup'); save()
            reports = {n: self.request(n, 'report') for n in NAMES}
            evidence['phases']['cleanReports'] = reports
            evidence['cleanEvaluation'] = evaluate(list(reports.values()), ordering, True); save()
            evidence['proxyFault'] = proxy_call(PROXY_CONTROL, 'disconnect'); save()
            evidence['phases']['recoveryFollowups'] = {n: self.request(n, 'recovery-followup') for n in NAMES}
            reports = {n: self.request(n, 'report') for n in NAMES}
            evidence['phases']['recoveryReports'] = reports
            evidence['recoveryEvaluation'] = evaluate(list(reports.values()), ordering, True, True)
            evidence['runtimesAfter'] = runtime_mapping(self.data['instances'])
            require_same_runtimes(evidence['runtimesBefore'], evidence['runtimesAfter'])
            evidence['hostAfter'] = inventory()
            evidence['proxyAfter'] = proxy_call(PROXY_CONTROL, 'status')
            evidence['status'] = 'pass' if evidence['cleanEvaluation']['pass'] and evidence['recoveryEvaluation']['pass'] else 'fail'
            save()
        except Exception as error:
            evidence['status'] = 'fail'
            # Exception text from SDK/provider may contain private payloads.
            evidence['errorType'] = type(error).__name__
            if isinstance(error, RuntimeError) and len(str(error)) < 120:
                evidence['errorCategory'] = str(error)
            if (self.directory / 'last-harness-failure.json').exists():
                evidence['harnessFailure'] = json.loads((self.directory / 'last-harness-failure.json').read_text())
            save()
            raise RuntimeError('RealCodexExperimentFailedSeeSanitizedEvidence') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'prepare-network', 'inject', 'run', 'cleanup'])
    parser.add_argument('--kind', choices=['auth', 'binary', 'runtime'])
    args = parser.parse_args()
    isolated()
    Sandbox, _, config = sdk()
    run = AgentRun(DIRECTORY, Sandbox, config, create=args.action == 'prepare')
    if args.action == 'prepare':
        run.prepare()
    elif args.action == 'prepare-network':
        run.verify_network()
    elif args.action == 'inject':
        run.inject(args.kind)
    elif args.action == 'run':
        run.execute()
    else:
        run.cleanup()
        write(DIRECTORY / 'cleanup.json', {'instancesDeleted': run.data['deleted'],
                                         'snapshotDeleted': run.data['snapshot'] is None})


if __name__ == '__main__':
    main()
