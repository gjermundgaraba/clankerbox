#!/usr/bin/env python3
"""Local driver for plan spike P4 ("smolvm as root") on the Linux KVM test host.

Owns a local WorkRun (local evidence) and one remote run directory
`~/clankerbox-rewrite/runs/p4-root-<3 hex>/` (manifest.json, scratch/, evidence/).
The remote id is 3 hex because the root data root `<run>/scratch/r` plus
`/.cache/smolvm/vms/<hash16>/control.sock` must fit the 108-byte sun_path.

Teardown callbacks are registered before the remote run directory exists
(callbacks run in reverse order):
  1. registered first, runs last: collect remote evidence; `finish` (only after
     callback 2 verified teardown): remove /dev/shm/smolvm-restore if this run
     created it, `sudo rm -rf` the exact scratch path, restore the directory
     modes smolvm widened, take the "after" snapshot and diff, mark the
     CLEANUP.md entries; then the closing production inventory.
  2. remote `teardown`: stop+delete every machine in both private inventories
     (root and clanker), stop/reset every clankerbox-rewrite-p4-* unit and
     smolvm-vm-clankerbox-rewrite-p4-* scope, verify no process references scratch.

Run in the background and poll `<local run>/evidence/driver.log`.
"""
import json
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
PHASES = sys.argv[1:] or ['q1q2', 'unpriv', 'q3']


class Stop(Exception):
    pass


def raise_stop(signum, frame):
    raise Stop(f'signal {signum}')


for _sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(_sig, raise_stop)


def main():
    with WorkRun('p4-root') as run:
        rid = 'p4-root-' + run.path.name.rsplit('-', 1)[1][:3]
        rdir = f'{REMOTE_RUNS}/{rid}'
        remote_py = f'{rdir}/p4_remote.py'
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

        def collect(tag):
            dest = run.evidence / 'remote'
            dest.mkdir(exist_ok=True)
            r = subprocess.run(['scp', '-r', '-q', '-o', 'BatchMode=yes', f'{HOST}:{rdir}/evidence',
                                f'{HOST}:{rdir}/manifest.json', f'{HOST}:{rdir}/state.json', str(dest)],
                               capture_output=True, text=True, timeout=600)
            log(f'collected remote evidence ({tag}) rc={r.returncode} {r.stderr.strip()[-300:]}')
            return r.returncode

        def collect_and_clean():
            if not state['remote_created']:
                return
            # Evidence written by root (unit logs) must be readable before scp.
            ssh(f'sudo -n chown -R clanker:clanker {rdir}/evidence', 'chown-evidence', timeout=120, check=False)
            if collect('pre-finish') != 0:
                raise RuntimeError('evidence collection failed; remote scratch retained')
            if not state['vms_verified_absent']:
                raise RuntimeError('remote VM teardown not verified; remote scratch and outside changes retained')
            remote('finish', 'finish', timeout=1800)
            remote('inventory after', 'inventory-after', timeout=600)
            collect('final')
            subprocess.run(['scp', '-q', '-o', 'BatchMode=yes', f'{HOST}:/home/clanker/clankerbox-rewrite/CLEANUP.md',
                            str(run.evidence / 'CLEANUP.md')], timeout=120)
            ssh(f'test ! -e {rdir}/scratch && echo "remote scratch absent"; du -sh ~/clankerbox-rewrite {rdir}; '
                f'ls -la {rdir}; stat -c "%a %U:%G %n" /home/clanker ~/clankerbox-rewrite ~/clankerbox-rewrite/runs; '
                f'getfacl -p /home/clanker 2>/dev/null; '
                f'ps -eo pid,uid,args | grep -E "clankerbox-rewrite-p4|{rid}|_boot-vm" | grep -v grep || '
                f'echo "no p4 processes"; ps -eo pid,uid,args | awk \'$2>=2000000\' | grep -v "PID" || '
                f'echo "no uid>=2000000 processes"; '
                f'systemctl list-units --all --no-legend "clankerbox-rewrite-p4-*" "smolvm-vm-*" || true; '
                f'echo "units listed above (empty = none)"; sudo -n ls -la /dev/shm; '
                f'ps -o pid,lstart,args -p 2301,2149,2155; '
                f'systemctl --user show clankerbox-host.service -p MainPID,ExecMainStartTimestamp,ActiveState',
                'final-check', timeout=300)

        run.on_cleanup(collect_and_clean)

        def teardown_vms():
            if not state['remote_created']:
                return
            remote('teardown', 'teardown', timeout=2400)
            state['vms_verified_absent'] = True
            log('remote VM/unit teardown verified')

        run.on_cleanup(teardown_vms)

        record(remote_host=HOST, remote_run=rdir, machine_prefix='clankerbox-rewrite-p4-',
               unit_prefix='clankerbox-rewrite-p4-host-', scope_prefix='smolvm-vm-clankerbox-rewrite-p4-',
               data_roots={'root': f'{rdir}/scratch/r', 'user': f'{rdir}/scratch/u'},
               publish_addr='127.0.0.2', egress_floor='strict',
               remote_layout='manifest.json, scratch/ (releases, data roots, keys, checkpoints), evidence/')
        log(f'local run {run.path.name}; remote run {rdir}')

        ssh(f'mkdir -p {REMOTE_RUNS} && mkdir -m 700 {rdir}', 'mkdir', timeout=60)
        state['remote_created'] = True
        subprocess.run(['scp', '-q', '-o', 'BatchMode=yes', str(HERE / 'p4_remote.py'), f'{HOST}:{remote_py}'],
                       check=True, timeout=120)
        remote('init', timeout=1800)
        remote('inventory before', 'inventory-before', timeout=600)
        remote('setup', timeout=1800)
        for phase in PHASES:
            remote(phase, timeout=3600)


if __name__ == '__main__':
    main()
