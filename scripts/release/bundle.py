#!/usr/bin/env python3
"""Build an immutable installed runtime bundle; no toolchains run on end users' hosts.

Engine binaries must already be built from scripts/release/inputs/pins.json
and runtime.patch. The image is the exported generic recipe output. This
assembler hashes every payload file and link and refuses to replace an output.
"""

import argparse, hashlib, json, os, pathlib, shutil, stat, subprocess, tarfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
RUNTIME_TEMPLATES = ('storage-template.ext4.zst', 'overlay-template.ext4.zst')


def sha(path):
    h = hashlib.sha256()
    if path.is_symlink():
        h.update(os.readlink(path).encode())
    else:
        with path.open('rb') as source:
            for block in iter(lambda: source.read(1 << 20), b''):
                h.update(block)
    return h.hexdigest()


def entry(path, name):
    info = path.lstat()
    record = {'path': name, 'mode': stat.S_IMODE(info.st_mode)}
    if stat.S_ISLNK(info.st_mode):
        record.update(type='symlink', mode=0o777, sha256=sha(path))
    elif stat.S_ISDIR(info.st_mode):
        record['type'] = 'directory'
    elif stat.S_ISREG(info.st_mode):
        record.update(type='file', sha256=sha(path))
    else:
        raise ValueError('unsupported payload type: ' + str(path))
    if record['mode'] & 0o6000:
        raise ValueError('setuid/setgid payload: ' + str(path))
    return record


def inventory(root, include_root=True):
    paths = ([root] if include_root else []) + sorted(root.rglob('*'), key=lambda p: p.relative_to(root).as_posix())
    return [entry(p, p.relative_to(root).as_posix()) for p in paths]


def canonical_json(value):
    return (
        json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
        .replace('\u2028', '\\u2028')
        .replace('\u2029', '\\u2029')
    )


def content_digest(files):
    return hashlib.sha256(canonical_json(files).encode()).hexdigest()


def verify_inputs(args):
    pins = json.loads((ROOT / 'scripts/release/inputs/pins.json').read_text())
    expected_engine = pins['hashes']['target/release/smolvm'] if args.os == 'darwin' else pins['linux_cli_sha256']
    if sha(args.engine) != expected_engine:
        raise ValueError('engine does not match qualified platform binary')
    if sha(ROOT / 'scripts/release/inputs/runtime.patch') != pins['runtime_patch_sha256']:
        raise ValueError('runtime patch does not match qualification')
    expected_agent = (
        pins['hashes']['agent-target/aarch64-unknown-linux-musl/release/smolvm-agent']
        if args.arch == 'arm64'
        else json.loads((ROOT / 'scripts/release/inputs/linux-amd64-image-sources.json').read_text())['agent_sha256']
    )
    if sha(args.image / 'usr/local/bin/smolvm-agent') != expected_agent:
        raise ValueError('image agent does not match qualified platform binary')
    if stat.S_IMODE(args.image.stat().st_mode) != 0o755:
        raise ValueError('image root must preserve guest mode 0755')
    verify_runtime_assets(args.runtime_assets, args.os, args.arch)


def verify_runtime_assets(root, os_name, arch):
    pins = json.loads((ROOT / 'scripts/release/inputs/runtime-artifacts.json').read_text())
    expected = pins['platforms'][os_name + '-' + arch]['files']
    # Only these inputs are shipped. In particular, inventory the complete library
    # tree so an added loader dependency cannot be blessed by the output manifest.
    paths = [root / 'lib', *sorted((root / 'lib').rglob('*')), *(root / name for name in RUNTIME_TEMPLATES)]
    actual = []
    for path in paths:
        if not path.exists() and not path.is_symlink():
            raise ValueError('missing qualified runtime artifact: ' + str(path))
        record = entry(path, path.relative_to(root).as_posix())
        # Ordinary modes vary with extraction umask; entry still rejects setid
        # bits. The installed manifest binds the resulting POSIX modes.
        del record['mode']
        actual.append(record)
    actual.sort(key=lambda record: record['path'])
    if actual != expected:
        raise ValueError('runtime artifacts do not match qualified platform inventory')


def required_file(root, name):
    path = root / name
    if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
        raise ValueError('required regular nonempty file: ' + str(path))
    return path


