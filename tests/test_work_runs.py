import importlib.util
import json
import os
import signal
import time
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'work_runs.py'
spec = importlib.util.spec_from_file_location('work_runs', SCRIPT)
work_runs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(work_runs)


class WorkRunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        # macOS /var aliases /private/var; use the physical root.
        self.root = Path(self.temp.name).resolve() / 'runs'

    def test_failure_runs_teardown_then_removes_scratch_but_keeps_evidence(self):
        calls = []
        with self.assertRaisesRegex(ValueError, 'test failure'):
            with work_runs.WorkRun('test', root=self.root) as run:
                (run.scratch / 'large').write_text('artifact')
                (run.evidence / 'result').write_text('failure evidence')
                run.on_cleanup(lambda: calls.append((run.scratch / 'large').read_text()))
                raise ValueError('test failure')
        self.assertEqual(calls, ['artifact'])
        self.assertFalse(run.scratch.exists())
        self.assertEqual((run.evidence / 'result').read_text(), 'failure evidence')
        self.assertEqual(work_runs.manifest(run.path)['outcome'], 'failed')

    def test_failed_callback_preserves_and_blocks_clean(self):
        calls = []
        def fail():
            raise RuntimeError('VM still running')
        with self.assertRaisesRegex(RuntimeError, 'scratch retained'):
            with work_runs.WorkRun('failure', root=self.root) as run:
                run.on_cleanup(lambda: calls.append('other teardown'))
                run.on_cleanup(fail)
        self.assertTrue(run.scratch.exists())
        self.assertEqual(calls, ['other teardown'])
        with self.assertRaisesRegex(RuntimeError, 'teardown not confirmed'):
            work_runs.clean(self.root, run.path.name)

    def test_active_refused_even_with_cleanable_manifest(self):
        with work_runs.WorkRun('active', root=self.root) as run:
            run.data['state'] = 'retained'
            work_runs.save(run.path, run.data)
            result = subprocess.run([sys.executable, str(SCRIPT), '--root', str(self.root),
                                     'clean', '--resources-stopped', run.path.name], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('run is active', result.stdout)
            self.assertTrue(run.scratch.exists())

    def test_keep_then_clean_preserves_evidence(self):
        with work_runs.WorkRun('keep', root=self.root, keep=True) as run:
            (run.evidence / 'log').write_text('keep me')
        self.assertTrue(run.scratch.exists())
        work_runs.clean(self.root, run.path.name)
        self.assertFalse(run.scratch.exists())
        self.assertTrue((run.evidence / 'log').exists())

    def test_clean_rejects_unowned_and_path_escape(self):
        self.root.mkdir()
        unowned = self.root / 'unowned'
        unowned.mkdir()
        (unowned / 'scratch').mkdir()
        (unowned / 'manifest.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'not an owned run'):
            work_runs.clean(self.root, 'unowned')
        for name in ('../unowned', '.', '..', str(unowned)):
            with self.subTest(name=name), self.assertRaises(ValueError):
                work_runs.clean(self.root, name)
        self.assertTrue((unowned / 'scratch').exists())

    def test_symlink_run_and_scratch_refused(self):
        with work_runs.WorkRun('keep', root=self.root, keep=True) as run:
            pass
        (self.root / 'alias').symlink_to(run.path, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            work_runs.clean(self.root, 'alias')
        outside = self.root.parent / 'outside'
        outside.mkdir()
        (outside / 'valuable').write_text('retained')
        run.scratch.rmdir()
        run.scratch.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            work_runs.clean(self.root, run.path.name)
        self.assertEqual((outside / 'valuable').read_text(), 'retained')

    def test_nested_symlink_does_not_delete_target(self):
        outside = self.root.parent / 'valuable'
        outside.write_text('retained')
        with work_runs.WorkRun('nested-link', root=self.root) as run:
            (run.scratch / 'link').symlink_to(outside)
        self.assertEqual(outside.read_text(), 'retained')

    def test_abandoned_running_state_requires_teardown(self):
        run = work_runs.WorkRun('abandoned', root=self.root)
        run.data['state'] = 'running'
        work_runs.save(run.path, run.data)
        with self.assertRaisesRegex(RuntimeError, 'teardown not confirmed'):
            work_runs.clean(self.root, run.path.name)

    def test_explicit_teardown_confirmation_allows_crash_cleanup(self):
        run = work_runs.WorkRun('crashed', root=self.root)
        run.scratch.mkdir()
        run.data['state'] = 'running'
        work_runs.save(run.path, run.data)
        work_runs.clean(self.root, run.path.name, resources_stopped=True)
        self.assertFalse(run.scratch.exists())

    def test_cli_interrupt_stops_child_before_cleanup(self):
        code = ("import os,pathlib,signal,time,sys; "
                "e=pathlib.Path(os.environ['WORK_RUN_EVIDENCE']); "
                "signal.signal(signal.SIGTERM, lambda *_: ((e/'stopped').write_text('yes'), sys.exit(0))); "
                "(e/'ready').write_text(str(os.getpid())); "
                "time.sleep(60)")
        process = subprocess.Popen([sys.executable, str(SCRIPT), '--root', str(self.root),
                                    'run', '--', sys.executable, '-c', code],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        path = Path(process.stdout.readline().strip())
        deadline = time.monotonic() + 5
        while not (path / 'evidence' / 'ready').exists() and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertTrue((path / 'evidence' / 'ready').exists())
        process.send_signal(signal.SIGTERM)
        stdout, stderr = process.communicate(timeout=15)
        self.assertEqual(process.returncode, 130, stderr)
        self.assertTrue((path / 'evidence' / 'stopped').exists())
        self.assertFalse((path / 'scratch').exists())
        child_pid = int((path / 'evidence' / 'ready').read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(child_pid, 0)

    def test_cli_failure_cleans_tmpdir(self):
        code = ('import os,pathlib,sys; '
                'pathlib.Path(os.environ["TMPDIR"], "artifact").write_text("large"); '
                'pathlib.Path(os.environ["WORK_RUN_EVIDENCE"], "result").write_text("failed"); '
                'sys.exit(7)')
        result = subprocess.run([sys.executable, str(SCRIPT), '--root', str(self.root),
                                 'run', '--', sys.executable, '-c', code],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 7, result.stderr)
        path = Path(result.stdout.strip())
        self.assertFalse((path / 'scratch').exists())
        self.assertEqual((path / 'evidence' / 'result').read_text(), 'failed')
        self.assertEqual(json.loads((path / 'manifest.json').read_text())['exit_code'], 7)
