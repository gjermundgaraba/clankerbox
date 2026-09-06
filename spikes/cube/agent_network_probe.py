#!/usr/bin/env python3
"""Credential-free direct-denial and exact CONNECT allowlist probe."""
import json
import socket

result = {}
for label, target in [('publicDirectBlocked', ('1.1.1.1', 443)),
                      ('hostDirectBlocked', ('10.77.70.2', 22)),
                      ('alternateProxyHostPortBlocked', ('10.77.70.15', 3000))]:
    try:
        with socket.create_connection(target, timeout=3):
            result[label] = False
    except OSError:
        result[label] = True
for label, host, expected in [('unlistedHostDenied', 'example.com', b'403'),
                              ('officialConnectAllowed', 'chatgpt.com', b'200')]:
    try:
        with socket.create_connection(('10.77.70.15', 18445), timeout=10) as stream:
            request = 'CONNECT ' + host + ':443 HTTP/1.1\r\nHost: ' + host + ':443\r\n\r\n'
            stream.sendall(request.encode())
            reply = stream.recv(100).split(b' ', 2)
            result[label] = len(reply) >= 2 and reply[1] == expected
    except OSError as error:
        result[label] = False
        result[label + 'Error'] = type(error).__name__
print(json.dumps(result))
