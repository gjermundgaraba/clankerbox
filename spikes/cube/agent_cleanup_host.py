#!/usr/bin/env python3
"""Erase only verified, stopped Cube experiment disks and ephemeral SSH material."""
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
WORK = ROOT / '.work'
scope = json.loads((WORK / 'scope.json').read_text())
if (os.geteuid() != 0 or scope['grant'] != 'cube-codex-20260905' or
        scope['root'] != '/home/clanker/clankerbox-cube.8h3eeX' or
        str(ROOT) != scope['root'] + '/cube'):
    raise RuntimeError('WrongCleanupScope')
owner = 'clanker-cube-8h3eex'
if scope['owner'] != owner:
    raise RuntimeError('WrongOwner')
container = subprocess.run(['docker', 'inspect', owner + '-qemu'], capture_output=True)
if container.returncode == 0:
    raise RuntimeError('RemoveVerifiedStoppedContainerFirst')
for port in ('22070', '18444'):
    if subprocess.check_output(['ss', '-H', '-ltn', 'sport = :' + port], text=True).strip():
        raise RuntimeError('OwnedListenerStillPresent:' + port)
target = WORK / 'target'
if target.resolve() != target or not target.is_dir():
    raise RuntimeError('InvalidTargetDirectory')
names = ('root.qcow2', 'data.raw', 'seed.iso', 'id_ed25519', 'id_ed25519.pub', 'qmp.sock')
targets = [target / name for name in names]
for path in targets:
    if path.is_symlink():
        raise RuntimeError('CleanupTargetSymlink')
open_handles = []
for process in Path('/proc').glob('[0-9]*'):
    try:
        for handle in (process / 'fd').iterdir():
            try:
                if str(handle.readlink()) in {str(path) for path in targets}:
                    open_handles.append({'pid': int(process.name), 'fd': handle.name})
            except FileNotFoundError:
                pass
    except (FileNotFoundError, ProcessLookupError):
        pass
if open_handles:
    raise RuntimeError('OwnedDisksStillOpen')
removed = []
for path in targets:
    if path.exists():
        removed.append({'name': path.name, 'allocatedBytes': path.stat().st_blocks * 512})
        path.unlink()
image = subprocess.run(['docker', 'image', 'inspect', owner + '-runner'], capture_output=True)
image_removed = False
if image.returncode == 0:
    info = json.loads(image.stdout)[0]
    if info['Config']['Labels'].get('clanker.owner') != owner:
        raise RuntimeError('WrongRunnerImageOwner')
    subprocess.run(['docker', 'image', 'rm', owner + '-runner'], check=True, stdout=subprocess.DEVNULL)
    image_removed = True
evidence = {'cleaned': True, 'removed': removed, 'privateRunnerImageRemoved': image_removed,
            'ownedListenersAbsent': [22070, 18444], 'openDiskHandles': [],
            'remainingAllocatedBytes': int(subprocess.check_output(
                ['du', '-sx', '--block-size=1', str(WORK)], text=True).split()[0])}
output = WORK / 'cube-secret-cleanup.json'
output.write_text(json.dumps(evidence, indent=2) + '\n')
output.chmod(0o644)
print(json.dumps(evidence))
