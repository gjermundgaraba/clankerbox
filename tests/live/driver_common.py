import hashlib
import json
import os
from pathlib import Path
import re
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
from scripts.work_runs import WorkRun, stop_group  # noqa: E402, F401


class Stop(Exception):
    pass


def raise_stop(signum, frame):
    raise Stop(f'signal {signum}')


def stop_on_signals():
    """Turns SIGTERM, SIGHUP and SIGINT into Stop, so the WorkRun's teardown runs; the WorkRun
    ignores them while it does."""
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, raise_stop)


def clean_commit():
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


def processes(text):
    out = subprocess.run(['ps', '-axo', 'pid=,command='], capture_output=True, text=True, check=True).stdout
    found = []
    for line in out.splitlines():
        pid, _, command = line.strip().partition(' ')
        if text in command and int(pid) != os.getpid():
            found.append((int(pid), command))
    return found


def redact(evidence, values, log, what):
    leaked = []
    for path in sorted(evidence.rglob('*')):
        if not path.is_file():
            continue
        text = path.read_bytes()
        found = [value for value in values if value in text]
        if found:
            for value in found:
                text = text.replace(value, b'<redacted>')
            path.write_bytes(text)
            leaked.append(str(path.relative_to(evidence)))
    if leaked:
        log(f'{what} was in {leaked}; redacted')
    return leaked


