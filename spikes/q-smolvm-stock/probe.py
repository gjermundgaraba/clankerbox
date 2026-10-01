"""Exploratory probe: first look at a stock-image machine (logged to evidence/probe.log)."""
import sys
from lib import *
set_log('probe.log')
name = PREFIX + 'probe'
port = free_port()
note(f'probe machine {name} port {port}')
smolvm('machine', 'create', '--name', name, '--image', 'ubuntu:24.04', '--cpus', '2', '--mem', '2048',
       '--net', '--net-backend', 'virtio-net', '-p', f'{port}:22', timeout=900)
status(name, 'probe-created')
smolvm('machine', 'start', '--name', name, '--branchable', timeout=900)
status(name, 'probe-started')
gx(name, 'cat /etc/os-release; echo; tr "\\0" " " </proc/1/cmdline; echo; id; hostname; cat /etc/machine-id; echo; cat /proc/mounts; ls /oldroot 2>&1 | head; ps -ef 2>&1 | head -30; df -h')
