"""What the live drivers (smolvm/driver.py, tart/driver.py, boat/driver.py) share: the commit a
run names, its signals, its evidence and the suite's run. A driver puts tests/live on its import
path and imports this module by name.
"""
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parents[2]
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

    def suite(self, runtime, binary, client_config, control, prefix, suite_args):
        """Runs the live suite on `runtime` (tests/live/tests/live.ts names the environment), and
        raises Failed unless it passes. The suite's key and scripts live in scratch, even if the
        suite dies before its afterAll."""
        tmp = self.run.scratch / 'tmp'
        tmp.mkdir()
        env = dict(os.environ, TMPDIR=str(tmp), CLANKERBOX_LIVE='1', CLANKERBOX_LIVE_RUNTIME=runtime,
                   CLANKERBOX_BIN=str(binary), CLANKERBOX_LIVE_CONFIG=str(client_config),
                   CLANKERBOX_LIVE_HOST_CONTROL=str(control), CLANKERBOX_LIVE_PREFIX=prefix)
        # Verbose, so the evidence names every test's result and keeps its [timing] lines.
        rc = self.sh(['vp', 'test', '--reporter=verbose', *shlex.split(suite_args)], 'suite', env=env,
                     cwd=REPO / 'tests' / 'live', timeout=5400, check=False)
        self.record(suite={'rc': rc})
        if rc != 0:
            self.log(f'suite: rc={rc}; see evidence/suite.log')
            # Teardown still runs on the way out.
            raise Failed(rc)
