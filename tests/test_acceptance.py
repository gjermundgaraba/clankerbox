import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from acceptance import Acceptance, Report
import live_lifecycle


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'nested/result.json'
        self.evidence = Report(self.path, {'events': [], 'machines': [], 'status': 'running'})
        self.acceptance = Acceptance('cli', 'config', self.evidence)

    def read(self):
        return json.loads(self.path.read_text())

    def test_exclusive_creation_and_explicit_resume(self):
        self.evidence.data['retained_id'] = 'owned-machine'
        self.evidence.save()
        before = self.path.read_bytes()
        with self.assertRaises(FileExistsError):
            Report(self.path, {'events': []})
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(Report(self.path, resume=True).data['retained_id'], 'owned-machine')

    def test_failed_save_preserves_previous_evidence(self):
        before = self.path.read_bytes()
        self.evidence.data['new'] = True
        with patch('acceptance.os.replace', side_effect=OSError('injected write failure')):
            with self.assertRaises(OSError):
                self.evidence.save()
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_accepted_resource_ids_persist_before_wait(self):
        for command, field, expected in [
            (('create', 'accept-new'), 'machine_id', 'machine'),
            (('fork', 'source', 'child'), 'machines', ['machine']),
            (('restore', 'checkpoint', 'child'), 'machines', ['machine']),
            (('checkpoint', 'create', 'source'), 'checkpoint', 'checkpoint'),
        ]:
            with self.subTest(command=command):
                self.evidence.data = {'events': [], 'machines': []}
                op = {'id': 'accepted-id', 'machine_id': 'machine', 'checkpoint_id': 'checkpoint', 'status': 'accepted'}
                calls = []

                def run(*argv):
                    calls.append(argv)
                    if argv[0] == 'operation':
                        saved = self.read()
                        self.assertEqual(saved[field], expected)
                        self.assertEqual(saved['pending']['operation']['id'], 'accepted-id')
                        return json.dumps(dict(op, status='succeeded'))
                    self.assertEqual(self.read()['pending']['command'], list(argv))
                    return json.dumps(op)

                with patch.object(self.acceptance, 'run', run):
                    self.acceptance.operation(*command)
                self.assertEqual(len(calls), 2)
                self.assertNotIn('pending', self.read())

    def test_terminal_failure_and_unresolved_are_recorded_without_replay(self):
        for status in ('failed', 'unresolved'):
            with self.subTest(status=status):
                self.evidence.data = {'events': []}
                op = {'id': 'accepted-id', 'machine_id': 'machine', 'status': status}
                with patch.object(self.acceptance, 'run', return_value=json.dumps(op)) as run:
                    with self.assertRaisesRegex(RuntimeError, 'requires inspection'):
                        self.acceptance.operation('create', 'accept-new')
                    self.assertEqual(run.call_count, 2)
                saved = self.read()
                self.assertEqual(saved['machine_id'], 'machine')
                self.assertEqual(saved['events'][-1]['completed']['status'], status)
                self.assertEqual('pending' in saved, status == 'unresolved')
                if status == 'unresolved':
                    resumed = Acceptance('cli', 'config', Report(self.path, resume=True))
                    with patch.object(resumed, 'run') as run:
                        with self.assertRaisesRegex(RuntimeError, 'refusing replay'):
                            resumed.operation('create', 'accept-new')
                        run.assert_not_called()

    def test_ambiguous_submission_preserves_intent_and_blocks_cleanup(self):
        with patch.object(self.acceptance, 'run', side_effect=subprocess.TimeoutExpired('cli', 90)):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.acceptance.operation('delete', 'owned-machine')
        self.assertEqual(self.read()['pending']['command'], ['delete', '--async', 'owned-machine'])
        with self.assertRaisesRegex(RuntimeError, 'refusing replay or cleanup'):
            self.acceptance.require_settled()

    def test_poll_timeout_keeps_accepted_identity(self):
        self.acceptance.timeout = 0
        op = {'id': 'accepted-id', 'machine_id': 'owned-machine', 'status': 'accepted'}
        with patch.object(self.acceptance, 'run', return_value=json.dumps(op)) as run:
            with self.assertRaisesRegex(RuntimeError, 'timeout'):
                self.acceptance.operation('create', 'accept-new')
            self.assertEqual(run.call_count, 1)
        self.assertEqual(self.read()['pending']['operation'], op)
        self.assertEqual(self.read()['machine_id'], 'owned-machine')

    def test_dependency_probe_requires_typed_refusal_and_journals_unexpected_acceptance(self):
        op = {'id': 'unexpected-id', 'machine_id': 'source', 'status': 'accepted'}

        def refusal(reason):
            return json.dumps({'error': {'message': 'refused', 'reason': reason, 'retryable': False}})

        for code, output, diagnostics, passes in (
            (1, '', refusal('dependency'), True),
            (1, '', 'warning\n' + refusal('dependency') + '\n', True),
            (1, '', refusal('conflict'), False),
            (1, '', 'connection reset', False),
            (0, json.dumps(op), '', False),
            (0, json.dumps(op), refusal('dependency'), False),
        ):
            with self.subTest(code=code, output=output, diagnostics=diagnostics):
                self.evidence.data = {'events': []}
                proc = subprocess.CompletedProcess([], code, output, diagnostics)
                with patch('acceptance.subprocess.run', return_value=proc) as run:
                    if passes:
                        self.acceptance.expect_delete_dependency('source')
                        self.assertNotIn('pending', self.read())
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'dependency rejection check failed'):
                            self.acceptance.expect_delete_dependency('source')
                        self.assertIn('pending', self.read())
                    self.assertEqual(run.call_count, 1)
                    command = run.call_args.args[0]
                    # Never waits, and the key was journaled before the request.
                    self.assertEqual(command[3:7], ['--json', 'delete', '--async', '--idempotency-key'])
                    self.assertEqual(command[8:], ['source'])
                    if not passes:
                        self.assertEqual(self.read()['pending']['command'][3], command[7])
                if output:
                    self.assertEqual(self.read()['pending']['operation'], op)
                    self.assertEqual(self.read()['events'][-1]['operation'], op)

    def test_guest_helpers_use_the_cli(self):
        import acceptance

        proc = subprocess.CompletedProcess([], 0, 'output', '')
        with patch('acceptance.subprocess.run', return_value=proc) as run:
            self.assertEqual(acceptance.run_guest('cli', 'cfg', 'machine', 'sh', '-se', data='script'), 'output')
        self.assertEqual(run.call_args.args[0], ['cli', '--config', 'cfg', 'shell', 'machine', '--', 'sh', '-se'])
        self.assertEqual(run.call_args.kwargs['input'], 'script')
        failed = subprocess.CompletedProcess([], 7, 'partial', 'diagnostic')
        with patch('acceptance.subprocess.run', return_value=failed):
            with self.assertRaisesRegex(RuntimeError, 'exited 7: diagnostic partial'):
                acceptance.run_guest('cli', 'cfg', 'machine', 'false')
        guest = {'machine_id': 'machine', 'incarnation': 'one'}
        with patch('acceptance.subprocess.run', return_value=subprocess.CompletedProcess([], 0, json.dumps(guest), '')) as run:
            self.assertEqual(acceptance.describe_guest('cli', 'cfg', 'machine'), guest)
        self.assertEqual(run.call_args.args[0], ['cli', '--config', 'cfg', '--json', 'guest', 'machine'])
        self.assertEqual(acceptance.cli_error('noise\n{"error": "text"}\n'), {})
        self.assertEqual(acceptance.cli_error(''), {})

    def test_lifecycle_refuses_overwrite_or_pending_resume_before_requests(self):
        self.evidence.data.update(
            name='accept-owned', machine_id='owned-machine', pending={'command': ['stop', 'owned-machine']}
        )
        self.evidence.save()
        before = self.path.read_bytes()
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
            str(self.path),
        ]
        for extra, error in (([], FileExistsError), (['--resume'], RuntimeError)):
            with patch('sys.argv', argv + extra), patch('subprocess.run') as run:
                with self.assertRaises(error):
                    live_lifecycle.main()
                run.assert_not_called()
            self.assertEqual(self.path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
