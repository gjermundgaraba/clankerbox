#!/usr/bin/env python3
"""Read-only exported evidence audit, not a host/artifact-bytes verification.

Default completeness means the six named core cases below, not every recovery
scenario. Failed historical attempts remain explicit but do not invalidate a
later supported capability. Any invalid guest integrity reply is always fatal.
"""
import argparse
import hashlib
import json
from pathlib import Path

from evaluate import GUEST_SHA256, evaluate

CORE = {'cocoon/process', 'cocoon/lineage', 'cocoon/native',
        'cocoon/corruption', 'cocoon/isolated', 'smolvm/portable'}
REMOTE = Path('/home/clanker/clankerbox-recovery.AsnzhP')
UBUNTU_SHA256 = '0a64e8ef15c93ff146f10729750955a4b4a1938293260cbf983d99b5466c99ed'


def load(path):
    return json.loads(path.read_text())


def profile_errors(manifest, recorded, build, manifest_sha256):
    """Crosscheck exported inventory metadata, NOT unexported rootfs bytes."""
    errors = []
    entries = manifest.get('entries', [])
    tree = hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    probe = hashlib.sha256(Path(__file__).with_name('disk_probe.py').read_bytes()).hexdigest()
    if (manifest.get('schema_version') != 1 or manifest.get('id') != 'ubuntu-bare-v1'
            or manifest.get('ubuntu_source_sha256') != UBUNTU_SHA256
            or manifest.get('guest_sha256') != GUEST_SHA256 or manifest.get('probe_sha256') != probe):
        errors.append('profile identity or shared input pins differ')
    if (not entries or manifest.get('tree_sha256') != tree or manifest.get('matching_build') != build
            or manifest.get('agent_sha256') != build.get('hashes', {}).get('runtime/agent-rootfs/usr/local/bin/smolvm-agent')):
        errors.append('profile inventory digest or matching build differs')
    wanted = {key: value for key, value in manifest.items() if key != 'entries'}
    wanted.update(manifest_path=str(REMOTE / 'smolvm/profiles/ubuntu-bare/profile.json'),
                  manifest_sha256=manifest_sha256, entry_count=len(entries))
    if recorded != wanted:
        errors.append('report profile identity/hash does not match exported manifest')
    return errors


