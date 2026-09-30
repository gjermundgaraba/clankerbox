#!/usr/bin/env python3
"""Hold a clankerbox 0.11.0 dev environment inside an owned work run for spike S3.

Teardown is registered before anything is started. The run is held until
`<run>/teardown` exists or the driver receives SIGINT/SIGTERM, then the dev
controller is stopped, `dev destroy` runs and the absence of every owned native
resource is verified before scratch is removed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--work-runs', required=True, help='path to work_runs.py')
parser.add_argument('--root', required=True, help='work runs root')
parser.add_argument('--label', required=True)
parser.add_argument('--url', required=True, help='release archive URL; URL.sha256 must exist')
parser.add_argument('--cpus', type=int, default=4)
parser.add_argument('--ram-mib', type=int, default=8192)
args = parser.parse_args()

sys.path.insert(0, str(Path(args.work_runs).resolve().parent))
from work_runs import WorkRun  # noqa: E402


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


class Stop(Exception):
    pass


def raise_stop(signum, frame):
    raise Stop(f'signal {signum}')


signal.signal(signal.SIGTERM, raise_stop)
signal.signal(signal.SIGINT, raise_stop)

with WorkRun(args.label, root=args.root) as run:
    record(run, run_dir=str(run.path), host=platform.node(), os=platform.system())
    archive = run.scratch / 'release.tar.gz'
    log(run, f'downloading {args.url}')
    subprocess.run(['curl', '-fsSL', '-o', str(archive), args.url], check=True)
    expected = subprocess.run(['curl', '-fsSL', args.url + '.sha256'], check=True,
                              capture_output=True, text=True).stdout.split()[0]
    h = hashlib.sha256()
    with open(archive, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    digest = h.hexdigest()
    if digest != expected:
        raise SystemExit(f'archive digest {digest} != {expected}')
    log(run, f'archive verified {digest}')

    release = run.scratch / 'release'
    release.mkdir()
    old = os.umask(0o077)
    subprocess.run(['tar', '-xzpf', str(archive), '-C', str(release)], check=True)
    archive.unlink()
    os.umask(old)
    cli = next(release.rglob('clankerbox'))
    env_dir = run.scratch / 'env'
    record(run, cli=str(cli), state_dir=str(env_dir))
    log(run, f'cli {cli}')

    dev = {'process': None}

    def teardown():
        process = dev['process']
        if process and process.poll() is None:
            log(run, 'stopping foreground dev controller')
            process.send_signal(signal.SIGINT)
            try:
                process.wait(60)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if env_dir.exists() and (env_dir / 'environment.json').exists():
            environment = json.loads((env_dir / 'environment.json').read_text())
            record(run, environment=environment)
            log(run, 'dev destroy')
            result = subprocess.run([str(cli), 'dev', '--state-dir', str(env_dir), 'destroy'],
                                    capture_output=True, text=True, timeout=900)
            (run.evidence / 'destroy.log').write_text(result.stdout + result.stderr)
            if result.returncode != 0:
                raise RuntimeError(f'dev destroy failed: {result.stderr[-2000:]}')
        leftovers = subprocess.run(['pgrep', '-fl', str(run.scratch)], capture_output=True, text=True).stdout
        if leftovers.strip():
            raise RuntimeError(f'processes still reference scratch: {leftovers}')
        namespace = json.loads((run.evidence / 'resources.json').read_text()).get('namespace')
        if namespace:
            if platform.system() == 'Darwin':
                jobs = subprocess.run(['launchctl', 'list'], capture_output=True, text=True).stdout
            else:
                jobs = subprocess.run(['systemctl', '--user', 'list-units', '--all', '--no-legend'],
                                      capture_output=True, text=True).stdout
            remaining = [line for line in jobs.splitlines() if namespace in line]
            if remaining:
                raise RuntimeError(f'native jobs remain: {remaining}')
        log(run, 'teardown verified')

    run.on_cleanup(teardown)

    log_file = open(run.evidence / 'dev.log', 'w')
    dev['process'] = subprocess.Popen(
        [str(cli), '--json', 'dev', '--state-dir', str(env_dir),
         '--cpus', str(args.cpus), '--ram-mib', str(args.ram_mib)],
        stdout=log_file, stderr=subprocess.STDOUT, start_new_session=True)
    record(run, dev_pid=dev['process'].pid)
    deadline = time.time() + 600
    while not (env_dir / 'connection.json').exists():
        if dev['process'].poll() is not None:
            raise RuntimeError('dev exited before readiness; see evidence/dev.log')
        if time.time() > deadline:
            raise RuntimeError('dev not ready in 600s')
        time.sleep(1)
    environment = json.loads((env_dir / 'environment.json').read_text())
    record(run, namespace=environment.get('namespace'), host_root=environment.get('host_root'))
    log(run, f'dev ready namespace={environment.get("namespace")} host_root={environment.get("host_root")}')
    (run.path / 'ready').write_text(json.dumps({'cli': str(cli), 'state_dir': str(env_dir),
                                                'config': str(env_dir / 'client.json')}) + '\n')
    try:
        while not (run.path / 'teardown').exists():
            if dev['process'].poll() is not None:
                raise RuntimeError('dev controller exited unexpectedly')
            time.sleep(2)
        log(run, 'teardown requested')
    except Stop as stop:
        log(run, f'stop: {stop}')
