import importlib.util
from pathlib import Path
import unittest
from collections import Counter

spec = importlib.util.spec_from_file_location('latency_run', Path(__file__).with_name('run.py'))
run = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run)


class ScheduleTests(unittest.TestCase):
    def test_full_counts_and_unique_identity(self):
        tasks = run.schedule('full')
        self.assertEqual(len(tasks), 320)
        self.assertEqual(len({t['key'] for t in tasks}), 320)
        groups = Counter((t['runtime'], t['case'], t['variant']) for t in tasks)
        self.assertEqual(len(groups), 28)
        for (_, case, profile), count in groups.items():
            self.assertEqual(count, 20 if case in ('cold', 'warm') else 10)
            if case in ('cold', 'warm'):
                self.assertEqual(profile, 'idle')

    def test_alternating_five_trial_blocks(self):
        tasks = run.schedule('full')
        for start in range(0, len(tasks), 10):
            pair = tasks[start:start + 10]
            self.assertEqual(len({t['runtime'] for t in pair[:5]}), 1)
            self.assertEqual(len({t['runtime'] for t in pair[5:]}), 1)
            self.assertNotEqual(pair[0]['runtime'], pair[5]['runtime'])
            self.assertEqual([t['trial'] for t in pair[:5]], [t['trial'] for t in pair[5:]])

    def test_smoke_never_shares_measurement_identity(self):
        tasks = run.schedule('smoke')
        self.assertEqual(len(tasks), 12)
        self.assertTrue(all(t['trial'] >= 90000 and t['block'] == 'smoke' for t in tasks))
        for task in tasks:
            argv = run.command(task)
            self.assertIn(str(task['trial']), argv)
            self.assertNotIn('--prepare', argv)


if __name__ == '__main__':
    unittest.main()
