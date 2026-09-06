#!/usr/bin/env python3
"""Disposable guest only: cooperative session reset while host gate remains shut."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

sys.path.insert(0, '/opt/clanker')
from guest import call


def guest_command(args):
    # Keep the proof's stdout exclusively JSON, including ssh-keygen progress.
    subprocess.check_call(args, stdout=sys.stderr)


def prepare(vm_id, nonce, address, gateway, mac, root=Path('/'), run=guest_command, call=call):
    before = call('/tmp/clanker-acceptance.sock', {'op': 'status'})
    # This changes only the cooperative sentinel's session. It does not repair
    # an arbitrary coding agent or invalidate secrets still cached in memory.
    call('/tmp/clanker-acceptance.sock', {'op': 'prepare'})
    machine = uuid.uuid4().hex
    (root / 'etc/machine-id').write_text(machine + '\n')
    (root / 'etc/hostname').write_text('cq-' + vm_id[:12] + '\n')
    run(['hostname', 'cq-' + vm_id[:12]])
    # Disable inherited SSH listener before rotating its keys.
    run(['systemctl', 'stop', 'ssh.service', 'ssh.socket'])
    for key in (root / 'etc/ssh').glob('ssh_host_*'):
        if key.is_file():
            key.unlink()
    run(['ssh-keygen', '-A'])
    keys = sorted((root / 'etc/ssh').glob('ssh_host_*_key.pub'))
    if not (keys): raise ValueError('SSH host key generation produced no public keys')
    fingerprints = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in keys}
    # Stop networkd so inherited leases/config cannot race the static repair.
    run(['systemctl', 'stop', 'systemd-networkd.service', 'systemd-networkd.socket'])
    nics = [p.name for p in (root / 'sys/class/net').iterdir() if p.name != 'lo']
    if not (len(nics) == 1): raise ValueError('spike requires exactly one guest NIC')
    dev = nics[0]
    network_dir = root / 'etc/systemd/network'
    network_dir.mkdir(parents=True, exist_ok=True)
    (network_dir / '10-clanker.network').write_text(
        f'[Match]\nName={dev}\n[Network]\nAddress={address}\nGateway={gateway}\nDHCP=no\nLinkLocalAddressing=no\n')
    for args in (['link', 'set', dev, 'down'], ['addr', 'flush', 'dev', dev],
                 ['link', 'set', dev, 'address', mac], ['addr', 'add', address, 'dev', dev],
                 ['link', 'set', dev, 'up'], ['route', 'replace', 'default', 'via', gateway, 'dev', dev]):
        run(['ip', *args])
    after = call('/tmp/clanker-acceptance.sock', {'op': 'new-session'})
    if not (after['session'] != before['session'] and after['session']): raise ValueError("validation failed: after['session'] != before['session'] and after['session']")
    if not (after['pid'] == before['pid'] and after['marker_sha256'] == before['marker_sha256']): raise ValueError("validation failed: after['pid'] == before['pid'] and after['marker_sha256'] == before['marker_sha256']")
    if not ((root / 'etc/machine-id').read_text().strip() == machine): raise ValueError("validation failed: (root / 'etc/machine-id').read_text().strip() == machine")
    proof = dict(prepared=True, vm_id=vm_id, gate_nonce=nonce, machine_id=machine,
                 ssh_public_key_sha256=fingerprints,
                 session=after['session'], inherited_session=before['session'],
                 pid=after['pid'], inherited_pid=before['pid'], marker_sha256=after['marker_sha256'],
                 inherited_marker_sha256=before['marker_sha256'])
    (root / 'var/tmp/clanker-identity.json').write_text(json.dumps(proof))
    return proof


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('vm_id'); p.add_argument('nonce'); p.add_argument('address')
    p.add_argument('gateway'); p.add_argument('mac')
    a = p.parse_args()
    ipaddress.ip_interface(a.address); ipaddress.ip_address(a.gateway)
    print(json.dumps(prepare(a.vm_id, a.nonce, a.address, a.gateway, a.mac)))
