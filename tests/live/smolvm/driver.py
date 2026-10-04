#!/usr/bin/env python3
"""Runs the smolvm live suite (tests/live) from this Mac against a clankerbox host on a Linux test
host, over the tailnet: builds both SEAs, runs the linux one as root on the test host through
remote.py, and runs the suite with the darwin one as the CLI.

  python3 tests/live/smolvm/driver.py --ssh USER@HOST --address TAILNET_ADDRESS \\
    --root OWNED_ROOT --smolvm-prefix PREFIX [--suite-args 'VP TEST ARGS']

OWNED_ROOT is the test host's directory for this work (runs/ and CLEANUP.md live there), and
PREFIX the smolvm 1.22.2 install the host uses; both absolute. The driver runs the suite once,
tears down, and exits with the suite's code.

The run owns a local WorkRun (scripts/WORK_RUNS.md) and one remote run directory,
OWNED_ROOT/runs/l<3 hex>, short because smolvm's socket paths limit the host's state dir (the
host refuses one too long). Teardown, registered before what it owns, runs in reverse order:
remote `teardown` stops the host and removes the run's VMs and scopes natively, by the run's own
data dir, so it works after a test left the host down; then the remote evidence is copied here,
and remote `finish` removes scratch and reverts what the run changed outside the owned root.
The host's ID, unit, machine prefix, scope pattern and state dir come from the remote run's
state.json, which remote.py writes.
The suite's own key and scripts stay in its local temporary directory, which it removes.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))
from scripts.work_runs import WorkRun  # noqa: E402

HERE = Path(__file__).resolve().parent
DIST = REPO / 'tools' / 'release' / 'dist'


class Stop(Exception):
    pass


class Failed(Exception):
    """A failed suite, raised inside the WorkRun so its manifest's outcome reads failed."""

    def __init__(self, code):
        super().__init__(f'exit code {code}')
        self.code = code


