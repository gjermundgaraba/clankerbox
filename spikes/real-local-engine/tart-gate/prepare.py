#!/usr/bin/env python3
"""Prepare an isolated Tart gate from explicitly selected artifacts; do not start a VM."""
import argparse
import hashlib
import json
import os
import pathlib
import plistlib
import pwd
import re
import shutil
import subprocess


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['root', 'seed', 'tart-app', 'host-binary', 'guest-binary', 'gate-binary']:
        parser.add_argument('--'+name, type=pathlib.Path, required=True)
    args = parser.parse_args()
    root = args.root.absolute()
    if not re.fullmatch('[A-Za-z0-9_-]+', root.name):
        parser.error('root basename must be a simple namespace')
    if os.geteuid() == 0:
        parser.error('prepare as the ordinary service owner')
    artifacts = [args.seed, args.tart_app, args.host_binary, args.guest_binary, args.gate_binary]
    for path in artifacts:
        path.resolve(strict=True)
    root.mkdir(mode=0o700)
    app = args.tart_app.resolve()
    records = [{'path': name, 'sha256': digest(args.seed/name)} for name in ['config.json', 'nvram.bin', 'disk.img']]
    runtime = [{'path': p.relative_to(app).as_posix(), 'sha256': digest(p)} for p in sorted(app.rglob('*')) if p.is_file()]
    image_digest = hashlib.sha256(json.dumps(records, sort_keys=True).encode()).hexdigest()
    runtime_digest = hashlib.sha256(json.dumps(runtime, sort_keys=True).encode()).hexdigest()
    (root/'source-pins.json').write_text(json.dumps({'image': records, 'runtime': runtime, 'image_digest': image_digest, 'runtime_digest': runtime_digest}, indent=2)+'\n')
    owner = pwd.getpwuid(os.getuid())
    cfg = {'root': str(root/'h'), 'host_id': 'tart-gate', 'host_os': 'darwin',
           'listen': 'unix://'+str(root/'h/host.sock'), 'port_lease_root': str(root/'ports'),
           'runtime_digest': runtime_digest, 'tart_path': str(app/'Contents/MacOS/tart'),
           'launchd_domain': 'gui/'+str(owner.pw_uid),
           'profiles': [{'id': 'mac-xcode-v3', 'os': 'macos', 'arch': 'arm64', 'runtime': 'tart',
                         'cpu': 4, 'ram_mib': 8192, 'image_path': 'gate-seed', 'image_digest': image_digest}]}
    (root/'host.json').write_text(json.dumps(cfg, indent=2)+'\n')
    subprocess.run([str(args.gate_binary.resolve()), 'init', str(root)], check=True)
    seed = root/'h/tart/vms/gate-seed'
    seed.mkdir(parents=True)
    for name in ['config.json', 'nvram.bin', 'disk.img']:
        subprocess.run(['/bin/cp', '-c', str(args.seed/name), str(seed/name)], check=True)
    guest = root/'h/guest'
    guest.mkdir(mode=0o700)
    shutil.copy2(args.guest_binary, guest/'clankerbox-guest-darwin-arm64')
    label = 'org.clankerbox.tart-gate.'+root.name+'.host'
    plist = {'Label': label, 'UserName': owner.pw_name, 'WorkingDirectory': str(root),
             'ProgramArguments': [str(args.host_binary.resolve()), '--config', str(root/'host.json')],
             'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 5,
             'EnvironmentVariables': {'HOME': owner.pw_dir, 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin'},
             'StandardOutPath': str(root/'host.log'), 'StandardErrorPath': str(root/'host.log')}
    (root/'system-host.plist').write_bytes(plistlib.dumps(plist))
    print(root)


if __name__ == '__main__':
    main()
