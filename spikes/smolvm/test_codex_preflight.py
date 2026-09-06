import struct
import unittest
from unittest.mock import patch

import codex_preflight


def attr(kind, value):
    raw = struct.pack("HH", len(value) + 4, kind) + value
    return raw + bytes((-len(raw)) % 4)


def link(name, hardware_type, kind=""):
    return (struct.pack("BBHiII", 0, 0, hardware_type, 1, 0, 0)
            + attr(3, name.encode() + b"\0")
            + attr(18, attr(1, kind.encode() + b"\0")))


class NetworkPreflightTests(unittest.TestCase):
    def inspect(self, links, routes=()):
        with patch.object(codex_preflight, "dump", side_effect=[links, routes]):
            return codex_preflight.inspect()

    def test_kernel_dummy_and_loopback_only(self):
        self.assertTrue(self.inspect([link("lo", 772), link("dummy0", 1, "dummy")])["ok"])

    def test_name_alone_does_not_prove_dummy(self):
        self.assertFalse(self.inspect([link("lo", 772), link("dummy0", 1, "veth")])["ok"])
        self.assertFalse(self.inspect([link("lo", 772), link("eth0", 1)])["ok"])

    def test_default_route_rejected(self):
        default = struct.pack("BBBBBBBBI", 2, 0, 0, 0, 254, 3, 0, 1, 0)
        self.assertFalse(self.inspect([link("lo", 772)], [default])["ok"])


if __name__ == "__main__":
    unittest.main()
