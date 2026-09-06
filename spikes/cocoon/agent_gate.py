#!/usr/bin/env python3
"""New-run gate using the proven historical host-peer/quarantine primitives."""
import json
import os
from pathlib import Path
import sys
import gate

RUN = Path('/home/clanker/clankerbox-cocoon.b0ngM6/ca04')
NETWORKS = {'cqagp': '172.30.226.1', 'cqaga': '172.30.227.1', 'cqagb': '172.30.228.1'}

def cni(config, command):
    if config.get('bridge') not in NETWORKS or config.get('endpoint') != NETWORKS[config['bridge']]:
        raise ValueError('network outside agent grant')
    state = Path(config['stateDir'])
    if state != RUN / 'gates' or state.resolve() != state: raise ValueError('unowned gate directory')
    state.mkdir(exist_ok=True, mode=0o700)
    path = gate.record_path(config, os.environ['CNI_CONTAINERID'], os.environ['CNI_IFNAME'])
    if command == 'DEL': path.unlink(missing_ok=True); return
    if command == 'CHECK': gate.verify_block(json.loads(path.read_text())['dev']); return
    if command != 'ADD': raise ValueError('unsupported command')
    prev = config['prevResult']; link = gate.host_interface(config, prev)
    gate.run('tc', 'qdisc', 'add', 'dev', link['ifname'], 'clsact')
    gate.block(link['ifname'])
    gate.atomic(path, dict(vm_id=os.environ['CNI_CONTAINERID'], dev=link['ifname'], ifindex=link['ifindex'],
                          bridge=config['bridge'], endpoint=config['endpoint'], nonce=os.urandom(16).hex(), state='quarantined'))
    return prev

def release(record, proof):
    if record['bridge'] not in NETWORKS or record['endpoint'] != NETWORKS[record['bridge']]: raise ValueError('unowned gate')
    if proof['vm_id'] != record['vm_id'] or proof['nonce'] != record['nonce'] or not proof['prepared']: raise ValueError('invalid preparation')
    link = json.loads(gate.run('ip', '-j', 'link', 'show', 'dev', record['dev']))[0]
    if link['ifindex'] != record['ifindex'] or link['master'] != record['bridge']: raise ValueError('gate identity changed')
    dev = record['dev']; gate.verify_block(dev)
    for direction in ('ingress', 'egress'):
        gate.run(*gate.filter_cmd(dev, direction, 'add', 100, 'protocol', 'all', 'matchall', 'action', 'drop'))
        gate.run(*gate.filter_cmd(dev, direction, 'add', 10, 'protocol', 'arp', 'flower', 'action', 'pass'))
        addr, port = ('dst_ip', 'dst_port') if direction == 'ingress' else ('src_ip', 'src_port')
        gate.run(*gate.filter_cmd(dev, direction, 'add', 20, 'protocol', 'ip', 'flower', addr, record['endpoint'],
                                 'ip_proto', 'tcp', port, '8443', 'action', 'pass'))
    for direction in ('egress', 'ingress'): gate.run(*gate.filter_cmd(dev, direction, 'del', 1))

if __name__ == '__main__':
    try:
        command = os.environ.get('CNI_COMMAND')
        if command == 'VERSION': print(json.dumps({'cniVersion': '1.0.0', 'supportedVersions': ['1.0.0']}))
        else:
            result = cni(json.load(sys.stdin), command)
            if result is not None: print(json.dumps(result))
    except Exception as error:
        print(json.dumps({'cniVersion': '1.0.0', 'code': 100, 'msg': str(error)})); sys.exit(1)
