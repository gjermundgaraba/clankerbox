"""stop_group and WorkRun's teardown, on harmless processes of the test's own:
`python3 -m unittest discover -s scripts`."""
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import unittest

from work_runs import TEARDOWN_SIGNALS, WorkRun, stop_group


class Interrupted(Exception):
    pass


def interrupt(signum, frame):
    raise Interrupted(signum)


class Teardown(unittest.TestCase):
    def setUp(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.root = Path(root.name).resolve()
        for sig in TEARDOWN_SIGNALS:
            self.addCleanup(signal.signal, sig, signal.signal(sig, interrupt))

    def test_a_signal_during_teardown_skips_no_step(self):
        """As a driver's second Ctrl-C or SIGTERM: each callback goes on past it, and so do the
        callbacks after it; the driver's handlers are back once teardown ends."""
        finished = []

        def step(name):
            for sig in TEARDOWN_SIGNALS:
                os.kill(os.getpid(), sig)
            finished.append(name)

        with self.assertRaises(Interrupted):
            with WorkRun('teardown-signals', root=self.root) as run:
                run.on_cleanup(lambda: step('second'))
                run.on_cleanup(lambda: step('first'))
                os.kill(os.getpid(), signal.SIGINT)
        self.assertEqual(finished, ['first', 'second'])
        manifest = json.loads((run.path / 'manifest.json').read_text())
        self.assertEqual((manifest['state'], manifest['outcome']), ('cleaned', 'failed'))
        self.assertFalse(run.scratch.exists())
        for sig in TEARDOWN_SIGNALS:
            self.assertIs(signal.getsignal(sig), interrupt)

    def test_a_child_teardown_starts_ignores_them_too(self):
        """A teardown step's command, such as `tart stop`, outlives a signal sent to it."""
        ended = []

        def command():
            child = subprocess.Popen(['sleep', '1'])
            child.send_signal(signal.SIGTERM)
            child.send_signal(signal.SIGINT)
            ended.append(child.wait())

        with WorkRun('teardown-child', root=self.root) as run:
            run.on_cleanup(command)
        self.assertEqual(ended, [0])


class StopGroup(unittest.TestCase):
    def test_a_group_whose_members_all_exited_is_gone(self):
        # Unreaped, the exited leader makes macOS refuse a signal to its group with EPERM.
        process = subprocess.Popen(['sh', '-c', 'exit 3'], start_new_session=True)
        os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOWAIT)
        stop_group(process)
        self.assertEqual(process.returncode, 3)

    def test_a_descendant_left_after_a_normal_exit_is_stopped(self):
        process = subprocess.Popen(['sh', '-c', 'sleep 300 & echo $!'], stdout=subprocess.PIPE,
                                   start_new_session=True)
        with process.stdout:
            sleeper = int(process.stdout.readline())

        def stop_sleeper():
            try:
                if os.getpgid(sleeper) == process.pid:
                    os.kill(sleeper, signal.SIGKILL)
            except ProcessLookupError:
                pass

        self.addCleanup(stop_sleeper)
        self.assertEqual(process.wait(), 0)
        self.assertEqual(os.getpgid(sleeper), process.pid)
        stop_group(process)
        with self.assertRaises(ProcessLookupError):
            os.kill(sleeper, 0)


if __name__ == '__main__':
    unittest.main()
