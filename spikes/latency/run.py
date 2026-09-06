#!/usr/bin/env python3
"""Serial host-side coordinator. No credentials, networking, or global tuning."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path('/home/clanker/clankerbox-latency.RPxPe6')
GRANT = 'latency-20260905'
PROFILES = ('idle', 'resident', 'dirty', 'workspace')
RUNTIMES = ('cocoon', 'smolvm')
SMOL_CASES = {'cold': 'cold', 'warm': 'warm', 'fresh': 'live-second',
              'fanout1': 'batch-1', 'fanout4': 'batch-4'}


def schedule(phase):
    if phase == 'smoke':
        cells = [('cold', 'idle'), ('warm', 'idle'), ('fresh', 'idle'),
                 ('fanout4', 'idle'), ('fresh', 'dirty'), ('fanout4', 'workspace')]
        return [dict(runtime=runtime, case=case, variant=profile, trial=90000 + i,
                     block='smoke', key=f'smoke-{i}-{runtime}')
                for i, (case, profile) in enumerate(cells) for runtime in RUNTIMES]
    cells = [('cold', 'idle', 20), ('warm', 'idle', 20)]
    cells += [(case, profile, 10) for profile in PROFILES
              for case in ('fresh', 'fanout1', 'fanout4')]
    tasks = []
    for cell, (case, profile, count) in enumerate(cells):
        for block in range(count // 5):
            order = RUNTIMES if (cell + block) % 2 == 0 else RUNTIMES[::-1]
            for runtime in order:
                for trial in range(block * 5, block * 5 + 5):
                    tasks.append(dict(runtime=runtime, case=case, variant=profile,
                                      trial=trial, block=f'measure-{cell}-{block}',
                                      key=f'{runtime}-{case}-{profile}-{trial}'))
    return tasks


def command(task, trial_offset=0):
    trial = task['trial'] + trial_offset
    if task['runtime'] == 'cocoon':
        return ['sudo', '-n', '--', 'python3', str(ROOT / 'cocoon/cocoon.py'),
                '--root', str(ROOT / 'cocoon'), '--grant', GRANT,
                '--lock', str(ROOT / 'measure.lock'), '--guest', str(ROOT / 'shared/latency-guest'),
                '--cpus', '4-11', '--run-case', task['case'], '--variant', task['variant'],
                '--repetitions', '1', '--trial-offset', str(trial), '--block', task['block']]
    return ['sudo', '-n', '-u', 'clanker', '-g', 'kvm', '--', 'taskset', '-c', '4-11',
            'python3', str(ROOT / 'smolvm/smolvm.py'), '--root', str(ROOT / 'smolvm'),
            '--host-slot', GRANT, '--profile', task['variant'], '--case', SMOL_CASES[task['case']],
            '--trial', str(trial)]


def host_state():
    result = {'wall_ns': time.time_ns(), 'monotonic_ns': time.monotonic_ns()}
    for name in ('loadavg', 'meminfo', 'stat', 'pressure/cpu', 'pressure/memory', 'pressure/io'):
        path = Path('/proc') / name
        result[name] = path.read_text() if path.exists() else None
    return result


def append(path, value):
    with path.open('a') as stream:
        stream.write(json.dumps(value) + '\n')
        stream.flush()
        os.fsync(stream.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=('smoke', 'full'), required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--trial-offset', type=int, default=0,
                        help='Explicit distinct attempt identity; earlier failures remain in raw data.')
    parser.add_argument('--limit', type=int, help='At most this many not-yet-completed tasks this invocation.')
    parser.add_argument('--runtime', choices=RUNTIMES)
    parser.add_argument('--plan', action='store_true')
    args = parser.parse_args()
    tasks = [t for t in schedule(args.phase) if not args.runtime or t['runtime'] == args.runtime]
    if args.plan:
        print(json.dumps(tasks, indent=2))
        return 0
    if not args.run_id.replace('-', '').isalnum() or not 0 <= args.trial_offset <= 8000:
        raise RuntimeError('invalid run identity or trial offset')
    if ROOT.resolve() != ROOT or ROOT.is_symlink() or ROOT.stat().st_uid != 1000:
        raise RuntimeError('unauthorized benchmark root')
    auth = json.loads((ROOT / 'authorization.json').read_text())
    if auth.get('root') != str(ROOT) or auth.get('grant') != GRANT or not auth.get('timing_authorized'):
        raise RuntimeError('coordinator timing gate closed or mismatched')
    lock = (ROOT / 'driver.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    journal = ROOT / ('driver-' + args.run_id + '.jsonl')
    prior = [json.loads(line) for line in journal.read_text().splitlines()] if journal.exists() else []
    completed = {row['key'] for row in prior if row.get('event') == 'end' and row.get('returncode') == 0}
    if any(row.get('event') == 'end' and row.get('returncode') != 0 for row in prior):
        raise RuntimeError('this run contains a failed attempt; inspect it and use an explicit new run identity')
    started = {row['key'] for row in prior if row.get('event') == 'start'}
    if started - completed:
        raise RuntimeError('unfinished task in journal; inspect ownership and cleanup before proceeding')
    pins = {}
    for relative in ('cocoon/cocoon.py', 'smolvm/smolvm.py', 'shared/latency-guest', 'smolvm/bin/smolvm'):
        with (ROOT / relative).open('rb') as stream:
            pins[relative] = hashlib.file_digest(stream, 'sha256').hexdigest()
    append(journal, dict(event='invocation', phase=args.phase, run_id=args.run_id,
                         trial_offset=args.trial_offset, pins=pins, host=host_state()))
    count = 0
    for index, task in enumerate(tasks):
        if task['key'] in completed:
            continue
        if args.limit is not None and count >= args.limit:
            break
        argv = command(task, args.trial_offset)
        append(journal, dict(event='start', **task, argv=argv, host=host_state()))
        print(json.dumps(dict(event='start', position=index + 1, total=len(tasks), **task)), flush=True)
        result = subprocess.run(argv, text=True, capture_output=True)
        append(journal, dict(event='end', **task, returncode=result.returncode,
                             stdout=result.stdout, stderr=result.stderr, host=host_state()))
        print(json.dumps(dict(event='end', key=task['key'], returncode=result.returncode,
                              stdout=result.stdout[-2000:], stderr=result.stderr[-5000:])), flush=True)
        count += 1
        if result.returncode:
            return result.returncode
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