def verify_licenses(engine_source, notices):
    source = json.loads((ROOT / 'scripts/release/inputs/source.json').read_text())
    for name, expected in source['files'].items():
        if sha(required_file(engine_source, name)) != expected:
            raise ValueError('engine source license/provenance mismatch: ' + name)
    native = ROOT / 'scripts/release/licenses'
    for item in json.loads(required_file(native, 'sources.json').read_text()):
        if sha(required_file(native, item['file'])) != item['sha256']:
            raise ValueError('native notice checksum mismatch: ' + item['file'])
    provenance = json.loads(required_file(notices, 'provenance.json').read_text())
    expected = {
        'go_mod_sha256': sha(ROOT / 'go.mod'),
        'go_sum_sha256': sha(ROOT / 'go.sum'),
        'rust_lock_sha256': source['files']['Cargo.lock'],
    }
    for key, value in expected.items():
        if provenance.get(key) != value:
            raise ValueError('dependency notice provenance mismatch: ' + key)
    rows = json.loads(required_file(notices, 'dependencies.json').read_text())
    if not rows or {row['ecosystem'] for row in rows} != {'go', 'rust'}:
        raise ValueError('dependency inventory must enumerate Go and Rust packages')
    for row in rows:
        if not row.get('name') or not row.get('version'):
            raise ValueError('dependency inventory lacks package identity')
        if row['ecosystem'] == 'go':
            key = row['name'].replace('/', '_') + '@' + row['version']
        else:
            key = row['name'] + '-' + row['version']
        if pathlib.PurePosixPath(key).name != key or key in ('.', '..'):
            raise ValueError('unsafe dependency package path')
        if not row.get('notices') and not (
            row.get('license') and row.get('notice_status') == 'upstream-no-notice-file'
        ):
            raise ValueError('unexplained missing dependency notice: ' + row['name'])
        for name in row['notices']:
            path = pathlib.PurePosixPath(name)
            if path.is_absolute() or '..' in path.parts:
                raise ValueError('unsafe dependency notice path')
            required_file(notices / row['ecosystem'] / key, name)
    declared = json.loads(required_file(notices, 'inventory.json').read_text())
    actual = [item for item in inventory(notices, include_root=False) if item['path'] != 'inventory.json']
    if declared != actual or any(item['type'] not in ('file', 'directory') for item in actual):
        raise ValueError('dependency notice inventory mismatch')
    return source


def verify_release_licenses(out):
    licenses = out / 'licenses'
    provenance = json.loads(required_file(licenses, 'source.json').read_text())
    if sha(required_file(licenses, 'smolvm-LICENSE')) != provenance['files']['LICENSE']:
        raise ValueError('release engine license checksum mismatch')
    for name in ['dependencies.json', 'provenance.json', 'inventory.json']:
        required_file(licenses / 'dependencies', name)
    notices = licenses / 'dependencies'
    actual = [item for item in inventory(notices, include_root=False) if item['path'] != 'inventory.json']
    if json.loads((notices / 'inventory.json').read_text()) != actual:
        raise ValueError('release dependency notice inventory mismatch')
    for item in json.loads(required_file(licenses / 'native', 'sources.json').read_text()):
        if sha(required_file(licenses / 'native', item['file'])) != item['sha256']:
            raise ValueError('release native notice mismatch: ' + item['file'])


