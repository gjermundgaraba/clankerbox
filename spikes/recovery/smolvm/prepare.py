#!/usr/bin/env python3
"""Archive exact local worktrees and build only in the granted recovery subtree."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import subprocess
import tarfile
import time

ROOT = Path('/home/clanker/clankerbox-recovery.AsnzhP/smolvm')
LOCAL = Path(__file__).resolve().parent
SOURCE = Path('/Users/example/ws/pers/not-mine/smolvm')
OLD = Path('/home/clanker/clankerbox-smolvm.Jf1bpB')
PIN = '8a571dce742a15631315ee6b386e5bae8f5af7ea'
LIBPIN = 'dbf5f235047333ac7b831b5a32497aa8c1d46663'


def run(argv, **kw):
    return subprocess.run(argv, check=True, **kw)


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def snapshot():
    output = LOCAL / '.work'
    output.mkdir(exist_ok=False)
    provenance = {'created_ns': time.time_ns(), 'sources': {}}
    for name, source, pin in [('source', SOURCE, PIN), ('libkrun', SOURCE / 'libkrun', LIBPIN)]:
        actual = run(['git', '-C', str(source), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
        if actual != pin:
            raise RuntimeError(f'{name} HEAD changed: {actual}')
        archive = output / (name + '.tar')
        with archive.open('xb') as stream:
            run(['git', '-C', str(source), 'archive', '--format=tar', 'HEAD'], stdout=stream)
        argv = ['git', '-C', str(source), 'diff', '--binary', 'HEAD', '--', '.']
        if name == 'source':
            argv += [':!libkrun']
        patch = run(argv, capture_output=True).stdout
        (output / (name + '.patch')).write_bytes(patch)
        provenance['sources'][name] = {'head': actual, 'archive_sha256': sha(archive),
            'diff_sha256': sha(output / (name + '.patch')),
            'status': run(['git', '-C', str(source), 'status', '--short'], capture_output=True, text=True).stdout}
    (output / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    print(json.dumps(provenance))


def validate():
    if ROOT.resolve() != ROOT or ROOT.stat().st_uid != os.getuid() or os.geteuid() == 0:
        raise RuntimeError('private root and clanker execution required')


def remote_prepare():
    validate()
    for name in ('source', 'runtime', 'runtime/lib', 'runtime/bin', 'tmp', 'artifacts'):
        (ROOT / name).mkdir(exist_ok=True)
    provenance = json.loads((ROOT / 'provenance.json').read_text())
    for name, destination in [('source', ROOT / 'source'), ('libkrun', ROOT / 'source/libkrun')]:
        archive = ROOT / (name + '.tar')
        if sha(archive) != provenance['sources'][name]['archive_sha256']:
            raise RuntimeError('source archive hash mismatch')
        destination.mkdir(exist_ok=True)
        with tarfile.open(archive) as tar:
            tar.extractall(destination, filter='data')
        patch = ROOT / (name + '.patch')
        if sha(patch) != provenance['sources'][name]['diff_sha256']:
            raise RuntimeError('source diff hash mismatch')
        if patch.stat().st_size:
            run(['git', 'apply', str(patch)], cwd=destination)
    # Every mutable build input is a private copy. Preserve relative compiler
    # wrapper paths by retaining the old staging layout beneath this new root.
    for name in ('cargo', 'toolchain', 'zig-x86_64-linux-0.15.2', 'cmake-4.1.3-linux-x86_64'):
        shutil.copytree(OLD / name, ROOT / name, symlinks=True)
    shutil.copytree(OLD / 'source/target', ROOT / 'source/target', symlinks=True)
    shutil.copytree(OLD / 'libkrun/target', ROOT / 'source/libkrun/target', symlinks=True)
    shutil.copytree(OLD / 'bundle/agent-rootfs', ROOT / 'runtime/agent-rootfs', symlinks=True)
    for path in (OLD / 'source/lib/linux-x86_64').glob('libkrunfw.so*'):
        if path.is_symlink():
            (ROOT / 'runtime/lib' / path.name).symlink_to(os.readlink(path))
        else:
            shutil.copyfile(path, ROOT / 'runtime/lib' / path.name)
    image = ROOT / 'image'
    image.mkdir()
    archive = Path('/home/clanker/clankerbox-cocoon.b0ngM6/guest-rootfs.tar')
    if sha(archive) != '0a64e8ef15c93ff146f10729750955a4b4a1938293260cbf983d99b5466c99ed':
        raise RuntimeError('Ubuntu rootfs hash mismatch')
    run(['tar', '-xf', str(archive), '-C', str(image), '--no-same-owner'])
    (image / 'opt/recovery').mkdir(parents=True)
    shutil.copyfile('/home/clanker/clankerbox-latency.RPxPe6/shared/latency-guest', image / 'opt/recovery/latency-guest')
    (image / 'opt/recovery/latency-guest').chmod(0o755)
    (ROOT / 'prepared.json').write_text(json.dumps({'rootfs_sha256': sha(archive),
        'guest_sha256': sha(image / 'opt/recovery/latency-guest')}, indent=2) + '\n')


def build(start_step=0):
    validate()
    patch = ROOT / 'publication-fsync.patch'
    if start_step == 0:
        run(['git', 'apply', '--check', str(patch)], cwd=ROOT / 'source')
        run(['git', 'apply', str(patch)], cwd=ROOT / 'source')
    else:
        run(['git', 'apply', '--reverse', '--check', str(patch)], cwd=ROOT / 'source')
    os.sched_setaffinity(0, set(range(4)))
    resource.setrlimit(resource.RLIMIT_AS, (8 * 1024 ** 3, 8 * 1024 ** 3))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'USER', 'LANG') if key in os.environ}
    env.update(PATH=f'{ROOT}/tools/usr/bin:{ROOT}/toolchain/bin:{ROOT}/cmake-4.1.3-linux-x86_64/bin:' + env['PATH'],
        TMPDIR=str(ROOT / 'tmp'), CARGO_HOME=str(ROOT / 'cargo'), CARGO_BUILD_JOBS='1',
        CARGO_NET_OFFLINE='true', CARGO_PROFILE_RELEASE_LTO='false', CARGO_PROFILE_RELEASE_CODEGEN_UNITS='16',
        CC=str(ROOT / 'toolchain/bin/cc'), AR=str(ROOT / 'toolchain/bin/ar'), CMAKE_GENERATOR='Ninja',
        LIBRARY_PATH=str(ROOT / 'runtime/lib'), LD_LIBRARY_PATH=str(ROOT / 'runtime/lib'),
        ZIG_GLOBAL_CACHE_DIR=str(ROOT / 'zig-cache'), ZIG_LOCAL_CACHE_DIR=str(ROOT / 'zig-local-cache'),
        CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=str(ROOT / 'toolchain/lib/rustlib/x86_64-unknown-linux-gnu/bin/rust-lld'))
    operations = [(['cargo', 'build', '--offline', '--locked', '--release', '-p', 'smolvm', '--bin', 'smolvm'], ROOT / 'source'),
        # Select the library package through Makefile's public flag variable;
        # root-workspace defaults also build unrelated GPU/input bindings.
        (['make', 'BLK=1', 'NET=1', 'FEATURE_FLAGS=--locked -p libkrun --features blk,net'], ROOT / 'source/libkrun'),
        (['cargo', 'build', '--offline', '--locked', '--release', '-p', 'smolvm-agent', '--target', 'x86_64-unknown-linux-musl'], ROOT / 'source')]
    for index, (argv, directory) in enumerate(operations):
        if index < start_step:
            continue
        with (ROOT / f'build-{index}.log').open('a') as log:
            started = time.monotonic_ns()
            record = {'argv': argv, 'cwd': str(directory), 'start_ns': started}
            try:
                result = subprocess.run(argv, cwd=directory, env=env, stdout=log, stderr=subprocess.STDOUT)
                record['returncode'] = result.returncode
            except Exception as error:
                record.update(returncode=None, error=repr(error))
                raise
            finally:
                record['end_ns'] = time.monotonic_ns()
                with (ROOT / 'build-commands.jsonl').open('a') as journal:
                    journal.write(json.dumps(record) + '\n')
            result.check_returncode()
    shutil.copyfile(ROOT / 'source/target/release/smolvm', ROOT / 'runtime/bin/smolvm')
    (ROOT / 'runtime/bin/smolvm').chmod(0o755)
    shutil.copyfile(ROOT / 'source/libkrun/target/release/libkrun.so', ROOT / 'runtime/lib/libkrun.so')
    for alias in ('libkrun.so.2', 'libkrun.so.2.0.0'):
        (ROOT / 'runtime/lib' / alias).symlink_to('libkrun.so')
    shutil.copyfile(ROOT / 'source/target/x86_64-unknown-linux-musl/release/smolvm-agent',
                    ROOT / 'runtime/agent-rootfs/usr/local/bin/smolvm-agent')
    inputs = {str(path.relative_to(ROOT)): sha(path) for path in
        (ROOT / 'runtime/bin/smolvm', ROOT / 'runtime/lib/libkrun.so', ROOT / 'runtime/agent-rootfs/usr/local/bin/smolvm-agent')}
    (ROOT / 'build.json').write_text(json.dumps({'status': 'pass', 'hashes': inputs,
        'publication_patch_sha256': sha(patch)}, indent=2) + '\n')
    print(json.dumps(inputs), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=('snapshot', 'prepare', 'build'))
    parser.add_argument('--start-step', type=int, choices=(0, 1, 2), default=0)
    args = parser.parse_args()
    if args.phase == 'build':
        build(args.start_step)
    else:
        {'snapshot': snapshot, 'prepare': remote_prepare}[args.phase]()
