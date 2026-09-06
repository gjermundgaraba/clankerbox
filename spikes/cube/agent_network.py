#!/usr/bin/env python3
"""Owned Cube-only CONNECT/relay and Unix control; never logs TLS payloads."""
import argparse
import json
import os
from pathlib import Path
import socket
import socketserver
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'cocoon'))
from agent_proxy import Connect, Server, tunnel


class OuterRelay(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            with socket.create_connection(('127.0.0.1', 18443), timeout=20) as remote:
                self.request.settimeout(None)
                remote.settimeout(None)
                with self.server.lock:
                    self.server.active.update((self.request, remote))
                    self.server.counts['relayed'] = self.server.counts.get('relayed', 0) + 1
                try:
                    tunnel(self.request, remote)
                finally:
                    with self.server.lock:
                        self.server.active.discard(self.request)
                        self.server.active.discard(remote)
        except OSError:
            pass


def identity():
    stat = Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()
    return {'pid': os.getpid(), 'startTicks': int(stat[19])}


def serve(role, control):
    from cube_spike import isolated
    if role == 'outer':
        isolated()
        address, handler = ('10.77.70.15', 18445), OuterRelay
    else:
        scope = json.loads((Path(__file__).resolve().parent / '.work/scope.json').read_text())
        if scope['grant'] != 'cube-codex-20260905' or scope['root'] != '/home/clanker/clankerbox-cube.8h3eeX':
            raise RuntimeError('Wrong host scope')
        address, handler = ('127.0.0.1', 18444), Connect
    # Reject occupied listeners; never unlink an unknown Unix control socket.
    with socket.socket(socket.AF_UNIX) as ctl, Server(address, handler) as server:
        ctl.bind(control)
        os.chmod(control, 0o600)
        ctl.listen(4)
        server.lock, server.active, server.counts = threading.Lock(), set(), {}
        threading.Thread(target=server.serve_forever, daemon=True).start()
        ident = identity()
        print(json.dumps({'ready': True, 'identity': ident, 'listen': address}), flush=True)
        while True:
            connection, _ = ctl.accept()
            with connection:
                connection.settimeout(5)
                op = connection.recv(64).decode().strip()
                result = {'identity': ident, 'counts': dict(server.counts)}
                if op == 'disconnect':
                    result['disconnectedActiveTunnels'] = server.disconnect()
                elif op not in ('status', 'stop'):
                    result = {'error': 'UnknownOperation'}
                connection.sendall(json.dumps(result).encode() + b'\n')
                if op == 'stop':
                    server.disconnect()
                    server.shutdown()
                    break
        Path(control).unlink()


def call(control, operation):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(5)
        connection.connect(control)
        connection.sendall(operation.encode() + b'\n')
        with connection.makefile('rb') as stream:
            return json.loads(stream.readline(8193))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('role', choices=['host', 'outer', 'call'])
    parser.add_argument('--control', required=True)
    parser.add_argument('--operation', choices=['status', 'disconnect', 'stop'], default='status')
    args = parser.parse_args()
    if args.role == 'call':
        print(json.dumps(call(args.control, args.operation)))
    else:
        serve(args.role, args.control)
