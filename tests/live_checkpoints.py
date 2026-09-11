#!/usr/bin/env python3
"""Fork/checkpoint acceptance using one explicitly retained disposable source."""
import argparse
import json
from pathlib import Path
import subprocess
import time


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
    if not source['name'].startswith('accept-') or source['status'] != 'passed' or source.get('cleaned'):
        raise ValueError('an uncleaned passed disposable lifecycle report is required')
    base = [str(Path(args.binary).resolve()), '--config', str(Path(args.config).resolve()), '--json']
    report = {'source': source['machine_id'], 'machines': [source['machine_id']],
              'events': [], 'status': 'running'}
    result = Path(args.result)
    if result.exists():
        raise ValueError('refusing to overwrite acceptance evidence')

    def save():
        result.write_text(json.dumps(report, indent=2) + '\n')

    def need(condition, message):
        if not condition:
            raise RuntimeError(message)

    def guest(machine, *argv, data=None):
        proc = subprocess.run([args.session_runner, '--config', args.config, machine, *argv],
                              input=data or '', text=True, capture_output=True, timeout=100)
        if proc.returncode:
            raise RuntimeError(f'session command failed: {proc.stderr[-2048:]} {proc.stdout[-2048:]}')
        return proc.stdout

    def run(*command, data=None):
        p = subprocess.run(base + list(command), input=data, text=True, capture_output=True, timeout=90)
        if p.returncode:
            raise RuntimeError(f'{command[0]}: {p.stderr[-2048:]}')
        return p.stdout

    def inspect(machine):
        return json.loads(run('inspect', machine))

    def operation(*command):
        offset = 2 if command[0] == 'checkpoint' else 1
        command = command[:offset] + ('--async',) + command[offset:]
        op = json.loads(run(*command))
        report['events'].append({'command': list(command), 'operation': op})
        if command[0] in ('fork', 'restore'):
            report['machines'].append(op['machine_id'])
        if command[:2] == ('checkpoint', 'create'):
            report['checkpoint'] = op['checkpoint_id']
        save()
        deadline = time.monotonic() + 480
        while time.monotonic() < deadline:
            op = json.loads(run('operation', op['id']))
            if op['status'] == 'succeeded':
                report['events'].append({'completed': op})
                save()
                return op
            if op['status'] in ('failed', 'unresolved'):
                raise RuntimeError(f'operation requires inspection: {op}')
            time.sleep(2)
        raise RuntimeError(f'operation timeout; retained for inspection: {op}')

    name = source['name'] + '-cp'
    directory = 'workspace/' + name
    mid = source['machine_id']
    linux = inspect(mid)['profile_spec']['os'] == 'linux'

    def write(machine, value):
        guest(machine, 'sh', '-se', data=f'printf %s {value} > "$HOME/{directory}/state"\nsync\n')

    def read(machine):
        return guest(machine, 'sh', '-c', f'cat "$HOME/{directory}/state"')

    def memory(machine):
        return json.loads(guest(machine, 'curl', '-fsS', 'http://127.0.0.1:18349/'))

    def stop(machine):
        operation('stop', machine)

    save()
    try:
        # An explicit stop/start upgrades the disposable source's supervisor to
        # branchable mode; never silently restart a user's existing workload.
        if inspect(mid)['state'] == 'running':
            stop(mid)
        operation('start', mid)
        guest(mid, 'sh', '-se', data=f'mkdir -p "$HOME/{directory}"\n')
        write(mid, 'source-A')
        original_key = inspect(mid)['ssh_host_key']
        if linux:
            program = '''import http.server, json, os, time, uuid
token = uuid.uuid4().hex
started = time.monotonic()
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps(dict(token=token, pid=os.getpid(), age=time.monotonic()-started)).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)
http.server.HTTPServer(('127.0.0.1', 18349), Handler).serve_forever()
'''
            guest(mid, 'sh', '-se', data=f"cat > \"$HOME/{directory}/memory.py\" <<'PY'\n{program}PY\n"
                + f'nohup python3 "$HOME/{directory}/memory.py" >"$HOME/{directory}/memory.log" 2>&1 </dev/null &\n'
                + 'i=0; until curl -fsS http://127.0.0.1:18349/ >/dev/null; do i=$((i+1)); test "$i" -lt 30; sleep 1; done\n')
            original_memory = memory(mid)
            report['original_memory'] = original_memory
        else:
            stop(mid)
        child = operation('fork', mid, name + '-fork')['machine_id']
        need(read(child) == 'source-A', 'fork lost source disk state')
        child_key = inspect(child)['ssh_host_key']
        need(child_key != original_key, 'fork reused SSH identity')
        if linux:
            for machine in (mid, child):
                sample = memory(machine)
                need(sample['token'] == original_memory['token'] and sample['pid'] == original_memory['pid'],
                     'fork did not continue source RAM process')
        write(child, 'child-B')
        stop(child)
        operation('start', child)
        need(read(child) == 'child-B', 'fork lost independent disk on cold restart')
        need(inspect(child)['ssh_host_key'] == child_key, 'fork key changed on cold restart')
        stop(child)
        if not linux:
            operation('start', mid)
        need(read(mid) == 'source-A', 'child mutation affected source disk')
        if linux:
            # A retained descendant prevents destructive source-store cleanup.
            stop(mid)
            denied = subprocess.run(base + ['delete', mid], capture_output=True, text=True, timeout=45)
            need(denied.returncode != 0, 'source deletion accepted while child depended on it')
            operation('start', mid)
        operation('delete', child)
        if args.fork_only:
            stop(mid)
            operation('delete', mid)
            report['status'] = 'passed'
            report['cleaned'] = True
            save()
            return
        # The previous explicit Linux cold restart ended the memory fixture.
        if linux:
            guest(mid, 'sh', '-se', data=f'nohup python3 "$HOME/{directory}/memory.py" >"$HOME/{directory}/memory.log" 2>&1 </dev/null &\n'
                + 'i=0; until curl -fsS http://127.0.0.1:18349/ >/dev/null; do i=$((i+1)); test "$i" -lt 30; sleep 1; done\n')
            original_memory = memory(mid)
        else:
            stop(mid)
        cp = operation('checkpoint', 'create', mid)['checkpoint_id']
        if not linux:
            operation('start', mid)
        write(mid, 'after-capture')
        stop(mid)
        operation('delete', mid)
        restored = []
        keys = {original_key, child_key}
        for index in range(2):
            machine = operation('restore', cp, name + '-restore-' + str(index))['machine_id']
            restored.append(machine)
            need(read(machine) == 'source-A', 'restore did not roll disk back to capture')
            key = inspect(machine)['ssh_host_key']
            need(key not in keys, 'restore reused SSH identity')
            keys.add(key)
            if linux:
                sample = memory(machine)
                need(sample['token'] == original_memory['token'] and sample['pid'] == original_memory['pid'],
                     'restore cold-booted instead of continuing RAM')
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
