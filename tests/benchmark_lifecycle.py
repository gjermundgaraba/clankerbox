#!/usr/bin/env python3
"""Measure ordinary APIs on new disposable machines; retain all ambiguous work."""

import argparse
from datetime import datetime
import json
import time
import uuid

from acceptance import Acceptance, Report, describe_guest


def duration(operation):
    """Controller acceptance-to-completion, excluding client poll quantization."""
    return (datetime.fromisoformat(operation['updated_at'].replace('Z', '+00:00')) -
            datetime.fromisoformat(operation['created_at'].replace('Z', '+00:00'))).total_seconds()


def benchmark(args, evidence):
    report = evidence.data
    acceptance = Acceptance(args.binary, args.config, evidence, poll_interval=0.1)

    def measure(phase, *command):
        started = time.monotonic()
        op = acceptance.operation(*command)
        item = {'phase': phase, 'operation_id': op['id'], 'controller_seconds': duration(op),
                'client_seconds': time.monotonic() - started}
        if phase in ('create', 'retained-start', 'fork', 'restore'):
            item['guest'] = describe_guest(args.binary, args.config, op['machine_id'])
        report['timings'].append(item)
        evidence.save()
        return op

    for _ in range(args.samples):
        name = 'bench-' + uuid.uuid4().hex[:12]
        machine = measure('create', 'create', name, '--host', args.host, '--profile', args.profile,
                          '--idempotency-key', name)['machine_id']
        measure('stop', 'stop', machine)
        measure('retained-start', 'start', machine)
        child = measure('fork', 'fork', machine, name + '-child')['machine_id']
        measure('child-stop', 'stop', child)
        measure('child-delete', 'delete', child)
        checkpoint = measure('checkpoint', 'checkpoint', 'create', machine)['checkpoint_id']
        measure('source-stop', 'stop', machine)
        measure('delete', 'delete', machine)
        restored = measure('restore', 'restore', checkpoint, name + '-restored')['machine_id']
        measure('restored-stop', 'stop', restored)
        measure('restored-delete', 'delete', restored)
        measure('checkpoint-delete', 'checkpoint', 'delete', checkpoint)
    report['cleaned'] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('binary', 'config', 'host', 'profile', 'result'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--samples', type=int, default=3)
    args = parser.parse_args()
    if args.samples < 1:
        parser.error('--samples must be positive')
    evidence = Report(args.result, {'status': 'running', 'events': [], 'machines': [], 'timings': []})
    try:
        benchmark(args, evidence)
        evidence.data['status'] = 'passed'
    except Exception as error:
        evidence.data.update(status='failed', error=str(error))
        # No automatic mutation replay or guessed cleanup after an uncertain result.
        raise
    finally:
        evidence.save()
    print(json.dumps(evidence.data, indent=2))


if __name__ == '__main__':
    main()
