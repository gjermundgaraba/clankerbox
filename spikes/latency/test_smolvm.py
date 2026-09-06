"""Boundary selection and cleanup ownership guards; no VMs or host mutations."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location('latency_smolvm', Path(__file__).with_name('smolvm.py'))
smolvm = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smolvm)


class BranchProtocolTests(unittest.TestCase):
    def test_batch_is_one_cli_capture_with_bounded_parallelism(self):
        argv = smolvm.branch_args('source', 'child', 4, True)
        self.assertEqual(argv, ['machine', 'branch', '--from', 'source', '--count', '4',
            '--name-prefix', 'child', '--parallel', '4', '--wait-ready', '--ready-timeout', '60s'])

    def test_fanout_one_explicitly_waits_at_same_boundary(self):
        argv = smolvm.branch_args('source', 'child', 1, True)
        self.assertIn('--wait-ready', argv)
        self.assertEqual(argv[argv.index('--name') + 1], 'child-0')
        self.assertNotIn('--count', argv)

    def test_fresh_does_not_cooperatively_park_dirty_writer(self):
        self.assertNotIn('--wait-ready', smolvm.branch_args('source', 'child', 1, False))

    def test_budget_rejects_other_fanouts(self):
        for count in (0, 2, 5, 1024):
            with self.assertRaises(RuntimeError):
                smolvm.branch_args('source', 'child', count, True)

    def test_only_explicit_checkpoint_elapsed_is_extracted(self):
        log = ('other elapsed_ms=999\n'
               '\x1b[32mINFO\x1b[0m fork: golden RAM checkpoint written elapsed_ms=123 clones=4\n'
               'fork: golden RAM checkpoint written elapsed_ms=456 clones=1\n')
        self.assertEqual(smolvm.checkpoint_timings(log), [123, 456])


class OwnershipTests(unittest.TestCase):
    def test_pid_birth_executable_and_exact_scope_required(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            binary = root / 'bin/smolvm'; binary.parent.mkdir(); binary.touch()
            config = root / 'c/smolvm/vms/hash/boot-config.json'
            config.parent.mkdir(parents=True); config.touch()
            proc_root = root / 'proc'; proc = proc_root / '123'; proc.mkdir(parents=True)
            (proc / 'exe').symlink_to(binary)
            (proc / 'cmdline').write_bytes(str(binary).encode() + b'\0_boot-vm\0' + str(config).encode() + b'\0')
            (proc / 'stat').write_text('123 (smolvm) S ' + '0 ' * 18 + '456 0')
            (proc / 'status').write_text('Uid:\t1000\t1000\t1000\t1000\n')
            (proc / 'smaps_rollup').write_text('Rss: 4096 kB\n')
            with patch.object(smolvm, 'ROOT', root), patch.object(smolvm, 'BINARY', binary):
                self.assertEqual(smolvm.inspect_pid(123, '456', proc_root)['start_time'], '456')
                with self.assertRaisesRegex(RuntimeError, 'birth'):
                    smolvm.inspect_pid(123, '457', proc_root)
                (proc / 'cmdline').write_bytes(str(binary).encode() + b'\0_boot-vm\0/old/root/boot-config.json\0')
                with self.assertRaisesRegex(RuntimeError, 'scope'):
                    smolvm.inspect_pid(123, proc_root=proc_root)


class EndpointTests(unittest.TestCase):
    def test_ready_and_preparation_do_not_wait_for_exec_completion(self):
        runner = smolvm.Runner.__new__(smolvm.Runner)
        exec_started, finish_exec = threading.Event(), threading.Event()
        ordering = []
        def guest(*args, **kwargs):
            exec_started.set()
            self.assertTrue(finish_exec.wait(2), 'readiness/preparation incorrectly waited for exec')
            ordering.append('exec-completed')
            return SimpleNamespace(timing={'end_ns': 999})
        def ready(*args, **kwargs):
            self.assertTrue(exec_started.wait(2))
            self.assertTrue(kwargs['require_release'])
            ordering.append('ready')
            return {'writes_paused': True}, 100
        def prepare(status):
            self.assertTrue(status['writes_paused'])
            ordering.append('prepared')
            finish_exec.set()
            return {'writes_paused': False}
        runner.guest, runner.ready = guest, ready
        value = runner.probe_ready('child', 'first', boundary=True, prepare=prepare)
        self.assertEqual(ordering, ['ready', 'prepared', 'exec-completed'])
        self.assertEqual(value['ready_ns'], 100)
        self.assertEqual(value['first_exec_ns'], 999)
        self.assertFalse(value['prepared']['writes_paused'])

    def test_release_check_and_status_share_one_rpc(self):
        runner = smolvm.Runner.__new__(smolvm.Runner)
        status = {'ok': True, 'ready': True, 'memory_ok': True, 'disk_ok': True}
        runner.guest = Mock(return_value=SimpleNamespace(stdout=json.dumps(status)))
        self.assertEqual(runner.call('child', require_release=True), status)
        runner.guest.assert_called_once()
        script = runner.guest.call_args.args[3]
        self.assertIn('test -f /tmp/latency-branch-released && exec ', script)
        self.assertIn(smolvm.GUEST, script)

    def test_helper_release_does_not_resume_writer(self):
        runner = smolvm.Runner.__new__(smolvm.Runner)
        runner.call, runner.guest = Mock(), Mock()
        runner.boundary('source')
        runner.call.assert_called_once_with('source', 'pause_writes')
        script = runner.guest.call_args_list[0].args[3]
        self.assertIn('smolvm-branch-ready && touch /tmp/latency-branch-released', script)
        self.assertNotIn('resume_writes', script)

    def test_preflight_failure_is_journaled_and_survives_cleanup_resource_errors(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = smolvm.Runner.__new__(smolvm.Runner)
            runner.root = runner.output = Path(temporary)
            runner.args = SimpleNamespace(profile='idle', case='cold')
            runner.report = {'status': 'fail'}
            runner.commands = io.StringIO()
            runner.records = Mock(side_effect=RuntimeError('preflight original'))
            runner.cleanup = Mock(side_effect=RuntimeError('cleanup failure'))
            with patch.object(smolvm, 'resources', side_effect=OSError('resource failure')), patch('builtins.print'):
                self.assertEqual(runner.run(), 1)
            runner.cleanup.assert_called_once()
            report = json.loads((runner.root / 'samples.jsonl').read_text())
            self.assertIn('preflight original', report['error'])
            self.assertIn('cleanup failure', report['cleanup_error'])
            self.assertIn('resource failure', report['resources_live_error'])
            self.assertIn('resource failure', report['resources_after_error'])


if __name__ == '__main__':
    unittest.main()
