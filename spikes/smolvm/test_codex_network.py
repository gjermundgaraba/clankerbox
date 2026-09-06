import socket
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import codex_network


class ProxyPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / "proxy.sock")
        self.proxy = codex_network.Proxy(self.path)
        self.thread = threading.Thread(target=self.proxy.serve_forever)
        self.thread.start()

    def tearDown(self):
        self.proxy.shutdown()
        self.proxy.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def request(self, target):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(3)
            client.connect(self.path)
            client.sendall(b"CONNECT " + target + b" HTTP/1.1\r\n\r\n")
            return client.recv(256)

    def test_only_exact_official_https_authorities_are_resolved(self):
        with patch.object(codex_network.socket, "getaddrinfo", side_effect=AssertionError("must not resolve")):
            for target in (b"example.com:443", b"chatgpt.com.evil.test:443", b"chatgpt.com:80", b"127.0.0.1:443"):
                self.assertIn(b"403", self.request(target))

    def test_private_or_mixed_dns_answers_cannot_be_connected(self):
        for address in ("127.0.0.1", "169.254.169.254", "10.0.0.1", "::1"):
            answers = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", (address, 443))]
            with patch.object(codex_network.socket, "getaddrinfo", return_value=answers):
                self.assertIn(b"403", self.request(b"chatgpt.com:443"))
        self.assertEqual(self.proxy.counts, {})


if __name__ == "__main__":
    unittest.main()
