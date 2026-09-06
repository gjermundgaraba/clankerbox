import subprocess
import unittest
from unittest.mock import patch

import remote_check


class RemoteCleanupTests(unittest.TestCase):
    def test_upload_failure_still_cleans_exact_paths(self):
        path = "/home/clanker/clankerbox-control.abc123"
        failure = subprocess.CalledProcessError(1, ["scp"])
        responses = [subprocess.CompletedProcess([], 0, path + "\n"), failure,
                     subprocess.CompletedProcess([], 0)]
        with patch.object(remote_check.subprocess, "run", side_effect=responses) as run:
            with self.assertRaises(subprocess.CalledProcessError) as caught:
                remote_check.main()
        self.assertIs(caught.exception, failure)
        self.assertEqual(run.call_args_list[-1].args[0][-1],
                         f"rm -f -- {path}/control.py {path}/fixture.sqlite && rmdir -- {path}")

    def test_cleanup_failure_does_not_hide_upload_failure(self):
        path = "/home/clanker/clankerbox-control.abc123"
        failure = subprocess.CalledProcessError(1, ["scp"])
        responses = [subprocess.CompletedProcess([], 0, path + "\n"), failure,
                     subprocess.CalledProcessError(255, ["ssh"])]
        with patch.object(remote_check.subprocess, "run", side_effect=responses):
            with self.assertRaises(subprocess.CalledProcessError) as caught:
                remote_check.main()
        self.assertIs(caught.exception, failure)
        self.assertIn(path, failure.__notes__[0])

    def test_invalid_remote_path_never_uploaded_or_removed(self):
        with patch.object(remote_check.subprocess, "run", return_value=
                          subprocess.CompletedProcess([], 0, "/home/clanker\n")) as run:
            with self.assertRaisesRegex(RuntimeError, "scratch path"):
                remote_check.main()
        self.assertEqual(run.call_count, 1)

    def test_acceptance_check_raises_explicitly(self):
        with self.assertRaisesRegex(RuntimeError, "failed"):
            remote_check.require(False, "failed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
