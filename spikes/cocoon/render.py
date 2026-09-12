#!/usr/bin/env python3
"""Write private config only; does not create a network or launch a VM."""
import argparse
import json
from pathlib import Path
from gate import validate_base


def render(base):
    base = base.resolve()
    validate_base(base)
    scope = 'q7'
    config = dict(root_dir=str(base / 'd'), run_dir=str(base / 'r'), log_dir=str(base / 'l'),
                  fc_binary=str(base / 'bin/firecracker'), use_firecracker=True,
                  cni_conf_dir=str(base / 'cni-conf'), cni_bin_dir=str(base / 'cni-bin'),
                  net_scope=scope, cgroup_parent='cq' + scope + '.slice',
                  dns='', pool_size=3, meta_backend='json', stop_timeout_seconds=30,
                  socket_wait_timeout_seconds=20, metering={'backend': 'file'})
    (base / 'config.json').write_text(json.dumps(config, indent=2))
    for i, name in enumerate(('parent', 'child-a', 'child-b')):
        bridge = 'cq' + scope + ('p', 'a', 'b')[i]
        subnet = f'172.30.{216+i}.0/24'; gateway = f'172.30.{216+i}.1'
        network = dict(cniVersion='1.0.0', name='cq-' + scope + '-' + name, plugins=[
            dict(type='bridge', bridge=bridge, isGateway=False, isDefaultGateway=False,
                 ipMasq=False, hairpinMode=False,
                 ipam=dict(type='host-local', dataDir=str(base / 'ipam'),
                           ranges=[[dict(subnet=subnet, rangeStart=f'172.30.{216+i}.2',
                                         rangeEnd=f'172.30.{216+i}.2', gateway=gateway)]])),
            dict(type='clanker-gate', bridge=bridge, endpoint=gateway, stateDir=str(base / 'gates'))])
        (base / 'cni-conf').mkdir(exist_ok=True)
        (base / 'cni-conf' / (name + '.conflist')).write_text(json.dumps(network, indent=2))
    return config


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__); p.add_argument('base', type=Path)
    a = p.parse_args()
    render(a.base)
