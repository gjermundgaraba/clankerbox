#!/usr/bin/env python3
"""Step 2b: the step-2 fork result depends on sshd loading host keys per connection.
OpenSSH 9.6p1 (noble) re-execs per connection; 9.8+ splits off sshd-session. Repeat the
fork comparison on ubuntu:25.10 (newer OpenSSH). Log: evidence/step2b.log."""
import json, re
from lib import *
set_log('step2b.log')
M, C = PREFIX + 'new', PREFIX + 'newfork'
PUB = (SCRATCH / 'client_ed25519.pub').read_text().strip()
for old in ('packed',):
    smolvm('machine', 'stop', '--name', PREFIX + old)
    smolvm('machine', 'delete', '--name', PREFIX + old, '--force')
port = free_port()
smolvm('machine', 'create', '--name', M, '--image', 'ubuntu:25.10', '--cpus', '2', '--mem', '1024',
       '--net', '--net-backend', 'virtio-net', '-p', f'{port}:22', check=True)
smolvm('machine', 'start', '--name', M, '--branchable', check=True, timeout=900)
gx(M, 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq --no-install-recommends '
      'openssh-server >/tmp/apt.log 2>&1; echo rc=$?; ssh-keygen -A >/dev/null; mkdir -p /run/sshd; '
      f'echo "{PUB}" > /root/.ssh/authorized_keys 2>/dev/null || (mkdir -p /root/.ssh && echo "{PUB}" > /root/.ssh/authorized_keys); '
      'dpkg -s openssh-server | grep ^Version; ls /usr/lib/openssh/', timeout=900, check=True)
smolvm('machine', 'exec', '--name', M, '--detach', '--', 'sh', '-c', 'exec /usr/sbin/sshd -D -e >>/var/log/sshd.out 2>&1')
sh(['sleep', '1'])
facts = {}

def fp(port):
    rc, out, err, _ = sh(['ssh-keyscan', '-T', '5', '-t', 'ed25519', '-p', str(port), '127.0.0.1'], quiet=True)
    return sh(['ssh-keygen', '-lf', '-'], input=out, quiet=True)[1].split()[1] if out.strip() else f'fail {err[-200:]}'

def disk(name):
    return gx(name, 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | cut -d" " -f2; ps -o pid=,lstart=,args= -C sshd -C sshd-session', quiet=True)[1]

facts['source'] = {'served': fp(port), 'disk': disk(M)}
rc, out, err, dt = smolvm('machine', 'branch', '--from', M, '--name', C, timeout=600)
m = re.search(r'remapped to (\d+)->22', err)
cport = int(m.group(1)) if m else None
facts['fork'] = {'rc': rc, 'port': cport, 'served': fp(cport) if cport else None, 'disk': disk(C)}
note(json.dumps(facts, indent=2))
(EVIDENCE / 'step2b.json').write_text(json.dumps(facts, indent=2) + '\n')
for n in (C, M):
    smolvm('machine', 'stop', '--name', n)
    smolvm('machine', 'delete', '--name', n, '--force')
