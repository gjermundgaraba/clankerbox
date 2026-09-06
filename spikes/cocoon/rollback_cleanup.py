#!/usr/bin/env python3
"""Finish rb01's recorded empty-resource cleanup; never launches or kills a VM."""
import json
import os
from pathlib import Path
import shutil
import subprocess

from rollback_host import STAGE, RUN, GROUP, HASHES, digest, inventory, require, wait_empty_group


def main():
    require(os.geteuid() == 0 and os.environ.get('CLANKER_HOST_SLOT') == 'cocoon-rollback-20260905', 'rollback cleanup grant required')
    require(RUN.resolve() == RUN and GROUP.stat().st_ino == 67399, 'exact recorded cgroup/run ownership required')
    source = RUN / 'rollback-evidence.json'
    evidence = json.loads(source.read_text())
    require(evidence['status'] == 'pass' and evidence['cleanup'] == 'fail', 'expected completed test with interrupted cleanup')
    require(evidence['cleanup_vms'] == [] and evidence['cleanup_snapshots'] == [], 'prior deletion proof missing')
    require(evidence['owned_leftovers']['cgroup_created_inode'] == GROUP.stat().st_ino, 'cgroup ownership changed')
    require(digest(STAGE / 'bin/cocoon') == HASHES['bin/cocoon'], 'binary changed')
    require(digest(STAGE / 'bin/firecracker') == HASHES['bin/firecracker'], 'binary changed')
    cli = [str(STAGE / 'bin/cocoon'), '--config', str(RUN / 'config.json')]
    vms = subprocess.check_output([*cli, 'vm', 'ls', '--format', 'json'], text=True)
    snapshots = subprocess.check_output([*cli, 'snapshot', 'ls', '--format', 'json'], text=True)
    require(json.loads(vms) == [] and snapshots.strip() == 'No snapshots found.', 'runtime objects remain')
    matches = []
    for process in Path('/proc').glob('[0-9]*'):
        try:
            args = (process / 'cmdline').read_bytes().split(b'\0')
            if any(arg.startswith(str(RUN).encode() + b'/') for arg in args):
                matches.append({'pid': process.name, 'argv': [arg.decode(errors='replace') for arg in args]})
        except FileNotFoundError:
            continue
    require(not matches, 'processes still reference the run: ' + repr(matches))
    for child in GROUP.iterdir():
        if child.is_dir():
            require(child.name == 'control', 'unexpected residual VM scope')
            wait_empty_group(child)
            child.rmdir()
    wait_empty_group(GROUP)
    GROUP.rmdir()
    after = inventory()
    require(after == evidence['host_before'], 'network inventory changed; do not mutate')
    for name in ('d', 'r', 'l', 'empty-cni', 'tools', 'downloads'):
        target = RUN / name
        require(target.resolve().parent == RUN and not target.is_symlink(), 'unowned cleanup path')
        shutil.rmtree(target)
    report = dict(status='pass', execution_scope='host_cleanup', source_sha256=digest(source),
                  explanation='Initial cleanup observed a briefly exiting control process. Follow-up verified no matching processes; no signals or new VMs.',
                  vms=[], snapshots=[], matching_processes=matches, cgroup_exists=GROUP.exists(),
                  host_after=after, retained_files={p.name: p.stat().st_size for p in RUN.iterdir() if p.is_file()})
    (RUN / 'rollback-cleanup.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