def raise_stop(signum, frame):
    raise Stop(f'signal {signum}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ssh', required=True, help='USER@HOST of the Linux test host')
    parser.add_argument('--address', required=True, help="the test host's tailnet address")
    parser.add_argument('--root', required=True, help='the owned root on the test host')
    parser.add_argument('--smolvm-prefix', required=True, help='the smolvm 1.22.2 install prefix there')
    parser.add_argument('--suite-args', default='', help='arguments for the suite run, such as -t PATTERN')
    options = parser.parse_args()
    if not (options.root.startswith('/') and options.smolvm_prefix.startswith('/')):
        parser.error('--root and --smolvm-prefix must be absolute')
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, raise_stop)

    with WorkRun('live-smolvm') as run:
        rid = 'l' + run.path.name.rsplit('-', 1)[1][:3]
        # The run's own ssh master, so another run's exit can't close it.
        control_path = f'/tmp/cbx-live-{rid}-%C'
        ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=8',
               '-o', 'ControlMaster=auto', '-o', f'ControlPath={control_path}', '-o', 'ControlPersist=900',
               options.ssh]
        scp = ['scp', '-q', '-o', 'BatchMode=yes', '-o', 'ControlMaster=auto', '-o', f'ControlPath={control_path}',
               '-o', 'ControlPersist=900']
        rdir = f'{options.root}/runs/{rid}'
        remote_py = f'{rdir}/remote.py'
        # Quoted for the remote shell.
        q_rdir, q_root, q_remote_py = shlex.quote(rdir), shlex.quote(options.root), shlex.quote(remote_py)
        # The remote dir holds evidence from its creation; only an initialised run owns more.
        state = {'remote_dir': False, 'initialised': False, 'remote_clean': False}
        darwin_bin = run.scratch / 'clankerbox'
        client_config = run.scratch / 'client.json'
        control_bin = run.scratch / 'host-control'

        def log(msg):
            line = f'{time.strftime("%Y-%m-%dT%H:%M:%S")} {msg}'
            print(line, flush=True)
            with open(run.evidence / 'driver.log', 'a') as f:
                f.write(line + '\n')

        def record(**fields):
            path = run.evidence / 'resources.json'
            data = json.loads(path.read_text()) if path.exists() else {}
            data.update(fields)
            path.write_text(json.dumps(data, indent=2) + '\n')

        def sh(cmd, label, timeout=3600, check=True, env=None, cwd=None):
            log(f'$ {shlex.join(cmd)}')
            with open(run.evidence / f'{label}.log', 'a') as out:
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
            log(f'{label}: rc={rc}')
            if check and rc != 0:
                raise RuntimeError(f'{label} failed rc={rc}; see evidence/{label}.log')
            return rc

        def remote(cmd, label, timeout=1800):
            return sh(ssh + [f'python3 {q_remote_py} --run {q_rdir} {cmd}'], label, timeout=timeout)

        def upload_remote_program():
            subprocess.run(scp + [str(HERE / 'remote.py'), f'{options.ssh}:{remote_py}.tmp'], check=True, timeout=120)
            subprocess.run(ssh + [f'mv -f {shlex.quote(remote_py + ".tmp")} {q_remote_py}'], check=True, timeout=60)

        def collect():
            dest = run.evidence / 'remote'
            dest.mkdir(exist_ok=True)
            # Root-owned files the run wrote, such as the journal copy, inside the run dir.
            subprocess.run(ssh + [f'sudo -n chown -R "$(id -u):$(id -g)" {q_rdir}/evidence'], timeout=120)
            with open(run.evidence / 'local-root-runs.log', 'a') as f:
                f.write(f'{time.strftime("%Y-%m-%dT%H:%M:%S")} | sudo -n chown -R <user> {rdir}/evidence '
                        '| evidence ownership, inside the run dir\n')
            r = subprocess.run(scp + ['-r', f'{options.ssh}:{rdir}/evidence', f'{options.ssh}:{rdir}/manifest.json',
                                      f'{options.ssh}:{rdir}/state.json', str(dest)],
                               capture_output=True, text=True, timeout=900)
            log(f'collected remote evidence rc={r.returncode} {r.stderr.strip()[-300:]}')
            return r.returncode

        def collect_and_finish():
            try:
                if not state['remote_dir']:
                    return
                if not state['initialised']:
                    collect()
                    log(f'init did not complete, so nothing remote was torn down; {rdir} keeps its evidence')
                    return
                if collect() != 0:
                    raise RuntimeError('evidence collection failed; remote scratch retained')
                if not state['remote_clean']:
                    raise RuntimeError('teardown not verified; remote scratch and outside changes retained')
                try:
                    remote('finish', 'finish')
                finally:
                    collect()
                subprocess.run(scp + [f'{options.ssh}:{options.root}/CLEANUP.md', str(run.evidence / 'CLEANUP.md')],
                               timeout=120)
                sh(ssh + [f'test ! -e {q_rdir}/scratch && echo "remote scratch absent"; du -sh {q_rdir}; '
                          'stat -c "%a %U:%G %n" "$HOME"; getfacl -p "$HOME" 2>/dev/null; '
                          f'ls -la {shlex.quote(options.smolvm_prefix)}; '
                          "ps -eo pid,uid,args | awk '$2>=2000000' | grep -v PID || echo 'no uid>=2000000 process'; "
                          'systemctl list-units --all --no-legend "smolvm-vm-*" "clankerbox-rewrite*"; '
                          'echo "units listed above (empty = none)"'], 'final-check', timeout=300, check=False)
            finally:
                subprocess.run(['ssh', '-o', f'ControlPath={control_path}', '-O', 'exit', options.ssh],
                               capture_output=True, timeout=30)

        run.on_cleanup(collect_and_finish)

        def remote_teardown():
            if not state['initialised']:
                return
            remote('teardown', 'teardown')
            state['remote_clean'] = True
            log('remote teardown verified')

        run.on_cleanup(remote_teardown)

        def build():
            sh(['vp', 'run', '-r', 'build'], 'build', cwd=REPO)
            sh(['sh', 'tools/release/build-sea.sh', 'darwin-arm64', 'linux-x64'], 'build-sea', cwd=REPO)
            shutil.copy2(DIST / 'darwin-arm64' / 'clankerbox', darwin_bin)
            linux = run.scratch / 'clankerbox-linux-x64.gz'
            raw = (DIST / 'linux-x64' / 'clankerbox').read_bytes()
            sha = hashlib.sha256(raw).hexdigest()
            with gzip.open(linux, 'wb', compresslevel=6) as f:
                f.write(raw)
            shutil.rmtree(DIST)
            commit = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=REPO, capture_output=True, text=True).stdout
            log(f'SEAs from {commit.strip()}; linux {len(raw) / 2**20:.1f} MiB, gzipped '
                f'{linux.stat().st_size / 2**20:.1f} MiB, sha256 {sha}')
            return linux, sha

        def upload(linux, sha):
            t0 = time.monotonic()
            subprocess.run(scp + [str(linux), f'{options.ssh}:{rdir}/scratch/clankerbox.gz'], check=True,
                           timeout=1800)
            took = time.monotonic() - t0
            log(f'uploaded {linux.stat().st_size / 2**20:.1f} MiB in {took:.1f}s '
                f'({linux.stat().st_size / 2**20 / took:.2f} MiB/s)')
            subprocess.run(ssh + [f'gunzip -f {q_rdir}/scratch/clankerbox.gz'], check=True, timeout=300)
            remote(f'set-binary-sha {sha}', 'set-sha', timeout=60)

        record(remote_host=options.ssh, remote_run=rdir, smolvm_prefix=options.smolvm_prefix, address=options.address)
        log(f'local run {run.path.name}; remote run {rdir}')
        linux, sha = build()
        sh(ssh + [f'mkdir -p {q_root}/runs && mkdir -m 700 {q_rdir}'], 'mkdir', timeout=60)
        state['remote_dir'] = True
        upload_remote_program()
        remote(f'init {shlex.quote(options.address)} {shlex.quote(options.smolvm_prefix)}', 'init', timeout=600)
        state['initialised'] = True
        upload(linux, sha)
        remote('setup', 'setup', timeout=900)
        subprocess.run(scp + [f'{options.ssh}:{rdir}/state.json', str(run.scratch / 'remote-state.json')], check=True)
        remote_state = json.loads((run.scratch / 'remote-state.json').read_text())
        record(**{key: remote_state[key] for key in ('host_id', 'unit', 'machine_prefix', 'scope_pattern',
                                                       'state_dir', 'inventory', 'api_port')})
        client_config.write_text(json.dumps({'hosts': [{'id': remote_state['host_id'],
                                                        'url': f'http://{options.address}:{remote_state["api_port"]}'}]},
                                            indent=2) + '\n')
        remote_control = f'python3 {q_remote_py} --run {q_rdir} control '
        control_bin.write_text(f'''#!/usr/bin/env python3
# The live suite's host-control program: runs remote.py's `control OP ARGS` on the test host.
import shlex, subprocess, sys, time
ssh = {ssh!r}
cmd = {remote_control!r} + shlex.join(sys.argv[1:])
with open({str(run.evidence / 'control.log')!r}, 'a') as log:
    log.write(time.strftime('%H:%M:%S ') + shlex.join(sys.argv[1:]) + '\\n')
sys.exit(subprocess.run(ssh + [cmd], stdin=subprocess.DEVNULL).returncode)
''')
        control_bin.chmod(0o755)

        suite_env = dict(os.environ, CLANKERBOX_LIVE='1', CLANKERBOX_BIN=str(darwin_bin),
                         CLANKERBOX_LIVE_CONFIG=str(client_config), CLANKERBOX_LIVE_HOST_CONTROL=str(control_bin),
                         CLANKERBOX_LIVE_PREFIX=remote_state['machine_prefix'])
        # Verbose, so the evidence names every test's result and keeps its [timing] lines.
        rc = sh(['vp', 'test', '--reporter=verbose', *shlex.split(options.suite_args)], 'suite', env=suite_env,
                cwd=REPO / 'tests' / 'live', timeout=5400, check=False)
        record(suite={'rc': rc})
        if rc != 0:
            log(f'suite: rc={rc}; see evidence/suite.log')
            # Teardown still runs on the way out.
            raise Failed(rc)


if __name__ == '__main__':
    try:
        main()
    except Failed as failure:
        sys.exit(failure.code)