def audit(root, required=None):
    root = Path(root)
    required = CORE if required is None else set(required)
    findings, attempts, completed = [], [], set()
    hashes = {}

    def check(value, where, reason):
        if not value:
            findings.append({'location': where, 'reason': reason})

    def pin(runtime, relative, expected, where):
        relative = Path(relative)
        if relative.is_absolute() or '..' in relative.parts:
            check(False, where, 'unsafe exported binary path')
            return
        path = root / runtime / relative
        if not path.resolve().is_relative_to((root / runtime).resolve()):
            check(False, where, 'exported binary redirects outside runtime')
            return
        if path not in hashes:
            with path.open('rb') as stream:
                hashes[path] = hashlib.file_digest(stream, 'sha256').hexdigest()
        check(hashes[path] == expected, where, 'exported bytes differ: ' + str(relative))

    paths = sorted(root.glob('cocoon/results/*/result.json'))
    paths += sorted(root.glob('smolvm/results/*/report.json'))
    for path in paths:
        where = str(path.relative_to(root))
        try:
            report = load(path)
            runtime = report.get('runtime')
            case = report.get('case') or ('portable' if 'portable' in report.get('stages', {})
                    or (runtime == 'smolvm' and path.with_name('portable-evidence.json').exists()) else
                    'interrupted' if 'interrupted' in report.get('stages', {}) else
                    'volatile-only' if 'volatile' in report.get('stages', {}) else 'setup')
            row = {'path': where, 'runtime': runtime, 'case': case,
                   'reported_status': report.get('status'), 'error': report.get('error'),
                   'integrity_responses': 0, 'direct_disk_responses': 0,
                   'strict_independent_restore': False}
            attempts.append(row)
            start_errors = len(findings)
            if runtime == 'cocoon' and report.get('case') not in (None, 'cleanup-retry'):
                pins = load(root / 'cocoon/prepared.json')['runtime_pins']
                check({'cocoon', 'firecracker'} <= {Path(k).name for k in pins}, where, 'runtime pins incomplete')
                for name, expected in pins.items():
                    pin(runtime, Path(name).relative_to(REMOTE / runtime), expected, where)
            if runtime == 'smolvm' and report.get('build'):
                recorded = report['build']['hashes']
                check(recorded == load(root / 'smolvm/build.json')['hashes'], where, 'build manifest differs from report')
                check({'runtime/bin/smolvm', 'runtime/lib/libkrun.so', 'runtime/agent-rootfs/usr/local/bin/smolvm-agent'} <= recorded.keys(), where, 'runtime pins incomplete')
                for name, expected in recorded.items():
                    pin(runtime, name, expected, where)
                for name, expected in report.get('library_hashes', {}).items():
                    pin(runtime, Path(name).relative_to(REMOTE / runtime), expected, where)
            if runtime == 'smolvm' and report.get('profile') == 'ubuntu-bare':
                profile = root / 'smolvm/profiles/ubuntu-bare/profile.json'
                for error in profile_errors(load(profile), report.get('profile_inputs', {}),
                                            report.get('build', {}), hashlib.sha256(profile.read_bytes()).hexdigest()):
                    check(False, where, error)
                row['profile_scope'] = 'Exported manifest and report hashes crosschecked; rootfs bytes not exported/rehashed.'
            commands_path = path.with_name('commands.jsonl')
            check(commands_path.is_file(), where, 'command journal missing')
            replies = []
            if commands_path.is_file():
                for number, line in enumerate(commands_path.read_text().splitlines(), 1):
                    command = json.loads(line)
                    try:
                        reply = json.loads(command.get('stdout', ''))
                    except (ValueError, TypeError):
                        continue  # Socket-not-found/non-JSON readiness output is expected.
                    if not isinstance(reply, dict):
                        continue
                    replies.append(reply)
                    if 'memory_ok' in reply or 'disk_ok' in reply:
                        row['integrity_responses'] += 1
                        check(all(reply.get(k) is True for k in ('ok', 'ready', 'memory_ok', 'disk_ok')),
                              where + f':command{number}', 'invalid/incomplete guest integrity flags')
                    if reply.get('method') == 'O_DIRECT+mmap+readv':
                        row['direct_disk_responses'] += 1
                        check(reply.get('ok') is True, where + f':command{number}', 'failed direct disk reply')
            if report.get('status') != 'pass':
                row['classification'] = 'incomplete' if report.get('status') == 'running' else 'failed-attempt-retained'
                continue
            if case in ('setup', 'cleanup-retry'):
                row['classification'] = 'setup-or-cleanup-only'
                continue
            check(row['integrity_responses'] > 0, where, 'no guest integrity responses')
            if runtime == 'cocoon':
                check(report.get('cleanup') == 'pass' and report.get('remaining_processes') == [], where, 'cleanup not proven')
            elif runtime == 'smolvm':
                cleanup = report.get('cleanup', [])
                check(bool(cleanup) and all(item.get('status') == 'pass' for item in cleanup)
                      and not any(key.endswith('_error') for key in report), where, 'cleanup not proven')
            else:
                check(False, where, 'unknown runtime')
            events = report.get('events', [])
            if case == 'native':
                check(any(e.get('event') == 'native-import' and e.get('code') == 0 for e in events), where, 'native import success missing')
                failure = report.get('native_failure_classification', {})
                check(failure.get('stage') == 'clone-prevalidation' and 'untrusted storage path' in failure.get('stderr', ''),
                      where, 'expected native dependency-path rejection missing')
                check(report.get('capabilities', {}).get('native_arbitrary_path_portability') == 'fail', where, 'negative capability mislabeled')
                row['classification'] = 'expected-negative-confirmed'
            elif case == 'corruption':
                cases = {item.get('kind'): item for item in report.get('corruptions', [])}
                for kind in ('missing-memory', 'truncated-vmstate', 'bad-sidecar', 'missing-cow', 'missing-base', 'gzip-crc'):
                    item = cases.get(kind, {})
                    check(item.get('vmm_started') is False and item.get('stage') == ('native-import' if kind == 'gzip-crc' else 'closure-preflight'), where, 'missing rejection: ' + kind)
                check('gzip: invalid checksum' in cases.get('gzip-crc', {}).get('stderr', ''), where, 'native gzip CRC evidence missing')
                capture = report.get('capture', {}).get('ram', {})
                retry = next((e.get('ram', {}) for e in events if e.get('event') == 'clone-ready' and e.get('name') == 'rc-valid-child'), {})
                check(all(k in capture and retry.get(k) == capture[k] for k in ('pid', 'start_monotonic_ns', 'ram_marker', 'branch')), where, 'valid retry RAM continuity missing')
                check(any(r.get('action') == 'read' and r.get('phase') == 'A' and r.get('ok') is True for r in replies), where, 'valid retry direct A read missing')
                row['classification'] = 'wrapper-preflight-and-native-gzip-only'
            elif case == 'lineage':
                snapshots = {e.get('name'): e for e in events if e.get('event') == 'snapshot-created'}
                check({'rc-generation0', 'rc-generation1', 'rc-generation2'} <= snapshots.keys(), where, 'three generation captures missing')
                final = next((e for e in events if e.get('event') == 'lineage-final'), {})
                check(final.get('grandchild_ram', {}).get('branch') == 3 and final.get('recovered_ram', {}).get('branch') == 4, where, 'final lineage RAM isolation missing')
                check({3, 4} <= {r.get('counter') for r in replies if r.get('action') == 'read' and r.get('phase') == 'branch'}, where, 'final lineage direct disk isolation missing')
                row['classification'] = 'generation1-restored-generation2-captured-only'
            elif case in ('process', 'isolated', 'portable'):
                evidence = load(path.with_name('portable-evidence.json')) if runtime == 'smolvm' else report
                evaluation = evaluate(evidence)
                errors = evaluation['findings']
                if case == 'process':
                    check(evidence.get('independent_restore', {}).get('source_paths_unavailable') is False, where, 'process scope changed; review required')
                    errors = [error for error in errors if error['location'] != 'independent_restore']
                    check(evidence.get('independent_restore', {}).get('origin_processes_absent') is True, where, 'origin process absence missing')
                    row['classification'] = 'process-independent-not-path-independent'
                else:
                    row['classification'] = 'strict-independent-recovery'
                    row['strict_independent_restore'] = evaluation['status'] == 'pass'
                for error in errors:
                    check(False, where + ':' + error['location'], error['reason'])
                if case == 'isolated':
                    hidden = next((e for e in events if e.get('event') == 'source-paths-unavailable'), {})
                    check(all(hidden.get(k) is True for k in ('marker_absent', 'export_absent', 'original_closure_absent')),
                          where, 'raw original-path hiding proof missing')
                    check(bool(hidden.get('namespace')) and hidden.get('namespace') != hidden.get('host_namespace') and bool(hidden.get('mountinfo')),
                          where, 'private mount namespace evidence missing')
                    check(report.get('namespace_cleanup', {}).get('mounts_removed') is True, where, 'private mounts cleanup missing')
                    mounts = [line.split() for line in hidden.get('mountinfo', '').splitlines()]
                    cleanup_mounts = [line.split() for line in report.get('namespace_cleanup', {}).get('mountinfo', '').splitlines()]
                    destination = str(REMOTE / 'cocoon/restores' / report['run_id'])
                    expected_mounts = {str(REMOTE / 'cocoon/s'): destination + '/tree',
                                       str(REMOTE / 'cocoon/artifacts'): destination + '/hidden-original-artifacts'}
                    for target, source in expected_mounts.items():
                        check(any(len(m) > 6 and m[4] == target and m[3] == source for m in mounts), where, 'raw copied bind mount missing: ' + target)
                        check(not any(len(m) > 4 and m[4] == target for m in cleanup_mounts), where, 'raw cleanup mount remains: ' + target)
                    check(all('-' in m and not any(v.startswith(('shared:', 'master:', 'propagate_from:')) for v in m[6:m.index('-')]) for m in mounts), where, 'mount propagation is not private')
                    crashes = [e for e in events if e.get('event') == 'source-crash']
                    check(any(e.get('remaining') == [] and e.get('identity') == evidence.get('capture', {}).get('vmm')
                              and e.get('monotonic_ns', 0) < hidden.get('monotonic_ns', 0) for e in crashes), where, 'raw originating VMM death before hiding missing')
                    copies = {r['member']: r for r in evidence.get('artifact_copies', [])}
                    original = {r['member']: r for r in report.get('closure', {}).get('manifest', {}).get('files', [])}
                    check(bool(original) and copies.keys() == original.keys()
                          and all(copies[k]['copied_sha256'] == original[k]['sha256'] for k in copies if k in original), where, 'copied closure differs from original manifest inventory')
                    for item in evidence.get('artifact_copies', []):
                        check(item.get('copy_method') == 'cp --sparse=always --reflink=never'
                              and (item.get('source_device'), item.get('source_inode')) != (item.get('copied_device'), item.get('copied_inode')),
                              where, 'independent copied inode proof missing')
                if runtime == 'smolvm':
                    removal = load(path.with_name('origin-removal.json'))
                    check(removal.get('old_path_exists') is False and removal.get('original_artifact_exists') is False
                          and removal.get('processes', {}).get('remaining') == []
                          and bool(removal.get('processes', {}).get('terminations')), where, 'raw origin removal proof missing')
            else:
                row['classification'] = 'outside-core-audit-scope'
                continue
            if len(findings) == start_errors:
                completed.add(runtime + '/' + case)
            else:
                row['strict_independent_restore'] = False
        except (ValueError, OSError, KeyError, TypeError, AttributeError) as error:
            if attempts and attempts[-1]['path'] == where:
                attempts[-1]['strict_independent_restore'] = False
            check(False, where, 'missing/malformed evidence: ' + str(error))
    missing = sorted(required - completed)
    return {'schema_version': 1, 'status': 'fail' if findings else ('incomplete' if missing else 'pass'),
            'scope': 'Exported core-case records, pinned runtime bytes, and all guest journal integrity replies; not checkpoint artifact bytes or host-state reinspection.',
            'exported_binary_files_checked': len(hashes),
            'core_matrix_complete': not missing, 'required_cases': sorted(required),
            'completed_cases': sorted(completed), 'missing_cases': missing,
            'findings': findings, 'attempts': attempts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--require', action='append', help='Override required core cases; repeat runtime/case.')
    parser.add_argument('--report', type=Path, help='Write generated audit JSON locally; source exports remain read-only.')
    args = parser.parse_args()
    result = audit(args.root, args.require)
    text = json.dumps(result, indent=2) + '\n'
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text)
    print(text, end='')
    return 0 if result['status'] == 'pass' else (2 if result['status'] == 'incomplete' else 1)


if __name__ == '__main__':
    raise SystemExit(main())
