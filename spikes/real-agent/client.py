#!/usr/bin/env python3
"""One bounded JSON request to the persistent guest controller."""
import argparse
import json
import socket
import sys

LIMIT = 262144


def call(path, request, timeout=200):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(timeout)
        connection.connect(path)
        connection.sendall(json.dumps(request).encode() + b'\n')
        with connection.makefile('rb') as stream:
            raw = stream.readline(LIMIT + 1)
    if len(raw) > LIMIT or not raw.endswith(b'\n'):
        raise ValueError('Invalid or oversized controller response')
    return json.loads(raw)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--socket', default='/tmp/real-agent.sock')
    parser.add_argument('--timeout', type=float, default=200)
    parser.add_argument('op', choices=['baseline', 'branch', 'followup', 'recovery-followup', 'report',
                                      'status', 'barrier-start', 'barrier-release',
                                      'barrier-wait'])
    parser.add_argument('--name', choices=['parent', 'child-a', 'child-b'])
    args = parser.parse_args()
    try:
        result = call(args.socket, {'op': args.op, 'name': args.name}, args.timeout)
    except (OSError, ValueError):
        result = {'ok': False, 'error': 'ControllerUnavailable'}
    print(json.dumps(result, sort_keys=True))
    return 0 if result.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main())
