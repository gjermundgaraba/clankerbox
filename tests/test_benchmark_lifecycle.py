from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from acceptance import Report
import benchmark_lifecycle as benchmark


class BenchmarkTests(unittest.TestCase):
    def test_controller_duration(self):
        self.assertAlmostEqual(benchmark.duration({'created_at': '2026-01-01T00:00:00Z',
                                                   'updated_at': '2026-01-01T00:00:02.5Z'}), 2.5)

    def test_measures_all_phases_and_cleans_only_its_own_resources(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = Report(Path(directory) / 'report.json', {'events': [], 'machines': [], 'timings': []})
            args = SimpleNamespace(binary='cli', config='cfg', samples=1,
                                   host='local', profile='linux')
            calls = []

            def operation(*cmd):
                calls.append(cmd)
                return {'id': 'op', 'machine_id': 'machine-' + cmd[0], 'checkpoint_id': 'checkpoint',
                        'created_at': '2026-01-01T00:00:00Z', 'updated_at': '2026-01-01T00:00:01Z'}

            with patch('benchmark_lifecycle.Acceptance') as acceptance:
                acceptance.return_value.operation.side_effect = operation
                with patch('benchmark_lifecycle.describe_guest', return_value={'machine_id': 'id', 'incarnation': 'inc'}):
                    benchmark.benchmark(args, evidence)
            self.assertTrue(evidence.data['cleaned'])
            self.assertEqual([c[1] for c in calls if c[0] == 'delete'], ['machine-fork', 'machine-create', 'machine-restore'])
            self.assertEqual([item['phase'] for item in evidence.data['timings']], [
                'create', 'stop', 'retained-start', 'fork', 'child-stop', 'child-delete',
                'checkpoint', 'source-stop', 'delete', 'restore', 'restored-stop',
                'restored-delete', 'checkpoint-delete',
            ])
            self.assertEqual(calls[-1], ('checkpoint', 'delete', 'checkpoint'))

    def test_failure_does_not_guess_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = Report(Path(directory) / 'report.json', {'events': [], 'machines': [], 'timings': []})
            args = SimpleNamespace(binary='cli', config='cfg', samples=1, host='local', profile='linux')
            with patch('benchmark_lifecycle.Acceptance') as acceptance:
                acceptance.return_value.operation.side_effect = RuntimeError('ambiguous')
                with self.assertRaisesRegex(RuntimeError, 'ambiguous'):
                    benchmark.benchmark(args, evidence)
                self.assertEqual(acceptance.return_value.operation.call_count, 1)
            self.assertNotIn('cleaned', evidence.data)
