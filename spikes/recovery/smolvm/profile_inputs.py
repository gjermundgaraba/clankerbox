#!/usr/bin/env python3
"""Prepare and verify an explicit bare Ubuntu portable-checkpoint profile."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat

ROOT = Path('/home/clanker/clankerbox-recovery.AsnzhP/smolvm')
PROFILE = ROOT / 'profiles/ubuntu-bare'
UBUNTU_SHA = '0a64e8ef15c93ff146f10729750955a4b4a1938293260cbf983d99b5466c99ed'


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def inventory(root):
    entries = []
    for path in sorted(root.rglob('*')):
        metadata = path.lstat()
        entry = {'path': str(path.relative_to(root)), 'mode': stat.S_IMODE(metadata.st_mode)}
        if stat.S_ISLNK(metadata.st_mode):
            entry.update(type='symlink', target=os.readlink(path))
        elif stat.S_ISREG(metadata.st_mode):
            entry.update(type='file', size_bytes=metadata.st_size, sha256=sha(path))
        elif stat.S_ISDIR(metadata.st_mode):
            entry.update(type='directory')
        else:
            raise RuntimeError('unexpected profile file type: ' + str(path))
        entries.append(entry)
    return entries


def tree_sha(entries):
    return hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def verify():
    manifest_path = PROFILE / 'profile.json'
    manifest = json.loads(manifest_path.read_text())
    if manifest['id'] != 'ubuntu-bare-v1' or manifest['ubuntu_source_sha256'] != UBUNTU_SHA:
        raise RuntimeError('unexpected Ubuntu bare profile identity')
    actual = inventory(PROFILE / 'agent-rootfs')
    if actual != manifest['entries'] or tree_sha(actual) != manifest['tree_sha256']:
        raise RuntimeError('Ubuntu bare profile contents changed')
    build = json.loads((ROOT / 'build.json').read_text())
    if manifest['matching_build'] != build:
        raise RuntimeError('Ubuntu bare profile build no longer matches')
    return {key: value for key, value in manifest.items() if key != 'entries'} | {
        'manifest_path': str(manifest_path), 'manifest_sha256': sha(manifest_path), 'entry_count': len(actual)}


def prepare():
    if ROOT.resolve() != ROOT or ROOT.stat().st_uid != os.getuid() or os.geteuid() == 0:
        raise RuntimeError('exact private root and clanker required')
    os.sched_setaffinity(0, set(range(4)))
    prepared = json.loads((ROOT / 'prepared.json').read_text())
    if prepared['rootfs_sha256'] != UBUNTU_SHA:
        raise RuntimeError('Ubuntu source pin mismatch')
    PROFILE.mkdir(parents=True, exist_ok=False)
    rootfs = PROFILE / 'agent-rootfs'
    shutil.copytree(ROOT / 'image', rootfs, symlinks=True)
    agent = ROOT / 'runtime/agent-rootfs/usr/local/bin/smolvm-agent'
    (rootfs / 'usr/local/bin').mkdir(parents=True, exist_ok=True)
    shutil.copy2(agent, rootfs / 'usr/local/bin/smolvm-agent')
    # Only this new profile's init entry is replaced. The retained agent
    # rootfs, source Ubuntu image and original build manifest are unchanged.
    init = rootfs / 'sbin/init'
    if not init.parent.resolve().is_relative_to(rootfs):
        raise RuntimeError('Ubuntu sbin parent escapes new profile')
    if init.exists() or init.is_symlink():
        init.unlink()
    init.symlink_to('/usr/local/bin/smolvm-agent')
    auxiliaries = []
    for relative in ('usr/bin/crun', 'usr/local/bin/crun', 'usr/local/bin/crane'):
        source = ROOT / 'runtime/agent-rootfs' / relative
        if source.is_file():
            target = rootfs / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            auxiliaries.append({'path': relative, 'sha256': sha(target)})
    build = json.loads((ROOT / 'build.json').read_text())
    if sha(rootfs / 'usr/local/bin/smolvm-agent') != build['hashes']['runtime/agent-rootfs/usr/local/bin/smolvm-agent']:
        raise RuntimeError('matching agent hash differs')
    entries = inventory(rootfs)
    manifest = {'schema_version': 1, 'id': 'ubuntu-bare-v1', 'ubuntu_source_sha256': UBUNTU_SHA,
        'mode': 'bare VM, no --image, bundled Ubuntu agent rootfs with writable native VM disk overlay',
        'matching_build': build, 'agent_sha256': sha(rootfs / 'usr/local/bin/smolvm-agent'),
        'guest_sha256': sha(rootfs / 'opt/recovery/latency-guest'),
        'probe_sha256': sha(rootfs / 'opt/recovery/disk_probe.py'), 'auxiliaries': auxiliaries,
        'tree_sha256': tree_sha(entries), 'entries': entries}
    (PROFILE / 'profile.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(verify()), flush=True)


if __name__ == '__main__':
    prepare()
