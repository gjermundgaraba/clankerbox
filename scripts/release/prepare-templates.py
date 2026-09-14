#!/usr/bin/env python3
"""Reproduce qualified compact ext4 templates using build-host tools only."""

import argparse
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile

from bundle import ROOT, RUNTIME_TEMPLATES, required_file, sha


def platform_pins(platform):
    inputs = ROOT / 'scripts/release/inputs'
    provenance = json.loads((inputs / 'template-provenance.json').read_text())
    rows = [row for row in provenance['templates'] if row['platform'] == platform]
    if len(rows) != len(RUNTIME_TEMPLATES) or {row['file'] for row in rows} != set(RUNTIME_TEMPLATES):
        raise ValueError('expected exactly the two qualified template pins')
    artifacts = json.loads((inputs / 'runtime-artifacts.json').read_text())['platforms'][platform]['files']
    for row in rows:
        artifact = next(item for item in artifacts if item['path'] == row['file'])
        if artifact['type'] != 'file' or artifact['sha256'] != row['sha256']:
            raise ValueError('template provenance differs from enforced runtime inventory')
    return rows


def verify_hash(path, expected, label):
    if sha(path) != expected:
        raise ValueError(label + ' checksum mismatch: ' + path.name)


def filesystem_size(superblock):
    if len(superblock) != 1024 or struct.unpack_from('<H', superblock, 56)[0] != 0xEF53:
        raise ValueError('invalid ext4 superblock')
    log_block_size = struct.unpack_from('<I', superblock, 24)[0]
    if log_block_size > 6:
        raise ValueError('invalid ext4 block size')
    blocks = struct.unpack_from('<I', superblock, 4)[0]
    if struct.unpack_from('<I', superblock, 96)[0] & 0x80:
        blocks += struct.unpack_from('<I', superblock, 336)[0] << 32
    if blocks == 0:
        raise ValueError('empty ext4 filesystem')
    return blocks * (1024 << log_block_size)


def compact(raw, pin):
    if raw.stat().st_size != pin['input_logical_size']:
        raise ValueError('decompressed template length differs from pin')
    with raw.open('r+b') as disk:
        disk.seek(1024)
        size = filesystem_size(disk.read(1024))
        if size != pin['filesystem_bytes'] or not 2048 <= size <= raw.stat().st_size:
            raise ValueError('ext4 boundary differs from pin or exceeds input')
        disk.seek(size)
        while data := disk.read(8 * 1024 * 1024):
            if data.strip(b'\0'):
                raise ValueError('nonzero data outside ext4 boundary')
        disk.truncate(size)
    verify_hash(raw, pin['raw_sha256'], 'filesystem')


def prepare(source, output, pins, zstd='zstd', e2fsck='e2fsck'):
    # Never modify source templates, existing outputs or runtime installations.
    if output.exists() or output.is_symlink():
        raise FileExistsError('refusing to replace output: ' + str(output))
    for pin in pins:
        required_file(source, pin['file'])
    with tempfile.TemporaryDirectory(prefix='.prepare-templates-', dir=output.parent) as directory:
        scratch = Path(directory)
        payload = scratch / 'payload'
        payload.mkdir()
        for pin in pins:
            name = pin['file']
            compressed = scratch / name
            # Verify the private copy that is actually consumed, not a separate
            # read of a potentially changing input. No tools run on unchecked bytes.
            shutil.copyfile(source / name, compressed)
            verify_hash(compressed, pin['input_sha256'], 'input')
            raw = scratch / name.removesuffix('.zst')
            subprocess.run([zstd, '-dq', '--sparse', str(compressed), '-o', str(raw)], check=True)
            compact(raw, pin)
            # Nonzero status (including repaired errors) fails; never repair.
            subprocess.run([e2fsck, '-fn', str(raw)], check=True)
            verify_hash(raw, pin['raw_sha256'], 'filesystem after fsck')
            target = payload / name
            subprocess.run([zstd, '-19', '-T1', '-q', str(raw), '-o', str(target)], check=True)
            verify_hash(target, pin['sha256'], 'qualified output')
            target.chmod(0o644)
            raw.unlink()
            compressed.unlink()
        # Publish only after every template passes. mkdir refuses existing paths
        # even if another process created one while preparation was running.
        output.mkdir(mode=0o755)
        try:
            for pin in pins:
                os.rename(payload / pin['file'], output / pin['file'])
        except BaseException:
            shutil.rmtree(output)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', choices=['darwin-arm64', 'linux-amd64'], required=True)
    parser.add_argument('--input', type=Path, required=True, help='Original qualified compressed template directory')
    parser.add_argument('--output', type=Path, required=True, help='New directory; parent must already exist')
    parser.add_argument('--zstd', default='zstd', help='Build-host zstd executable (name or path)')
    parser.add_argument('--e2fsck', default='e2fsck', help='Build-host e2fsck executable (name or path)')
    args = parser.parse_args()
    pins = platform_pins(args.platform)
    prepare(args.input, args.output, pins, args.zstd, args.e2fsck)
    print(json.dumps({'platform': args.platform, 'output': str(args.output), 'verified': [p['file'] for p in pins]}))


if __name__ == '__main__':
    main()
