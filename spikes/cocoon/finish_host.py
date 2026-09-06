#!/usr/bin/env python3
"""Continue only this run's proven VM IDs: workload and retained recovery checks."""
import json
import os
from pathlib import Path
import signal
import subprocess
import time

from gate import REMOTE_BASE


def main():
    base = Path(__file__).resolve().parent
    if base != REMOTE_BASE or os.geteuid() != 0 or os.environ.get('CLANKER_HOST_SLOT') != 'cocoon':
        raise ValueError('exact authorized host directory, root and slot token required')
    result = json.loads((base / 'results/ram-result.json').read_text())
    if result['status'] != 'pass' or result['execution_scope'] != 'vm':
        raise ValueError('actual RAM acceptance required before continuation')
    expected = result['evidence']['runtime']
    cli = [str(base / 'bin/cocoon'), '--config', str(base / 'config.json')]
    report = {'execution_scope': 'vm', 'status': 'running', 'checks': {},
              'timing_context': 'concurrent-host activity; disjoint smolvm execution authorized'}
    log = (base / 'results/finish-commands.jsonl').open('a')

    def cc(*args):
        start = time.monotonic_ns()
        p = subprocess.run([*cli, *args], capture_output=True, text=True, timeout=180)
        log.write(json.dumps(dict(argv=args, start_ns=start, end_ns=time.monotonic_ns(),
                                 code=p.returncode, stdout=p.stdout, stderr=p.stderr)) + '\n'); log.flush()
        if p.returncode:
            raise RuntimeError(p.stderr)
        return p.stdout

    def inspect(role):
        vm = json.loads(cc('vm', 'inspect', expected[role]['id']))
        if vm['id'] != expected[role]['id'] or vm['config']['name'] != 'cq-q7-' + role:
            raise ValueError('refusing an unowned VM')
        if any(not Path(d['path']).is_relative_to(base) for d in vm['storage_configs']):
            raise ValueError('storage outside the owned runtime')
        return vm

    def guest(role, *args):
        return cc('vm', 'exec', expected[role]['id'], '--', *args)

    def status(role):
        return json.loads(guest(role, 'python3', '/opt/clanker/guest.py', 'call', '{"op":"status"}'))

    def save():
        (base / 'results/finish-result.json').write_text(json.dumps(report, indent=2))

    daemon = None
    try:
        vms = {role: inspect(role) for role in expected}
        for role in ('parent', 'child-b'):
            if vms[role]['pid'] != expected[role]['pid'] or status(role)['marker_sha256'] != result['evidence']['baseline']['marker_sha256']:
                raise ValueError('source/child process no longer matches recorded baseline')
        for role in expected:
            output = guest(role, 'sh', '-ec', (base / 'guest_workload.sh').read_text())
            if output.count('clanker-build-ok') != 2 or '\nvfs\n' not in output:
                raise ValueError('guest native build + vfs Docker run not established')
            (base / 'results' / (role + '-workload.txt')).write_text(output)
            report['checks'][role + ':gcc_docker_vfs_build_run'] = 'pass'; save()
        # The baseline already checked reattachment and stop/start; repeat those
        # here to produce a complete standalone lifecycle result after the fix.
        before = {role: inspect(role)['pid'] for role in expected}
        def supervise():
            return subprocess.Popen([*cli, 'daemon', '--reconcile-interval', '500ms'],
                stdout=(base / 'results/finish-daemon.log').open('a'), stderr=subprocess.STDOUT)
        daemon = supervise(); time.sleep(2)
        if daemon.poll() is not None: raise ValueError('daemon failed to start')
        daemon.terminate(); daemon.wait(timeout=15)
        daemon = supervise(); time.sleep(2)
        if daemon.poll() is not None: raise ValueError('daemon failed to reattach')
        if {role: inspect(role)['pid'] for role in expected} != before:
            raise ValueError('daemon restart changed VMM PIDs')
        report['checks']['daemon_reattachment'] = 'pass'; save()
        storage = inspect('child-a')['storage_configs']
        cc('vm', 'stop', expected['child-a']['id']); cc('vm', 'start', expected['child-a']['id'])
        deadline = time.monotonic() + 90
        while True:
            try:
                disk = json.loads(guest('child-a', 'cat', '/var/tmp/clanker-acceptance-disk.json')); break
            except RuntimeError:
                if time.monotonic() > deadline: raise
                time.sleep(0.5)
        if inspect('child-a')['storage_configs'] != storage or disk != result['evidence']['after']['child-a']['disk']:
            raise ValueError('child workspace changed across stop/start')
        report['checks']['same_disk_stop_start'] = 'pass'; save()
        # A child-owned checkpoint supports source deletion and VMM-loss recovery.
        checkpoint = 'cq-q7-recovery'
        baseline = status('child-b')
        cc('snapshot', 'save', '--name', checkpoint, expected['child-b']['id'])
        cc('vm', 'rm', '--force', expected['parent']['id'])
        cc('snapshot', 'rm', 'cq-q7-ram')
        if status('child-b') != baseline:
            # Elapsed time advances; only continuity and retained mutations matter.
            current = status('child-b')
            if any(current[k] != baseline[k] for k in ('pid', 'marker_sha256', 'counter', 'disk', 'session')):
                raise ValueError('source/reference deletion changed the child')
        if json.loads(guest('child-a', 'cat', '/var/tmp/clanker-acceptance-disk.json')) != disk:
            raise ValueError('source deletion changed cold child disk')
        report['checks']['children_survive_source_checkpoint_deletion'] = 'pass'; save()
        child = inspect('child-b'); cow = next(Path(d['path']) for d in child['storage_configs'] if d['role'] == 'cow')
        if Path(f"/proc/{child['pid']}/exe").resolve() != base / 'bin/firecracker':
            raise ValueError('refusing to signal an unverified process')
        os.kill(child['pid'], signal.SIGKILL)
        time.sleep(2)
        if not cow.is_file(): raise ValueError('workspace deleted after VMM loss')
        report['checks']['vmm_loss_preserves_disk'] = 'pass'; save()
        cc('vm', 'restore', expected['child-b']['id'], checkpoint)
        deadline = time.monotonic() + 90
        while True:
            try:
                recovered = status('child-b'); break
            except RuntimeError:
                if time.monotonic() > deadline: raise
                time.sleep(0.5)
        if any(recovered[k] != baseline[k] for k in ('pid', 'marker_sha256', 'counter', 'disk', 'session')):
            raise ValueError('checkpoint recovery did not restore captured execution')
        report['checks']['retained_checkpoint_after_vmm_loss'] = 'pass'
        report['recovered_state'] = recovered; report['status'] = 'pass'; save()
    except Exception as error:
        report['status'] = 'fail'; report['error'] = str(error); save(); raise
    finally:
        if daemon is not None and daemon.poll() is None:
            daemon.terminate(); daemon.wait(timeout=15)
        log.close()


if __name__ == '__main__':
    main()
