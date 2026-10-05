"""stop_group, on harmless processes of the test's own: `python3 -m unittest discover -s scripts`."""
import os
import signal
import subprocess
import unittest

from work_runs import stop_group


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
