#!/usr/bin/env python3
"""Private CONNECT tunnel: exact host allowlist, public DNS destinations, no content logs."""
import ipaddress
import json
import select
import socket
import socketserver
import sys
import threading
from pathlib import Path

ALLOWED = {'chatgpt.com', 'auth.openai.com', 'api.openai.com'}

def tunnel(a, b):
    while True:
        ready, _, _ = select.select([a, b], [], [], 300)
        if not ready:
            return
        for source in ready:
            data = source.recv(65536)
            if not data:
                return
            (b if source is a else a).sendall(data)

class Connect(socketserver.BaseRequestHandler):
    def handle(self):
        remote = None
        try:
            self.request.settimeout(20)
            header = bytearray()
            while not header.endswith(b'\r\n\r\n'):
                part = self.request.recv(1)
                if not part or len(header) > 8192:
                    raise ValueError('invalid header')
                header.extend(part)
            method, authority, protocol = bytes(header).split(b'\r\n', 1)[0].decode('ascii').split()
            host, port = authority.rsplit(':', 1)
            if method != 'CONNECT' or host not in ALLOWED or port != '443' or protocol != 'HTTP/1.1':
                raise ValueError('destination denied')
            addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
            if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
                raise ValueError('nonpublic DNS destination')
            for family, kind, proto, _, addr in addresses:
                try:
                    remote = socket.socket(family, kind, proto)
                    remote.settimeout(20); remote.connect(addr); break
                except OSError:
                    remote.close(); remote = None
            if remote is None:
                raise ValueError('upstream unavailable')
            self.request.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            self.request.settimeout(None); remote.settimeout(None)
            with self.server.lock:
                self.server.counts[host] = self.server.counts.get(host, 0) + 1
                self.server.active.update((self.request, remote))
            tunnel(self.request, remote)
        except Exception:
            try: self.request.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
            except OSError: pass
        finally:
            with self.server.lock:
                self.server.active.discard(self.request)
                self.server.active.discard(remote)
            if remote: remote.close()

class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            destination = Path('/etc/real-agent-proxy').read_text().strip()
            if destination not in ('172.30.226.1', '172.30.227.1', '172.30.228.1'):
                raise ValueError('relay address outside scope')
            with socket.create_connection((destination, 8443), timeout=20) as remote:
                remote.settimeout(None); tunnel(self.request, remote)
        except (OSError, ValueError):
            pass

class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def disconnect(self):
        with self.lock:
            active = list(self.active)
        for stream in active:
            try: stream.shutdown(socket.SHUT_RDWR)
            except OSError: pass
        return len(active) // 2

if __name__ == '__main__':
    if sys.argv[1] != 'guest': raise ValueError('host servers are runner-owned')
    Server(('127.0.0.1', 8888), Relay).serve_forever()
