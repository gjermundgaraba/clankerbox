"""What the live drivers (smolvm/driver.py, tart/driver.py, boat/driver.py) share: the commit a
run names, its signals, its evidence and the suite's run, the release bundles it builds in its
scratch and the binary it takes from one, and for a host on this Mac, its keeper, its start and end,
its API port and a file's checksum. A driver puts tests/live on its import path and imports this
module by name.
"""
import hashlib
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import subprocess
import sys
import tarfile
import time

REPO = Path(__file__).resolve().parents[2]
RELEASE = REPO / 'tools' / 'release'
sys.path.insert(0, str(REPO))
from scripts.work_runs import WorkRun  # noqa: E402, F401


class Stop(Exception):
    pass


class Failed(Exception):
    """A failed suite, raised inside the WorkRun so its manifest's outcome reads failed."""

    def __init__(self, code):
        super().__init__(f'exit code {code}')
        self.code = code


def raise_stop(signum, frame):
    raise Stop(f'signal {signum}')


def stop_on_signals():
    """Turns SIGTERM, SIGHUP and SIGINT into Stop, so the WorkRun's teardown runs."""
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, raise_stop)


def clean_commit():
    """HEAD, which names the code the run builds, provided the tree holds no change on it."""
    status = subprocess.run(['git', 'status', '--porcelain'], cwd=REPO, capture_output=True, text=True,
                            check=True).stdout
    if status:
        sys.exit(f'the tree has uncommitted changes, which no commit would name; commit them first:\n{status}')
    return subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=REPO, capture_output=True, text=True,
                          check=True).stdout.strip()


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 22), b''):
            digest.update(chunk)
    return digest.hexdigest()


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def read_int(path):
    try:
        return int(path.read_text().strip())
    except (FileNotFoundError, ValueError):
        return None


def free_port(address):
    """A port outside the machines' range (10000-19999) that binds on `address`."""
    for port in range(47000, 48000):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind((address, port))
            except OSError:
                continue
            return port
    raise RuntimeError(f'no free port in 47000-47999 on {address}')


# A host on this Mac and its keeper. The run's state file names its scratch, evidence, binary,
# config, address and API port.

def keep(state, env=None):
    """Runs the host to its end with environment `env` (None: the keeper's own), recording its pid
    and exit status (negative: the signal)."""
    scratch = Path(state['scratch'])
    with open(Path(state['evidence']) / 'host.log', 'a') as log:
        log.write(f'--- host start {time.strftime("%Y-%m-%dT%H:%M:%S")}\n')
        log.flush()
        host = subprocess.Popen([state['binary'], 'host', '--config', state['config']], stdout=log,
                                stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env)
        (scratch / 'host.pid.new').write_text(f'{host.pid}\n')
        (scratch / 'host.pid.new').replace(scratch / 'host.pid')
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        code = host.wait()
        (scratch / 'host.exit.new').write_text(f'{code}\n')
        (scratch / 'host.exit.new').replace(scratch / 'host.exit')


