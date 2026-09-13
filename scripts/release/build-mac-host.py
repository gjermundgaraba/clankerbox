#!/usr/bin/env python3
"""Build the production Mac host with its stable Local Network identity."""

import argparse
import pathlib
import plistlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--identity', required=True, help='Existing Apple signing identity name or SHA-1')
    args = parser.parse_args()
    if not args.version.strip() or args.identity.strip() in ('', '-'):
        parser.error('a version and Apple signing identity are required')
    output = args.output.absolute()
    if output.exists() or output.is_symlink():
        parser.error('refusing to replace output: ' + str(output))
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='cb-sign-', dir='/tmp') as directory:
        staging = pathlib.Path(directory)
        info = plistlib.loads((ROOT / 'scripts/release/inputs/HostInfo.plist').read_bytes())
        info['CFBundleVersion'] = args.version
        plist = staging / 'HostInfo.plist'
        plist.write_bytes(plistlib.dumps(info))
        binary = staging / 'clankerbox-host'
        flags = f"-linkmode external -extldflags '-Wl,-sectcreate,__TEXT,__info_plist,{plist}'"
        subprocess.run(
            ['go', 'build', '-trimpath', '-ldflags', flags, '-o', str(binary), './cmd/clankerbox-host'],
            cwd=ROOT,
            check=True,
        )
        subprocess.run(
            [
                'codesign',
                '--force',
                '--sign',
                args.identity,
                '--identifier',
                'org.clankerbox.host',
                '--options',
                'runtime',
                str(binary),
            ],
            check=True,
        )
        subprocess.run(['codesign', '--verify', '--strict', '-R', '=anchor apple generic', str(binary)], check=True)
        # Exclusive creation prevents replacing an installed executable accidentally.
        with output.open('xb') as destination:
            destination.write(binary.read_bytes())
        output.chmod(0o755)
    subprocess.run(['codesign', '--verify', '--strict', str(output)], check=True)
    subprocess.run(['shasum', '-a', '256', str(output)], check=True)


if __name__ == '__main__':
    main()
