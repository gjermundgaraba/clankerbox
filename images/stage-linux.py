#!/usr/bin/env python3
"""Stage verified Linux images without host privileges or host account paths."""

import argparse, hashlib, json, os, pathlib, posixpath, shutil, tarfile

PINS = {
    'arm64': {
        'ubuntu': '5a1906794ced63a71a8119c3f211ef5f0bbe0a243001b4bbd41fdf80c5b219fd',
        'node': '81d8f0fdea9dcd3bfdcfeafc5f8359c151f097e9880b0007c0645ca670d07971',
    },
    'amd64': {
        'ubuntu': 'a496a960472ce474a59590b8987d3a1135d3cbef1991f3b1abe8cacfea8bf85a',
        'node': '40e1d3225c1c9ae9a2671c98ecb9857e4d5555026394f348645676798840d5c5',
    },
}


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def extract(archive, root, strip=0):
    """Normalize guest absolute symlinks into links inside the staged image."""
    dirs = []
    with tarfile.open(archive) as tar:
        for member in tar:
            parts = pathlib.PurePosixPath(member.name).parts[strip:]
            if not parts:
                if member.isdir():
                    dirs.append((root, member.mode))
                continue
            if '..' in parts or parts[0] == '/':
                raise ValueError('unsafe archive path')
            dest = root.joinpath(*parts)
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not dest.parent.resolve().is_relative_to(root.resolve()):
                raise ValueError('archive parent escapes image')
            if member.isdir():
                dest.mkdir(exist_ok=True)
                dirs.append((dest, member.mode))
                continue
            if dest.is_symlink() or dest.exists():
                dest.unlink()
            if member.issym():
                target = member.linkname
                if target.startswith('/'):
                    target = os.path.relpath(root / target.lstrip('/'), dest.parent)
                resolved = dest.parent / pathlib.Path(target)
                if not pathlib.Path(os.path.abspath(resolved)).is_relative_to(root.resolve()):
                    raise ValueError('symlink escapes image')
                dest.symlink_to(target)
            elif member.islnk():
                linkparts = pathlib.PurePosixPath(member.linkname).parts[strip:]
                if '..' in linkparts or not linkparts:
                    raise ValueError('unsafe hardlink')
                source = root.joinpath(*linkparts)
                if not source.resolve().is_relative_to(root.resolve()):
                    raise ValueError('hardlink escapes image')
                os.link(source, dest)
            elif member.isfile():
                with tar.extractfile(member) as src, open(dest, 'wb') as out:
                    shutil.copyfileobj(src, out)
                dest.chmod(member.mode & 0o777)  # no setuid/setgid workload escape
            # Device nodes are supplied by the engine, never created on the host.
    for dest, mode in reversed(dirs):
        dest.chmod(mode & 0o1777)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--arch', choices=PINS, required=True)
    p.add_argument('--ubuntu', type=pathlib.Path, required=True)
    p.add_argument('--node', type=pathlib.Path, required=True)
    p.add_argument('--agent', type=pathlib.Path, required=True)
    p.add_argument('--agent-sha256', required=True)
    p.add_argument('--output', type=pathlib.Path, required=True)
    a = p.parse_args()
    for name in ['ubuntu', 'node']:
        if digest(getattr(a, name)) != PINS[a.arch][name]:
            raise SystemExit(name + ' checksum mismatch')
    if digest(a.agent) != a.agent_sha256:
        raise SystemExit('agent checksum mismatch')
    a.output.mkdir(mode=0o755, parents=True, exist_ok=False)
    a.output.chmod(0o755)
    extract(a.ubuntu, a.output)
    (a.output / 'usr/local').mkdir(exist_ok=True)
    extract(a.node, a.output / 'usr/local', strip=1)
    for name in [
        'mnt/overlay',
        'mnt/storage',
        'mnt/newroot',
        'mnt/rosetta',
        'run/smolvm/virtiofs',
        'storage',
        'workspace',
        'proc',
        'sys',
        'dev/pts',
    ]:
        (a.output / name).mkdir(parents=True, exist_ok=True)
    agent = a.output / 'usr/local/bin/smolvm-agent'
    shutil.copyfile(a.agent, agent)
    agent.chmod(0o755)
    init = a.output / 'usr/sbin/init'
    init.parent.mkdir(parents=True, exist_ok=True)
    init.symlink_to('../local/bin/smolvm-agent')
    (a.output / 'tmp').chmod(0o1777)
    # The pinned smolvm virtio-net gateway is also the guest DNS endpoint.
    # The address belongs to the runtime's virtual network, not to the host.
    # Host config `dns` / smolvm --dns selects the gateway's upstream instead.
    resolver = a.output / 'etc/resolv.conf'
    if resolver.is_symlink():
        resolver.unlink()
    resolver.write_text('nameserver 100.96.0.1\n')
    resolver.chmod(0o644)
    meta = a.output / '.clankerbox-image'
    meta.mkdir(mode=0o755)
    (meta / 'sources.json').write_text(
        json.dumps(
            {
                'ubuntu': '26.04.1',
                'node': '26.8.2',
                'arch': a.arch,
                'archives': PINS[a.arch],
                'agent_sha256': a.agent_sha256,
            },
            indent=2,
        )
        + '\n'
    )
    print(a.output)


if __name__ == '__main__':
    main()
