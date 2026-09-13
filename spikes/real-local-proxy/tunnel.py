#!/usr/bin/env python3
"""Bounded TCP/stdio forwarding for the isolated edge proxy qualification.

remote PORT connects stdio to a loopback TCP listener. local PORT COMMAND...
accepts loopback clients and gives each connection a fresh stdio subprocess.
No production credentials, TLS termination, or network listener beyond loopback.
"""
import socket
import subprocess
import sys
import threading


def pump(source, destination, finish):
    try:
        read = getattr(source, "read1", source.read)
        while data := read(65536):
            destination.write(data)
            destination.flush()
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass
    finally:
        finish()


def remote(port):
    with socket.create_connection(("127.0.0.1", port), timeout=10) as stream:
        stream.settimeout(None)
        def finish_input():
            try:
                stream.shutdown(socket.SHUT_WR)
            except OSError:
                pass
        thread = threading.Thread(target=pump, args=(sys.stdin.buffer.raw, stream.makefile("wb", buffering=0), finish_input), daemon=True)
        thread.start()
        pump(stream.makefile("rb", buffering=0), sys.stdout.buffer, lambda: None)


def handle(stream, command):
    with stream, subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE) as child:
        thread = threading.Thread(target=pump, args=(stream.makefile("rb", buffering=0), child.stdin, child.stdin.close), daemon=True)
        thread.start()
        def finish_output():
            try:
                stream.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        pump(child.stdout, stream.makefile("wb", buffering=0), finish_output)
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.terminate()
            child.wait(timeout=5)


if __name__ == "__main__":
    mode, port = sys.argv[1], int(sys.argv[2])
    if mode == "remote":
        remote(port)
    elif mode == "local":
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", port))
            listener.listen(16)
            print(f"listening 127.0.0.1:{listener.getsockname()[1]}", flush=True)
            while True:
                stream, _ = listener.accept()
                threading.Thread(target=handle, args=(stream, sys.argv[3:]), daemon=True).start()
    else:
        raise SystemExit("expected local or remote")
