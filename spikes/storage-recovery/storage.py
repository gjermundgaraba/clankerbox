#!/usr/bin/env python3
"""Disposable file-level branch test; not a VM snapshot or crash-consistency test."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def clone(source, destination, mode):
    if source.is_symlink() or not source.is_file():
        raise ValueError("source must be a regular, non-symlink fixture file")
    if mode not in ("copy", "reflink"):
        raise ValueError("unsupported mode")
    if mode == "reflink" and not sys.platform.startswith("linux"):
        raise ValueError("this reflink path requires Linux")
    started = time.monotonic()
    with source.open("rb") as reader, destination.open("xb") as writer:
        if mode == "reflink":
            # Linux FICLONE, also used by coreutils cp --reflink=always.
            fcntl.ioctl(writer.fileno(), 0x40049409, reader.fileno())
        else:
            shutil.copyfileobj(reader, writer, length=1024 * 1024)
        writer.flush()
        os.fsync(writer.fileno())
    return round((time.monotonic() - started) * 1000, 3)


def mutate(path, marker):
    with path.open("r+b") as stream:
        stream.write(marker)
        stream.flush()
        os.fsync(stream.fileno())


def exercise(directory, mode="copy", size_mib=256):
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError("choose an existing non-symlink scratch parent")
    if not 1 <= size_mib <= 1024:
        raise ValueError("size must be 1..1024 MiB")
    required = size_mib * 1024**2 * 6
    if shutil.disk_usage(directory).free < required:
        raise ValueError("insufficient scratch capacity; no files created")
    with tempfile.TemporaryDirectory(prefix="cb-storage-files-", dir=directory) as scratch:
        root = Path(scratch)
        free_before = shutil.disk_usage(root).free
        paths = {name: root / (name + ".raw") for name in ("source", "checkpoint", "a", "b", "grandchild")}
        block = os.urandom(1024 * 1024)
        with paths["source"].open("xb") as stream:
            for _ in range(size_mib):
                stream.write(block)
            stream.flush()
            os.fsync(stream.fileno())
        original = digest(paths["source"])
        times = {}
        for child, parent in (("checkpoint", "source"), ("a", "checkpoint"), ("b", "checkpoint")):
            times[child] = clone(paths[parent], paths[child], mode)
            if digest(paths[child]) != original:
                raise RuntimeError("clone contents differ")
        mutate(paths["a"], b"child-a")
        mutate(paths["b"], b"child-b")
        times["grandchild"] = clone(paths["a"], paths["grandchild"], mode)
        a_state = digest(paths["a"])
        if digest(paths["grandchild"]) != a_state:
            raise RuntimeError("grandchild did not capture child state")
        mutate(paths["grandchild"], b"grandchild")
        hashes = {key: digest(path) for key, path in paths.items()}
        if hashes["source"] != original or hashes["checkpoint"] != original:
            raise RuntimeError("child writes altered ancestor")
        if hashes["a"] != a_state or len({hashes[x] for x in ("a", "b", "grandchild")}) != 3:
            raise RuntimeError("branches are not independent")
        blocks = {key: path.stat().st_blocks * 512 for key, path in paths.items()}
        free_peak = shutil.disk_usage(root).free
        paths["source"].unlink()
        paths["checkpoint"].unlink()
        paths["a"].unlink()
        if digest(paths["b"]) != hashes["b"] or digest(paths["grandchild"]) != hashes["grandchild"]:
            raise RuntimeError("ancestor deletion damaged descendant")
        return {"execution_scope": "filesystem", "status": "pass", "mode": mode,
                "size_mib": size_mib, "clone_ms": times,
                "allocated_bytes_per_file": blocks,
                "filesystem_free_delta_bytes": free_before - free_peak,
                "checks": ["checkpoint contents", "child write isolation", "grandchild state",
                           "descendant survival after ancestor deletion"],
                "limitations": ["One warm-cache file trial; not VM pause/readiness",
                                "Per-file allocated blocks double-count shared extents",
                                "Filesystem free delta includes concurrent filesystem activity",
                                "No power-loss, RAM, application flush or runtime-GC proof"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--mode", choices=("copy", "reflink"), required=True)
    parser.add_argument("--size-mib", type=int, default=256)
    args = parser.parse_args()
    print(json.dumps(exercise(args.directory, args.mode, args.size_mib), indent=2))


if __name__ == "__main__":
    main()
