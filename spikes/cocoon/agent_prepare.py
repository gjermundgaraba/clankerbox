#!/usr/bin/env python3
"""Repair guest identities and local relay destination without restarting agent processes."""
import json
from pathlib import Path
import subprocess
import sys
import uuid

def run(*args): subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

vm_id, nonce, address, gateway, mac = sys.argv[1:]
machine = uuid.uuid4().hex
Path('/etc/machine-id').write_text(machine + '\n')
Path('/etc/hostname').write_text('cq-' + vm_id[:12] + '\n')
run('hostname', 'cq-' + vm_id[:12])
run('systemctl', 'stop', 'ssh.service', 'ssh.socket', 'systemd-networkd.service', 'systemd-networkd.socket')
for path in Path('/etc/ssh').glob('ssh_host_*'): path.unlink()
run('ssh-keygen', '-A')
devs = [p.name for p in Path('/sys/class/net').iterdir() if p.name != 'lo']
if len(devs) != 1: raise ValueError('expected one NIC')
dev = devs[0]
for args in [('link','set',dev,'down'), ('addr','flush','dev',dev), ('link','set',dev,'address',mac),
             ('addr','add',address,'dev',dev), ('link','set',dev,'up'),
             ('route','replace','default','via',gateway,'dev',dev)]: run('ip', *args)
Path('/etc/real-agent-proxy').write_text(gateway + '\n')
print(json.dumps(dict(vm_id=vm_id, nonce=nonce, prepared=True, machine_id=machine, address=address, mac=mac)))
