#!/usr/bin/env python3
"""Supply Cubelet's gateway inside restricted SLIRP; prove basic egress denial."""
import json
import socket
import subprocess
from cube_spike import isolated, require


if __name__ == '__main__':
    isolated()
    subprocess.run(['ip', 'route', 'replace', 'default', 'via', '10.77.70.2', 'dev', 'ens5'], check=True)
    results = {}
    for host, port in [('1.1.1.1', 443), ('10.77.70.2', 22)]:
        try:
            with socket.create_connection((host, port), timeout=3):
                connected = True
        except OSError:
            connected = False
        require(not connected, f'Restricted outer network unexpectedly reached {host}:{port}')
        results[f'{host}:{port}'] = 'blocked'
    print(json.dumps({'status': 'pass', 'outer_egress_checks': results}))
