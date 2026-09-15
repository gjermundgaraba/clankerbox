#!/usr/bin/env python3
"""Fork/checkpoint acceptance using one explicitly retained disposable source."""

import argparse
from functools import partial
import json
from pathlib import Path

from acceptance import Acceptance, Report, run_guest, describe_guest


def require_copy_identity(source, child, *, ram):
    if child['machine_id'] == source['machine_id']:
        raise RuntimeError('copy reused machine identity')
    same_manager = child['incarnation'] == source['incarnation']
    if same_manager != ram:
        raise RuntimeError('RAM copy restarted manager' if ram else 'disk copy reused manager incarnation')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--config', required=True)
    parser.add_argument('--session-runner', required=True)
    parser.add_argument('--lifecycle-result', required=True)
    parser.add_argument('--result', required=True)
    parser.add_argument('--fork-only', action='store_true')
    args = parser.parse_args()
    source = json.loads(Path(args.lifecycle_result).read_text())
    if (
        not source['name'].startswith('accept-')
        or source['status'] != 'passed'
        or source.get('cleaned')
        or source.get('pending')
        or source.get('cleanup_error')
    ):
        raise ValueError('an uncleaned passed disposable lifecycle report is required')
    evidence = Report(
        args.result,
        {'source': source['machine_id'], 'machines': [source['machine_id']], 'events': [], 'status': 'running'},
    )
    report = evidence.data
    acceptance = Acceptance(args.binary, args.config, evidence)
    save, run, operation = evidence.save, acceptance.run, acceptance.operation

    def need(condition, message):
        if not condition:
            raise RuntimeError(message)

    guest = partial(run_guest, args.session_runner, args.config)

    def inspect(machine):
        return json.loads(run('inspect', machine))

    name = source['name'] + '-cp'
    directory = 'workspace/' + name
    mid = source['machine_id']

    def write(machine, value):
        guest(machine, 'sh', '-se', data=f'printf %s {value} > "$HOME/{directory}/state"\nsync\n')

    def read(machine):
        return guest(machine, 'sh', '-c', f'cat "$HOME/{directory}/state"')

    def memory(machine):
        return json.loads(guest(machine, 'curl', '-fsS', 'http://127.0.0.1:18349/'))

    def stop(machine):
        operation('stop', machine)

    try:
        linux = inspect(mid)['profile_spec']['os'] == 'linux'
        # An explicit stop/start upgrades the disposable source's supervisor to
        # branchable mode; never silently restart a user's existing workload.
        if inspect(mid)['state'] == 'running':
            stop(mid)
        operation('start', mid)
        guest(mid, 'sh', '-se', data=f'mkdir -p "$HOME/{directory}"\n')
        write(mid, 'source-A')
        original_identity = describe_guest(args.session_runner, args.config, mid)
        if linux:
            program = """import http.server, json, os, time, uuid
token = uuid.uuid4().hex
started = time.monotonic()
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps(dict(token=token, pid=os.getpid(), age=time.monotonic()-started)).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)
http.server.HTTPServer(('127.0.0.1', 18349), Handler).serve_forever()
"""
            guest(
                mid,
                'sh',
                '-se',
                data=f'cat > "$HOME/{directory}/memory.py" <<\'PY\'\n{program}PY\n'
                + f'nohup python3 "$HOME/{directory}/memory.py" >"$HOME/{directory}/memory.log" 2>&1 </dev/null &\n'
                + 'i=0; until curl -fsS http://127.0.0.1:18349/ >/dev/null; do i=$((i+1)); test "$i" -lt 30; sleep 1; done\n',
            )
            original_memory = memory(mid)
            report['original_memory'] = original_memory
            report['fork_identity'] = original_identity
            save()
        else:
            stop(mid)
        child = operation('fork', mid, name + '-fork')['machine_id']
        need(read(child) == 'source-A', 'fork lost source disk state')
        child_identity = describe_guest(args.session_runner, args.config, child)
        require_copy_identity(original_identity, child_identity, ram=linux)
        report['events'].append({'forked_machine': child, 'identity': child_identity})
        save()
        if linux:
            for machine in (mid, child):
                sample = memory(machine)
                need(
                    sample['token'] == original_memory['token'] and sample['pid'] == original_memory['pid'],
                    'fork did not continue source RAM process',
                )
        write(child, 'child-B')
        stop(child)
        operation('start', child)
        need(read(child) == 'child-B', 'fork lost independent disk on cold restart')
        restarted_child = describe_guest(args.session_runner, args.config, child)
        need(
            restarted_child['machine_id'] == child_identity['machine_id']
            and restarted_child['incarnation'] != child_identity['incarnation'],
            'cold restart identity invariant failed',
        )
        stop(child)
        if not linux:
            operation('start', mid)
        need(read(mid) == 'source-A', 'child mutation affected source disk')
        if linux:
            # A retained descendant prevents destructive source-store cleanup.
            stop(mid)
            acceptance.expect_delete_dependency(args.session_runner, args.config, mid)
            operation('start', mid)
        operation('delete', child)
        if args.fork_only:
            stop(mid)
            operation('delete', mid)
            report['status'] = 'passed'
            report['cleaned'] = True
            return
        capture_identity = describe_guest(args.session_runner, args.config, mid)
        # The previous explicit Linux cold restart ended the memory fixture.
        if linux:
            guest(
                mid,
                'sh',
                '-se',
                data=f'nohup python3 "$HOME/{directory}/memory.py" >"$HOME/{directory}/memory.log" 2>&1 </dev/null &\n'
                + 'i=0; until curl -fsS http://127.0.0.1:18349/ >/dev/null; do i=$((i+1)); test "$i" -lt 30; sleep 1; done\n',
            )
            original_memory = memory(mid)
            report['capture_memory'] = original_memory
        else:
            stop(mid)
        report['capture_identity'] = capture_identity
        save()
        cp = operation('checkpoint', 'create', mid)['checkpoint_id']
        if not linux:
            operation('start', mid)
        write(mid, 'after-capture')
        stop(mid)
        operation('delete', mid)
        restored = []
        identities = {original_identity['machine_id'], child_identity['machine_id']}
        restored_incarnations = set()
        for index in range(2):
            machine = operation('restore', cp, name + '-restore-' + str(index))['machine_id']
            restored.append(machine)
            need(read(machine) == 'source-A', 'restore did not roll disk back to capture')
            identity = describe_guest(args.session_runner, args.config, machine)
            need(identity['machine_id'] not in identities, 'restore reused machine identity')
            identities.add(identity['machine_id'])
            require_copy_identity(capture_identity, identity, ram=linux)
            if not linux:
                need(identity['incarnation'] not in restored_incarnations, 'disk restores shared manager incarnation')
                restored_incarnations.add(identity['incarnation'])
                report['events'].append({'restored_machine': machine, 'identity': identity})
                save()
            if linux:
                sample = memory(machine)
                need(
                    sample['token'] == original_memory['token'] and sample['pid'] == original_memory['pid'],
                    'restore cold-booted instead of continuing RAM',
                )
                report['events'].append({'restored_machine': machine, 'identity': identity, 'memory': sample})
                save()
            write(machine, 'restore-' + str(index))
            stop(machine)
        operation('checkpoint', 'delete', cp)
        for index, machine in enumerate(restored):
            operation('start', machine)
            need(read(machine) == 'restore-' + str(index), 'restored disk lost independent contents')
            stop(machine)
            operation('delete', machine)
        report['status'] = 'passed'
        report['cleaned'] = True
    except Exception as error:
        report['status'] = 'failed'
        report['error'] = str(error)
        raise
    finally:
        # Failed/ambiguous objects remain named in this report. No blind cleanup.
        save()


if __name__ == '__main__':
    main()
