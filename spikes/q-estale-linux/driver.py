#!/usr/bin/env python3
"""Local driver for the ESTALE / hunk-3 spike on the Linux KVM test host.

Owns a local WorkRun (local evidence) and one remote run directory
`~/clankerbox-rewrite/runs/estale-<4 hex>/` (manifest.json, scratch/, evidence/).
The remote id is short because smolvm's per-VM sockets live under
`$SMOLVM_DATA_DIR/.cache/smolvm/vms/<hash16>/` and Linux sun_path is 108 bytes.

Teardown callbacks are registered before the remote run directory exists
(callbacks run in reverse order):
  1. registered first, runs last: copy remote evidence here, then remove remote
     scratch, but only if callback 2 verified that no VM/process remains.
  2. stop+delete every machine in the run's private smolvm inventory, verify the
     inventory is empty and no process references the run's scratch, then take
     the closing process/unit inventory.

Every experiment runs inside one ssh session (estale_remote.py); its VMs are
created and deleted inside that session. Run in the background and poll
`<local run>/evidence/driver.log`.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
from scripts.work_runs import WorkRun  # noqa: E402

HOST = 'clanker@37.27.63.112'
SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=8', HOST]
REMOTE_RUNS = '/home/clanker/clankerbox-rewrite/runs'
HERE = Path(__file__).resolve().parent

# Run 1 ("documented"): the reproduction exactly as spikes/q-runtime-patch/RESULTS.md wrote it,
# then hunk 3. Run 2 ("prime2"): boot 2 looks up the lower in a new order before the targets.
PLANS = {
    'documented': [[('a1', ''), ('a2', '')], [('b1', ''), ('b2', ' --no-pkg')], [('c', '')]],
    'prime2': [[('a3', ' --prime2'), ('a4', ' --prime2')], [('b3', ' --prime2'), ('b4', ' --prime2 --no-pkg')]],
}
PLAN = sys.argv[1] if len(sys.argv) > 1 else 'documented'
if PLAN not in PLANS:
    sys.exit(f'usage: driver.py [{"|".join(PLANS)}]')


class Stop(Exception):
    pass


def raise_stop(signum, frame):
    raise Stop(f'signal {signum}')


for _sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(_sig, raise_stop)


def main():
    with WorkRun(f'estale-linux-{PLAN}') as run:
        rid = 'estale-' + run.path.name.rsplit('-', 1)[1][:4]
        rdir = f'{REMOTE_RUNS}/{rid}'
        remote_py = f'{rdir}/estale_remote.py'
        log_path = run.evidence / 'driver.log'
        state = {'remote_created': False, 'vms_verified_absent': False}

        def log(msg):
            line = f'{time.strftime("%Y-%m-%dT%H:%M:%S")} {msg}'
            print(line, flush=True)
            with open(log_path, 'a') as f:
                f.write(line + '\n')

        def record(**fields):
            path = run.evidence / 'resources.json'
            data = json.loads(path.read_text()) if path.exists() else {}
            data.update(fields)
            path.write_text(json.dumps(data, indent=2) + '\n')

        def ssh(remote_cmd, label, timeout=3600, check=True):
            """One ssh session; stream output into local evidence and the console."""
            log(f'ssh: {remote_cmd}')
            out_path = run.evidence / f'ssh-{label}.log'
            with open(out_path, 'a') as out:
                proc = subprocess.Popen(SSH + [remote_cmd], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        stdin=subprocess.DEVNULL, text=True)
                try:
                    deadline = time.time() + timeout
                    for line in proc.stdout:
                        out.write(line)
                        out.flush()
                        print(f'  [{label}] {line}', end='', flush=True)
                        if time.time() > deadline:
                            raise RuntimeError(f'{label} exceeded {timeout}s')
                    rc = proc.wait()
                except BaseException:
                    proc.terminate()
                    try:
                        proc.wait(10)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                    raise
            log(f'ssh {label}: rc={rc}')
            if check and rc != 0:
                raise RuntimeError(f'remote {label} failed rc={rc}; see {out_path}')
            return rc

        def remote(cmd, label=None, **kw):
            return ssh(f'python3 {remote_py} --run {rdir} {cmd}', label or cmd.replace(' ', '-'), **kw)

        def collect_and_clean():
            if not state['remote_created']:
                return
            dest = run.evidence / 'remote'
            dest.mkdir(exist_ok=True)
            r = subprocess.run(['scp', '-r', '-q', '-o', 'BatchMode=yes', f'{HOST}:{rdir}/evidence',
                                f'{HOST}:{rdir}/manifest.json', f'{HOST}:{rdir}/state.json', str(dest)],
                               capture_output=True, text=True, timeout=600)
            log(f'collected remote evidence rc={r.returncode} {r.stderr.strip()[-300:]}')
            if r.returncode != 0:
                raise RuntimeError('evidence collection failed; remote scratch retained')
            if not state['vms_verified_absent']:
                raise RuntimeError('remote VM teardown not verified; remote scratch retained for recovery')
            remote('finish', 'finish', timeout=600)
            subprocess.run(['scp', '-q', '-o', 'BatchMode=yes', f'{HOST}:{rdir}/manifest.json',
                            str(dest / 'manifest.json')], timeout=120)
            ssh(f'test ! -e {rdir}/scratch && echo "remote scratch absent"; '
                f'du -sh ~/clankerbox-rewrite {rdir}; ls -la {rdir}; '
                f'ps -eo pid,args | grep -E "clankerbox-rewrite-estale|{rid}" | grep -v grep || echo "no estale processes"',
                'final-check', timeout=300)

        run.on_cleanup(collect_and_clean)

        def teardown_vms():
            if not state['remote_created']:
                return
            remote('teardown', 'teardown', timeout=1800)
            remote('inventory after', 'inventory-after', timeout=600)
            state['vms_verified_absent'] = True
            log('remote VM teardown verified')

        run.on_cleanup(teardown_vms)

        record(remote_host=HOST, remote_run=rdir, machine_prefix='clankerbox-rewrite-estale-',
               remote_layout='manifest.json, scratch/ (smolvm HOME/SMOLVM_DATA_DIR/XDG_*, release), evidence/')
        log(f'local run {run.path.name}; remote run {rdir}')

        # Create the remote run dir (refuse if it exists), then upload the remote half.
        ssh(f'mkdir -p {REMOTE_RUNS} && mkdir -m 700 {rdir}', 'mkdir', timeout=60)
        state['remote_created'] = True
        subprocess.run(['scp', '-q', '-o', 'BatchMode=yes', str(HERE / 'estale_remote.py'), f'{HOST}:{remote_py}'],
                       check=True, timeout=120)
        remote('init')
        remote('inventory before', 'inventory-before', timeout=600)

        remote('setup', timeout=1800)
        verdicts = {}

        def result(tag):
            r = subprocess.run(SSH + [f'cat {rdir}/evidence/exp-{tag}.json'], capture_output=True, text=True,
                               timeout=120)
            try:
                return json.loads(r.stdout)
            except ValueError:
                return {'error': 'no result', 'stderr': r.stderr}

        for group in PLANS[PLAN]:
            for tag, flags in group:
                kind = 'c' if tag == 'c' else tag[0]
                remote(f'exp-{kind}' + ('' if kind == 'c' else f' {tag}') + flags, timeout=2700)
                res = result(tag)
                keys = (('source_state_after_restart', 'stop_after_restart_rc', 'delete_source_first_rc',
                         'stop_after_child_delete_rc', 'error') if kind == 'c' else
                        ('reproduced', 'stale_hits', 'error'))
                verdicts[tag] = {k: res.get(k) for k in keys}
                log(f'{tag}: {verdicts[tag]}')
                if res.get('reproduced'):
                    break  # a positive ends the group; a negative is repeated once
        (run.evidence / 'verdicts.json').write_text(json.dumps(verdicts, indent=2) + '\n')


if __name__ == '__main__':
    main()
