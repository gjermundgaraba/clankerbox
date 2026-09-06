#!/usr/bin/env python3
"""Read-only export of recovery evidence; never copies live VM disks or secrets."""
import argparse
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
REMOTE = 'clanker@203.0.113.10:/home/clanker/clankerbox-recovery.AsnzhP'
DEST = HERE / 'results/2026-09-06'


def sync(relative, patterns):
    destination = DEST / relative
    destination.mkdir(parents=True, exist_ok=True)
    argv = ['rsync', '-a', '--rsync-path=sudo -n rsync']
    argv += ['--include=' + pattern for pattern in patterns]
    argv += ['--exclude=*', REMOTE + ('/' + relative if relative else '') + '/', str(destination) + '/']
    subprocess.run(argv, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binaries', action='store_true', help='Also export pinned private runtime binaries.')
    args = parser.parse_args()
    sync('', ['/*.json', '/*.jsonl', '/host_audit.py'])
    for runtime in ('cocoon', 'smolvm'):
        patterns = ['/*.json', '/*.jsonl', '/*.py', '/*.patch', '/*.md', '/results/***']
        if runtime == 'smolvm':
            patterns += ['/profiles/', '/profiles/ubuntu-bare/', '/profiles/ubuntu-bare/profile.json']
        if args.binaries:
            patterns += (['/s/', '/s/bin/***'] if runtime == 'cocoon' else
                         ['/runtime/', '/runtime/bin/***', '/runtime/lib/***',
                          '/runtime/agent-rootfs/', '/runtime/agent-rootfs/usr/',
                          '/runtime/agent-rootfs/usr/local/', '/runtime/agent-rootfs/usr/local/bin/',
                          '/runtime/agent-rootfs/usr/local/bin/smolvm-agent'])
        sync(runtime, patterns)
    print(json.dumps(dict(destination=str(DEST), mode='read-only export', includes_binaries=args.binaries)))


if __name__ == '__main__':
    main()
