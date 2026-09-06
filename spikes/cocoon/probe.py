#!/usr/bin/env python3
"""Synthetic side effect, using a fresh TCP connection on each attempt."""
import json
import sys
import time
import urllib.request
from guest import call


def attempt(url, owner):
    state = call('/tmp/clanker-acceptance.sock', {'op': 'status'})
    request = urllib.request.Request(url, data=json.dumps(dict(session=state['session'], owner=owner)).encode(),
                                     headers={'Content-Type': 'application/json'})
    # Disable environment proxies; only the controlled private endpoint is used.
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=0.5) as r:
        assert r.status == 200


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[3] == 'loop':
        while True:
            try:
                attempt(sys.argv[1], sys.argv[2])
            except Exception:
                pass
            time.sleep(0.1)
    else:
        attempt(sys.argv[1], sys.argv[2])
