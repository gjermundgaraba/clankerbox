#!/usr/bin/env python3
"""Step 1 (review item 10): stock ubuntu:24.04 image machine, sshd over a published port.

Leaves `clankerbox-rewrite-src` running (started --branchable, sshd up) for step 2.
Log: evidence/step1.log. Facts: evidence/step1.json.
"""
import json
import subprocess
from lib import *

set_log('step1.log')
facts = {}
SRC = PREFIX + 'src'
KEY = SCRATCH / 'client_ed25519'
KNOWN = SCRATCH / 'known_hosts'

# The exploratory probe machine is no longer needed (it also warmed the image seed).
# A first attempt installed with recommends, which pulled systemd-resolved; its
# /etc/resolv.conf symlink made every later start fail (see diag_restart.py).
rc, out, _, _ = smolvm('machine', 'ls', '--quiet', quiet=True)
for old in ('probe', 'diag', 'src'):
    if PREFIX + old in out.split():
        smolvm('machine', 'stop', '--name', PREFIX + old)
        smolvm('machine', 'delete', '--name', PREFIX + old, '--force')

if not KEY.exists():
    sh(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'q-smolvm-stock', '-f', str(KEY)], check=True)
PUB = (SCRATCH / 'client_ed25519.pub').read_text().strip()


def ssh(port, command):
    return sh(['ssh', '-F', '/dev/null', '-i', str(KEY), '-p', str(port), '-o', 'IdentitiesOnly=yes',
               '-o', 'BatchMode=yes', '-o', f'UserKnownHostsFile={KNOWN}', '-o', 'StrictHostKeyChecking=accept-new',
               '-o', 'ConnectTimeout=10', 'root@127.0.0.1', command], timeout=60)


port = free_port()
facts['src_port'] = port
note(f'source machine {SRC} on host port {port}')
_, _, _, facts['create_s'] = smolvm('machine', 'create', '--name', SRC, '--image', 'ubuntu:24.04',
                                    '--cpus', '2', '--mem', '2048', '--net', '--net-backend', 'virtio-net',
                                    '-p', f'{port}:22', check=True)
status(SRC, 'src-created')
_, _, _, facts['first_start_s'] = smolvm('machine', 'start', '--name', SRC, check=True, timeout=900)
status(SRC, 'src-started')
smolvm('machine', 'ls', '-v')

_, out, _, _ = gx(SRC, 'cat /etc/os-release; echo ---; tr "\\0" " " </proc/1/cmdline; echo; echo ---; cat /proc/mounts; '
                       'echo ---; grep -E "Cap(Eff|Bnd)" /proc/self/status; cat /proc/self/uid_map; echo ---; df -h /; uname -a')
(EVIDENCE / 'step1-guest-fs.txt').write_text(out)

note('install openssh-server over machine exec')
_, _, _, facts['apt_s'] = gx(SRC, 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && '
                                  'apt-get install -y -qq --no-install-recommends openssh-server libcap2-bin attr >/tmp/apt.log 2>&1; '
                                  'rc=$?; tail -5 /tmp/apt.log; ls -la /etc/resolv.conf; '
                                  'dpkg -l systemd-resolved 2>&1 | tail -1; exit $rc', check=True, timeout=900)
gx(SRC, f'ssh-keygen -A && mkdir -p /root/.ssh /run/sshd && chmod 700 /root/.ssh && '
        f'echo "{PUB}" > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && ls -la /etc/ssh/', check=True)


def start_sshd(name):
    gx(name, 'mkdir -p /run/sshd')
    return smolvm('machine', 'exec', '--name', name, '--detach', '--',
                  'sh', '-c', 'exec /usr/sbin/sshd -D -e >>/var/log/sshd.out 2>&1')


start_sshd(SRC)
gx(SRC, 'sleep 1; ps -ef; cat /var/log/sshd.out')
rc, out, _, _ = ssh(port, 'echo SSH_OK; hostname; cat /etc/os-release | head -1; tr "\\0" " " </proc/1/cmdline; echo')
facts['ssh_ok'] = 'SSH_OK' in out

note('persistence across stop/start')
_, _, _, facts['stop_s'] = smolvm('machine', 'stop', '--name', SRC, check=True)
status(SRC, 'src-stopped')
# Restart as a branch source for step 2.
_, _, _, facts['restart_branchable_s'] = smolvm('machine', 'start', '--name', SRC, '--branchable', check=True)
status(SRC, 'src-restarted')
_, out, _, _ = gx(SRC, 'dpkg -s openssh-server | grep -E "^(Status|Version)"; ls /etc/ssh/ssh_host_*_key.pub; '
                       'cat /root/.ssh/authorized_keys | wc -l; ps -ef | grep -c "[s]shd"; ls -d /run/sshd 2>&1')
facts['after_restart'] = out
rc, out, err, _ = ssh(port, 'true')
facts['ssh_after_restart_without_restarting_sshd'] = {'rc': rc, 'err': err.strip()[-300:]}
start_sshd(SRC)
rc, out, _, _ = ssh(port, 'echo SSH_OK')
facts['ssh_after_sshd_restart'] = 'SSH_OK' in out

data_dir = smolvm('machine', 'data-dir', '--name', SRC, quiet=True)[1].strip()
facts['data_dir'] = data_dir
sh(['du', '-sh', data_dir + '/storage.raw', data_dir + '/overlay.raw'])
sh(['du', '-sh', READY['home'] + '/Library/Caches/smolvm/image-seeds'])
sh(['du', '-sh', str(SCRATCH / 'release' / 'smolvm-1.22.0-darwin-arm64' / 'agent-rootfs')])
facts['du'] = sh(['du', '-sk', data_dir + '/storage.raw', data_dir + '/overlay.raw',
                  READY['home'] + '/Library/Caches/smolvm/image-seeds',
                  str(SCRATCH / 'release' / 'smolvm-1.22.0-darwin-arm64' / 'agent-rootfs')], quiet=True)[1]
(EVIDENCE / 'step1.json').write_text(json.dumps(facts, indent=2) + '\n')
print(json.dumps(facts, indent=2))
