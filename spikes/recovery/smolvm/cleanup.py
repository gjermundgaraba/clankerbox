#!/usr/bin/env python3
"""Exact-plan cleanup of disposable recovery runs/caches. Planning deletes nothing."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import subprocess
import time
import uuid

ROOT = Path('/home/clanker/clankerbox-recovery.AsnzhP/smolvm')
COMMON = ROOT.parent
LABELS = ('portable-01', 'portable-02', 'portable-03', 'portable-04', 'full-01',
          'interrupted-01', 'volatile-final-01')
CACHES = ('source/target', 'source/libkrun/target', 'cargo', 'toolchain',
          'zig-cache', 'zig-local-cache', 'zig-x86_64-linux-0.15.2', 'cmake-4.1.3-linux-x86_64')
GROUPS = (Path('/sys/fs/cgroup/smrec20260906.slice'), Path('/sys/fs/cgroup/cqrec20260906.slice'))
MAX_METADATA = 16 * 1024**2


def need(value, message):
    if not value:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fact(path):
    value = path.lstat()
    need(stat.S_ISDIR(value.st_mode) and value.st_uid == 1000, 'top target must be a clanker-owned real directory')
    return {'device': value.st_dev, 'inode': value.st_ino, 'mode': value.st_mode, 'uid': value.st_uid}


def inventory_processes():
    found = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            exe = (proc / 'exe').resolve(strict=True)
            argv = (proc / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
            scoped_runtime = (exe.name in ('smolvm', 'cocoon', 'firecracker')
                and (exe.is_relative_to(COMMON) or str(COMMON).encode() in b'\0'.join(argv)))
            if exe.is_relative_to(ROOT) or scoped_runtime:
                found.append({'pid': int(proc.name), 'executable': str(exe),
                              'argv': [os.fsdecode(v) for v in argv]})
        except (FileNotFoundError, ProcessLookupError):
            pass
    return found


def safety():
    need(os.geteuid() == 0, 'root observer required')
    need(ROOT.resolve() == ROOT and ROOT.stat().st_uid == 1000, 'exact root path/owner changed')
    auth = json.loads((COMMON / 'authorization.json').read_text())
    need(auth.get('grant') == 'recovery-20260906' and auth.get('smolvm_root') == str(ROOT), 'grant/root changed')
    need(auth.get('execution_authorized_runtime') is None and auth.get('mount_namespace_authorized') is False,
         'global execution and mount gates must be closed')
    need(not any(path.exists() for path in GROUPS), 'runtime cgroup remains')
    need(not inventory_processes(), 'owned runtime/build process remains')
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        mounted = Path(re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), line.split()[4]))
        need(not mounted.is_relative_to(COMMON), 'owned host mount remains')
    return auth


def target_names():
    names = []
    for label in LABELS:
        report = json.loads((ROOT / 'results' / label / 'report.json').read_text())
        need(report['label'] == label and report['runtime'] == 'smolvm'
             and report['cleanup'] and all(row['status'] == 'pass' for row in report['cleanup']),
             'run lacks successful process cleanup: ' + label)
        names += ['artifacts/' + label, 'x/' + hashlib.sha256(label.encode()).hexdigest()[:6]]
    return names + list(CACHES)


def target(relative):
    path = ROOT / relative
    need(path.resolve() == path and path != ROOT and path.is_relative_to(ROOT), 'redirected/broad target')
    return {'path': str(path), 'identity': fact(path),
            'allocated_bytes': int(subprocess.check_output(['du', '-s', '-B1', '--', str(path)], text=True).split()[0])}


def publish(path, value):
    data = json.dumps(value, sort_keys=True, indent=2).encode() + b'\n'
    with path.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return digest(data)


def archive_evidence(targets, output):
    archived = []
    artifacts = []
    for row in targets:
        root = Path(row['path'])
        if root.parent == ROOT / 'x':
            for source in root.rglob('*'):
                rel = str(source.relative_to(root))
                vm_metadata = '/c/smolvm/vms/' in '/' + rel and (source.suffix in ('.json', '.log', '.pid') or source.name == 'name')
                db_metadata = '/d/smolvm/server/' in '/' + rel and source.name.startswith('smolvm.db')
                if not (vm_metadata or db_metadata) or source.is_symlink() or not source.is_file():
                    continue
                fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    info = os.fstat(fd)
                    need(info.st_size <= MAX_METADATA, 'unexpectedly large audit metadata')
                    with os.fdopen(os.dup(fd), 'rb') as stream:
                        data = stream.read(MAX_METADATA + 1)
                    need(len(data) == info.st_size and os.fstat(fd).st_mtime_ns == info.st_mtime_ns,
                         'metadata changed during archival')
                finally:
                    os.close(fd)
                destination = output / 'evidence' / source.relative_to(ROOT)
                destination.parent.mkdir(parents=True, exist_ok=True)
                with destination.open('xb') as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                archived.append({'source': str(source), 'archive': str(destination), 'sha256': digest(data), 'size_bytes': len(data)})
        elif root.parent == ROOT / 'artifacts':
            for source in sorted(root.glob('*.smolcheckpoint')):
                need(not source.is_symlink() and source.is_file(), 'redirected artifact')
                item = {'source': str(source), 'sha256': file_sha(source), 'size_bytes': source.stat().st_size}
                with source.open('rb') as stream:
                    try:
                        stream.seek(-64, 2)
                        footer = stream.read(64)
                        need(footer[:8] == b'SMOLPACK', 'invalid/truncated footer (expected for negative fixture)')
                        offset, size = struct.unpack_from('<QQ', footer, 36)
                        need(0 < size <= MAX_METADATA and offset + size <= item['size_bytes'] - 64, 'manifest range invalid')
                        stream.seek(offset)
                        item['manifest'] = json.loads(stream.read(size))
                    except (OSError, ValueError, RuntimeError) as error:
                        item['manifest_error'] = str(error)
                artifacts.append(item)
    # Make evidence directory publication explicit before a cleanup plan can
    # be approved. No memory blobs or rootfs contents are copied to evidence.
    for directory, _, _ in os.walk(output, topdown=False):
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return archived, artifacts


def plan():
    rows = [target(name) for name in target_names()]
    output = ROOT / 'results' / ('cleanup-' + uuid.uuid4().hex[:8])
    output.mkdir(mode=0o700)
    metadata, artifacts = archive_evidence(rows, output)
    data = {'schema_version': 1, 'kind': 'smolvm-exact-cleanup-v1', 'root': str(ROOT),
            'created_ns': time.time_ns(), 'targets': rows, 'metadata': metadata, 'artifacts': artifacts,
            'target_allocated_bytes': sum(v['allocated_bytes'] for v in rows),
            'preserved': ['results', 'runtime', 'profiles', 'image', 'source (except target directories)',
                          'source.tar', 'libkrun.tar', 'source.patch', 'libkrun.patch',
                          'publication-fsync.patch', 'provenance.json', 'build.json', 'scripts/tests/logs', 'tools', 'tmp']}
    sha = publish(output / 'plan.json', data)
    return {'plan': str(output / 'plan.json'), 'plan_sha256': sha, 'target_allocated_bytes': data['target_allocated_bytes'],
            'target_count': len(rows), 'metadata_count': len(metadata), 'artifact_count': len(artifacts)}


def execute(path, expected_sha):
    auth = safety()
    need(auth.get('smolvm_cleanup_plan_sha256') == expected_sha, 'coordinator has not approved exact plan hash')
    need(path.resolve() == path and path.name == 'plan.json' and path.parent.parent == ROOT / 'results'
         and re.fullmatch(r'cleanup-[0-9a-f]{8}', path.parent.name), 'invalid plan path')
    raw = path.read_bytes()
    need(digest(raw) == expected_sha, 'plan bytes changed')
    data = json.loads(raw)
    need(data['kind'] == 'smolvm-exact-cleanup-v1' and data['root'] == str(ROOT), 'plan scope changed')
    need([row['path'] for row in data['targets']] == [str(ROOT / name) for name in target_names()], 'target allowlist changed')
    need(shutil.rmtree.avoids_symlink_attacks, 'descriptor-safe rmtree unavailable')
    for row in data['targets']:
        need(fact(Path(row['path'])) == row['identity'], 'top target identity changed')
    for row in data['metadata']:
        archived = Path(row['archive'])
        need(archived.resolve() == archived and archived.is_relative_to(path.parent / 'evidence')
             and file_sha(archived) == row['sha256'], 'retained evidence changed')
    journal = path.parent / 'deletion.jsonl'
    need(not journal.exists(), 'deletion already attempted; no implicit retry')
    removed = []
    def event(value):
        with journal.open('a') as stream:
            stream.write(json.dumps({'at_ns': time.monotonic_ns(), **value}) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
    try:
        for row in data['targets']:
            safety()
            target_path = Path(row['path'])
            need(target_path.resolve() == target_path and fact(target_path) == row['identity'], 'target changed before deletion')
            parent = os.open(target_path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                current = os.stat(target_path.name, dir_fd=parent, follow_symlinks=False)
                need(current.st_ino == row['identity']['inode'] and current.st_dev == row['identity']['device']
                     and current.st_uid == 1000, 'descriptor target changed')
                event({'event': 'before-delete', **row})
                shutil.rmtree(target_path.name, dir_fd=parent)
                os.fsync(parent)
            finally:
                os.close(parent)
            removed.append(row['path'])
            event({'event': 'deleted', 'path': row['path']})
        safety()
        result = {'status': 'pass', 'removed': removed, 'plan_sha256': expected_sha,
                  'allocated_bytes_removed_as_planned': data['target_allocated_bytes']}
    except BaseException as error:
        event({'event': 'failure', 'error': repr(error), 'removed': removed})
        publish(path.parent / 'cleanup-result.json', {'status': 'fail', 'error': repr(error), 'removed': removed})
        raise
    publish(path.parent / 'cleanup-result.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--plan', action='store_true')
    action.add_argument('--execute', type=Path)
    parser.add_argument('--plan-sha256')
    args = parser.parse_args()
    auth = safety()
    lock = COMMON / 'execute.lock'
    need(auth.get('lock_path') == str(lock) and lock.resolve() == lock, 'lock redirected')
    with lock.open('r+') as descriptor:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        safety()
        print(json.dumps(plan() if args.plan else execute(args.execute, args.plan_sha256)))
