#!/usr/bin/env python3
"""Evaluate exported recovery evidence; no guest or host mutations."""
import argparse
import hashlib
import json
from pathlib import Path
import re

from disk_probe import BASE, METHOD, SIZE, payload

GUEST_SHA256 = 'c0db3a0cab9c3f039d45b9098b1e57746d37ac7ac16467885c34e9fe9281701e'


def evaluate(evidence):
    if not isinstance(evidence, dict):
        return dict(schema_version=1, status='fail', findings=[dict(location='schema', reason='evidence must be an object')],
                    independent_restore_proven=False, sibling_isolation_proven=False)
    errors = []
    def require(condition, location, reason):
        if not condition:
            errors.append(dict(location=location, reason=reason))
    def ram(state, location):
        require(isinstance(state, dict) and all(state.get(key) is True for key in ('ok', 'ready', 'memory_ok', 'disk_ok')),
                location, 'missing valid RAM/readiness/disk flags')
        require(all(key in state for key in ('pid', 'start_monotonic_ns', 'ram_marker', 'branch', 'disk_branch')),
                location, 'guest identity fields missing')
        require(type(state.get('pid')) is int and state['pid'] > 0
                and type(state.get('start_monotonic_ns')) is int and state['start_monotonic_ns'] > 0
                and isinstance(state.get('ram_marker'), str) and re.fullmatch('[0-9a-f]{16}', state['ram_marker']) is not None,
                location, 'invalid guest PID/start/RAM marker')
        require(state.get('branch') == state.get('disk_branch'), location, 'RAM and latency-guest disk branches differ')
    def same_process(before, after, location, branches=False):
        ram(after, location)
        keys = ('pid', 'start_monotonic_ns', 'ram_marker') + (('branch', 'disk_branch') if branches else ())
        require(all(key in before and key in after and before[key] == after[key] for key in keys), location, 'captured process identity/state not preserved')
    def vmm(value, location):
        require(value.get('owned') is True and type(value.get('pid')) is int and value['pid'] > 1
                and str(value.get('start_ticks', '')).isdigit() and int(value['start_ticks']) > 0,
                location, 'owned VMM PID/birth proof missing')
        return value.get('pid'), str(value.get('start_ticks'))
    probe_hash = hashlib.sha256(Path(__file__).with_name('disk_probe.py').read_bytes()).hexdigest()
    def disk(value, phase, counter, location):
        try:
            wanted = hashlib.sha256(payload(value.get('namespace'), phase, counter)).hexdigest()
            require(value.get('ok') is True and value.get('schema_version') == 1 and value.get('size') == SIZE
                    and value.get('phase') == phase and value.get('counter') == counter
                    and value.get('method') == METHOD and value.get('sha256') == wanted
                    and value.get('expected_sha256') == wanted and value.get('probe_sha256') == probe_hash
                    and value.get('path') == str(BASE / value['namespace'] / 'payload.bin'),
                    location, 'direct disk payload/provenance mismatch')
        except (KeyError, ValueError, TypeError):
            require(False, location, 'invalid direct disk record')
    try:
        require(evidence.get('schema_version') == 1 and evidence.get('runtime') in ('cocoon', 'smolvm'), 'schema', 'unknown schema/runtime')
        provenance = evidence.get('provenance', {})
        require(provenance.get('guest_sha256') == GUEST_SHA256 and provenance.get('probe_sha256') == probe_hash,
                'provenance', 'shared binary/probe hash mismatch')
        capture = evidence.get('capture', {})
        initial = capture.get('ram', {})
        ram(initial, 'capture.ram')
        disk(capture.get('disk', {}), 'A', 0, 'capture.disk')
        origin = vmm(capture.get('vmm', {}), 'capture.vmm')
        post = evidence.get('source_after_capture', {})
        same_process(initial, post.get('ram', {}), 'source_after_capture.ram')
        disk(post.get('disk', {}), 'B', 1, 'source_after_capture.disk')
        require(post.get('disk', {}).get('namespace') == capture.get('disk', {}).get('namespace'), 'source_after_capture.disk', 'different disk namespace')
        independence = evidence.get('independent_restore', {})
        require(independence.get('origin_processes_absent') is True and independence.get('source_paths_unavailable') is True,
                'independent_restore', 'origin absence and source path unavailability required')
        copies = evidence.get('artifact_copies', [])
        require(isinstance(copies, list) and bool(copies), 'artifact_copies', 'nonempty copied artifact hash inventory required')
        for index, item in enumerate(copies):
            require(isinstance(item.get('source_sha256'), str) and re.fullmatch('[0-9a-f]{64}', item['source_sha256']) is not None
                    and item.get('copied_sha256') == item['source_sha256'] and type(item.get('size_bytes')) is int
                    and item['size_bytes'] > 0 and item.get('copied_size_bytes') == item['size_bytes'],
                    f'artifact_copies[{index}]', 'copied artifact hash/size differs')
        children = evidence.get('restored', [])
        require(isinstance(children, list) and bool(children), 'restored', 'at least one independent restoration required')
        barrier = evidence.get('all_mutations_completed_ns')
        require(type(barrier) is int and barrier > 0, 'all_mutations_completed_ns', 'host monotonic mutation barrier required')
        identities, branches, names = [], [], []
        for index, child in enumerate(children):
            loc = f'restored[{index}]'
            branch = child.get('branch_counter')
            require(type(branch) is int and 1 <= branch <= 2147483647, loc, 'positive branch counter required')
            same_process(initial, child.get('ram_initial', {}), loc + '.ram_initial', branches=True)
            same_process(initial, child.get('ram_later', {}), loc + '.ram_later', branches=True)
            before_samples = child.get('ram_initial', {}).get('heartbeat', {}).get('samples')
            after_samples = child.get('ram_later', {}).get('heartbeat', {}).get('samples')
            require(type(before_samples) is int and type(after_samples) is int and after_samples > before_samples,
                    loc + '.heartbeat', 'heartbeat did not advance after restoration')
            same_process(initial, child.get('ram_final', {}), loc + '.ram_final')
            require(child.get('ram_final', {}).get('branch') == branch, loc + '.ram_final', 'final RAM branch differs')
            disk(child.get('disk_initial', {}), 'A', 0, loc + '.disk_initial')
            disk(child.get('disk_final', {}), 'branch', branch, loc + '.disk_final')
            require(child.get('disk_initial', {}).get('sha256') == capture.get('disk', {}).get('sha256')
                    and child.get('disk_initial', {}).get('sha256') != post.get('disk', {}).get('sha256')
                    and child.get('disk_final', {}).get('namespace') == capture.get('disk', {}).get('namespace'),
                    loc + '.disk', 'did not restore A independently of source B')
            require(type(child.get('final_observed_ns')) is int and type(barrier) is int and child['final_observed_ns'] > barrier,
                    loc, 'final branch reads must follow all mutations')
            identities.append(vmm(child.get('vmm', {}), loc + '.vmm'))
            branches.append(branch)
            names.append(child.get('name'))
        require(len(set(identities)) == len(children) and origin not in identities, 'restored.vmm', 'restored VMM identities overlap origin or siblings')
        require(len(set(branches)) == len(children) and len(set(names)) == len(children) and all(isinstance(name, str) and name for name in names),
                'restored.branches', 'distinct named branches required')
    except (AttributeError, KeyError, TypeError, ValueError) as error:
        errors.append(dict(location='schema', reason=f'malformed evidence: {error}'))
    return dict(schema_version=1, status='fail' if errors else 'pass', findings=errors,
                independent_restore_proven=not errors,
                sibling_isolation_proven=not errors and len(evidence.get('restored', [])) >= 2,
                limits='Direct-read quiesced file rollback and continuing RAM process identity; not arbitrary in-flight transactions, physical extent inspection, model calls, credentials or agent history.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('evidence', type=Path)
    args = parser.parse_args()
    result = evaluate(json.loads(args.evidence.read_text()))
    print(json.dumps(result, indent=2))
    return 0 if result['status'] == 'pass' else 1


if __name__ == '__main__':
    raise SystemExit(main())
