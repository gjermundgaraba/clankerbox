#!/usr/bin/env python3
"""Step 2 (review item 5): is SSH host identity re-minted on RAM fork and checkpoint restore?

Needs step 1's running `clankerbox-rewrite-src` (started --branchable, sshd up).
For the source, a RAM fork, and two restores of one checkpoint it records:
  - the host key served by the running sshd (ssh-keyscan via the published port),
  - the on-disk host keys, /etc/machine-id, /etc/hostname, hostname(1),
  - the sshd listener PID/start time (is it the source's, RAM-inherited?).
Log: evidence/step2.log. Facts: evidence/step2.json.
"""
import json
import re
from lib import *

set_log('step2.log')
SRC, CHILD, R1, R2 = (PREFIX + n for n in ('src', 'fork1', 'restore1', 'restore2'))
CKPT_DIR = SCRATCH / 'ckpt'
CKPT_DIR.mkdir(exist_ok=True)
CKPT = CKPT_DIR / 'src.checkpoint'
facts = {}


def host_port(name):
    """The published host port for guest 22, from `machine ls -v` (status --json has only a count)."""
    _, out, _, _ = smolvm('machine', 'ls', '-v', quiet=True)
    block = re.split(r'\n(?=\S)', out)
    for b in block:
        if b.split() and b.split()[0] == name:
            m = re.search(r'Port: (\d+) -> 22', b)
            return int(m.group(1)) if m else None
    return None


def keyscan(port):
    rc, out, err, _ = sh(['ssh-keyscan', '-T', '5', '-t', 'ed25519', '-p', str(port), '127.0.0.1'], quiet=True)
    if rc != 0 or not out.strip():
        return f'keyscan failed rc={rc}: {err.strip()[-200:]}'
    _, fp, _, _ = sh(['ssh-keygen', '-lf', '-'], input=out, quiet=True)
    return fp.split()[1] if fp.split() else fp


def ident(name, tag):
    port = host_port(name)
    st = status(name, tag)
    _, out, _, _ = gx(name, 'echo disk_ed25519=$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | cut -d" " -f2); '
                            'echo machine_id=$(cat /etc/machine-id); echo etc_hostname=$(cat /etc/hostname); '
                            'echo hostname=$(hostname); echo boot_id=$(cat /proc/sys/kernel/random/boot_id); '
                            'echo sshd=$(ps -o pid=,lstart= -C sshd | tr -s " " | head -1); '
                            'echo key_mtime=$(stat -c %y /etc/ssh/ssh_host_ed25519_key)')
    d = dict(line.split('=', 1) for line in out.strip().splitlines() if '=' in line)
    d['port'] = port
    d['served_ed25519'] = keyscan(port) if port else None
    d['served_matches_disk'] = d['served_ed25519'] == d.get('disk_ed25519')
    d['state'] = st.get('state')
    d['parent_machine'] = st.get('parent_machine')
    facts[tag] = d
    note(f'{tag}: {json.dumps(d)}')
    return d


src = ident(SRC, 'source')

note('RAM fork (machine branch) of the running source')
rc, out, err, dt = smolvm('machine', 'branch', '--from', SRC, '--name', CHILD, timeout=600)
facts['branch'] = {'rc': rc, 'seconds': round(dt, 2), 'stderr': err.strip()[-600:]}
smolvm('machine', 'ls', '-v')
if rc == 0:
    child = ident(CHILD, 'fork1')
    # Restart the child's sshd: does the served key then follow the disk?
    gx(CHILD, 'pkill -x sshd; sleep 0.5; mkdir -p /run/sshd')
    smolvm('machine', 'exec', '--name', CHILD, '--detach', '--', 'sh', '-c',
           'exec /usr/sbin/sshd -D -e >>/var/log/sshd.out 2>&1')
    sh(['sleep', '1'])
    ident(CHILD, 'fork1-after-sshd-restart')
    ident(SRC, 'source-after-fork')

note('checkpoint the running source')
rc, out, err, dt = smolvm('machine', 'checkpoint', '--name', SRC, '--output', str(CKPT), timeout=900)
facts['checkpoint'] = {'rc': rc, 'seconds': round(dt, 2), 'stderr': err.strip()[-600:]}
if CKPT.exists():
    facts['checkpoint']['du'] = sh(['du', '-sh', str(CKPT)], quiet=True)[1].strip()
    facts['checkpoint']['ls'] = sh(['ls', '-la', str(CKPT)], quiet=True)[1].strip()
smolvm('machine', 'ls', '-v')
ident(SRC, 'source-after-checkpoint')

# Stay at <= 3 machines: drop the fork before restoring.
smolvm('machine', 'stop', '--name', CHILD)
smolvm('machine', 'delete', '--name', CHILD, '--force')


def restore(name, tag):
    rc, out, err, dt = smolvm('machine', 'create', '--name', name, '--from', str(CKPT), timeout=900)
    r = {'create_rc': rc, 'create_s': round(dt, 2), 'create_err': err.strip()[-600:]}
    smolvm('machine', 'ls', '-v')
    r['recorded_port'] = host_port(name)
    status(name, f'{tag}-created')
    rc, out, err, dt = smolvm('machine', 'start', '--name', name, timeout=600)
    r['start1'] = {'rc': rc, 's': round(dt, 2), 'err': err.strip()[-800:]}
    if rc != 0:
        new = free_port()
        old = r['recorded_port'] or src['port']
        rc2, _, err2, _ = smolvm('machine', 'update', '--name', name, '--remove-port', f'{old}:22', '-p', f'{new}:22')
        r['update'] = {'rc': rc2, 'err': err2.strip()[-600:], 'new_port': new}
        smolvm('machine', 'ls', '-v')
        rc, out, err, dt = smolvm('machine', 'start', '--name', name, timeout=600)
        r['start2'] = {'rc': rc, 's': round(dt, 2), 'err': err.strip()[-800:]}
    facts[f'{tag}-restore'] = r
    if rc == 0:
        ident(name, tag)
        gx(name, 'pkill -x sshd; sleep 0.5; mkdir -p /run/sshd')
        smolvm('machine', 'exec', '--name', name, '--detach', '--', 'sh', '-c',
               'exec /usr/sbin/sshd -D -e >>/var/log/sshd.out 2>&1')
        sh(['sleep', '1'])
        ident(name, f'{tag}-after-sshd-restart')


restore(R1, 'restore1')
restore(R2, 'restore2')
ident(SRC, 'source-final')
(EVIDENCE / 'step2.json').write_text(json.dumps(facts, indent=2) + '\n')
print(json.dumps(facts, indent=2))