def agent_env(run, option, log):
    """The suite's environment for its Sandbox Agent tests, which run only when a driver's
    --agent-env-file names a file of NAME=value lines holding an LLM credential. The suite copies
    the file into a recipe in its temporary directory, under the run's scratch.

    The values are read as the guest reads them, by sourcing the file with sh. The teardown step
    registered here redacts them from the evidence and fails the run if one was there, leaving
    teardown itself to finish, so scratch and any copy of the file in it go. A driver calls this
    before it registers any other teardown: this one then runs last."""
    if option is None:
        return {}
    file = Path(option).resolve()
    names = re.findall(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=', file.read_text(), re.M)
    sourced = subprocess.run(['env', '-i', '/bin/sh', '-c', 'set -a; . "$1"; env -0', 'sh', str(file)],
                             capture_output=True, check=True, stdin=subprocess.DEVNULL).stdout
    env = dict(item.split(b'=', 1) for item in sourced.split(b'\0') if b'=' in item)
    # A value too short to be a credential would also match ordinary text.
    values = [env[name.encode()] for name in names if len(env.get(name.encode(), b'')) >= 12]
    if not values:
        sys.exit(f'{file} holds no NAME=value line with a credential')

    def check():
        leaked = redact(run.evidence, values, log, 'an agent credential')
        if leaked:
            # The smolvm driver's remote/ is a copy of the test host's evidence, which keeps its own.
            remote = ("; the test host's own copy of the run's evidence holds it too: remove it there"
                      if any(path.startswith('remote/') for path in leaked) else '')
            run.fail(f'an agent credential reached evidence: {leaked}{remote}')

    run.on_cleanup(check)
    return {'CLANKERBOX_LIVE_AGENT_ENV': str(file)}


def write_client_config(path, hosts):
    path.write_text(json.dumps({'hosts': [{'id': host_id, 'url': f'http://{address}:{port}'}
                                          for host_id, address, port in hosts]}, indent=2) + '\n')


def choose_address(wanted):
    if wanted is None:
        return '127.0.0.1', 'no address given'
    if not re.search(rf'^\tinet {re.escape(wanted)} ',
                     subprocess.run(['ifconfig'], capture_output=True, text=True).stdout, re.M):
        return '127.0.0.1', f'{wanted} is not assigned on this Mac'
    return wanted, 'the tailnet address, as production listens'


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


def stop_host(scratch, log, fail):
    """Stops the host whose keeper records its pid in `scratch`, if it runs: SIGTERM, then
    SIGKILL after 30 s. Waits up to 10 s for its keeper to record its exit, and logs it. 130, the
    host's exit on SIGTERM, is its contract: any other exit, or none recorded, goes to `fail`
    (WorkRun.fail), which fails the run's verdict while its teardown goes on. Returns the host's
    pid."""
    pid = read_int(scratch / 'host.pid')
    if pid is None or (scratch / 'host.exit').exists():
        return pid
    if alive(pid):
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 30
        while alive(pid) and time.monotonic() < deadline:
            time.sleep(0.2)
        if alive(pid):
            os.kill(pid, signal.SIGKILL)
    deadline = time.monotonic() + 10
    while (code := read_int(scratch / 'host.exit')) is None and time.monotonic() < deadline:
        time.sleep(0.2)
    if alive(pid):
        raise RuntimeError(f'the host (pid {pid}) still runs after SIGKILL')
    ended = 'left no exit status' if code is None else f'exited {code}{"" if code == 130 else ", not 130"}'
    log(f'teardown: stopped the host (pid {pid}); it {ended}')
    if code != 130:
        fail(f'the host (pid {pid}) {ended} on teardown\'s SIGTERM')
    return pid


def write_control_stub(path, driver, state_file):
    path.write_text(f'#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(driver))} control '
                    f'{shlex.quote(str(state_file))} "$@"\n')
    path.chmod(0o755)


def control(driver, state_file, op, args, ops):
    state = json.loads(Path(state_file).read_text())
    with open(Path(state['evidence']) / 'control.log', 'a') as log:
        log.write(f'{time.strftime("%H:%M:%S")} {shlex.join([op, *args])}\n')
    if op == 'host-start':
        host_start(state, driver)
    elif op == 'host-stop':
        host_end(state, signal.SIGTERM, 130)
    elif op == 'host-kill':
        host_end(state, signal.SIGKILL, -signal.SIGKILL)
    elif op == 'probe':
        address, port = args
        try:
            with socket.create_connection((address, int(port)), timeout=5):
                print('reached')
        except OSError:
            print('unreachable')
    elif op in ops:
        return ops[op](state, args) or 0
    else:
        print(f'unknown op {op}', file=sys.stderr)
        return 2
    return 0


def run_driver(driver, main, ops, keep_env=None):
    if sys.argv[1:2] == ['keep']:
        state = json.loads(Path(sys.argv[2]).read_text())
        keep(state, keep_env and keep_env(state))
    elif sys.argv[1:2] == ['control']:
        try:
            sys.exit(control(driver, sys.argv[2], sys.argv[3], sys.argv[4:], ops))
        except RuntimeError as error:
            print(error, file=sys.stderr)
            sys.exit(1)
    else:
        main()


class Steps:
    """A teardown's steps: every step runs even after one failed, each failure is logged and
    noted, and `done` raises with them all."""

    def __init__(self, log):
        self.log = log
        self.errors = []

    def __call__(self, what, action, *args):
        try:
            return action(*args)
        except Exception as error:
            self.fail(f'{what}: {error}')
            return None

    def fail(self, message):
        self.errors.append(message)
        self.log(f'teardown: {message}')

    def done(self):
        if self.errors:
            raise RuntimeError('; '.join(self.errors))


class Evidence:

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
            # Its group goes with it, after its exit too, so no descendant outlives the command.
            try:
                rc = proc.wait(timeout)
            finally:
                stop_group(proc)
        self.log(f'{label}: rc={rc}')
        if check and rc != 0:
            raise RuntimeError(f'{label} failed rc={rc}; see evidence/{label}.log')
        return rc

    def build_binary(self, binary, also=()):
        out = self.run.scratch / 'bundles'
        targets = ('darwin-arm64', *also)
        self.sh(['vp', 'run', '-r', 'build'], 'build', cwd=REPO)
        self.sh(['sh', str(RELEASE / 'build.sh'), '--out', str(out), *targets], 'bundle', cwd=REPO)
        bundles = {target: out / f'clankerbox-{target}.tar.gz' for target in targets}
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
        `extra_env` adds the runtime's own), and exits with its code unless it passes, inside the
        WorkRun, so its manifest's outcome reads failed and teardown still runs. The suite's key
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
            raise SystemExit(rc)
