import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import live_connections


class ConnectionHarnessTests(unittest.TestCase):
    def test_setup_error_survives_missing_log_and_failed_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / 'lifecycle.json'
            report.write_text(json.dumps(dict(name='accept-test', status='passed', machine_id='a' * 32)))
            setup_error = subprocess.CalledProcessError(17, ['ssh', 'setup'])
            log_error = subprocess.CalledProcessError(18, ['ssh', 'log'])
            cleanup_error = subprocess.CalledProcessError(19, ['ssh', 'cleanup'])
            argv = ['live_connections.py', '--binary', '/bin/false', '--config', '/unused',
                    '--lifecycle-result', str(report)]
            stderr = io.StringIO()
            with patch('sys.argv', argv), contextlib.redirect_stderr(stderr), patch.object(
                    live_connections.subprocess, 'check_output',
                    side_effect=[setup_error, log_error, cleanup_error]) as run:
                with self.assertRaises(subprocess.CalledProcessError) as caught:
                    live_connections.main()
            self.assertIs(caught.exception, setup_error)
            self.assertEqual(run.call_count, 3)
            self.assertIn('Could not read guest startup log', stderr.getvalue())
            self.assertIn('Guest cleanup failed', stderr.getvalue())
