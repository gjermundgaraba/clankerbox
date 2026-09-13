#!/usr/bin/env python3
"""Validate frozen package locks, optionally against qualified image exports."""
import argparse
import hashlib
import json
from pathlib import Path


def inventory(data):
    rows = [line.split('\t') for line in data.splitlines()]
    assert all(len(row) == 3 for row in rows), 'invalid inventory row'
    result = {name: (version, arch) for name, version, arch in rows}
    assert len(result) == len(rows), 'duplicate package'
    return result


def paragraphs(path):
    for block in path.read_text().split('\n\n'):
        fields = {}
        for line in block.splitlines():
            if line and not line[0].isspace() and ': ' in line:
                key, value = line.split(': ', 1)
                fields[key] = value
        if fields:
            yield fields


def installed(image):
    result = {}
    for fields in paragraphs(image / 'var/lib/dpkg/status'):
        if fields.get('Status') != 'install ok installed':
            continue
        name = fields['Package']
        if fields.get('Multi-Arch') == 'same':
            name += ':' + fields['Architecture']
        result[name] = (fields['Version'], fields['Architecture'])
    return result


def automatic(image, final):
    result = []
    for fields in paragraphs(image / 'var/lib/apt/extended_states'):
        if fields.get('Auto-Installed') != '1':
            continue
        candidates = [name for name, (_, arch) in final.items()
                      if name.split(':')[0] == fields['Package']
                      and arch in (fields['Architecture'], 'all')]
        assert len(candidates) == 1, fields
        result += candidates
    return sorted(result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', action='append', default=[], metavar='ARCH=PATH')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent / 'package-locks'
    metadata = json.loads((root / 'sources.json').read_text())
    assert metadata['format'] == 1
    finals = {}
    for arch, pin in metadata['architectures'].items():
        directory = root / arch
        for name, digest in pin['files'].items():
            assert hashlib.sha256((directory / name).read_bytes()).hexdigest() == digest, (arch, name)
        base = inventory((directory / 'base.tsv').read_text())
        final = inventory((directory / 'packages.tsv').read_text())
        delta = inventory((directory / 'install.tsv').read_text())
        assert base.keys() <= final.keys(), 'unexpected base removal'
        assert delta == {name: value for name, value in final.items() if base.get(name) != value}
        assert (len(base), len(final), len(delta)) == (pin['base_count'], pin['package_count'], pin['install_count'])
        assert all(value[1] in (arch, 'all') for value in final.values())
        assert set(metadata['requested']) <= final.keys()
        auto = (directory / 'automatic.txt').read_text().splitlines()
        assert auto == sorted(set(auto)) and set(auto) <= final.keys()
        assert not set(metadata['requested']) & set(auto)
        finals[arch] = final
        print(f'{arch}: base={len(base)}, final={len(final)}, exact installation constraints={len(delta)}')
    for argument in args.image:
        arch, value = argument.split('=', 1)
        image = Path(value)
        pin = metadata['architectures'][arch]
        source = json.loads((image / '.clankerbox-image/sources.json').read_text())
        assert source['arch'] == arch and source['ubuntu'] == pin['ubuntu']
        assert source['archives']['ubuntu'] == pin['ubuntu_sha256']
        assert (image / '.clankerbox-image/packages.tsv').read_bytes() == (root / arch / 'packages.tsv').read_bytes()
        assert installed(image) == finals[arch], 'dpkg status differs from lock'
        assert automatic(image, finals[arch]) == (root / arch / 'automatic.txt').read_text().splitlines()
        print(f'{arch}: qualified image metadata, installed status, and automatic flags match')


if __name__ == '__main__':
    main()
