#!/usr/bin/env python3
"""Explicit cleanup after evidence export. Never invoked automatically on failure."""
import argparse
import json
import os
from pathlib import Path
import subprocess

p=argparse.ArgumentParser(description=__doc__); p.add_argument('base', type=Path)
p.add_argument('--delete-disposable-vms', action='store_true'); a=p.parse_args()
base=a.base.resolve()
if not (os.environ.get('CLANKER_HOST_SLOT') == 'cocoon' and a.delete_disposable_vms): raise ValueError("validation failed: os.environ.get('CLANKER_HOST_SLOT') == 'cocoon' and a.delete_disposable_vms")
if not (base.name.startswith('clankerbox-cocoon.') and os.geteuid() == 0): raise ValueError("validation failed: base.name.startswith('clankerbox-cocoon.') and os.geteuid() == 0")
config=json.loads((base/'config.json').read_text()); scope=config['net_scope']
cli=[str(base/'bin/cocoon'), '--config', str(base/'config.json')]
for role in ('child-a','child-b','parent'):
    name=f'cq-{scope}-{role}'
    probe=subprocess.run([*cli,'vm','inspect',name],capture_output=True,text=True)
    if probe.returncode:
        continue
    vm=json.loads(probe.stdout)
    if not (vm['config']['name'] == name): raise ValueError("validation failed: vm['config']['name'] == name")
    if not (all(str(base) in d['path'] for d in vm['storage_configs'])): raise ValueError("validation failed: all(str(base) in d['path'] for d in vm['storage_configs'])")
    subprocess.run([*cli,'vm','rm','--force',vm['id']],check=True)
for snapshot in (f'cq-{scope}-ram', f'cq-{scope}-recovery'):
    if subprocess.run([*cli,'snapshot','inspect',snapshot],capture_output=True).returncode == 0:
        subprocess.run([*cli,'snapshot','rm',snapshot],check=True)
for suffix in ('p','a','b'):
    name='cq'+scope+suffix
    p=subprocess.run(['ip','-j','link','show','master',name],capture_output=True,text=True)
    if p.returncode == 0:
        if not (json.loads(p.stdout) == []): raise ValueError('bridge still has attached interfaces')
        subprocess.run(['ip','link','delete',name,'type','bridge'],check=True)
parent=Path('/sys/fs/cgroup')/config['cgroup_parent']
if parent.exists():
    parent.rmdir()  # refuses nonempty or still-populated scopes
print('Disposable VM/network cleanup complete. Private files and results retained at',base)
