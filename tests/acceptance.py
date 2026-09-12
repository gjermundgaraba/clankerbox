"""Local acceptance evidence and bounded operation handling; never replay mutations."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


def run_guest(runner, config, machine, *argv, data=None):
    proc = subprocess.run([runner, '--config', config, machine, *argv],
                          input=data or '', text=True, capture_output=True, timeout=100)
    if proc.returncode:
        raise RuntimeError(f'session command failed: {proc.stderr[-2048:]} {proc.stdout[-2048:]}')
    return proc.stdout


class Report:
    def __init__(self, path, initial=None, *, resume=False):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if resume:
            self.data = json.loads(self.path.read_text())
        else:
            self.data = initial
            # Reserve the evidence path before any request, without a TOCTOU check.
            with self.path.open('x') as stream:
                os.fchmod(stream.fileno(), 0o600)
                self._write(stream)
            self._sync_parent()

    def _write(self, stream):
        stream.write(json.dumps(self.data, indent=2) + '\n')
        stream.flush()
        os.fsync(stream.fileno())

    def _sync_parent(self):
        fd = os.open(self.path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def save(self):
        # A crash must leave either the previous report or the complete next one.
        with tempfile.NamedTemporaryFile(mode='w', dir=self.path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            try:
                self._write(stream)
                os.replace(temporary, self.path)
                self._sync_parent()
            finally:
                temporary.unlink(missing_ok=True)


class Acceptance:
    def __init__(self, binary, config, report, *, timeout=480):
        self.base = [str(Path(binary).resolve()), '--config', str(Path(config).resolve()), '--json']
        self.report = report
        self.timeout = timeout

    def run(self, *command):
        proc = subprocess.run(self.base + list(command), text=True,
                              capture_output=True, timeout=90)
        if proc.returncode:
            raise RuntimeError(f'{command[0]} failed: {proc.stderr[-2048:]}')
        return proc.stdout

    def require_settled(self):
        if self.report.data.get('pending'):
            raise RuntimeError('pending mutation requires inspection; refusing replay or cleanup')

    def begin(self, command):
        self.require_settled()
        self.report.data['pending'] = {'command': list(command)}
        self.report.save()

    def accepted(self, command, op):
        report = self.report.data
        report['events'].append({'command': list(command), 'operation': op})
        report['pending']['operation'] = op
        if command[0] == 'create':
            report['machine_id'] = op['machine_id']
        if command[0] in ('fork', 'restore'):
            report['machines'].append(op['machine_id'])
        if tuple(command[:2]) == ('checkpoint', 'create'):
            report['checkpoint'] = op['checkpoint_id']
        self.report.save()

    def operation(self, *command):
        offset = 2 if command[0] == 'checkpoint' else 1
        command = command[:offset] + ('--async',) + command[offset:]
        self.begin(command)
        op = json.loads(self.run(*command))
        self.accepted(command, op)
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            op = json.loads(self.run('operation', op['id']))
            if op['status'] in ('succeeded', 'failed', 'unresolved'):
                self.report.data['events'].append({'completed': op})
                if op['status'] != 'unresolved':
                    self.report.data.pop('pending')
                else:
                    self.report.data['pending']['operation'] = op
                self.report.save()
                if op['status'] == 'succeeded':
                    return op
                raise RuntimeError(f'operation requires inspection: {op}')
            time.sleep(2)
        raise RuntimeError(f'operation timeout; retained for inspection: {op}')

    def expect_delete_dependency(self, runner, config, machine):
        command = ('delete', machine)
        self.begin(command)
        proc = subprocess.run([runner, '--config', config, '--expect-delete-dependency', machine],
                              capture_output=True, text=True, timeout=100)
        # The adapter emits any unexpectedly accepted operation even on failure.
        # Retain its identity before reporting a failed qualification; never wait,
        # retry or clean up following this potentially destructive acceptance.
        if proc.stdout.strip():
            self.accepted(command, json.loads(proc.stdout))
        if proc.returncode or proc.stdout.strip():
            raise RuntimeError(f'dependency rejection check failed: {proc.stderr[-2048:]}')
        self.report.data.pop('pending')
        self.report.data['events'].append({'source_delete_dependency_rejected': machine})
        self.report.save()
