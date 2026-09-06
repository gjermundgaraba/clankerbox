#!/usr/bin/env python3
"""Remove only this completed benchmark's disposable caches, after read-only audits.

Retains source, optimized CLI, workload binary, raw reports and logs. No retained
earlier spike artifact is a target. Default is a non-destructive plan.
"""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

ROOT = Path('/home/clanker/clankerbox-latency.RPxPe6')
TARGETS = ('cocoon/d', 'cocoon/r', 'cocoon/tools', 'cocoon/downloads', 'cocoon/empty-cni',
           'smolvm/build-target', 'smolvm/image', 'smolvm/agent-rootfs', 'smolvm/c', 'smolvm/d',
           'smolvm/config', 'smolvm/r', 'smolvm/empty-docker', 'smolvm/tmp',
           'smolvm/zig-cache', 'smolvm/zig-local-cache', 'shared/zig-global', 'shared/zig-local')


def require(value, message):
    if not value:
        raise RuntimeError(message)


def load_smol():
    spec = importlib.util.spec_from_file_location('cleanup_smol', ROOT/'smolvm/smolvm.py')
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def allocated(path):
    return int(subprocess.check_output(['du', '-s', '-B1', str(path)], text=True).split()[0])


def validate_final_audit(audit):
    require(audit.get('status') == 'pass', 'final dataset audit not passed')
    require(audit.get('scope', {}).get('detailed_guest_proofs') == 'required'
            and audit.get('scope', {}).get('pins') == 'recorded hashes and exported bytes'
            and audit.get('scope', {}).get('command_status_responses') == 'all measured trials required',
            'strict detailed proof and exported-byte audit required')
    require(audit.get('driver', {}).get('starts') == 320 and audit.get('driver', {}).get('ends') == 320
            and audit.get('samples', {}).get('non_smoke') == 320 and audit.get('samples', {}).get('groups') == 28
            and audit.get('finding_count') == 0, 'complete matched zero-finding audit required')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    require(os.geteuid() == 0 and ROOT.resolve() == ROOT and ROOT.stat().st_uid == 1000,
            'root in exact owned benchmark directory required')
    auth = json.loads((ROOT/'authorization.json').read_text())
    require(auth.get('root') == str(ROOT) and auth.get('grant') == 'latency-20260905', 'grant mismatch')
    require(auth.get('timing_authorized') is False, 'close timing gate before cleanup')
    locks = []
    for name in ('driver.lock', 'measure.lock'):
        path = ROOT/name
        require(path.is_file() and not path.is_symlink(), 'missing or redirected lock')
        lock = path.open('r+')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        locks.append(lock)
    require(not (ROOT/'final-cleanup.json').exists(), 'cleanup evidence already exists')
    journal = [json.loads(line) for line in (ROOT/'driver-measure1.jsonl').read_text().splitlines()]
    starts = [row for row in journal if row.get('event') == 'start']
    ends = [row for row in journal if row.get('event') == 'end']
    require(len(starts) == len(ends) == 320 and all(row['returncode'] == 0 for row in ends),
            'full successful driver journal required; failures need an explicit recovery cleanup')
    require({row['key'] for row in starts} == {row['key'] for row in ends} and len({row['key'] for row in ends}) == 320,
            'driver identities mismatch')
    smol = load_smol()
    require(not smol.inventory(), 'owned smolvm VMM/guardian remains')
    require(not Path(auth['cocoon_cgroup']).exists(), 'Cocoon cgroup remains')
    smol.validate_cgroup_owner()
    smol.validate_cgroup()
    require(not (smol.CGROUP/'cgroup.procs').read_text().strip(), 'smol cgroup remains populated')
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            argv = (proc/'cmdline').read_bytes()
            exe = (proc/'exe').resolve(strict=True)
            require(not (str(ROOT).encode() in argv and exe.name in ('firecracker', 'smolvm')),
                    'owned runtime executable remains: ' + proc.name)
        except (FileNotFoundError, ProcessLookupError):
            continue
    cc = ['/home/clanker/clankerbox-cocoon.b0ngM6/bin/cocoon', '--config', str(ROOT/'cocoon/config.json')]
    inventories = {}
    for kind in ('vm', 'snapshot', 'image'):
        output = subprocess.check_output([*cc, kind, 'ls', '--format', 'json'], text=True).strip()
        rows = [] if output.startswith('No ') else json.loads(output)
        inventories[kind] = rows
        if kind != 'image':
            require(not rows, 'Cocoon ' + kind + ' records remain')
        else:
            require(len(rows) == 4 and {row['name'] for row in rows} == {'cl-idle', 'cl-resident', 'cl-dirty', 'cl-workspace'},
                    'unexpected cached image inventory')
    import sqlite3
    database = ROOT/'smolvm/d/smolvm/server/smolvm.db'
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as connection:
        require(connection.execute('SELECT count(*) FROM vms').fetchone()[0] == 0, 'smolvm records remain')
    listeners = subprocess.check_output(['ss', '-xlH'], text=True)
    require(str(ROOT) not in listeners, 'owned Unix listener remains')
    targets = []
    for relative in TARGETS:
        path = ROOT/relative
        require(path.resolve() == path and not path.is_symlink() and path.is_dir(), 'unexpected target: ' + relative)
        require(path.stat().st_uid in (0, 1000), 'foreign target owner: ' + relative)
        targets.append(dict(path=str(path), allocated_bytes=allocated(path)))
    result = dict(schema_version=1, status='plan', inventories=inventories, targets=targets,
                  allocated_before_bytes=allocated(ROOT), wall_ns=time.time_ns(),
                  retained='Earlier spike roots untouched; this root retains source, binaries, raw reports and logs.')
    if args.execute:
        require((ROOT/'final-audit.json').is_file(), 'export and supply successful final audit before deleting caches')
        audit = json.loads((ROOT/'final-audit.json').read_text())
        validate_final_audit(audit)
        result['removed'] = []
        result['status'] = 'running'
        (ROOT/'final-cleanup.json').write_text(json.dumps(result, indent=2)+'\n')
        try:
            result['cgroup_cleanup'] = smol.close_cgroup()
            for target in targets:
                shutil.rmtree(target['path'])
                result['removed'].append(target)
            result['allocated_after_bytes'] = allocated(ROOT)
            result['reclaimed_bytes'] = result['allocated_before_bytes'] - result['allocated_after_bytes']
            result['status'] = 'pass'
        except BaseException as error:
            result.update(status='fail', error=repr(error))
            raise
        finally:
            (ROOT/'final-cleanup.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
