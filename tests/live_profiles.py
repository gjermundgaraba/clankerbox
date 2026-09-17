#!/usr/bin/env python3
"""Qualify runtime profiles in an explicitly disposable environment; retain failed evidence."""

import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

from acceptance import Acceptance, Report, run_guest


def qualify(args, report):
    api = Acceptance(args.binary, args.config, report, poll_interval=.2)
    profile = 'profile-check-' + uuid.uuid4().hex[:12]
    report.data['profile'] = profile
    report.save()

    def call(*command, rejected=False):
        p = subprocess.run([args.binary, '--config', args.config, '--json', *command],
                           text=True, capture_output=True, timeout=180)
        if rejected:
            if p.returncode == 0 or 'failed_precondition' not in p.stderr:
                raise RuntimeError(f'expected dependency rejection: {command}: {p.stderr}')
            report.data['events'].append({'rejected': command, 'error': p.stderr})
            report.save()
            return None
        if p.returncode:
            raise RuntimeError(p.stderr[-4096:])
        return json.loads(p.stdout) if p.stdout.strip() else None

    def wait(build, expected='succeeded', phase=None):
        deadline = time.monotonic() + args.build_timeout
        while time.monotonic() < deadline:
            state = call('profile', 'build', build)
            if phase and state['phase'] == phase:
                return state
            if state['status'] in ('succeeded', 'failed', 'cancelled'):
                report.data['events'].append({'build_completed': state})
                report.save()
                if phase or state['status'] != expected:
                    raise RuntimeError(f'build {build}: {state}')
                return state
            time.sleep(.2)
        raise TimeoutError(f'build {build} did not finish; inspect retained evidence')

    def publish(recipe):
        build = uuid.uuid4().hex
        report.data['builds'].append(build)
        report.save()
        accepted = call('profile', 'publish', str(recipe), '--build-id', build)
        report.data['events'].append({'build_accepted': accepted})
        report.save()
        return build

    def version(machine):
        return run_guest(args.binary, args.config, machine,
                         '/usr/local/bin/clankerbox-profile-check').strip()

    def create(suffix):
        mid = api.operation('create', profile + suffix, '--host', args.host,
                            '--profile', profile)['machine_id']
        report.data['machines'].append(mid)
        report.save()
        return mid

    base = next(b for b in call('profile', 'bases', args.host) if b['id'] == args.base)
    linux = base['os'] == 'linux'
    with tempfile.TemporaryDirectory(prefix='clankerbox-profile-recipe-') as temporary:
        recipe = Path(temporary)
        (recipe / 'files').mkdir()
        (recipe / 'profile.json').write_text(json.dumps({
            'id': profile, 'host_id': args.host, 'base_id': args.base,
            'cpu': args.cpu, 'ram_mib': args.ram_mib,
            **({'storage_gib': args.storage_gib, 'overlay_gib': args.overlay_gib} if linux else {}),
        }))
        script = recipe / 'setup.sh'
        tool = recipe / 'files/tool'
        install = 'set -eu\ninstall -m 755 files/tool /usr/local/bin/clankerbox-profile-check\n'
        if args.setup_script:
            (recipe / 'files/package-setup.sh').write_text(Path(args.setup_script).read_text())
            install += '/bin/sh files/package-setup.sh\n'
        script.write_text(install)
        tool.write_text('#!/bin/sh\necho version-one\n')
        first = publish(recipe)
        wait(first)
        old = create('-old')
        assert version(old) == 'version-one'
        # smolvm cold restart enables its native RAM-branching supervisor.
        api.operation('stop', old)
        if linux:
            api.operation('start', old)
        child = api.operation('fork', old, profile + '-fork')['machine_id']
        assert version(child) == 'version-one'
        api.operation('stop', child)
        cp = api.operation('checkpoint', 'create', old)['checkpoint_id']
        report.data['checkpoints'].append(cp)
        report.save()
        if not linux:
            api.operation('start', old)

        tool.write_text('#!/bin/sh\necho version-two\n')
        script.write_text(f'set -eu\nsleep {args.setup_delay}\n' + install)
        second = publish(recipe)
        wait(second, phase='setup')
        start = time.monotonic()
        api.operation('stop', old)
        api.operation('start', old)
        elapsed = time.monotonic() - start
        during = call('profile', 'build', second)
        report.data['restart_during_setup_seconds'] = elapsed
        report.data['phase_after_restart'] = during['phase']
        report.save()
        if during['phase'] != 'setup':
            raise RuntimeError('restart did not finish during setup; increase --setup-delay to distinguish phase delays')
        wait(second)
        assert version(old) == 'version-one'
        api.operation('start', child)
        assert version(child) == 'version-one'
        api.operation('stop', child)
        restored = api.operation('restore', cp, profile + '-restored')['machine_id']
        assert version(restored) == 'version-one'
        api.operation('stop', restored)
        new = create('-new')
        assert version(new) == 'version-two'
        call('profile', 'delete-revision', first, rejected=True)
        # macOS permits only two simultaneous native VMs; leave room for a builder.
        api.operation('stop', new)

        script.write_text('echo expected-build-failure\nexit 7\n')
        failed = publish(recipe)
        wait(failed, 'failed')
        failed_log = subprocess.check_output(
            [args.binary, '--config', args.config, 'profile', 'logs', failed],
            text=True, timeout=30)
        assert 'expected-build-failure' in failed_log, 'failure recipe never ran'
        report.data['events'].append({'failed_recipe_log': failed_log})
        report.save()
        assert next(p for p in call('profiles') if p['id'] == profile)['revision_id'] == second
        script.write_text('echo cancellation-ready\nsleep 120\n')
        cancelled = publish(recipe)
        wait(cancelled, phase='setup')
        call('profile', 'cancel', cancelled)
        wait(cancelled, 'cancelled')
        assert next(p for p in call('profiles') if p['id'] == profile)['revision_id'] == second

        if not args.keep_profile:
            call('profile', 'delete', profile)
        api.operation('stop', old)
        api.operation('start', old)
        assert version(old) == 'version-one'
        api.operation('stop', old)
        for machine in [restored, child, new, old]:
            api.operation('delete', machine)
        api.operation('checkpoint', 'delete', cp)
        call('profile', 'delete-revision', first)
        if not args.keep_profile:
            call('profile', 'delete-revision', second)
        report.data['retained_revision'] = second if args.keep_profile else None
        report.data['cleaned'] = True
        report.save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('binary', 'config', 'host', 'base', 'result'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--cpu', type=int, default=2)
    parser.add_argument('--ram-mib', type=int, default=1024)
    parser.add_argument('--storage-gib', type=int, default=1)
    parser.add_argument('--overlay-gib', type=int, default=8)
    parser.add_argument('--setup-delay', type=int, default=30)
    parser.add_argument('--build-timeout', type=int, default=3600)
    parser.add_argument('--setup-script', help='additional root-run package installation script')
    parser.add_argument('--keep-profile', action='store_true', help='retain current revision for lifecycle/benchmark tests')
    args = parser.parse_args()
    report = Report(args.result, {'status': 'running', 'events': [], 'builds': [], 'machines': [], 'checkpoints': []})
    try:
        qualify(args, report)
        report.data['status'] = 'passed'
    except Exception as error:
        report.data.update(status='failed', error=str(error))
        raise
    finally:
        report.save()
    print(json.dumps(report.data, indent=2))


if __name__ == '__main__':
    main()
