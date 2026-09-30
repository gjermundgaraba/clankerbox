#!/usr/bin/env python3
"""Hold one Tart macOS VM, cloned from the retained local seed, in an owned run.

The seed is only read (APFS clone). The VM lives under a private host root of at
most 37 bytes (scripts/WORK_RUNS.md). Removal of that root is registered before
the VM is started; stopping the VM is registered after, so it runs first. Held
until `<run>/teardown` exists or SIGINT/SIGTERM.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'scripts'))
from work_runs import WorkRun  # noqa: E402

SEED = Path('/Users/gg/ws/pers/clankerbox/.work/inputs/tart-local')
TART = SEED / 'tart.app/Contents/MacOS/tart'
NAME = 'clankerbox-rewrite-s3'


class Stop(Exception):
    pass


def raise_stop(signum, frame):
    raise Stop(f'signal {signum}')


signal.signal(signal.SIGTERM, raise_stop)
signal.signal(signal.SIGINT, raise_stop)

with WorkRun('s3-tart', root=REPO / '.work' / 'runs') as run:
    def log(message):
        line = f'{time.strftime("%Y-%m-%dT%H:%M:%S")} {message}'
        print(line, flush=True)
        with open(run.evidence / 'driver.log', 'a') as f:
            f.write(line + '\n')

    root = Path(tempfile.mkdtemp(prefix='clankerbox-', dir='/private/tmp'))
    if len(str(root)) > 37:
        raise SystemExit(f'host root too long: {root}')
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'C', 'NO_COLOR': '1',
           'HOME': str(root), 'TART_HOME': str(root / 'tart'), 'TART_NO_AUTO_PRUNE': '1'}
    resources = {'host_root': str(root), 'vm': NAME, 'tart': str(TART), 'seed': str(SEED / 'home/vms/local-base')}
    (run.evidence / 'resources.json').write_text(json.dumps(resources, indent=2) + '\n')

    def remove_root():
        subprocess.run(['rm', '-rf', str(root)], check=True)
        if root.exists():
            raise RuntimeError(f'{root} still exists')
        log('host root removed')

    run.on_cleanup(remove_root)
    vm = {'process': None}

    def stop_vm():
        subprocess.run([str(TART), 'stop', NAME], env=env, capture_output=True, timeout=180)
        process = vm['process']
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(60)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        leftovers = subprocess.run(['pgrep', '-fl', str(root)], capture_output=True, text=True).stdout
        if leftovers.strip():
            raise RuntimeError(f'processes still reference {root}: {leftovers}')
        log('vm stopped and verified')

    run.on_cleanup(stop_vm)

    vms = root / 'tart' / 'vms'
    vms.mkdir(parents=True)
    subprocess.run(['cp', '-c', '-R', str(SEED / 'home/vms/local-base'), str(vms / NAME)], check=True)
    log(f'cloned seed into {vms / NAME}')
    vm['process'] = subprocess.Popen([str(TART), 'run', '--no-graphics', NAME], env=env,
                                     stdout=open(run.evidence / 'tart-run.log', 'w'), stderr=subprocess.STDOUT,
                                     start_new_session=True)
    started = time.time()
    while True:
        probe = subprocess.run([str(TART), 'exec', NAME, 'true'], env=env, capture_output=True, text=True)
        if probe.returncode == 0:
            break
        if vm['process'].poll() is not None:
            raise RuntimeError('tart run exited; see evidence/tart-run.log')
        if time.time() - started > 600:
            raise RuntimeError(f'guest agent not ready: {probe.stderr[-500:]}')
        time.sleep(2)
    log(f'guest exec ready after {time.time() - started:.1f}s')
    (run.path / 'ready').write_text(json.dumps({'tart': str(TART), 'name': NAME, 'env': env}) + '\n')
    try:
        while not (run.path / 'teardown').exists():
            if vm['process'].poll() is not None:
                raise RuntimeError('tart run exited unexpectedly')
            time.sleep(2)
        log('teardown requested')
    except Stop as stop:
        log(f'stop: {stop}')
