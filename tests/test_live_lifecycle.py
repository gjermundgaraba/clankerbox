import contextlib
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import live_lifecycle


class StoppedSessionAcceptanceTests(unittest.TestCase):
    def exercise(self, probe_result):
        state = 'running'
        operation = None
        reports = []
        probes = []

        def run(command, **kwargs):
            nonlocal state, operation
            if command[0] == 'runner':
                if '--expect-stopped' in command:
                    probes.append(command)
                    if isinstance(probe_result, Exception):
                        raise probe_result
                    return subprocess.CompletedProcess(command, probe_result, '', 'probe failure')
                return subprocess.CompletedProcess(command, 0, 'unchanged workspace', '')
            action = command[4]
            if action in ('create', 'stop', 'start'):
                state = 'stopped' if action == 'stop' else 'running'
                operation = {'id': 'operation', 'machine_id': 'a' * 32, 'status': 'succeeded'}
                value = operation
            elif action == 'operation':
                value = operation
            elif action == 'inspect':
                value = {'state': state, 'ssh_host_key': 'unchanged identity'}
            else:
                self.fail(f'unexpected command: {command}')
            return subprocess.CompletedProcess(command, 0, json.dumps(value), '')

        def save(_path, text):
            reports.append(json.loads(text))
            return len(text)

        argv = ['live_lifecycle.py', '--binary', 'cli', '--config', 'config',
                '--host', 'linux', '--profile', 'test', '--session-runner', 'runner',
                '--result', 'not-written.json', '--keep']
        with (patch('sys.argv', argv), patch.object(subprocess, 'run', run),
              patch.object(Path, 'mkdir'), patch.object(Path, 'write_text', save),
              contextlib.redirect_stdout(io.StringIO())):
            try:
                live_lifecycle.main()
            except (RuntimeError, subprocess.TimeoutExpired):
                pass
        self.assertEqual(len(probes), 1)
        self.assertEqual(probes[0][-2:], ['--expect-stopped', 'a' * 32])
        return reports[-1]

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
