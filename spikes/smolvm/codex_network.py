"""Owned Unix CONNECT proxy and guest loopback relay; never logs content."""
import ipaddress
import select
import socket
import socketserver
import struct
import sys
import threading

ALLOWED = frozenset({"chatgpt.com", "auth.openai.com", "api.openai.com"})


def tunnel(first, second):
    while True:
        ready, _, _ = select.select([first, second], [], [], 300)
        if not ready:
            return
        for source in ready:
            data = source.recv(65536)
            if not data:
                return
            (second if source is first else first).sendall(data)


class Connect(socketserver.BaseRequestHandler):
    def handle(self):
        remote = None
        try:
            if self.server.allowed_peers is not None:
                peer_pid, _, _ = struct.unpack("3i", self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                with self.server.lock:
                    if peer_pid not in self.server.allowed_peers:
                        raise ValueError("VmmProxyGateClosed")
            self.request.settimeout(20)
            header = bytearray()
            while not header.endswith(b"\r\n\r\n"):
                part = self.request.recv(1)
                if not part or len(header) > 8192:
                    raise ValueError("InvalidHeader")
                header.extend(part)
            method, authority, protocol = bytes(header).split(b"\r\n", 1)[0].decode("ascii").split()
            host, port = authority.rsplit(":", 1)
            if method != "CONNECT" or host not in ALLOWED or port != "443" or protocol != "HTTP/1.1":
                raise ValueError("DeniedDestination")
            addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
            if not addresses or any(not ipaddress.ip_address(entry[4][0]).is_global for entry in addresses):
                raise ValueError("NonpublicDestination")
            for family, kind, proto, _, address in addresses:
                try:
                    remote = socket.socket(family, kind, proto)
                    remote.settimeout(20)
                    remote.connect(address)
                    break
                except OSError:
                    remote.close()
                    remote = None
            if remote is None:
                raise ValueError("UpstreamUnavailable")
            self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            self.request.settimeout(None)
            remote.settimeout(None)
            with self.server.lock:
                self.server.counts[host] = self.server.counts.get(host, 0) + 1
                self.server.active.update((self.request, remote))
            tunnel(self.request, remote)
        except Exception:
            with self.server.lock:
                self.server.denied += 1
            try:
                self.request.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            except OSError:
                pass
        finally:
            with self.server.lock:
                self.server.active.discard(self.request)
                self.server.active.discard(remote)
            if remote:
                remote.close()


class Proxy(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True

    def __init__(self, path):
        self.lock = threading.Lock()
        self.active = set()
        self.counts = {}
        self.denied = 0
        self.allowed_peers = None
        super().__init__(path, Connect)

    def disconnect(self):
        with self.lock:
            active = list(self.active)
        for stream in active:
            try:
                stream.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        return len(active) // 2

    def allow_peer(self, pid):
        with self.lock:
            self.allowed_peers.add(pid)


class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            with socket.socket(socket.AF_UNIX) as remote:
                remote.connect("/run/real-agent-proxy.sock")
                tunnel(self.request, remote)
        except OSError:
            pass


class GuestRelay(socketserver.ThreadingTCPServer):
    daemon_threads = True


if __name__ == "__main__":
    if sys.argv[1:] != ["guest"]:
        raise ValueError("Host proxy must be runner-owned")
    GuestRelay(("127.0.0.1", 8888), Relay).serve_forever()
