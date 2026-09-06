#!/usr/bin/env python3
"""Read-only host observations for this exact disposable recovery run."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path('/home/clanker/clankerbox-recovery.AsnzhP')
GROUPS = ('cqrec20260906.slice', 'smrec20260906.slice')


def command(argv):
    result = subprocess.run(argv, text=True, capture_output=True)
    return dict(argv=argv, returncode=result.returncode, stdout=result.stdout, stderr=result.stderr)


def observe():
    if ROOT.resolve() != ROOT or ROOT.stat().st_uid != 1000:
        raise RuntimeError('exact owned recovery root required')
    result = dict(schema_version=1, wall_ns=time.time_ns(), root=str(ROOT), commands={},
                  sysctls={}, cgroups={}, owned_runtime_processes=[])
    for name, argv in {
        'uname': ['uname', '-a'], 'disk': ['df', '-B1', str(ROOT)],
        'allocation': ['du', '-s', '-B1', str(ROOT)],
        'links': ['ip', '-j', 'link', 'show'], 'routes': ['ip', '-j', '-4', 'route', 'show', 'table', 'all'],
        'netns': ['ip', '-j', 'netns', 'list'], 'unix_listeners': ['ss', '-xlH'],
    }.items():
        result['commands'][name] = command(argv)
    for name in ('vm/unprivileged_userfaultfd', 'vm/overcommit_memory', 'net/ipv4/ip_forward'):
        result['sysctls'][name] = (Path('/proc/sys') / name).read_text().strip()
    for name in GROUPS:
        path = Path('/sys/fs/cgroup') / name
        if path.exists():
            result['cgroups'][name] = {entry: (path / entry).read_text().strip()
                for entry in ('cgroup.procs', 'memory.current', 'memory.peak', 'memory.max', 'memory.events')}
        else:
            result['cgroups'][name] = None
    for process in Path('/proc').iterdir():
        if not process.name.isdigit():
            continue
        try:
            exe = str((process / 'exe').resolve(strict=True))
            argv = (process / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
            text = [os.fsdecode(value) for value in argv]
            if not any(str(ROOT) in value for value in [exe, *text]):
                continue
            if Path(exe).name not in ('firecracker', 'smolvm', 'cocoon'):
                continue
            fields = (process / 'stat').read_text().rsplit(')', 1)[1].split()
            result['owned_runtime_processes'].append(dict(pid=int(process.name), exe=exe, argv=text,
                start_ticks=fields[19], state=fields[0],
                cgroup=(process / 'cgroup').read_text(), mount_namespace=os.readlink(process / 'ns/mnt')))
        except (FileNotFoundError, ProcessLookupError):
            continue
    result['owned_unix_listeners'] = [line for line in
        result['commands']['unix_listeners']['stdout'].splitlines() if str(ROOT) in line]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=('before', 'after'), required=True)
    args = parser.parse_args()
    result = observe()
    destination = ROOT / ('host-' + args.phase + '.json')
    # Observation files are immutable evidence, never overwrite a prior audit.
    with destination.open('x') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
