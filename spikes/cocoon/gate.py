#!/usr/bin/env python3
"""Last CNI chain step: quarantine the host veth before Cocoon creates its TAP."""
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys

REMOTE_BASE = Path('/home/clanker/clankerbox-cocoon.b0ngM6')


def validate_base(base):
    base = base.resolve()
    local_work = Path(__file__).resolve().parent / '.work'
    if base != REMOTE_BASE and not base.is_relative_to(local_work):
        raise ValueError('path outside the owned spike directory')


def run(*args):
    return subprocess.check_output(args, text=True)


def atomic(path, data):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, sort_keys=True))
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def record_path(config, container, interface):
    key = hashlib.sha256((container + ':' + interface).encode()).hexdigest()
    return Path(config['stateDir']) / (key + '.json')


def host_interface(config, prev, run=run):
    # Bridge plugin returns bridge, host veth and sandbox interface. Prove the
    # host veth's peer is the sandbox NIC; never pick the bridge by position.
    sandbox = [i for i in prev['interfaces'] if i.get('sandbox') == os.environ['CNI_NETNS']
               and i['name'] == os.environ['CNI_IFNAME']]
    if not (len(sandbox) == 1): raise ValueError('one sandbox NIC required')
    guest = json.loads(run('nsenter', '--net=' + os.environ['CNI_NETNS'],
                           'ip', '-j', 'link', 'show', 'dev', sandbox[0]['name']))[0]
    candidates = []
    for item in prev['interfaces']:
        if item.get('sandbox') or item['name'] == config['bridge']:
            continue
        link = json.loads(run('ip', '-j', '-d', 'link', 'show', 'dev', item['name']))[0]
        if (link['ifindex'] == guest['link_index'] and link.get('master') == config['bridge']
                and link['linkinfo']['info_kind'] == 'veth'):
            candidates.append(link)
    if not (len(candidates) == 1): raise ValueError('cannot prove unique host veth peer')
    return candidates[0]


def filter_cmd(dev, direction, verb, pref, *rule):
    handle = ('handle', '1') if verb in ('add', 'replace') else ()
    return ('tc', 'filter', verb, 'dev', dev, direction, 'pref', str(pref), *handle, *rule)


def block(dev, run=run):
    # pref 1 wins over every allow rule; both directions cover IPv4/IPv6/L2.
    for direction in ('ingress', 'egress'):
        run(*filter_cmd(dev, direction, 'add', 1, 'protocol', 'all',
                        'matchall', 'action', 'drop'))


def verify_block(dev, run=run):
    # Linux matchall rejects replacement of an existing classifier (EEXIST).
    # Verify the existing all-traffic drops; never remove/reinstall them to open.
    for direction in ('ingress', 'egress'):
        rules = json.loads(run('tc', '-j', 'filter', 'show', 'dev', dev, direction))
        if not any(r.get('pref') == 1 and r.get('protocol') == 'all'
                   and r.get('kind') == 'matchall'
                   and any(a.get('kind') == 'gact' and a.get('control_action', {}).get('type') == 'drop'
                           for a in r.get('options', {}).get('actions', [])) for r in rules):
            raise ValueError('required all-traffic quarantine drop is missing: ' + direction)


