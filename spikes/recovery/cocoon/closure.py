#!/usr/bin/env python3
"""Versioned, integrity-checked fixed-layout Cocoon recovery closure.

This does not rewrite Firecracker vmstate or claim arbitrary-path portability.
The separately pinned manifest is the trust anchor; no VMM is started here.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tarfile

FORMAT = 'cocoon-fixed-layout-closure-v1'
MAX_BYTES = 50 * 1024**3
MEMORY_BYTES = 2 * 1024**3
REQUIRED = {'snapshot.json', 'cocoon.json', 'mem', 'vmstate', 'cow.raw'}


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def relative(value):
    require(isinstance(value, str) and value and '\\' not in value, 'invalid member path')
    path = PurePosixPath(value)
    require(not path.is_absolute() and '..' not in path.parts and '.' not in path.parts,
            'unsafe member path: '+value)
    require(str(path) == value, 'noncanonical member path: '+value)
    return path


def regular(path):
    path = Path(path)
    require(path.resolve(strict=True) == path and stat.S_ISREG(path.lstat().st_mode),
            'regular nonsymlink file required: '+str(path))
    return path.stat()


def files(root):
    root = Path(root)
    found = set()
    for directory, names, members in os.walk(root, followlinks=False):
        for name in names:
            require(not (Path(directory)/name).is_symlink(), 'symlink directory in closure')
        for name in members:
            path = Path(directory)/name
            regular(path)
            found.add(path.relative_to(root).as_posix())
    return found


def sync_dir(path):
    descriptor=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def copy_file(source, target):
    """Independent inode and actual copy; preserve holes, never use reflinks."""
    before = regular(source)
    require(target.is_absolute() and target.resolve()==target, 'copy target has redirected parent')
    require(not target.exists() and not target.is_symlink(), 'copy target already exists')
    new_parents=[]; ancestor=target.parent
    while not ancestor.exists():
        new_parents.append(ancestor); ancestor=ancestor.parent
    target.parent.mkdir(parents=True, exist_ok=True)
    expected = digest(source)
    subprocess.run(['cp', '--sparse=always', '--reflink=never', '--', str(source), str(target)], check=True)
    copied = regular(target)
    require((before.st_dev, before.st_ino) != (copied.st_dev, copied.st_ino), 'copy shares original inode')
    actual = digest(target)
    require(before.st_size == copied.st_size and expected == actual and digest(source) == expected,
            'copy integrity or concurrent source mutation')
    with target.open('rb') as stream:
        os.fsync(stream.fileno())
    for directory in dict.fromkeys([target.parent,*new_parents,ancestor]):
        sync_dir(directory)
    return {'size_bytes': copied.st_size, 'sha256': actual,
            'source_sha256': expected, 'copied_sha256': actual,
            'copied_size_bytes': copied.st_size,
            'source_device': before.st_dev, 'source_inode': before.st_ino,
            'copied_device': copied.st_dev, 'copied_inode': copied.st_ino,
            'copy_method': 'cp --sparse=always --reflink=never'}


def snapshot_metadata(snapshot, original_root):
    envelope = json.loads((snapshot/'snapshot.json').read_text())
    sidecar = json.loads((snapshot/'cocoon.json').read_text())
    require(envelope.get('version') == 1, 'unsupported native snapshot envelope')
    config = envelope.get('config', {})
    require(config.get('hypervisor') == 'firecracker' and config.get('nics', 0) == 0,
            'closure only supports no-NIC Firecracker')
    require(config.get('cpu') == 2 and config.get('memory') == MEMORY_BYTES,
            'closure only supports granted 2-GiB/2-vCPU snapshot')
    storage = sidecar.get('storage_configs')
    require(isinstance(storage, list) and storage, 'missing storage configuration')
    dependencies = {}
    cow = []
    for item in storage:
        require(isinstance(item, dict), 'invalid storage entry')
        path = Path(item.get('path', ''))
        require(path.is_absolute() and path.is_relative_to(original_root), 'storage path escapes fixed-layout root')
        if item.get('role') == 'cow':
            require(item.get('ro') is False and path.name == 'cow.raw', 'unsupported writable disk')
            cow.append(path)
        else:
            require(item.get('role') == 'layer' and item.get('ro') is True, 'unsupported disk role')
            dependencies[str(path)] = 'readonly-layer'
    require(len(cow) == 1, 'exactly one snapshot-resident COW disk required')
    boot = sidecar.get('boot_config', {})
    require(boot.get('kernel_path') and boot.get('initrd_path'), 'missing boot dependency')
    require(not boot.get('firmware_path'), 'firmware closure is not supported')
    for key in ('kernel_path', 'initrd_path'):
        path = Path(boot[key])
        require(path.is_absolute() and path.is_relative_to(original_root), 'boot path escapes fixed-layout root')
        dependencies[str(path)] = 'boot-'+key
    return envelope, sidecar, dependencies


def create(snapshot, original_root, target, runtime_pins):
    snapshot, original_root, target = map(Path, (snapshot, original_root, target))
    require(all(p.is_absolute() and p.resolve()==p for p in (snapshot, original_root, target)), 'exact nonsymlink source and destination roots required')
    require(original_root.is_dir(), 'source layout root missing')
    require(not target.exists(), 'refuse preexisting closure')
    members = files(snapshot)
    require(REQUIRED <= members and all('/' not in name for name in members), 'incomplete or nested native export')
    envelope, sidecar, dependencies = snapshot_metadata(snapshot, original_root)
    require((snapshot/'mem').stat().st_size == envelope['config']['memory'], 'memory image size mismatch')
    require((snapshot/'vmstate').stat().st_size > 0, 'empty VM state')
    require(isinstance(runtime_pins,dict) and {'cocoon','firecracker'} <= {Path(p).name for p in runtime_pins},
            'both runtime binary pins are required')
    for path, expected in runtime_pins.items():
        path = Path(path)
        require(path.is_absolute() and path.is_relative_to(original_root), 'runtime pin outside source root')
        regular(path)
        require(digest(path) == expected, 'runtime pin differs: '+str(path))
        dependencies[str(path)] = 'runtime-pin'
    # FC boot validation may derive vmlinux from vmlinuz. Carry the existing
    # validated conversion too, keeping reconstruction independent of tools.
    kernel = Path(sidecar['boot_config']['kernel_path'])
    vmlinux = kernel.with_name('vmlinux')
    if vmlinux.exists():
        dependencies[str(vmlinux)] = 'boot-vmlinux'
    all_sources = [(snapshot/name, 'snapshot/'+name, 'snapshot') for name in sorted(members)]
    all_sources += [(Path(name), 'tree/'+Path(name).relative_to(original_root).as_posix(), role)
                    for name, role in sorted(dependencies.items())]
    require(sum(regular(source).st_size for source, _, _ in all_sources) <= MAX_BYTES, 'closure logical byte budget exceeded')
    target.mkdir(mode=0o700)
    manifest = {'schema_version':1, 'format':FORMAT, 'original_root':str(original_root),
                'scope':'fixed absolute layout; unmodified native Firecracker state',
                'runtime_pins':{str(p):v for p,v in runtime_pins.items()}, 'files':[]}
    for source, member, role in all_sources:
        record = copy_file(source, target/member)
        record.update(member=member, role=role, source_path=str(source))
        manifest['files'].append(record)
    path = target/'closure.json'
    path.write_text(json.dumps(manifest, sort_keys=True, indent=2)+'\n')
    with path.open('rb') as stream:
        os.fsync(stream.fileno())
    sync_dir(target); sync_dir(target.parent)
    return {'manifest_sha256':digest(path), 'manifest':manifest}


def verify(root, expected_manifest_sha256):
    root = Path(root)
    require(root.resolve() == root and root.is_dir(), 'closure root must be an exact nonsymlink directory')
    regular(root/'closure.json')
    require(digest(root/'closure.json') == expected_manifest_sha256, 'closure manifest hash mismatch')
    manifest=json.loads((root/'closure.json').read_text())
    require(manifest.get('schema_version')==1 and manifest.get('format')==FORMAT, 'unsupported closure schema')
    original=Path(manifest.get('original_root',''))
    require(original.is_absolute(), 'invalid original layout root')
    entries=manifest.get('files')
    require(isinstance(entries,list) and entries, 'manifest inventory missing')
    expected=set()
    total=0
    for row in entries:
        member=str(relative(row['member']))
        require(member.startswith(('snapshot/','tree/')) and member not in expected, 'invalid or duplicate closure member')
        expected.add(member)
        size=regular(root/member).st_size
        require(type(row['size_bytes']) is int and size==row['size_bytes'], 'closure size mismatch: '+member)
        total+=size
        require(total<=MAX_BYTES, 'closure size budget exceeded')
        require(digest(root/member)==row['sha256'], 'closure file hash mismatch: '+member)
    require(files(root)==expected|{'closure.json'}, 'missing or unlisted closure files')
    require({'snapshot/'+name for name in REQUIRED} <= expected, 'required snapshot member absent')
    envelope,sidecar,deps=snapshot_metadata(root/'snapshot',original)
    require((root/'snapshot/mem').stat().st_size==envelope['config']['memory'], 'memory image geometry differs')
    for source in deps:
        require('tree/'+Path(source).relative_to(original).as_posix() in expected, 'missing readonly dependency')
    runtime_pins=manifest.get('runtime_pins',{})
    require(isinstance(runtime_pins,dict) and {'cocoon','firecracker'} <= {Path(p).name for p in runtime_pins},
            'runtime binary pins missing')
    for source,pin in runtime_pins.items():
        path=Path(source)
        require(path.is_absolute() and path.is_relative_to(original), 'runtime pin escapes layout')
        require(digest(root/'tree'/path.relative_to(original))==pin, 'runtime binary pin mismatch')
    return manifest


def materialize(root, expected_manifest_sha256, destination):
    root, destination=Path(root),Path(destination)
    manifest=verify(root,expected_manifest_sha256)  # Before any destination mutation.
    require(not destination.exists() and destination.resolve()==destination, 'refuse existing or redirected destination')
    destination.mkdir(mode=0o700)
    copies=[]
    for row in manifest['files']:
        copies.append(dict(member=row['member'], **copy_file(root/row['member'],destination/row['member'])))
    shutil.copyfile(root/'closure.json',destination/'closure.json')
    with (destination/'closure.json').open('rb') as stream: os.fsync(stream.fileno())
    sync_dir(destination); sync_dir(destination.parent)
    verify(destination,expected_manifest_sha256)
    return copies


def verify_gzip(path):
    """Read through real gzip EOF; tar end blocks alone do not validate CRC."""
    with gzip.open(path,'rb') as stream:
        while stream.read(1024*1024):
            pass
    return {'gzip_crc':'pass','sha256':digest(path)}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='operation',required=True)
    p=sub.add_parser('create'); p.add_argument('--snapshot',required=True); p.add_argument('--original-root',required=True)
    p.add_argument('--output',required=True); p.add_argument('--runtime-pins',required=True)
    for name in ('verify','materialize'):
        p=sub.add_parser(name); p.add_argument('--closure',required=True); p.add_argument('--manifest-sha256',required=True)
        if name=='materialize': p.add_argument('--output',required=True)
    p=sub.add_parser('verify-gzip'); p.add_argument('path')
    args=parser.parse_args()
    if args.operation=='create':
        result=create(args.snapshot,args.original_root,args.output,json.loads(Path(args.runtime_pins).read_text()))
    elif args.operation=='verify': result=verify(Path(args.closure),args.manifest_sha256)
    elif args.operation=='materialize': result=materialize(Path(args.closure),args.manifest_sha256,Path(args.output))
    else: result=verify_gzip(Path(args.path))
    print(json.dumps(result,sort_keys=True))


if __name__=='__main__': main()
