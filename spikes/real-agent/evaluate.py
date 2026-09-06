#!/usr/bin/env python3
"""Evaluate reports plus host ordering evidence; cannot itself prove VM provenance."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

BRANCHES = {'parent', 'child-a', 'child-b'}
EXPECTED_TEST_SHA256 = hashlib.sha256(
    (Path(__file__).resolve().parent / 'fixture' / 'test_calculator.py').read_bytes()).hexdigest()


def evaluate(reports, ordering, require_barrier=False, allow_upstream_recovery=False):
    errors = []
    reports = [r.get('state', r) for r in reports]
    if len(reports) != 3 or {r.get('branch') for r in reports} != BRANCHES:
        return {'pass': False, 'errors': ['ExactlyParentAndTwoChildrenRequired']}
    source = next(r for r in reports if r['branch'] == 'parent')
    for report in reports:
        branch = report['branch']
        def check(ok, issue):
            if not ok:
                errors.append(branch + ':' + issue)
        check(report.get('kind') == 'real-codex-ram-fork', 'WrongReportKind')
        check(report.get('schemaVersion') == 1, 'WrongSchemaVersion')
        check(report.get('identity') == source.get('identity'), 'InheritedProcessOrPipeMismatch')
        identity = report.get('identity', {})
        check(identity.get('spawnCount') == identity.get('initializeCount') == 1,
              'ProcessOrTransportRestarted')
        check(identity.get('transport') == 'stdio', 'WrongTransport')
        check(report.get('threadId') and report['threadId'] == source.get('threadId'), 'ThreadMismatch')
        check(report.get('sessionId') == source.get('sessionId'), 'SessionMismatch')
        check(report.get('sessionEvidence') in ('thread/start', 'thread/started', 'unavailable'),
              'SessionEvidenceNotReported')
        check(bool(report.get('sessionId')) == (report.get('sessionEvidence') != 'unavailable'),
              'SessionAvailabilityMismatch')
        check(report.get('authMode') == 'chatgpt', 'ChatGPTLoginRequired')
        check(report.get('continuity') is True, 'ProcessContinuityLost')
        check(report.get('fatal') is None, 'FatalControllerError')
        check(report.get('forbiddenMethodsSent') == 0, 'HistoryForkOrResumeUsed')
        baseline = report.get('baseline') or {}
        check(baseline == source.get('baseline') and baseline.get('idle'), 'IdleBaselineMismatch')
        check(baseline.get('toolCount', 0) > 0, 'NoBaselineToolEvidence')
        turns = report.get('completedTurnIds') or []
        check(len(turns) >= 3 and len(turns) == len(set(turns)), 'IncompleteTurns')
        check(bool(turns) and turns[0] == baseline.get('turnId'), 'BaselineTurnMismatch')
        check(report.get('followupOK') is True, 'FollowupContextMissing')
        if allow_upstream_recovery:
            check(report.get('recoveryOK') is True, 'RecoveryFollowupMissing')
        check((report.get('fixture') or {}).get('testExitCode') == 0, 'BranchTestsFailed')
        check((report.get('fixture') or {}).get('independentTransformOK') is True,
              'IndependentTransformChecksFailed')
        check((report.get('fixture') or {}).get('testScriptSha256') == EXPECTED_TEST_SHA256,
              'FixtureTestsModified')
        check(isinstance(report.get('writeSeq'), int) and
              report.get('readSeq', -1) > report.get('writeSeq', 0), 'ReadBeforeWrite')
        for problem, count in report.get('problems', {}).items():
            if count and not (allow_upstream_recovery and problem == 'TransportRecoveryObserved'):
                errors.append(branch + ':' + problem)
        if require_barrier:
            barrier = report.get('barrierResult') or {}
            inherited = source.get('barrierIdentity') or {}
            check(bool(inherited) and report.get('barrierIdentity') == inherited,
                  'BarrierProcessMismatch')
            check(barrier.get('branch') == branch and all(
                barrier.get(k) == inherited.get(k) for k in ('pid', 'startTicks', 'ramSha256')),
                'BlockedToolDidNotContinue')
    hashes = {(r.get('fixture') or {}).get('calculatorSha256') for r in reports}
    if None in hashes or len(hashes) != 3:
        errors.append('BranchFileContentsNotDistinct')
    branch_turns = [r.get('completedTurnIds', [])[1:] for r in reports]
    # The active barrier turn is intentionally inherited; later branch/followup IDs differ.
    tail_ids = [turn_id for turns in branch_turns for turn_id in turns[-2:]]
    if len(tail_ids) != len(set(tail_ids)):
        errors.append('PostForkTurnIdentityCollision')
    try:
        writes = ordering['writesCompleted']
        reads = ordering['readsStarted']
        if set(writes) != BRANCHES or set(reads) != BRANCHES:
            raise ValueError()
        if not all(type(value) in (int, float) for value in list(writes.values()) + list(reads.values())):
            raise ValueError()
        if max(writes.values()) >= min(reads.values()):
            errors.append('FinalReadsMustFollowAllWrites')
        if ordering.get('clock') != 'host-monotonic':
            errors.append('SharedHostMonotonicClockRequired')
        if ordering.get('ramSnapshotVerified') is not True:
            errors.append('HostRAMSnapshotEvidenceRequired')
    except (KeyError, TypeError, ValueError):
        errors.append('InvalidHostOrderingEvidence')
    return {'pass': not errors, 'errors': errors,
            'scope': 'active-builtin-tool' if require_barrier else 'idle-real-codex',
            'upstreamRecoveryAllowed': allow_upstream_recovery,
            'transportRecoveryCounts': {r['branch']: r.get('problems', {}).get('TransportRecoveryObserved', 0)
                                        for r in reports},
            'sessionIdAvailable': bool(source.get('sessionId')),
            'provenance': 'Requires runner VM snapshot logs alongside these reports'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reports', nargs=3)
    parser.add_argument('--ordering', required=True)
    parser.add_argument('--require-barrier', action='store_true')
    parser.add_argument('--allow-upstream-recovery', action='store_true',
                        help='Explicit fault experiment only; preserve original stdio/PID requirements')
    args = parser.parse_args()
    result = evaluate([json.loads(Path(p).read_text()) for p in args.reports],
                      json.loads(Path(args.ordering).read_text()), args.require_barrier,
                      args.allow_upstream_recovery)
    print(json.dumps(result, sort_keys=True))
    return 0 if result['pass'] else 1


if __name__ == '__main__':
    sys.exit(main())
