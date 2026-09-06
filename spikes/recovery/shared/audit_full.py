#!/usr/bin/env python3
"""Audit Smol full-run stage records and journal; does not audit interruption."""
import argparse
import hashlib
import json
from pathlib import Path

from audit_export import audit as core_audit
from disk_probe import METHOD, payload

IDENTITY = ('pid', 'start_monotonic_ns', 'ram_marker')


def audit(root, label='full-01'):
    root = Path(root)
    findings = []
    def check(value, reason):
        if not value:
            findings.append(reason)
    result = {'schema_version': 1, 'status': 'fail', 'label': label, 'findings': findings,
              'scope': 'Smol invalid, lineage, restored cold restart and volatile stage records plus journal; core audit supplies pin/integrity/cleanup checks. No interruption or checkpoint-byte rehash.',
              'limits': ['Lineage retains ancestor disk paths.',
                         'Volatile children have post-mutation disk rereads, but no final all-sibling RAM sweep.',
                         'Malformed input rejection permits temporary disk setup before rejection.']}
    def ram(value, branch):
        check(all(value.get(k) is True for k in ('ok', 'ready', 'memory_ok', 'disk_ok'))
              and value.get('branch') == value.get('disk_branch') == branch, 'invalid RAM state/branch')
    def same(a, b):
        return all(k in a and a[k] == b.get(k) for k in IDENTITY)
    def disk(value, phase, counter):
        expected = hashlib.sha256(payload(label, phase, counter)).hexdigest()
        check(value.get('ok') is True and value.get('method') == METHOD and value.get('size') == 4096
              and value.get('phase') == phase and value.get('counter') == counter
              and value.get('sha256') == value.get('expected_sha256') == expected, 'invalid direct disk payload')
    def killed(value):
        check(value.get('signal') == 'SIGKILL' and value.get('pidfd') is True
              and value.get('absent_or_zombie') is True and value.get('identity', {}).get('owned') is True,
              'owned pidfd death proof missing')
    try:
        core = core_audit(root)
        check(core['status'] == 'pass', 'core export audit is not pass')
        path = root / 'smolvm/results' / label
        report = json.loads((path / 'report.json').read_text())
        evidence = json.loads((path / 'portable-evidence.json').read_text())
        stages = report['stages']
        check(report.get('status') == 'pass', 'full run not pass')
        check(all(stages.get(k, {}).get('status') == 'pass' for k in ('invalid', 'lineage', 'restored_cold_restart', 'volatile')), 'required full stage missing/not pass')
        replies, commands = [], []
        for line in (path / 'commands.jsonl').read_text().splitlines():
            command = json.loads(line)
            commands.append(command)
            try:
                reply = json.loads(command.get('stdout', ''))
            except (ValueError, TypeError):
                continue
            argv = command.get('argv', [])
            if isinstance(reply, dict) and '--name' in argv:
                replies.append((argv[argv.index('--name') + 1], command, reply))
        invalid = stages['invalid']
        defects = {row['kind']: row for row in invalid['attempts']}
        check(defects.keys() == {'corrupt', 'truncated', 'incompatible'}, 'negative input inventory differs')
        for row in defects.values():
            check(row.get('returncode') != 0 and row.get('records_after') == {} and row.get('vmm_set_unchanged') is True,
                  'negative input accepted/reserved VM/changed VMM set')
        check("requires runtime ABI 'libkrun-portable-snapshot-v9'" in defects['incompatible']['stderr'], 'ABI rejection not observed')
        check(same(evidence['capture']['ram'], invalid['good_retry_ram']), 'valid retry process identity differs')
        ram(invalid['good_retry_ram'], evidence['capture']['ram']['branch'])
        retry_disks = [v for name, _, v in replies if name == 'retry' and v.get('method') == METHOD]
        check(bool(retry_disks), 'valid retry direct disk evidence missing')
        for value in retry_disks:
            disk(value, 'A', 0)
        lineage = stages['lineage']
        killed(lineage['ancestor_kill'])
        ram(lineage['restored_ram'], 201)
        disk(lineage['restored_disk'], 'branch', 201)
        check(same(evidence['capture']['ram'], lineage['restored_ram']), 'lineage process identity differs')
        saves = [c for c in commands if 'checkpoint' in c.get('argv', []) and lineage['checkpoint']['path'] in c['argv']]
        check(len(saves) == 1 and saves[0].get('returncode') == 0
              and saves[0]['start_ns'] > lineage['ancestor_kill']['end_ns'], 'checkpoint did not follow ancestor death')
        cold = stages['restored_cold_restart']
        ram(cold['ram_before'], 102); ram(cold['ram_after'], 102)
        check(cold['ram_before']['ram_marker'] != cold['ram_after']['ram_marker']
              and cold['ram_before']['start_monotonic_ns'] != cold['ram_after']['start_monotonic_ns'], 'cold restart lacks fresh RAM identity')
        check((cold['old_vmm']['pid'], cold['old_vmm']['start_ticks']) != (cold['new_vmm']['pid'], cold['new_vmm']['start_ticks'])
              and cold.get('old_source_path_still_absent') is True, 'cold restart identity/path proof missing')
        disk(cold['disk_after'], 'branch', 102)
        volatile = stages['volatile']
        killed(volatile['source_kill']); ram(volatile['source_ram_before_kill'], 399)
        disk(volatile['source_disk_before_kill'], 'B', 1)
        check(volatile['fresh_branch'].get('returncode') != 0
              and volatile['fresh_branch'].get('classification') == 'rejected-dead-source', 'fresh dead-source branch not rejected')
        children = volatile['surviving_children']
        check(len(children) == 2 and len({v['vmm']['pid'] for v in children}) == 2, 'two distinct surviving VMMs missing')
        writes = [c['end_ns'] for name, c, v in replies if name.startswith('volatile-child-') and v.get('action') == 'write']
        for number, child in enumerate(children, 1):
            branch = 300 + number
            ram(child['ram'], branch); disk(child['disk'], 'branch', branch)
            check(same(volatile['source_ram_before_kill'], child['ram']), 'volatile child RAM identity differs')
            initial = next((v for name, _, v in replies if name == child['child'] and 'memory_ok' in v), {})
            check(child['ram']['heartbeat']['samples'] > initial.get('heartbeat', {}).get('samples', -1), 'volatile heartbeat did not advance')
            final = [(c, v) for name, c, v in replies if name == child['child'] and v.get('action') == 'read']
            check(bool(writes) and bool(final) and final[-1][0]['start_ns'] > max(writes), 'final volatile disk read precedes writes')
            if final:
                disk(final[-1][1], 'branch', branch)
        result['completed_stages'] = ['invalid', 'lineage', 'restored_cold_restart', 'volatile']
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        findings.append('missing/malformed evidence: ' + str(error))
    result['status'] = 'fail' if findings else 'pass'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--label', default='full-01')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    result = audit(args.root, args.label)
    text = json.dumps(result, indent=2) + '\n'
    if args.report:
        args.report.write_text(text)
    print(text, end='')
    return result['status'] != 'pass'


if __name__ == '__main__':
    raise SystemExit(main())
