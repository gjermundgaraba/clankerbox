#!/usr/bin/env python3
"""Private 4096-byte recovery probe. O_DIRECT errors are fatal, never buffered."""
import argparse
import hashlib
import json
import mmap
import os
from pathlib import Path
import re
import stat


BASE = Path('/var/tmp/clanker-recovery')
SIZE = 4096
METHOD = 'O_DIRECT+mmap+readv'


def valid_namespace(name):
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', name):
        raise ValueError('namespace must be a private 1..64 character token')
    return name


def payload(namespace, phase, counter):
    valid_namespace(namespace)
    if phase not in ('A', 'B', 'branch') or type(counter) is not int or not 0 <= counter <= 2147483647:
        raise ValueError('unknown phase or invalid counter')
    if (phase == 'A' and counter != 0) or (phase == 'B' and counter != 1) or (phase == 'branch' and counter < 1):
        raise ValueError('A requires counter0, B counter1, branch a positive counter')
    seed = json.dumps(dict(protocol='clanker-recovery-v1', namespace=namespace, phase=phase, counter=counter), sort_keys=True).encode() + b'\n'
    result = bytearray(seed)
    for index in range((SIZE - len(seed) + 31) // 32):
        result.extend(hashlib.sha256(seed + index.to_bytes(4, 'big')).digest())
    return bytes(result[:SIZE])


def check_directory(fd):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('private directory must be owned by current UID with mode0700')


def namespace_fd(namespace, create):
    valid_namespace(namespace)
    parent = os.open('/var/tmp', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if create:
            try:
                os.mkdir(BASE.name, 0o700, dir_fd=parent)
                os.fsync(parent)
            except FileExistsError:
                pass
        base = os.open(BASE.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        check_directory(base)
        if create:
            os.mkdir(namespace, 0o700, dir_fd=base)  # Never reuse an initialization target.
            os.fsync(base)
        result = os.open(namespace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=base)
        try:
            check_directory(result)
        except BaseException:
            os.close(result)
            raise
        return result
    finally:
        os.close(base)


def check_file(fd, size=SIZE):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_size != size or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError('unexpected probe target: require owned regular mode0600 single-link file with exact size')
    return info


def direct_read(directory):
    if not hasattr(os, 'O_DIRECT'):
        raise RuntimeError('O_DIRECT unavailable; buffered fallback forbidden')
    fd = os.open('payload.bin', os.O_RDONLY | os.O_DIRECT | os.O_NOFOLLOW, dir_fd=directory)
    try:
        info = check_file(fd)
        with mmap.mmap(-1, SIZE) as aligned:
            count = os.readv(fd, [aligned])
            if count != SIZE:
                raise ValueError('short O_DIRECT read')
            return bytes(aligned[:]), info
    finally:
        os.close(fd)


def perform(action, namespace, phase, counter, expect_phase=None, expect_counter=None):
    expected = payload(namespace, phase, counter)
    if action not in ('initialize', 'write', 'read'):
        raise ValueError('unknown action')
    if action == 'initialize' and (phase, counter) != ('A', 0):
        raise ValueError('initialize requires A counter0')
    previous = payload(namespace, expect_phase, expect_counter) if action == 'write' else None
    # Fail before filesystem mutation when this platform has no direct I/O.
    if not hasattr(os, 'O_DIRECT'):
        raise RuntimeError('O_DIRECT unavailable; buffered fallback forbidden')
    directory = namespace_fd(namespace, action == 'initialize')
    try:
        old_info = None
        if action == 'write':
            data, old_info = direct_read(directory)
            if data != previous:
                raise ValueError('existing direct-read payload differs from expected prior phase/counter')
        if action in ('initialize', 'write'):
            flags = os.O_WRONLY | os.O_NOFOLLOW
            if action == 'initialize':
                flags |= os.O_CREAT | os.O_EXCL
            fd = os.open('payload.bin', flags, 0o600, dir_fd=directory)
            try:
                info = check_file(fd, 0 if action == 'initialize' else SIZE)
                if old_info and (info.st_dev, info.st_ino) != (old_info.st_dev, old_info.st_ino):
                    raise ValueError('probe inode changed before overwrite')
                if os.pwrite(fd, expected, 0) != SIZE:
                    raise ValueError('short probe write')
                os.fsync(fd)
            finally:
                os.close(fd)
            os.fsync(directory)
        data, info = direct_read(directory)
        if data != expected:
            raise ValueError('direct-read payload differs from requested phase/counter')
        return dict(schema_version=1, ok=True, action=action, namespace=namespace, phase=phase, counter=counter,
                    path=str(BASE / namespace / 'payload.bin'), size=SIZE,
                    sha256=hashlib.sha256(data).hexdigest(), expected_sha256=hashlib.sha256(expected).hexdigest(),
                    method=METHOD, inode=info.st_ino, device=info.st_dev,
                    probe_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                    sync='file+parent fsync' if action != 'read' else 'none')
    finally:
        os.close(directory)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('initialize', 'write', 'read'))
    parser.add_argument('--namespace', required=True)
    parser.add_argument('--phase', choices=('A', 'B', 'branch'), required=True)
    parser.add_argument('--counter', type=int, required=True)
    parser.add_argument('--expect-phase', choices=('A', 'B', 'branch'))
    parser.add_argument('--expect-counter', type=int)
    args = parser.parse_args(argv)
    try:
        if args.action != 'write' and (args.expect_phase is not None or args.expect_counter is not None):
            raise ValueError('prior expectation is only valid for write')
        result = perform(args.action, args.namespace, args.phase, args.counter, args.expect_phase, args.expect_counter)
    except (OSError, ValueError, RuntimeError) as error:
        print(json.dumps(dict(schema_version=1, ok=False, error=f'{type(error).__name__}: {error}')))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
