#!/usr/bin/env python3
"""Verify private downloads and release binaries; no VM execution."""
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
from cube_spike import REV, require

ROOT = Path(__file__).resolve().parent
ARCHIVE = ROOT / '.work/cube-sandbox-one-click-v0.7.0-amd64.tar.gz'
CLOUD = ROOT / '.work/noble-server-cloudimg-amd64.img'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify():
    require(digest(ARCHIVE) == 'd4522eb97fe898dd8ea681a7caaadbfd1f331d98df76a7c08e5865d6b7229ba4',
            'Cube bundle checksum mismatch')
    require(digest(CLOUD) == 'd0fe84bb5f80853425fa6be28e2c106f30104c3cfe8611933f2e65c9b63f0e30',
            'Ubuntu cloud image checksum mismatch')
    source = ROOT / '.work/upstream'
    for ref in ('HEAD', 'v0.7.0'):
        require(subprocess.check_output(['git', '-C', str(source), 'rev-parse', ref], text=True).strip() == REV,
                f'Wrong upstream source pin: {ref}')
    manifest = json.loads((ROOT / 'components.lock.json').read_text())
    require(manifest['git_commit'] == REV, 'Release manifest source mismatch')
    files = {}
    package = ROOT / '.work/bundle/cube-sandbox-one-click-v0.7.0-amd64/assets/package/sandbox-package.tar.gz'
    with tarfile.open(package) as tar:
        for member in tar:
            if not member.isfile():
                continue
            name = Path(member.name).name
            expected = manifest['components'].get(name, {}).get('digest_sha256')
            if name == 'cube-guest-image-cpu.img':
                expected = manifest['guest_image']['digest_sha256']
            if name == 'vmlinux-bm':
                expected = manifest['kernel']['vmlinux_digest_sha256']
            if not expected:
                continue
            actual = 'sha256:' + hashlib.file_digest(tar.extractfile(member), 'sha256').hexdigest()
            require(actual == expected, f'Packaged component checksum mismatch: {name}')
            files[name] = {'sha256': actual, 'bytes': member.size}
    require({'cube-runtime', 'containerd-shim-cube-rs', 'vmlinux-bm'} <= files.keys(),
            'Missing required packaged components')
    output = {'scope': 'artifact verification only', 'status': 'pass', 'source': REV,
              'bundle_bytes': ARCHIVE.stat().st_size, 'cloud_image_bytes': CLOUD.stat().st_size,
              'components': files,
              'limitations': ['cube-agent binary is inside its ext4 plane; the release archive hash pins that plane, '
                              'but this check does not extract and independently hash the embedded agent binary.']}
    (ROOT / 'results/artifact-verification.json').write_text(json.dumps(output, indent=2) + '\n')
    return output


if __name__ == '__main__':
    print(json.dumps(verify(), indent=2))
