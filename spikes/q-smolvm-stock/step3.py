#!/usr/bin/env python3
"""Step 3 (review item 7, plan spike P6): `pack create --from-vm` as profile capture.

In step 1's `clankerbox-rewrite-src` (stock ubuntu:24.04 + openssh-server, libcap2-bin,
attr): create files owned by a non-root uid/gid, a file with xattrs, a binary with
a file capability and a setuid file; stop; pack; create a machine from the pack
with no network (so nothing can be pulled) and check what survived.
Log: evidence/step3.log. Facts: evidence/step3.json.
"""
import json
from lib import *

set_log('step3.log')
SRC, PACKED = PREFIX + 'src', PREFIX + 'packed'
PACK_DIR = SCRATCH / 'pack'
PACK_DIR.mkdir(exist_ok=True)
OUT = PACK_DIR / 'profile'
facts = {}

for old in ('restore1', 'restore2', 'fork1', 'packed'):
    if smolvm('machine', 'status', '--name', PREFIX + old, quiet=True)[0] == 0:
        smolvm('machine', 'stop', '--name', PREFIX + old)
        smolvm('machine', 'delete', '--name', PREFIX + old, '--force')

PROBE = ('cd /srv/q && stat -c "%n %u:%g %a" owned owned/inner setuid capbin xattr-file; '
         'getfattr -d -m - xattr-file capbin 2>&1; getcap capbin; '
         'echo machine_id=$(cat /etc/machine-id); echo hostname=$(hostname); '
         'echo disk_ed25519=$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | cut -d" " -f2); '
         'dpkg -s openssh-server | grep ^Status')

gx(SRC, 'set -e; mkdir -p /srv/q/owned && echo data > /srv/q/owned/inner && chown -R 1234:2345 /srv/q/owned && '
        'chmod 2750 /srv/q/owned; echo x > /srv/q/xattr-file; setfattr -n user.q -v hello /srv/q/xattr-file; '
        'setfattr -n trusted.q -v root-only /srv/q/xattr-file; '
        'cp /usr/bin/sleep /srv/q/capbin; setcap cap_net_bind_service+ep /srv/q/capbin; '
        'cp /usr/bin/true /srv/q/setuid; chmod 4755 /srv/q/setuid; sync', check=True)
_, facts['source_view'], _, _ = gx(SRC, PROBE)
smolvm('machine', 'stop', '--name', SRC, check=True)

rc, out, err, dt = smolvm('pack', 'create', '--from-vm', SRC, '--output', str(OUT), timeout=1800)
facts['pack'] = {'rc': rc, 'seconds': round(dt, 2), 'stdout': out.strip()[-1500:], 'stderr': err.strip()[-1500:]}
_, facts['pack']['ls'], _, _ = sh(['ls', '-la', str(PACK_DIR)])
_, facts['pack']['du'], _, _ = sh(['du', '-sh', *[str(p) for p in PACK_DIR.iterdir()]])
sh(['file', *[str(p) for p in PACK_DIR.iterdir()]])

sidecar = next((p for p in PACK_DIR.iterdir() if p.suffix == '.smolmachine'), None)
if rc == 0 and sidecar:
    # No --net: if the pack were a delta needing the base image from a registry, this could not pull it.
    rc, out, err, dt = smolvm('machine', 'create', '--name', PACKED, '--from', str(sidecar), '--cpus', '2', '--mem', '2048')
    facts['packed_create'] = {'rc': rc, 's': round(dt, 2), 'err': err.strip()[-800:]}
    if rc == 0:
        rc, out, err, dt = smolvm('machine', 'start', '--name', PACKED, timeout=900)
        facts['packed_start'] = {'rc': rc, 's': round(dt, 2), 'err': err.strip()[-800:]}
        status(PACKED, 'packed-started')
        _, facts['packed_view'], _, _ = gx(PACKED, PROBE)
        gx(PACKED, 'cat /proc/mounts | head -3; df -h /')
        d = smolvm('machine', 'data-dir', '--name', PACKED, quiet=True)[1].strip()
        sh(['ls', '-la', d])
        sh(['du', '-sh', d])
(EVIDENCE / 'step3.json').write_text(json.dumps(facts, indent=2) + '\n')
print(json.dumps(facts, indent=2))
