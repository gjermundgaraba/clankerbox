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
        scripts = []
        incarnation = 0

        def run(command, **kwargs):
            nonlocal state, operation, incarnation
            if command[3] == 'shell':
                self.assertEqual(command[4:6], ['a' * 32, '--'])
                if kwargs.get('input'):
                    scripts.append(kwargs['input'])
                return subprocess.CompletedProcess(command, 0, 'unchanged workspace', '')
            action = command[4]
            if action == 'guest' and state == 'stopped':
                probes.append(command)
                if isinstance(probe_result, Exception):
                    raise probe_result
                return subprocess.CompletedProcess(command, probe_result[0], '', probe_result[1])
            if action == 'guest':
                value = {'machine_id': 'a' * 32, 'incarnation': str(incarnation)}
                return subprocess.CompletedProcess(command, 0, json.dumps(value), '')
            if action in ('create', 'stop', 'start'):
                state = 'stopped' if action == 'stop' else 'running'
                if action in ('create', 'start'):
                    incarnation += 1
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
            argv = [
                'live_lifecycle.py',
                '--binary',
                'cli',
                '--config',
                'config',
                '--host',
                'linux',
                '--profile',
                'test',
                '--result',
                str(result),
                '--keep',
            ]
            with (
                patch('sys.argv', argv),
                patch.object(subprocess, 'run', run),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                try:
                    live_lifecycle.main()
                except (RuntimeError, subprocess.TimeoutExpired):
                    pass
            report = json.loads(result.read_text())
        self.assertEqual(len(probes), 1)
        self.assertEqual(probes[0][3:], ['--json', 'guest', 'a' * 32])
        diff_checks = [script for script in scripts if '--no-ext-diff' in script]
        self.assertTrue(diff_checks)
        for script in diff_checks:
            self.assertIn('git --no-pager diff --cached --no-ext-diff', script)
            self.assertIn('git --no-pager diff --no-ext-diff', script)
        return report

    @staticmethod
    def refusal(reason):
        return json.dumps({'error': {'message': 'refused', 'code': 'failed_precondition', 'reason': reason}})

    def test_confirmed_prerequisite_passes(self):
        self.assertEqual(self.exercise((1, 'warning\n' + self.refusal('prerequisite') + '\n'))['status'], 'passed')

    def test_any_other_outcome_fails(self):
        for outcome in (
            (0, ''),
            (0, self.refusal('prerequisite')),
            (1, self.refusal('unavailable')),
            (1, 'probe failure'),
            (-9, ''),
        ):
            with self.subTest(outcome=outcome):
                report = self.exercise(outcome)
                self.assertEqual(report['status'], 'failed')
                self.assertIn('expected prerequisite refusal of guest', report['error'])

    def test_probe_timeout_fails(self):
        result = self.exercise(subprocess.TimeoutExpired('runner', 100))
        self.assertEqual(result['status'], 'failed')


if __name__ == '__main__':
    unittest.main()
