#!/usr/bin/env python3
"""Explicit live acceptance against disposable machines, never existing targets."""
import argparse
import json
from pathlib import Path
import subprocess
import time
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--config', required=True)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--host', required=True)
    parser.add_argument('--key', required=True)
    parser.add_argument('--result', required=True)
    parser.add_argument('--keep', action='store_true', help='leave this new machine running for connection acceptance')
    parser.add_argument('--resume', action='store_true', help='resume the exact disposable machine recorded in --result')
    args = parser.parse_args()
    base = [str(Path(args.binary).resolve()), '--config', str(Path(args.config).resolve()), '--json']
    report = {'name': 'accept-' + uuid.uuid4().hex[:12], 'events': [], 'status': 'running'}
    result_path = Path(args.result)
    result_path.parent.mkdir(parents=True, exist_ok=True)
    if args.resume:
        report = json.loads(result_path.read_text())
        assert report['name'].startswith('accept-') and report['machine_id']
        report['status'] = 'running'
        report.pop('error', None)

    def save():
        result_path.write_text(json.dumps(report, indent=2) + '\n')

    def run(*command, data=None):
        proc = subprocess.run(base + list(command), input=data, text=True, capture_output=True, timeout=90)
        if proc.returncode:
            raise RuntimeError(f'{command[0]} failed: {proc.stderr[-2048:]}')
        return proc.stdout

    def operation(*command):
        offset = 2 if command[0] == 'checkpoint' else 1
        command = command[:offset] + ('--async',) + command[offset:]
        op = json.loads(run(*command))
        report['events'].append({'action': command[0], 'operation': op})
        if command[0] == 'create':
            report['machine_id'] = op['machine_id']
        save()
        deadline = time.monotonic() + 420
        while time.monotonic() < deadline:
            op = json.loads(run('operation', op['id']))
            if op['status'] == 'succeeded':
                report['events'].append({'completed': op})
                save()
                return op
            if op['status'] == 'failed':
                raise RuntimeError(str(op))
            time.sleep(2)
        raise RuntimeError(f'operation did not complete: {op}')

    save()
    try:
        if not args.resume:
            operation('create', report['name'], '--profile', args.profile,
                      '--host', args.host, '--key', args.key,
                      '--idempotency-key', report['name'])
        machine = report['machine_id']
        directory = 'workspace/' + report['name']
        setup = f'''set -eu
mkdir -p "$HOME/{directory}"
cd "$HOME/{directory}"
git init -q
printf 'staged\\n' > tracked
git add tracked
printf 'dirty\\n' >> tracked
printf 'untracked\\n' > scratch
chmod 755 scratch
ln -sfn tracked link
sync
'''
        run('exec', machine, '--', 'sh', '-se', data=setup)
        check = f'''set -eu
cd "$HOME/{directory}"
git diff --cached --no-ext-diff
git diff --no-ext-diff
cat scratch
test -x scratch
readlink link
'''
        before = run('exec', machine, '--', 'sh', '-se', data=check)
        identity_before = json.loads(run('inspect', machine))['ssh_host_key']
        operation('stop', machine)
        stopped = json.loads(run('inspect', machine))
        if stopped['state'] != 'stopped':
            raise RuntimeError(f'expected stopped: {stopped}')
        denied = subprocess.run(base + ['exec', machine, '--', 'true'], capture_output=True, timeout=30)
        if denied.returncode == 0:
            raise RuntimeError('SSH unexpectedly accepted a stopped machine')
        operation('start', machine)
        after = run('exec', machine, '--', 'sh', '-se', data=check)
        identity_after = json.loads(run('inspect', machine))['ssh_host_key']
        if before != after or identity_before != identity_after:
            raise RuntimeError('workspace contents or SSH identity changed across stop/start')
        report['events'].append({'retained_dirty_git_and_identity': True, 'stopped_ssh_rejected': True})
        report['status'] = 'passed'
    except Exception as error:
        report['status'] = 'failed'
        report['error'] = str(error)
        raise
    finally:
        machine = report.get('machine_id')
        if machine and not args.keep:
            try:
                state = json.loads(run('inspect', machine))['state']
                if state == 'running':
                    operation('stop', machine)
                    state = 'stopped'
                if state == 'stopped':
                    operation('delete', machine)
                    report['cleaned'] = True
                else:
                    report['cleanup_error'] = f'unsafe/unknown state {state}; retained for reconciliation'
            except Exception as error:
                report['cleanup_error'] = str(error)
        save()
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
