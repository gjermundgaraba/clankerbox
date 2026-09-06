#!/usr/bin/env python3
"""One quiesced-file rollback probe; O_DIRECT failure is fatal, never buffered."""
import hashlib
import json
import mmap
import os
from pathlib import Path
import sys

FILE = Path('/var/tmp/clanker-rollback-20260905.bin')
SENTINEL = Path('/var/tmp/clanker-acceptance-disk.json')
SIZE = 4096


def payload(phase):
    if phase not in ('checkpoint', 'after-capture'):
        raise ValueError('unknown rollback phase')
    seed = ('cocoon-rollback-20260905:' + phase + '\n').encode()
    return (seed * (SIZE // len(seed) + 1))[:SIZE]


def flush(path):
    for target, flags in ((path, os.O_RDONLY), (path.parent, os.O_RDONLY | os.O_DIRECTORY)):
        fd = os.open(target, flags | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def direct_read(path):
    # Anonymous mmap is page-aligned; readv avoids Python's unaligned bytes buffer.
    fd = os.open(path, os.O_RDONLY | os.O_DIRECT | os.O_NOFOLLOW)
    try:
        size = os.fstat(fd).st_size
        with mmap.mmap(-1, SIZE) as buffer:
            count = os.readv(fd, [buffer])
            if count != size or not 0 < count <= SIZE:
                raise ValueError('short/oversized direct read')
            data = bytes(buffer[:count])
    finally:
        os.close(fd)
    return {'sha256': hashlib.sha256(data).hexdigest(), 'size': count,
            'method': 'O_DIRECT + page-aligned mmap + readv',
            'open_flags': os.O_RDONLY | os.O_DIRECT | os.O_NOFOLLOW,
            'text': data.decode() if path == SENTINEL else None}


def main(action, phase):
    expected = hashlib.sha256(payload(phase)).hexdigest()
    if action == 'write':
        flags = os.O_WRONLY | os.O_NOFOLLOW
        flags |= os.O_CREAT | os.O_EXCL if phase == 'checkpoint' else 0
        fd = os.open(FILE, flags, 0o600)
        try:
            if phase == 'after-capture' and os.fstat(fd).st_size != SIZE:
                raise ValueError('refuse to overwrite an unexpected file')
            if os.write(fd, payload(phase)) != SIZE:
                raise ValueError('short checkpoint write')
            os.fsync(fd)
        finally:
            os.close(fd)
        flush(FILE)
        flush(SENTINEL)
        os.sync()  # This helper runs INSIDE the disposable guest only.
    elif action != 'read':
        raise ValueError('unknown operation')
    result = {'phase': phase, 'action': action, 'file': direct_read(FILE),
              'sentinel_disk': direct_read(SENTINEL), 'inode': FILE.stat().st_ino,
              'guest_interfaces': sorted(p.name for p in Path('/sys/class/net').iterdir()),
              'flush': 'file fsync + directory fsync + guest sync' if action == 'write' else 'none'}
    if result['file']['sha256'] != expected:
        raise ValueError('direct backing-file contents do not match ' + phase)
    print(json.dumps(result))


if __name__ == '__main__':
    main(*sys.argv[1:])
