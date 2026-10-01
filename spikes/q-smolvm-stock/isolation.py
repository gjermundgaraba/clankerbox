#!/usr/bin/env python3
"""Which host directory backs the agent root (virtiofs tag /dev/root), and can the
image container write it? Writes a canary through a fresh virtiofs mount of /dev/root
from inside the container, finds it on the host, then removes it."""
from lib import *
set_log('isolation.log')
REL = SCRATCH / 'release' / 'smolvm-1.22.0-darwin-arm64' / 'agent-rootfs'
for name in [PREFIX + 'packed', PREFIX + 'src']:
    if smolvm('machine', 'status', '--name', name, quiet=True)[1].find('"running"') < 0:
        smolvm('machine', 'start', '--name', name)
    d = smolvm('machine', 'data-dir', '--name', name, quiet=True)[1].strip()
    sh(['cat', d + '/agent.config.json'])
    canary = f'CANARY-{name}'
    gx(name, f'mkdir -p /mnt/vfs && mount -t virtiofs /dev/root /mnt/vfs && touch /mnt/vfs/{canary} && '
             f'grep -E " /mnt/vfs " /proc/mounts; umount /mnt/vfs')
    sh(['sh', '-c', f'ls -la {REL}/{canary} {d}/pack/agent-rootfs/{canary} 2>&1'])
    sh(['rm', '-f', f'{REL}/{canary}', f'{d}/pack/agent-rootfs/{canary}'])
