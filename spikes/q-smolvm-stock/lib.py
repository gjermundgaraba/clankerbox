"""Shared helpers for the spike Q step scripts. They run beside hold.py, which owns
the work run, the private smolvm HOME and teardown; see hold.py."""
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import time

RUNS = Path(__file__).resolve().parents[2] / '.work' / 'runs'


def find_run():
    if os.environ.get('Q_RUN'):
        path = Path(os.environ['Q_RUN'])
    else:
        held = [p for p in RUNS.glob('q-smolvm-stock-*') if (p / 'ready').exists()
                and not (p / 'teardown').exists()]
        if len(held) != 1:
            sys.exit(f'expected one held run, found {held}')
        path = held[0]
    return path, json.loads((path / 'ready').read_text())


RUN, READY = find_run()
EVIDENCE = Path(READY['evidence'])
SCRATCH = Path(READY['scratch'])
PREFIX = READY['prefix']
ENV = dict(os.environ)
for k in ('XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR',
          'SMOLVM_AGENT_ROOTFS', 'SMOLVM_DATA_DIR', 'DOCKER_CONFIG'):
    ENV.pop(k, None)
ENV.update(READY['env'])

_log_name = 'commands.log'


def set_log(name):
    global _log_name
    _log_name = name


def note(message):
    line = f'{time.strftime("%H:%M:%S")} # {message}'
    print(line, flush=True)
    with open(EVIDENCE / _log_name, 'a') as f:
        f.write(line + '\n')


def sh(cmd, *, check=False, timeout=600, input=None, quiet=False):
    """Run a host command; log the exact command, wall time, exit code and output."""
    shown = ' '.join(shlex.quote(c) for c in cmd).replace(READY['smolvm'], 'smolvm')
    t0 = time.monotonic()
    try:
        r = subprocess.run(cmd, env=ENV, capture_output=True, text=True, timeout=timeout, input=input)
        rc, out, err = r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired as e:
        rc, out, err = 'timeout', (e.stdout or b'').decode() if isinstance(e.stdout, bytes) else (e.stdout or ''), \
            (e.stderr or b'').decode() if isinstance(e.stderr, bytes) else (e.stderr or '')
    dt = time.monotonic() - t0
    with open(EVIDENCE / _log_name, 'a') as f:
        f.write(f'{time.strftime("%H:%M:%S")} $ {shown}\n  [rc={rc} {dt:.2f}s]\n')
        if out.strip():
            f.write(''.join('  | ' + l + '\n' for l in out.rstrip('\n').split('\n')[-200:]))
        if err.strip():
            f.write(''.join('  ! ' + l + '\n' for l in err.rstrip('\n').split('\n')[-60:]))
    if not quiet:
        print(f'$ {shown}\n  [rc={rc} {dt:.2f}s] {out.strip()[-1500:]} {err.strip()[-1500:]}', flush=True)
    if check and rc != 0:
        raise RuntimeError(f'command failed rc={rc}: {shown}\n{err[-2000:]}')
    return rc, out, err, dt


def smolvm(*args, **kw):
    return sh([READY['smolvm'], *args], **kw)


def gx(name, script, **kw):
    """Run a shell script in the guest over `machine exec`."""
    return smolvm('machine', 'exec', '--name', name, '--', 'sh', '-c', script, **kw)


def status(name, tag):
    rc, out, err, _ = smolvm('machine', 'status', '--name', name, '--json', quiet=True)
    (EVIDENCE / f'status-{tag}.json').write_text(out if out.strip() else err)
    try:
        return json.loads(out)
    except ValueError:
        return {}


def free_port(lo=20000, hi=32000):
    """Bind-probe a host loopback port below the ephemeral range."""
    import random
    for _ in range(200):
        p = random.randint(lo, hi)
        s = socket.socket()
        try:
            s.bind(('127.0.0.1', p))
            return p
        except OSError:
            pass
        finally:
            s.close()
    raise RuntimeError('no free port')
