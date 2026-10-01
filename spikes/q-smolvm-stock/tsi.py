#!/usr/bin/env python3
"""Step 1b: does -p work on the default (TSI) backend? Machine created with only -p
(no --net, no --net-backend); sshd installed as in step 1; ssh through the port."""
from lib import *
set_log('tsi.log')
M = PREFIX + 'tsi'
KEY = SCRATCH / 'client_ed25519'
PUB = (SCRATCH / 'client_ed25519.pub').read_text().strip()
port = free_port()
smolvm('machine', 'create', '--name', M, '--image', 'ubuntu:24.04', '--cpus', '2', '--mem', '1024', '-p', f'{port}:22', check=True)
smolvm('machine', 'start', '--name', M, check=True)
d = smolvm('machine', 'data-dir', '--name', M, quiet=True)[1].strip()
sh(['cat', d + '/agent.config.json'])
gx(M, 'cat /etc/resolv.conf; ip addr 2>&1 | head; export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && '
      'apt-get install -y -qq --no-install-recommends openssh-server >/tmp/apt.log 2>&1; echo apt_rc=$?; tail -2 /tmp/apt.log', timeout=900)
gx(M, f'ssh-keygen -A >/dev/null; mkdir -p /root/.ssh /run/sshd; echo "{PUB}" > /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys')
smolvm('machine', 'exec', '--name', M, '--detach', '--', 'sh', '-c', 'exec /usr/sbin/sshd -D -e >>/var/log/sshd.out 2>&1')
sh(['ssh', '-F', '/dev/null', '-i', str(KEY), '-p', str(port), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
    '-o', f'UserKnownHostsFile={SCRATCH}/known_hosts_tsi', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10', 'root@127.0.0.1', 'echo SSH_OK_TSI'], timeout=60)
sh(['lsof', '-nP', f'-iTCP:{port}', '-sTCP:LISTEN'])
smolvm('machine', 'stop', '--name', M)
smolvm('machine', 'delete', '--name', M, '--force')
