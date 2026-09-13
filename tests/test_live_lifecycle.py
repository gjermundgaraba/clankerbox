import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import live_lifecycle


class StoppedSessionAcceptanceTests(unittest.TestCase):
    def exercise(self, probe_result):
        state = 'running'
        operation = None
        probes = []
        incarnation = 0

        def run(command, **kwargs):
            nonlocal state, operation, incarnation
            if command[0] == 'runner':
                if '--describe-guest' in command:
                    value = {'machine_id': 'a' * 32, 'incarnation': str(incarnation)}
                    return subprocess.CompletedProcess(command, 0, json.dumps(value), '')
                if '--expect-stopped' in command:
                    probes.append(command)
                    if isinstance(probe_result, Exception):
                        raise probe_result
                    return subprocess.CompletedProcess(command, probe_result, '', 'probe failure')
                return subprocess.CompletedProcess(command, 0, 'unchanged workspace', '')
            action = command[4]
            if action in ('create', 'stop', 'start'):
                state = 'stopped' if action == 'stop' else 'running'
                if action in ('create', 'start'): incarnation += 1
                operation = {'id': 'operation', 'machine_id': 'a' * 32, 'status': 'succeeded'}
                value = operation
            elif action == 'operation':
                value = operation
            elif action == 'inspect':
                value = {'state': state}
            else:
                self.fail(f'unexpected command: {command}')
            return subprocess.CompletedProcess(command, 0, json.dumps(value), '')

        with tempfile.TemporaryDirectory() as directory:
            result = Path(directory) / 'evidence.json'
            argv = ['live_lifecycle.py', '--binary', 'cli', '--config', 'config',
                    '--host', 'linux', '--profile', 'test', '--session-runner', 'runner',
                    '--result', str(result), '--keep']
            with (patch('sys.argv', argv), patch.object(subprocess, 'run', run),
                  contextlib.redirect_stdout(io.StringIO())):
                try:
                    live_lifecycle.main()
                except (RuntimeError, subprocess.TimeoutExpired):
                    pass
            report = json.loads(result.read_text())
        self.assertEqual(len(probes), 1)
        self.assertEqual(probes[0][-2:], ['--expect-stopped', 'a' * 32])
        return report

    def test_confirmed_prerequisite_passes(self):
        self.assertEqual(self.exercise(0)['status'], 'passed')

    def test_nonzero_probe_exit_fails(self):
        for code in (1, 17, -9):
            with self.subTest(code=code):
                report = self.exercise(code)
                self.assertEqual(report['status'], 'failed')
                self.assertIn('probe failure', report['error'])

    def test_probe_timeout_fails(self):
        result = self.exercise(subprocess.TimeoutExpired('runner', 100))
        self.assertEqual(result['status'], 'failed')


if __name__ == '__main__':
    unittest.main()
