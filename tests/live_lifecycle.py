#!/usr/bin/env python3
"""Explicit live acceptance against disposable machines, never existing targets."""
import argparse
from functools import partial
import json
import subprocess
import uuid

from acceptance import Acceptance, Report, run_guest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--config', required=True)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--host', required=True)
    parser.add_argument('--session-runner', required=True)
    parser.add_argument('--result', required=True)
    parser.add_argument('--keep', action='store_true', help='leave this new machine running for checkpoint acceptance')
    parser.add_argument('--resume', action='store_true', help='resume the exact disposable machine recorded in --result')
    args = parser.parse_args()
    evidence = Report(args.result,
                      {'name': 'accept-' + uuid.uuid4().hex[:12], 'events': [], 'status': 'running'},
                      resume=args.resume)
    report = evidence.data
    acceptance = Acceptance(args.binary, args.config, evidence, timeout=420)
    if args.resume:
        if not report['name'].startswith('accept-') or not report.get('machine_id') or report.get('cleaned'):
            raise ValueError('an uncleaned disposable machine report is required')
        acceptance.require_settled()
        report['status'] = 'running'
        report.pop('error', None)
        evidence.save()
    save, run, operation = evidence.save, acceptance.run, acceptance.operation

    guest = partial(run_guest, args.session_runner, args.config)

    try:
        if not args.resume:
            operation('create', report['name'], '--profile', args.profile,
                      '--host', args.host,
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
        guest(machine, 'sh', '-se', data=setup)
        check = f'''set -eu
cd "$HOME/{directory}"
git diff --cached --no-ext-diff
git diff --no-ext-diff
cat scratch
test -x scratch
readlink link
'''
        before = guest(machine, 'sh', '-se', data=check)
        identity_before = json.loads(run('inspect', machine))['ssh_host_key']
        operation('stop', machine)
        stopped = json.loads(run('inspect', machine))
        if stopped['state'] != 'stopped':
            raise RuntimeError(f'expected stopped: {stopped}')
        denied = subprocess.run([args.session_runner, '--config', args.config, '--expect-stopped', machine],
                                capture_output=True, text=True, timeout=100)
        if denied.returncode != 0:
            raise RuntimeError(f'stopped-session prerequisite check failed: {denied.stderr[-2048:]}')
        operation('start', machine)
        after = guest(machine, 'sh', '-se', data=check)
        identity_after = json.loads(run('inspect', machine))['ssh_host_key']
        if before != after or identity_before != identity_after:
            raise RuntimeError('workspace contents or SSH identity changed across stop/start')
        report['events'].append({'retained_dirty_git_and_identity': True, 'stopped_session_rejected': True})
        report['status'] = 'passed'
    except Exception as error:
        report['status'] = 'failed'
        report['error'] = str(error)
        raise
    finally:
        machine = report.get('machine_id')
        if machine and not args.keep:
            try:
                acceptance.require_settled()
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
