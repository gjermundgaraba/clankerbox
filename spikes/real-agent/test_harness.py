import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from collections import Counter, deque

from evaluate import EXPECTED_TEST_SHA256, evaluate
from guest import Controller, HarnessError, category, marker_match, scrub_diagnostic, text_input


def samples():
    reports = []
    for name in ('parent', 'child-a', 'child-b'):
        reports.append({'schemaVersion': 1, 'kind': 'real-codex-ram-fork', 'branch': name,
            'identity': {'spawnCount': 1, 'initializeCount': 1, 'transport': 'stdio',
                         'controller': {'pid': 1, 'startTicks': 10},
                         'appServer': {'pid': 2, 'startTicks': 11},
                         'stdinPipe': 3, 'stdoutPipe': 4, 'ramSha256': 'a' * 64},
            'threadId': 'thread-shared', 'sessionId': 'session-shared', 'authMode': 'chatgpt',
            'sessionEvidence': 'thread/start',
            'continuity': True, 'fatal': None, 'forbiddenMethodsSent': 0,
            'baseline': {'turnId': 'baseline', 'idle': True, 'toolCount': 1, 'seq': 1},
            'completedTurnIds': ['baseline', name + '-write', name + '-followup'],
            'followupOK': True, 'fixture': {'testExitCode': 0, 'calculatorSha256': name,
                'independentTransformOK': True, 'testScriptSha256': EXPECTED_TEST_SHA256},
            'writeSeq': 10, 'readSeq': 20, 'problems': {}})
    ordering = {'clock': 'host-monotonic', 'ramSnapshotVerified': True,
        'writesCompleted': {'parent': 1, 'child-a': 2, 'child-b': 3},
        'readsStarted': {'parent': 4, 'child-a': 5, 'child-b': 6}}
    return reports, ordering


class EvaluatorTests(unittest.TestCase):
    def test_valid_idle(self):
        self.assertTrue(evaluate(*samples())['pass'])

    def test_restarted_process(self):
        reports, order = samples()
        reports[1]['identity']['appServer']['startTicks'] += 1
        self.assertFalse(evaluate(reports, order)['pass'])

    def test_shared_files_and_read_order(self):
        reports, order = samples()
        reports[1]['fixture'] = reports[0]['fixture']
        order['readsStarted']['parent'] = 2.5
        result = evaluate(reports, order)
        self.assertIn('BranchFileContentsNotDistinct', result['errors'])
        self.assertIn('FinalReadsMustFollowAllWrites', result['errors'])

    def test_collision_and_recovery_fail_closed(self):
        reports, order = samples()
        reports[1]['completedTurnIds'] = reports[0]['completedTurnIds']
        reports[2]['problems'] = {'TransportRecoveryObserved': 1}
        result = evaluate(reports, order)
        self.assertIn('PostForkTurnIdentityCollision', result['errors'])
        self.assertIn('child-b:TransportRecoveryObserved', result['errors'])

    def test_explicit_fault_recovery_allowed_but_reported(self):
        reports, order = samples()
        reports[2]['problems'] = {'TransportRecoveryObserved': 2}
        for report in reports:
            report['recoveryOK'] = True
        result = evaluate(reports, order, allow_upstream_recovery=True)
        self.assertTrue(result['pass'])
        self.assertEqual(result['transportRecoveryCounts']['child-b'], 2)

    def test_unavailable_session_is_not_invented(self):
        reports, order = samples()
        for report in reports:
            report['sessionId'] = None
            report['sessionEvidence'] = 'unavailable'
        result = evaluate(reports, order)
        self.assertTrue(result['pass'])
        self.assertFalse(result['sessionIdAvailable'])

    def test_changed_tests_and_bad_formula_fail(self):
        reports, order = samples()
        reports[1]['fixture']['testScriptSha256'] = 'tampered'
        reports[2]['fixture']['independentTransformOK'] = False
        result = evaluate(reports, order)
        self.assertIn('child-a:FixtureTestsModified', result['errors'])
        self.assertIn('child-b:IndependentTransformChecksFailed', result['errors'])

    def test_barrier_requires_live_inherited_helper(self):
        reports, order = samples()
        self.assertFalse(evaluate(reports, order, True)['pass'])
        identity = {'pid': 9, 'startTicks': 90, 'ramSha256': 'b' * 64}
        for report in reports:
            report['barrierIdentity'] = identity
            report['barrierResult'] = dict(identity, branch=report['branch'])
        self.assertTrue(evaluate(reports, order, True)['pass'])


class ProtocolTests(unittest.TestCase):
    def controller(self):
        c = Controller.__new__(Controller)
        c.responses, c.turns = {}, {}
        c.sequence = 0
        c.thread_id = 'thread'
        c.counts, c.problems = Counter(), Counter()
        c.events = deque(maxlen=128)
        c.warnings = deque(maxlen=8)
        c.fatal = None
        c.sent = []
        c.send = c.sent.append
        return c

    def test_account_notification_never_logged(self):
        c = self.controller()
        c.consume({'method': 'account/updated', 'params':
                   {'email': 'private@example.org', 'accessToken': 'secret-token'}})
        output = json.dumps(list(c.events))
        self.assertNotIn('private', output)
        self.assertNotIn('secret', output)

    def test_refresh_request_fails_without_credentials(self):
        c = self.controller()
        c.consume({'id': 4, 'method': 'account/chatgptAuthTokens/refresh',
                   'params': {'previousAccountId': 'private-account'}})
        self.assertEqual(c.fatal, 'NeedsLogin')
        self.assertNotIn('private-account', json.dumps(c.sent))
        self.assertNotIn('private-account', json.dumps(list(c.events)))

    def test_terminal_notification_and_message(self):
        c = self.controller()
        c.consume({'method': 'item/completed', 'params': {'threadId': 'thread',
            'turnId': 'turn', 'item': {'type': 'agentMessage', 'text': 'BASELINE_OK x'}}})
        c.consume({'method': 'turn/completed', 'params': {'threadId': 'thread',
            'turn': {'id': 'turn', 'status': 'completed'}}})
        self.assertEqual(c.turns['turn']['status'], 'completed')
        self.assertNotIn('BASELINE_OK', json.dumps(list(c.events)))

    def test_error_redaction(self):
        self.assertEqual(category({'message': '401 private@example.org sk-secret'}), 'NeedsLogin')
        self.assertEqual(category({'message': 'stream disconnected private-id'}), 'TransportRecoveryObserved')

    def test_markdown_markers(self):
        self.assertTrue(marker_match(['**BASELINE_OK**\n`RAM_CONTEXT_123`'],
                                      'BASELINE_OK', 'RAM_CONTEXT_123'))
        self.assertFalse(marker_match(['RAM_CONTEXT_1234'], 'RAM_CONTEXT_123'))

    def test_failure_text_scrubs_credentials_and_email(self):
        raw = 'No shell host. user@example.org sk-testsecret Bearer abcdef access_token=privatevalue'
        clean = scrub_diagnostic(raw)
        self.assertIn('No shell host.', clean)
        for value in ('user@example.org', 'sk-testsecret', 'abcdef', 'privatevalue'):
            self.assertNotIn(value, clean)

    def test_history_methods_forbidden(self):
        c = Controller.__new__(Controller)
        for method in ('thread/fork', 'thread/resume', 'account/login/start',
                       'account/rateLimitResetCredit/consume'):
            with self.assertRaises(HarnessError):
                c.send({'method': method, 'params': {}})


if __name__ == '__main__':
    unittest.main()
