#!/usr/bin/env python3
"""Persistent guest TCP relay with a private, acknowledged transport reset.

Only its controller changes the upstream-address file. The host CONNECT proxy
enforces destination policy. This relay does not inspect or log traffic.
"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import select
import socket
import socketserver
import threading
import time


class Registry:
    def __init__(self, address_file, port, upstream_unix=None):
        self.address_file = Path(address_file)
        self.port = port
        self.upstream_unix = upstream_unix
        self.cv = threading.Condition()
        self.generation = 0
        self.sequence = 0
        self.active = {}

    def status(self):
        with self.cv:
            return dict(pid=os.getpid(), generation=self.generation,
                        activeTunnels=len(self.active))

    def reset(self):
        with self.cv:
            cutoff = self.generation
            self.generation += 1
            victims = [row for row in self.active.values() if row['generation'] <= cutoff]
            for row in victims:
                row['cancelled'] = True
                for stream in row['sockets']:
                    try: stream.shutdown(socket.SHUT_RDWR)
                    except OSError: pass
                    stream.close()
            deadline = time.monotonic() + 25
            while any(row['generation'] <= cutoff for row in self.active.values()):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return dict(ok=False, error='OldTunnelsRemain', **self.status())
                self.cv.wait(min(remaining, .1))
            return dict(ok=True, oldTunnels=len(victims), oldTunnelsRemaining=0,
                        **self.status())


class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        registry = self.server.registry
        remote = None
        with registry.cv:
            registry.sequence += 1
            identity = registry.sequence
            row = dict(generation=registry.generation, cancelled=False, sockets=[self.request])
            registry.active[identity] = row
        try:
            if registry.upstream_unix:
                family, target = socket.AF_UNIX, registry.upstream_unix
            else:
                address = ipaddress.ip_address(registry.address_file.read_text().strip())
                if not address.is_private:
                    raise ValueError('Upstream must be private')
                family = socket.AF_INET6 if address.version == 6 else socket.AF_INET
                target = (str(address), registry.port)
            with registry.cv:
                if row['cancelled']: return
                remote = socket.socket(family, socket.SOCK_STREAM)
                remote.settimeout(20)
                row['sockets'].append(remote)
            remote.connect(target)
            remote.settimeout(None)
            while True:
                ready, _, _ = select.select([self.request, remote], [], [], 300)
                if not ready: return
                for source in ready:
                    data = source.recv(65536)
                    if not data: return
                    (remote if source is self.request else self.request).sendall(data)
        except (OSError, ValueError):
            pass
        finally:
            if remote is not None: remote.close()
            with registry.cv:
                registry.active.pop(identity, None)
                registry.cv.notify_all()


class Control(socketserver.StreamRequestHandler):
    def handle(self):
        self.request.settimeout(30)
        request = self.rfile.readline(32).strip()
        if request == b'reset': result = self.server.registry.reset()
        elif request == b'status': result = dict(ok=True, **self.server.registry.status())
        else: result = dict(ok=False, error='UnknownOperation')
        self.wfile.write(json.dumps(result).encode() + b'\n')


class TCP(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class Unix(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


def control(path, operation):
    with socket.socket(socket.AF_UNIX) as stream:
        stream.settimeout(30)
        stream.connect(path)
        stream.sendall(operation.encode() + b'\n')
        with stream.makefile('rb') as reader:
            return json.loads(reader.readline(4096))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('serve', 'status', 'reset'))
    parser.add_argument('--socket', default='/tmp/real-agent-relay.sock')
    parser.add_argument('--upstream-file', default='/etc/real-agent-proxy')
    parser.add_argument('--upstream-port', type=int, default=8443)
    parser.add_argument('--upstream-unix', help='Private published Unix socket, e.g. a guest vsock bridge')
    parser.add_argument('--listen-port', type=int, default=8888)
    args = parser.parse_args()
    if args.operation != 'serve':
        result = control(args.socket, args.operation)
        print(json.dumps(result))
        return 0 if result['ok'] else 1
    registry = Registry(args.upstream_file, args.upstream_port, args.upstream_unix)
    with TCP(('127.0.0.1', args.listen_port), Relay) as relay, Unix(args.socket, Control) as manager:
        os.chmod(args.socket, 0o600)
        relay.registry = manager.registry = registry
        threading.Thread(target=manager.serve_forever, daemon=True).start()
        relay.serve_forever()


if __name__ == '__main__':
    raise SystemExit(main())
