#!/usr/bin/env python3
"""Credential-free Linux rtnetlink inspection; does not change networking."""
import json
import socket
import struct


def attributes(data):
    result = {}
    while len(data) >= 4:
        size, kind = struct.unpack_from("HH", data)
        if size < 4 or size > len(data):
            raise ValueError("invalid netlink attribute")
        result[kind & 0x3fff] = data[4:size]
        data = data[(size + 3) & ~3:]
    return result


def dump(kind, payload):
    with socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, socket.NETLINK_ROUTE) as connection:
        connection.settimeout(3)
        connection.bind((0, 0))
        connection.send(struct.pack("IHHII", 16 + len(payload), kind, 0x301, 1, 0) + payload)
        while True:
            data = connection.recv(65536)
            while len(data) >= 16:
                size, reply, _, _, _ = struct.unpack_from("IHHII", data)
                if size < 16 or size > len(data):
                    raise ValueError("invalid netlink message")
                body = data[16:size]
                data = data[(size + 3) & ~3:]
                if reply == 3:
                    return
                if reply == 2:
                    raise ValueError("netlink error")
                yield body


def inspect():
    links = []
    for body in dump(18, struct.pack("BBHiII", socket.AF_UNSPEC, 0, 0, 0, 0, 0)):
        _, _, hardware_type, index, flags, _ = struct.unpack_from("BBHiII", body)
        attrs = attributes(body[16:])
        info = attributes(attrs.get(18, b""))
        links.append({"name": attrs[3].rstrip(b"\0").decode(), "index": index,
                      "hardware_type": hardware_type, "flags": flags,
                      "kind": info.get(1, b"").rstrip(b"\0").decode()})
    defaults = []
    for body in dump(26, bytes(12)):
        family, prefix, _, _, table, protocol, scope, route_type, flags = struct.unpack_from("BBBBBBBBI", body)
        if prefix == 0 and route_type == 1:  # unicast defaults, not unreachable sentinels
            defaults.append({"family": family, "table": table, "protocol": protocol, "scope": scope})
    safe = (any(link["name"] == "lo" and link["hardware_type"] == 772 for link in links)
            and all((link["name"] == "lo" and link["hardware_type"] == 772)
                    or (link["name"] == "dummy0" and link["kind"] == "dummy") for link in links)
            and not defaults)
    return {"ok": safe, "links": links, "unicast_default_routes": defaults}


if __name__ == "__main__":
    print(json.dumps(inspect(), sort_keys=True))
