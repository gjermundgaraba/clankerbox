#!/usr/bin/env python3
"""Private file preparation only. No VMs, networking, packages or global defaults."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import urllib.request

base = Path(__file__).resolve().parent
if not (base.name.startswith('clankerbox-cocoon.')): raise ValueError("validation failed: base.name.startswith('clankerbox-cocoon.')")
pins = json.loads((base / 'pins.json').read_text())
for name in ('bin', 'downloads', 'erofs', 'cni-bin', 'cni-conf', 'gates', 'results'):
    (base / name).mkdir(exist_ok=True)
items = [('firecracker.tgz', 'https://github.com/firecracker-microvm/firecracker/releases/download/v1.16.1/firecracker-v1.16.1-x86_64.tgz', pins['firecracker_x86_64_sha256']),
         ('erofs.deb', pins['erofs_deb'], pins['erofs_deb_sha256']),
         ('libdeflate.deb', pins['libdeflate_deb'], pins['libdeflate_deb_sha256'])]
for name, url, digest in items:
    target = base / 'downloads' / name
    if not target.exists():
        urllib.request.urlretrieve(url, target)
    if not (hashlib.sha256(target.read_bytes()).hexdigest() == digest): raise ValueError(name)
with tarfile.open(base / 'downloads/firecracker.tgz') as tar:
    member = next(m for m in tar.getmembers() if m.name.endswith('/firecracker-v1.16.1-x86_64'))
    (base / 'bin/firecracker').write_bytes(tar.extractfile(member).read())
(base / 'bin/firecracker').chmod(0o755)
subprocess.run(['dpkg-deb', '-x', str(base / 'downloads/erofs.deb'), str(base / 'erofs')], check=True)
subprocess.run(['dpkg-deb', '-x', str(base / 'downloads/libdeflate.deb'), str(base / 'erofs')], check=True)
os.environ['LD_LIBRARY_PATH'] = str(base / 'erofs/usr/lib/x86_64-linux-gnu')
subprocess.run([str(base / 'bin/firecracker'), '--version'], check=True)
subprocess.run([str(base / 'erofs/usr/bin/mkfs.erofs'), '--version'], check=True)
print('PRESTAGED', base)
