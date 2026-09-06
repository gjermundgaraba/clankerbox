#!/usr/bin/env python3
"""Persistent, stdlib-only guest sentinel. Transport one JSON line over AF_UNIX."""
import argparse
import ctypes
import hashlib
import json
import mmap
import os
from pathlib import Path
import resource
import socket
import sys
import time
import uuid

LIMIT = 65536


class State:
    def __init__(self, disk):
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        # Lock before filling: the source of truth never goes to a marker file.
        self.marker = mmap.mmap(-1, mmap.PAGESIZE)
        address = ctypes.addressof(ctypes.c_char.from_buffer(self.marker))
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.mlock(ctypes.c_void_p(address), ctypes.c_size_t(mmap.PAGESIZE)):
            raise OSError(ctypes.get_errno(), "mlock marker page failed")
        if libc.getentropy(ctypes.c_void_p(address), ctypes.c_size_t(32)):
            raise OSError(ctypes.get_errno(), "getentropy marker initialization failed")
        self.disk = Path(disk)
        if self.disk.exists():
            raise FileExistsError(f"Use a fresh disk path: {self.disk}")
        self.counter = 0
        self.label = "parent"
        self.session = uuid.uuid4().hex  # Synthetic identity, never a credential.
        self.started = time.monotonic()
        self.disk.write_text(json.dumps({"label": "parent", "counter": 0}))

    def status(self):
        return {
            "marker_sha256": hashlib.sha256(memoryview(self.marker)[:32]).hexdigest(),
            "pid": os.getpid(), "counter": self.counter, "ram_label": self.label,
            "disk": json.loads(self.disk.read_text()), "session": self.session,
            "elapsed_seconds": time.monotonic() - self.started,
        }

    def command(self, request):
        op = request.get("op")
        if op == "status":
            pass
        elif op == "mutate":
            delta, label = request.get("delta"), request.get("label")
            if type(delta) is not int or not isinstance(label, str) or not 1 <= len(label) <= 128:
                raise ValueError("mutate needs integer delta and 1–128 character label")
            disk = json.loads(self.disk.read_text())
            # Write before changing RAM so a failed write does not report success.
            self.disk.write_text(json.dumps({"label": label, "counter": disk["counter"] + delta}))
            self.counter += delta
            self.label = label
        elif op == "prepare":
            self.session = None
        elif op == "new-session":
            if self.session is not None:
                raise ValueError("prepare must clear the inherited session first")
            self.session = uuid.uuid4().hex
        else:
            raise ValueError(f"unknown operation: {op}")
        return self.status()


def read_json(stream):
    raw = stream.readline(LIMIT + 1)
    if len(raw) > LIMIT or not raw.endswith(b"\n"):
        raise ValueError("expected JSON line of at most 65536 bytes")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("expected JSON object")
    return value


def call(path, request, timeout=5):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(timeout)
        client.connect(str(path))
        client.sendall(json.dumps(request).encode() + b"\n")
        with client.makefile("rb") as stream:
            result = read_json(stream)
    if not result["ok"]:
        raise ValueError(result["error"])
    return result["state"]


def serve(path, disk):
    # Refuse stale/existing paths instead of unlinking an unknown live socket.
    with socket.socket(socket.AF_UNIX) as server:
        server.bind(str(path))
        os.chmod(path, 0o600)
        try:
            state = State(disk)
            server.listen(8)
            print(json.dumps({"ready": True, "pid": os.getpid()}), flush=True)
            while True:
                connection, _ = server.accept()
                with connection:
                    connection.settimeout(5)
                    try:
                        with connection.makefile("rb") as stream:
                            reply = {"ok": True, "state": state.command(read_json(stream))}
                    except (ValueError, OSError, KeyError, TypeError) as error:
                        reply = {"ok": False, "error": str(error)}
                    try:
                        connection.sendall(json.dumps(reply).encode() + b"\n")
                    except OSError:
                        pass
        finally:
            Path(path).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    server = sub.add_parser("serve")
    server.add_argument("--socket", default="/tmp/clanker-acceptance.sock")
    server.add_argument("--disk", required=True)
    client = sub.add_parser("call")
    client.add_argument("--socket", default="/tmp/clanker-acceptance.sock")
    client.add_argument("request", help='e.g. {"op":"status"}')
    args = parser.parse_args()
    try:
        if args.command == "serve":
            serve(args.socket, args.disk)
        else:
            print(json.dumps(call(args.socket, json.loads(args.request)), sort_keys=True))
    except (ValueError, OSError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