def release(record, proof, run=run):
    if record.get('bridge') not in ('cqq7p', 'cqq7a', 'cqq7b'):
        raise ValueError('unowned gate interface')
    if not (proof['prepared'] is True and proof['vm_id'] == record['vm_id']): raise ValueError("validation failed: proof['prepared'] is True and proof['vm_id'] == record['vm_id']")
    if not (proof['gate_nonce'] == record['nonce']): raise ValueError('stale preparation proof')
    if not (proof['session'] and proof['session'] != proof['inherited_session']): raise ValueError("validation failed: proof['session'] and proof['session'] != proof['inherited_session']")
    if not (re.fullmatch(r'[0-9a-f]{32}', proof['machine_id'])): raise ValueError("validation failed: re.fullmatch(r'[0-9a-f]{32}', proof['machine_id'])")
    if not (proof['pid'] == proof['inherited_pid'] and proof['marker_sha256'] == proof['inherited_marker_sha256']): raise ValueError("validation failed: proof['pid'] == proof['inherited_pid'] and proof['marker_sha256'] == proof['inherited_marker_sha256']")
    link = json.loads(run('ip', '-j', '-d', 'link', 'show', 'dev', record['dev']))[0]
    if not (link['ifindex'] == record['ifindex'] and link['master'] == record['bridge']): raise ValueError("validation failed: link['ifindex'] == record['ifindex'] and link['master'] == record['bridge']")
    dev = record['dev']
    verify_block(dev, run)
    # Keep a permanent default drop. After preparation only ARP and this
    # bridge-local synthetic HTTP service are reachable; no general egress.
    for direction in ('ingress', 'egress'):
        run(*filter_cmd(dev, direction, 'add', 100, 'protocol', 'all', 'matchall', 'action', 'drop'))
        run(*filter_cmd(dev, direction, 'add', 10, 'protocol', 'arp', 'flower', 'action', 'pass'))
        addr, port = ('dst_ip', 'dst_port') if direction == 'ingress' else ('src_ip', 'src_port')
        run(*filter_cmd(dev, direction, 'add', 20, 'protocol', 'ip', 'flower',
                        addr, record['endpoint'], 'ip_proto', 'tcp', port, '8080', 'action', 'pass'))
    # Enable inbound replies first. Child requests cannot leave until final call.
    for direction in ('egress', 'ingress'):
        run(*filter_cmd(dev, direction, 'del', 1))


def cni(config, command, run=run):
    expected = {'cqq7p': '172.30.216.1', 'cqq7a': '172.30.217.1', 'cqq7b': '172.30.218.1'}
    if config.get('bridge') not in expected or config.get('endpoint') != expected[config['bridge']]:
        raise ValueError('network outside granted host scope')
    if not (config['cniVersion'] == '1.0.0'): raise ValueError("validation failed: config['cniVersion'] == '1.0.0'")
    if not (re.fullmatch(r'cq[a-z0-9]{2}[pab]', config['bridge'])): raise ValueError("validation failed: re.fullmatch(r'cq[a-z0-9]{2}[pab]', config['bridge'])")
    if not (ipaddress.ip_address(config['endpoint']).is_private): raise ValueError("validation failed: ipaddress.ip_address(config['endpoint']).is_private")
    state = Path(config['stateDir'])
    if not (state.is_absolute() and state.name == 'gates'): raise ValueError("validation failed: state.is_absolute() and state.name == 'gates'")
    validate_base(state.parent)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = record_path(config, os.environ['CNI_CONTAINERID'], os.environ['CNI_IFNAME'])
    if command == 'DEL':
        # Bridge plugin owns link teardown. Never remove a drop on DEL failure.
        path.unlink(missing_ok=True)
        return None
    if command == 'CHECK':
        record = json.loads(path.read_text())
        if not (record['state'] == 'quarantined'): raise ValueError('CHECK only certifies quarantine')
        verify_block(record['dev'], run)
        return None
    if not (command == 'ADD'): raise ValueError('unsupported CNI command')
    prev = config['prevResult']
    link = host_interface(config, prev, run)
    dev = link['ifname']
    # Fail closed on an unexpected existing qdisc; do not overwrite it.
    run('tc', 'qdisc', 'add', 'dev', dev, 'clsact')
    block(dev, run)
    # Bridge CNI isGateway=false avoids its host-wide ip_forward sysctl.
    run('ip', 'addr', 'replace', config['endpoint'] + '/24', 'dev', config['bridge'])
    atomic(path, dict(vm_id=os.environ['CNI_CONTAINERID'], dev=dev,
                     ifindex=link['ifindex'], bridge=config['bridge'], endpoint=config['endpoint'],
                     nonce=os.urandom(16).hex(), state='quarantined'))
    return prev


def main():
    if len(sys.argv) == 4 and sys.argv[1] == 'release':
        path = Path(sys.argv[2]); validate_base(path.parent.parent)
        record = json.loads(path.read_text())
        release(record, json.loads(Path(sys.argv[3]).read_text()))
        record['state'] = 'fake-endpoint-only'
        atomic(path, record)
        return
    command = os.environ.get('CNI_COMMAND')
    if command == 'VERSION':
        print(json.dumps({'cniVersion': '1.0.0', 'supportedVersions': ['1.0.0']})); return
    result = cni(json.load(sys.stdin), command)
    if result is not None:
        print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'cniVersion': '1.0.0', 'code': 100, 'msg': str(error)}))
        sys.exit(1)