def package_archive(out):
    archive = out.with_name(out.name + '.tar.gz')
    if archive.exists():
        raise FileExistsError('refusing to replace archive: ' + str(archive))
    with tarfile.open(archive, 'w:gz', format=tarfile.GNU_FORMAT, dereference=False, compresslevel=3) as tar:

        def normalize(info):
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            info.mtime = 0
            # GNU headers preserve literal Unicode link bytes on Apple tar
            # without PAX hdrcharset warnings on GNU tar.
            return info

        for path in sorted(out.iterdir()):
            tar.add(path, arcname=path.name, filter=normalize)
    checksum = sha(archive)
    archive.with_suffix(archive.suffix + '.sha256').write_text(checksum + '  ' + archive.name + '\n')
    return archive, checksum


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--os', choices=['darwin', 'linux'], required=True)
    parser.add_argument('--arch', choices=['arm64', 'amd64'], required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--no-archive', action='store_true', help='Build a local qualification candidate only')
    parser.add_argument('--engine', type=pathlib.Path, required=True)
    parser.add_argument('--runtime-assets', type=pathlib.Path, required=True)
    parser.add_argument('--image', type=pathlib.Path, required=True)
    parser.add_argument(
        '--engine-source',
        type=pathlib.Path,
        required=True,
        help='Pinned smolvm source containing LICENSE and Cargo.lock',
    )
    parser.add_argument(
        '--dependency-notices',
        type=pathlib.Path,
        required=True,
        help='Complete notices.py output with provenance and inventory',
    )
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    if (args.os, args.arch) not in [('darwin', 'arm64'), ('linux', 'amd64')]:
        parser.error('unqualified platform')
    verify_inputs(args)
    source_provenance = verify_licenses(args.engine_source, args.dependency_notices)
    # The private extraction parent protects the bundle; payload modes are reproducible.
    os.umask(0o022)
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    binaries = out / 'bin'
    binaries.mkdir()
    env = os.environ | {'GOOS': args.os, 'GOARCH': args.arch, 'CGO_ENABLED': '0'}
    subprocess.run(
        ['go', 'build', '-trimpath', '-o', str(out / 'clankerbox'), './cmd/clankerbox'], cwd=ROOT, env=env, check=True
    )
    for name in ['clankerbox-server', 'clankerbox-host']:
        subprocess.run(
            ['go', 'build', '-trimpath', '-o', str(binaries / name), './cmd/' + name], cwd=ROOT, env=env, check=True
        )
    subprocess.run(
        ['go', 'build', '-trimpath', '-o', str(binaries / 'clankerbox-guest'), './cmd/clankerbox-guest'],
        cwd=ROOT,
        env=env | {'GOOS': 'linux'},
        check=True,
    )
    runtime = out / 'runtime'
    runtime.mkdir()
    shutil.copy2(args.engine, runtime / 'smolvm')
    shutil.copytree(args.runtime_assets / 'lib', runtime / 'lib', symlinks=True)
    for name in RUNTIME_TEMPLATES:
        shutil.copy2(args.runtime_assets / name, runtime / name)
    verify_runtime_assets(runtime, args.os, args.arch)
    shutil.copytree(args.image, out / 'image', symlinks=True)
    licenses = out / 'licenses'
    licenses.mkdir()
    shutil.copy2(args.engine_source / 'LICENSE', licenses / 'smolvm-LICENSE')
    (licenses / 'source.json').write_text(json.dumps(source_provenance, indent=2) + '\n')
    shutil.copytree(ROOT / 'scripts/release/licenses', licenses / 'native')
    shutil.copytree(args.dependency_notices, licenses / 'dependencies')
    verify_release_licenses(out)
    shutil.copy2(ROOT / 'scripts/release/README.md', out / 'RELEASE.md')
    shutil.copy2(ROOT / 'LICENSE', out / 'LICENSE')
    shutil.copy2(ROOT / 'scripts/release/inputs/pins.json', out / 'engine-pins.json')
    shutil.copy2(ROOT / 'scripts/release/inputs/runtime-artifacts.json', out / 'runtime-artifacts.json')
    shutil.copy2(ROOT / 'scripts/release/inputs/runtime.patch', out / 'runtime.patch')
    if args.os == 'darwin':
        subprocess.run(['codesign', '--verify', '--strict', str(runtime / 'smolvm')], check=True)
        subprocess.run(['codesign', '--force', '--sign', '-', str(out / 'clankerbox')], check=True)
        for name in ['clankerbox-server', 'clankerbox-host']:
            subprocess.run(['codesign', '--force', '--sign', '-', str(binaries / name)], check=True)
    image_digest = content_digest(inventory(out / 'image'))
    runtime_digest = content_digest(
        inventory(runtime) + [entry(out / 'image/usr/local/bin/smolvm-agent', 'smolvm-agent')]
    )
    manifest = {
        'manifest_format': 2,
        'version': args.version,
        'os': args.os,
        'arch': args.arch,
        'controller': 'bin/clankerbox-server',
        'host': 'bin/clankerbox-host',
        'guest': 'bin/clankerbox-guest',
        'smolvm': 'runtime/smolvm',
        'library_dir': 'runtime/lib',
        'image_path': 'image',
        'runtime_digest': runtime_digest,
        'image_digest': image_digest,
        'profile_id': 'linux-dev-v3',
        'profile_cpu': 2,
        'profile_ram_mib': 1024,
        'storage_gib': 1,
        'overlay_gib': 8,
        'files': inventory(out, include_root=False),
    }
    (out / 'bundle.json').write_text(json.dumps(manifest, indent=2) + '\n')
    if args.no_archive:
        print(
            json.dumps(
                {'manifest': str(out / 'bundle.json'), 'runtime_digest': runtime_digest, 'image_digest': image_digest},
                indent=2,
            )
        )
        return
    archive, checksum = package_archive(out)
    print(
        json.dumps(
            {
                'manifest': str(out / 'bundle.json'),
                'archive': str(archive),
                'sha256': checksum,
                'runtime_digest': runtime_digest,
                'image_digest': image_digest,
            },
            indent=2,
        )
    )


if __name__ == '__main__':
    main()
