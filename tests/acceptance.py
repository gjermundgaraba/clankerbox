"""Local acceptance evidence and bounded operation handling; never replay mutations."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid


def run_guest(binary, config, machine, *argv, data=None):
    """Run argv in the machine through `clankerbox shell`: pipes, real end of input, its exit status."""
    proc = subprocess.run(
        [binary, '--config', config, 'shell', machine, '--', *argv],
        input=data or '',
        text=True,
        capture_output=True,
        timeout=100,
    )
    if proc.returncode:
        raise RuntimeError(
            f'session command exited {proc.returncode}: {proc.stderr[-2048:]} {proc.stdout[-2048:]}'
        )
    return proc.stdout


def cli_error(stderr):
    """The structured failure the CLI prints last on stderr under --json, or {}."""
    lines = [line for line in stderr.splitlines() if line.strip()]
    try:
        error = json.loads(lines[-1])['error']
    except (IndexError, ValueError, KeyError, TypeError):
        return {}
    return error if isinstance(error, dict) else {}


def expect_refusal(binary, config, reason, *command):
    """Require the API to refuse command with the stable reason; classify on it, not the message."""
    proc = subprocess.run(
        [binary, '--config', config, '--json', *command], capture_output=True, text=True, timeout=100
    )
    if proc.returncode == 0 or cli_error(proc.stderr).get('reason') != reason:
        raise RuntimeError(
            f'expected {reason} refusal of {command[0]}: exit {proc.returncode} {proc.stderr[-2048:]}'
        )


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
    def __init__(self, binary, config, report, *, timeout=480, poll_interval=2):
        self.base = [str(Path(binary).resolve()), '--config', str(Path(config).resolve()), '--json']
        self.report = report
        self.timeout = timeout
        self.poll_interval = poll_interval

    def run(self, *command):
        proc = subprocess.run(self.base + list(command), text=True, capture_output=True, timeout=90)
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
            time.sleep(self.poll_interval)
        raise RuntimeError(f'operation timeout; retained for inspection: {op}')

    def expect_delete_dependency(self, machine):
        # The key is journaled with the command before the request, and --async
        # returns an accepted operation at once: an unexpected acceptance is
        # destructive, so retain its identity and never wait, retry or clean up.
        key = uuid.uuid4().hex
        command = ('delete', '--async', '--idempotency-key', key, machine)
        self.begin(command)
        proc = subprocess.run(self.base + list(command), capture_output=True, text=True, timeout=100)
        if proc.returncode == 0:
            self.accepted(command, json.loads(proc.stdout))
            raise RuntimeError(f'dependency rejection check failed: delete was accepted: {proc.stdout[-2048:]}')
        if cli_error(proc.stderr).get('reason') != 'dependency':
            raise RuntimeError(
                f'dependency rejection check failed; idempotency key {key} requires inspection: '
                f'{proc.stderr[-2048:]}'
            )
        self.report.data.pop('pending')
        self.report.data['events'].append({'source_delete_dependency_rejected': machine})
        self.report.save()


def describe_guest(binary, config, machine):
    proc = subprocess.run(
        [binary, '--config', config, '--json', 'guest', machine], capture_output=True, text=True, timeout=100
    )
    if proc.returncode:
        raise RuntimeError('guest description failed: ' + proc.stderr[-2048:])
    value = json.loads(proc.stdout)
    if value.get('machine_id') != machine or not value.get('incarnation'):
        raise RuntimeError('verified guest identity differs from requested machine')
    return value