def host_start(state, driver):
    """Starts the host under a keeper, `driver keep STATE_FILE`, and returns its pid once it
    listens."""
    scratch = Path(state['scratch'])
    pid = read_int(scratch / 'host.pid')
    if pid is not None and alive(pid) and not (scratch / 'host.exit').exists():
        raise RuntimeError(f'the host already runs as pid {pid}')
    for name in ('host.pid', 'host.exit'):
        (scratch / name).unlink(missing_ok=True)
    subprocess.Popen([sys.executable, str(driver), 'keep', state['state_file']], start_new_session=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if (scratch / 'host.exit').exists():
            log = (Path(state['evidence']) / 'host.log').read_text()[-2000:]
            raise RuntimeError(f'the host exited {(scratch / "host.exit").read_text().strip()} at startup:\n{log}')
        try:
            with socket.create_connection((state['address'], state['api_port']), timeout=2):
                return read_int(scratch / 'host.pid')
        except OSError:
            time.sleep(0.25)
    raise RuntimeError('the host did not listen within 60 s')


def host_end(state, sig, expected, wait=60):
    """Signals the host and waits for its keeper to record how it ended."""
    scratch = Path(state['scratch'])
    pid = read_int(scratch / 'host.pid')
    if pid is None or (scratch / 'host.exit').exists():
        raise RuntimeError('the host does not run')
    os.kill(pid, sig)
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        code = read_int(scratch / 'host.exit')
        if code is not None:
            if code != expected:
                raise RuntimeError(f'the host ended with {code}, not {expected}')
            return
        time.sleep(0.1)
    raise RuntimeError(f'the host did not end within {wait} s of signal {sig}')


class Evidence:
    """A run's evidence: the driver's log, resources.json and each command's own log."""

    def __init__(self, run):
        self.run = run

    def log(self, msg):
        line = f'{time.strftime("%Y-%m-%dT%H:%M:%S")} {msg}'
        print(line, flush=True)
        with open(self.run.evidence / 'driver.log', 'a') as f:
            f.write(line + '\n')

    def record(self, **fields):
        path = self.run.evidence / 'resources.json'
        data = json.loads(path.read_text()) if path.exists() else {}
        data.update(fields)
        path.write_text(json.dumps(data, indent=2) + '\n')

    def sh(self, cmd, label, timeout=3600, check=True, env=None, cwd=None):
        self.log(f'$ {shlex.join(cmd)}')
        with open(self.run.evidence / f'{label}.log', 'a') as out:
            proc = subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                    env=env, cwd=cwd, start_new_session=True)
            try:
                rc = proc.wait(timeout)
            except BaseException:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(15)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait()
                raise
        self.log(f'{label}: rc={rc}')
        if check and rc != 0:
            raise RuntimeError(f'{label} failed rc={rc}; see evidence/{label}.log')
        return rc

    def build_binary(self, binary, also=()):
        """Builds the code, then tools/release/build.sh's darwin-arm64 bundle and one for each
        target in `also`, into the run's scratch/bundles; smokes the darwin-arm64 bundle with
        tools/release/smoke.sh, writes its binary to `binary`, executable, and records every
        bundle. Returns each target's bundle, beside its .sha256."""
        out = self.run.scratch / 'bundles'
        targets = ('darwin-arm64', *also)
        self.sh(['vp', 'run', '-r', 'build'], 'build', cwd=REPO)
        self.sh(['sh', str(RELEASE / 'build.sh'), '--out', str(out), *targets], 'bundle', cwd=REPO)
        bundles = {}
        for target in targets:
            found = sorted(out.glob(f'clankerbox-*-{target}.tar.gz'))
            if len(found) != 1:
                raise RuntimeError(f'build.sh left {len(found)} {target} bundles in {out}, not one')
            bundles[target] = found[0]
        # Smoke's own temporary directory stays in scratch.
        self.sh(['sh', str(RELEASE / 'smoke.sh'), str(bundles['darwin-arm64'])], 'smoke',
                env=dict(os.environ, TMPDIR=str(self.run.scratch)))
        with tarfile.open(bundles['darwin-arm64']) as bundle:
            binary.write_bytes(bundle.extractfile('clankerbox').read())
        binary.chmod(0o755)
        self.record(bundles={target: {'name': path.name, 'bytes': path.stat().st_size, 'sha256': sha256(path)}
                             for target, path in bundles.items()},
                    binary={'bytes': binary.stat().st_size, 'sha256': sha256(binary)})
        for target, path in bundles.items():
            self.log(f'{path.name}: {path.stat().st_size / 2**20:.1f} MiB, sha256 {sha256(path)}')
        self.log(f'binary: {binary.stat().st_size / 2**20:.1f} MiB, sha256 {sha256(binary)}')
        return bundles

    def suite(self, runtime, binary, client_config, control, prefix, suite_args, extra_env=None):
        """Runs the live suite on `runtime` (tests/live/tests/live.ts names the environment, and
        `extra_env` adds the runtime's own), and raises Failed unless it passes. The suite's key
        and scripts live in scratch, even if the suite dies before its afterAll."""
        tmp = self.run.scratch / 'tmp'
        tmp.mkdir()
        env = dict(os.environ, TMPDIR=str(tmp), CLANKERBOX_LIVE='1', CLANKERBOX_LIVE_RUNTIME=runtime,
                   CLANKERBOX_BIN=str(binary), CLANKERBOX_LIVE_CONFIG=str(client_config),
                   CLANKERBOX_LIVE_HOST_CONTROL=str(control), CLANKERBOX_LIVE_PREFIX=prefix, **(extra_env or {}))
        # Verbose, so the evidence names every test's result and keeps its [timing] lines.
        rc = self.sh(['vp', 'test', '--reporter=verbose', *shlex.split(suite_args)], 'suite', env=env,
                     cwd=REPO / 'tests' / 'live', timeout=5400, check=False)
        self.record(suite={'rc': rc})
        if rc != 0:
            self.log(f'suite: rc={rc}; see evidence/suite.log')
            # Teardown still runs on the way out.
            raise Failed(rc)
