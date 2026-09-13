#!/usr/bin/env python3
"""Collect notices and a complete inventory from explicit locked source inputs."""
import argparse
import json
import pathlib
import shutil
import subprocess

from bundle import ROOT, inventory, required_file, sha


def copy_notices(source, destination):
    files = []
    for file in sorted([*source.glob('*'), *source.glob('*/*')]):
        if file.is_file() and file.name.upper().startswith(('LICENSE', 'COPYING', 'NOTICE', 'COPYRIGHT')):
            relative = file.relative_to(source)
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, target)
            files.append(relative.as_posix())
    return files


def collect(args):
    engine = args.engine_source.resolve(strict=True)
    pins = json.loads((ROOT/'scripts/release/inputs/source.json').read_text())
    for name, digest in pins['files'].items():
        if sha(required_file(engine, name)) != digest:
            raise ValueError('engine source does not match pinned ' + name)
    metadata = json.loads(args.rust_metadata.read_text())
    if pathlib.Path(metadata['workspace_root']).resolve() != engine:
        raise ValueError('Rust metadata belongs to a different engine source')
    subprocess.run(['go', 'mod', 'download', 'all'], cwd=ROOT, check=True)
    args.output.mkdir(parents=True, exist_ok=False)
    rows = []
    for package in metadata['packages']:
        key = package['name'] + '-' + package['version']
        source = pathlib.Path(package['manifest_path']).parent
        target = args.output/'rust'/key
        notices = copy_notices(source, target)
        if not notices and source.is_relative_to(engine):
            target.mkdir(parents=True, exist_ok=True)
            shutil.copy2(engine/'LICENSE', target/'LICENSE')
            notices = ['LICENSE']
        if package.get('license_file'):
            declared = source/package['license_file']
            if declared.is_file():
                target.mkdir(parents=True, exist_ok=True)
                shutil.copy2(declared, target/'DECLARED-LICENSE')
                notices.append('DECLARED-LICENSE')
        row = {'ecosystem': 'rust', 'name': package['name'], 'version': package['version'],
               'source': package.get('source'), 'license': package.get('license'), 'notices': notices}
        if not notices:
            if not row['license']:
                raise ValueError('dependency has neither license declaration nor notices: ' + key)
            row['notice_status'] = 'upstream-no-notice-file'
        rows.append(row)
    raw = subprocess.check_output(['go', 'list', '-m', '-json', 'all'], cwd=ROOT, text=True)
    decoder = json.JSONDecoder()
    while raw.strip():
        value, end = decoder.raw_decode(raw.lstrip())
        raw = raw.lstrip()[end:]
        if value.get('Main'):
            continue
        source = pathlib.Path(value['Dir'])
        key = value['Path'].replace('/', '_') + '@' + value['Version']
        notices = copy_notices(source, args.output/'go'/key)
        if not notices:
            raise ValueError('Go dependency lacks notices: ' + value['Path'])
        rows.append({'ecosystem': 'go', 'name': value['Path'], 'version': value['Version'], 'notices': notices})
    (args.output/'dependencies.json').write_text(json.dumps(rows, indent=2)+'\n')
    provenance = {'go_mod_sha256': sha(ROOT/'go.mod'), 'go_sum_sha256': sha(ROOT/'go.sum'),
                  'rust_lock_sha256': sha(engine/'Cargo.lock'), 'rust_metadata_sha256': sha(args.rust_metadata)}
    (args.output/'provenance.json').write_text(json.dumps(provenance, indent=2)+'\n')
    (args.output/'inventory.json').write_text(json.dumps(inventory(args.output, include_root=False), indent=2)+'\n')
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rust-metadata', type=pathlib.Path, required=True)
    parser.add_argument('--engine-source', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    rows = collect(parser.parse_args())
    print(json.dumps({'packages': len(rows), 'upstream_without_notice_files': [r['name'] for r in rows if not r['notices']]}))


if __name__ == '__main__':
    main()
