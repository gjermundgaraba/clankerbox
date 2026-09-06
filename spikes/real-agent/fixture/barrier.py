"""A real builtin shell tool blocks here across the VM RAM snapshot."""
import hashlib
import json
import os
from pathlib import Path
import time

root = Path(__file__).resolve().parent
nonce = os.urandom(32)  # Marker source exists only in this live process.
stat = Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()
identity = {'pid': os.getpid(), 'startTicks': int(stat[19]),
            'ramSha256': hashlib.sha256(nonce).hexdigest()}
(root / 'barrier-waiting.json').write_text(json.dumps(identity))
deadline = time.monotonic() + 900
while not (root / 'barrier-release.json').exists():
    if time.monotonic() > deadline:
        raise SystemExit('barrier timeout')
    time.sleep(0.2)
branch = json.loads((root / 'barrier-release.json').read_text())['branch']
if branch not in ('parent', 'child-a', 'child-b'):
    raise SystemExit('invalid branch')
identity['branch'] = branch
(root / 'barrier-result.json').write_text(json.dumps(identity))
print('BARRIER_BRANCH=' + branch, flush=True)
