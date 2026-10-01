#!/usr/bin/env python3
"""Hold an isolated upstream smolvm 1.22.0 inventory inside an owned work run.

Spike Q (stock smolvm): downloads the upstream darwin-arm64 release and its
checksums into scratch, verifies them, and gives smolvm a private HOME so no
state lands in ~/. smolvm's per-VM sockets live under
$HOME/Library/Caches/smolvm/vms/<hash16>/agent.sock, and the macOS sun_path
budget is 104 bytes, so HOME is a short private root under /private/tmp (as
scripts/WORK_RUNS.md prescribes for Tart). Its path is recorded in evidence and
its removal is registered before the VM teardown callback (callbacks run in
reverse order: VMs stop first, then the root goes).

Teardown stops and deletes every machine in that private inventory (all are
named clankerbox-rewrite-*), verifies the inventory is empty and that no process
references the private root or the scratch binary, then removes the root.

The run is held until `<run>/teardown` exists or SIGINT/SIGTERM arrives.
Experiments run as separate processes using `<run>/ready` (env for smolvm).
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
from scripts.work_runs import WorkRun  # noqa: E402

VERSION = '1.22.0'
ASSET = f'smolvm-{VERSION}-darwin-arm64.tar.gz'
PREFIX = 'clankerbox-rewrite-'


class Stop(Exception):
    pass


def raise_stop(signum, frame):
    raise Stop(f'signal {signum}')


signal.signal(signal.SIGTERM, raise_stop)
signal.signal(signal.SIGINT, raise_stop)


def log(run, message):
    line = f'{time.strftime("%Y-%m-%dT%H:%M:%S")} {message}'
    print(line, flush=True)
    with open(run.evidence / 'driver.log', 'a') as f:
        f.write(line + '\n')


def record(run, **fields):
    path = run.evidence / 'resources.json'
    data = json.loads(path.read_text()) if path.exists() else {}
    data.update(fields)
    path.write_text(json.dumps(data, indent=2) + '\n')


with WorkRun('q-smolvm-stock') as run:
    state = {'home': None, 'smolvm': None, 'env': None}
    record(run, run_dir=str(run.path), machine_prefix=PREFIX)

    def remove_home():
        home = state['home']
        if home and Path(home).exists():
            # Only the directory this driver created (recorded in evidence).
            shutil.rmtree(home)
            log(run, f'removed private HOME {home}')

    run.on_cleanup(remove_home)
    home = tempfile.mkdtemp(prefix='cbq-', dir='/private/tmp')
    state['home'] = home
    record(run, private_home=home)
    log(run, f'private HOME {home}')

    def smolvm(*args, timeout=300):
        return subprocess.run([state['smolvm'], *args], env=state['env'],
                              capture_output=True, text=True, timeout=timeout)

    def machines():
        r = smolvm('machine', 'ls', '--json')
        if r.returncode != 0:
            raise RuntimeError(f'machine ls failed: {r.stderr}')
        data = json.loads(r.stdout or '[]')
        return data if isinstance(data, list) else data.get('machines', [])

    def teardown_vms():
        if not state['smolvm']:
            return
        log(run, 'teardown: stopping and deleting machines')
        out = []
        for attempt in range(4):
            ms = machines()
            out.append({'attempt': attempt, 'machines': ms})
            if not ms:
                break
            # Children before sources: delete refuses fork bases with live clones.
            for m in sorted(ms, key=lambda m: 0 if m.get('parent_machine') else 1):
                name = m.get('name')
                if not name or not name.startswith(PREFIX):
                    raise RuntimeError(f'unexpected machine in private inventory: {m}')
                s = smolvm('machine', 'stop', '--name', name, timeout=120)
                d = smolvm('machine', 'delete', '--name', name, '--force', timeout=120)
                out.append({'name': name, 'stop': [s.returncode, s.stderr[-500:]],
                            'delete': [d.returncode, d.stdout[-500:], d.stderr[-500:]]})
        (run.evidence / 'teardown.json').write_text(json.dumps(out, indent=2) + '\n')
        remaining = machines()
        if remaining:
            raise RuntimeError(f'machines remain: {[m.get("name") for m in remaining]}')
        for _ in range(30):
            procs = subprocess.run(['pgrep', '-fl', f'{home}|{run.scratch}'],
                                   capture_output=True, text=True).stdout.strip()
            if not procs:
                break
            time.sleep(1)
        if procs:
            raise RuntimeError(f'processes still reference the run: {procs}')
        log(run, 'teardown verified: inventory empty, no processes reference the run')

    run.on_cleanup(teardown_vms)

    log(run, f'downloading {ASSET} and checksums.sha256 from smol-machines/smolvm v{VERSION}')
    dl = run.scratch / 'dl'
    subprocess.run(['gh', 'release', 'download', f'v{VERSION}', '-R', 'smol-machines/smolvm',
                    '-p', ASSET, '-p', 'checksums.sha256', '-D', str(dl)], check=True)
    sums = (dl / 'checksums.sha256').read_text()
    (run.evidence / 'checksums.sha256').write_text(sums)
    expected = next(l.split()[0] for l in sums.splitlines() if l.strip().endswith(ASSET))
    h = hashlib.sha256()
    with open(dl / ASSET, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    if h.hexdigest() != expected:
        raise SystemExit(f'{ASSET} digest {h.hexdigest()} != {expected}')
    log(run, f'{ASSET} verified sha256={expected}')
    release = run.scratch / 'release'
    release.mkdir()
    subprocess.run(['tar', '-xzpf', str(dl / ASSET), '-C', str(release)], check=True)
    (dl / ASSET).unlink()
    listing = subprocess.run(['find', str(release), '-maxdepth', '3'], capture_output=True, text=True).stdout
    (run.evidence / 'release-listing.txt').write_text(listing)
    wrapper = next(p for p in release.rglob('smolvm') if p.is_file() and os.access(p, os.X_OK)
                   and p.parent.name != 'lib')
    state['smolvm'] = str(wrapper)
    env = dict(os.environ, HOME=home, TMPDIR=str(Path(home) / 'tmp'))
    for k in ('XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR',
              'SMOLVM_AGENT_ROOTFS', 'SMOLVM_DATA_DIR', 'DOCKER_CONFIG'):
        env.pop(k, None)
    os.makedirs(env['TMPDIR'], exist_ok=True)
    state['env'] = env
    record(run, smolvm=str(wrapper))
    v = smolvm('--version')
    log(run, f'smolvm --version: {v.stdout.strip()} {v.stderr.strip()}')
    if machines():
        raise RuntimeError('fresh private inventory is not empty')

    (run.path / 'ready').write_text(json.dumps({
        'smolvm': str(wrapper), 'home': home, 'scratch': str(run.scratch),
        'evidence': str(run.evidence), 'prefix': PREFIX,
        'env': {'HOME': home, 'TMPDIR': env['TMPDIR']}}) + '\n')
    log(run, 'ready')
    try:
        while not (run.path / 'teardown').exists():
            time.sleep(2)
        log(run, 'teardown requested')
    except Stop as stop:
        log(run, f'stop: {stop}')
