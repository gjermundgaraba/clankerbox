#!/usr/bin/env python3
"""Runs the boat live suite (tests/live) on this Mac against boat's trial: builds the darwin-arm64
SEA, runs it unprivileged as a boat host, and runs the suite with the same binary as the CLI.

  python3 tests/live/boat/driver.py --key-file KEY_FILE [--address TAILNET_ADDRESS] \\
    [--suite-args 'VP TEST ARGS']

The host listens on TAILNET_ADDRESS when it is assigned here, and on loopback otherwise or when
none is given (recorded in evidence). It needs no root, and the driver refuses to run as root.

KEY_FILE holds the boat API key alone; keep it outside the repository, mode 0600. The boat CLI's
config holds the key as its JSON `token`; this writes it to KEY_FILE without the key reaching an
argument list:

  python3 -c 'import json, os, sys; key = json.load(open(sys.argv[1]))["token"]; \\
    os.write(os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), key.encode())' \\
    "$HOME/Library/Application Support/ascii/boat/config.json" KEY_FILE

The driver reads the key from KEY_FILE and writes it only into the host's config in the run's
scratch (mode 0600), which the host and the host-control program read. It never reaches an argument
list, an environment, a log or evidence: the driver's own calls log their method, path, status and
boat's code only, and the last teardown step redacts the key from every evidence file and fails the
run if it finds it there.

The run owns one WorkRun (scripts/WORK_RUNS.md) and a host ID of its own,
`clankerbox-live-b<5 hex>`, so the display name of every sandbox the run makes (its machine
ID) starts `<host ID>_`, and every named snapshot's name `cbx-<host ID>-`. Before it builds
anything, a read-only pre-flight counts the account's sandboxes, active sandboxes and named
snapshots, and reads its start limits; the evidence keeps the counts, never the operator's
names or IDs. The run stops there unless two active sandboxes are free, the hour's and day's
starts cover the suite's `STARTS`, and the account has room for its `SNAPSHOTS` named snapshots
under boat's cap of 10. The suite learns the account's active limit
(`CLANKERBOX_LIVE_BOAT_ACTIVE_LIMIT`) and tier (`CLANKERBOX_LIVE_BOAT_TIER`). It skips its test of
boat's 429 for a third active sandbox unless that limit is the trial's two, and its large create,
which expects the trial's 403, unless the tier is `trial`; the pre-flight records each skip.

The host runs under a keeper process (`driver.py keep`), which records the host's pid and exit
status, so the suite's host-control program (`driver.py control`, tests/live/tests/live.ts) can
stop, kill and start it. Teardown, registered before the host starts, works with the host down:
it stops the host, then deletes, by ID, every sandbox the host's database records and every one
the control program saw, then sweeps sandboxes named `<host ID>_…` and named snapshots named
`cbx-<host ID>-…`, and checks that none remains. It touches nothing else on the account; a
sandbox made during the run that carries no run name is counted in evidence, for the operator.
The evidence also records the suite's `[start]` lines and the account's start count before and
after.

It refuses a tree with uncommitted changes, so the commit it records (resources.json `commit`)
names the code it ran. The suite's key and scripts stay in its temporary directory, under the
run's scratch, which it removes; nothing here prints a setup script.
"""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shlex
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from driver_common import (Evidence, Failed, Steps, WorkRun, clean_commit, free_port, host_end, host_start,  # noqa: E402
                           keep, stop_host, stop_on_signals)

API = 'https://boat.dev/api/v1'
# What one run uses (tests/live/tests/boat.test.ts): its starts, the 429 refusal included, the
# sandboxes it has active at once, which is the trial's limit, and its named snapshots.
STARTS = 7
ACTIVE = 2
SNAPSHOTS = 2
SNAPSHOT_CAP = 10


class NoRoom(Exception):
    """The account can't hold the run: it stops before creating anything."""


def read_key(path):
    """The API key in `path`, which holds it alone. Errors name the file, never what it holds."""
    try:
        token = path.read_text().strip()
    except OSError as error:
        sys.exit(f"couldn't read the API key at {path}: {type(error).__name__}")
    if token.startswith('{'):
        sys.exit(f'{path} holds JSON, not the API key alone; --help shows how to write the key file')
    if not token or any(c.isspace() for c in token):
        sys.exit(f'{path} holds no API key')
    return token


class Boat:
    """boat's API v1, for the driver's read-only checks and its teardown. The key travels only in
    the Authorization header; `log` gets the method, path, status and boat's code, never a header
    or a body (a sandbox's desktopUrl carries a token), and errors are scrubbed of the key."""

    def __init__(self, token, log_file):
        self.token = token
        self.log_file = log_file

    def scrub(self, text):
        return str(text).replace(self.token, '<redacted>')

    def call(self, method, path, body=None, headers=None, timeout=60):
        data = None if body is None else json.dumps(body).encode()
        sent = {'Authorization': f'Bearer {self.token}', 'Accept': 'application/json'}
        if body is not None:
            sent['Content-Type'] = 'application/json'
        sent.update(headers or {})
        status, text = None, ''
        try:
            request = urllib.request.Request(API + path, data=data, headers=sent, method=method)
            with urllib.request.urlopen(request, timeout=timeout) as response:
                status, text = response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            status, text = error.code, error.read().decode()
        except (OSError, ValueError) as error:
            text = self.scrub(f'{type(error).__name__}: {error}')
        try:
            answer = json.loads(text) if text else None
        except ValueError:
            answer = None
        code = answer.get('code') if isinstance(answer, dict) else None
        with open(self.log_file, 'a') as log:
            log.write(f'{time.strftime("%H:%M:%S")} {method} {path.split("?")[0]} {status} {code or ""}\n')
        if status is None:
            raise RuntimeError(f'boat {method} {path}: {text}')
        return status, answer

    def ok(self, method, path, body=None, headers=None, timeout=60):
        status, answer = self.call(method, path, body, headers, timeout)
        if status is None or not 200 <= status < 300 or not isinstance(answer, dict):
            code = answer.get('code') if isinstance(answer, dict) else None
            raise RuntimeError(f'boat {method} {path.split("?")[0]} answered {status} {code or ""}')
        return answer

    def sandboxes(self):
        """Every sandbox on the account, stopped ones included. More than a page fails, as it
        does for the host."""
        listed = self.ok('GET', '/sandboxes?limit=200')
        if listed.get('pageInfo', {}).get('hasMore'):
            raise RuntimeError('boat lists more than 200 sandboxes; the run reads only one page')
        return listed['sandboxes']

    def snapshots(self):
        return self.ok('GET', '/named-snapshots')['snapshots']

    def limits(self):
        return self.ok('GET', '/limits')

    def gone(self, sandbox_id, wait=60):
        """Whether boat answers 404 for the sandbox within `wait` seconds."""
        deadline = time.monotonic() + wait
        while True:
            status, _ = self.call('GET', f'/sandboxes/{sandbox_id}')
            if status == 404:
                return True
            if time.monotonic() > deadline:
                return False
            time.sleep(1)

    def delete(self, sandbox_id):
        status, answer = self.call('DELETE', f'/sandboxes/{sandbox_id}',
                                   headers={'X-Ascii-Confirm-Delete': sandbox_id})
        if status not in (202, 404):
            code = answer.get('code') if isinstance(answer, dict) else None
            raise RuntimeError(f'boat DELETE /sandboxes/{sandbox_id} answered {status} {code or ""}')

    def delete_snapshot(self, name):
        status, answer = self.call('DELETE', f'/named-snapshots/{name}')
        if status not in (200, 202, 204, 404):
            code = answer.get('code') if isinstance(answer, dict) else None
            raise RuntimeError(f'boat DELETE /named-snapshots/{name} answered {status} {code or ""}')

    def command(self, sandbox_id, command, timeout_seconds=300):
        return self.ok('POST', f'/sandboxes/{sandbox_id}/commands',
                       {'command': command, 'timeoutSeconds': timeout_seconds}, timeout=timeout_seconds + 30)


def boat_of(state):
    """boat, with the key the host's config holds."""
    token = json.loads(Path(state['config']).read_text())['boat']['apiKey']
    return Boat(token, Path(state['evidence']) / 'api.log')


def starts_of(limits):
    """The start limits and counts boat reports, by window."""
    return {window: {key: limits['starts'][window][key] for key in ('limit', 'used', 'remaining')}
            for window in ('minute', 'hour', 'day')}


def scratch_processes(scratch):
    """(PID, program) of every other process whose command line names the run's scratch."""
    procs = subprocess.run(['ps', '-axo', 'pid=,command='], capture_output=True, text=True).stdout
    return [(pid_text, Path(command.split(' ', 1)[0]).name)
            for pid_text, command in (line.strip().split(' ', 1) for line in procs.splitlines() if scratch in line)
            if int(pid_text) != os.getpid()]


def note_sandboxes(state, ids):
    """Adds sandbox IDs of the run's to the ledger teardown deletes by."""
    if ids:
        with open(Path(state['evidence']) / 'sandbox-ids.txt', 'a') as ledger:
            ledger.write(''.join(f'{sandbox_id}\n' for sandbox_id in ids))


def machine_sandboxes(state, boat, name):
    """The sandboxes whose display name is machine `name`'s ID, noted in the ledger."""
    found = [sandbox for sandbox in boat.sandboxes() if sandbox.get('name') == f'{state["host_id"]}_{name}']
    note_sandboxes(state, [sandbox['id'] for sandbox in found])
    return found


# The suite's host-control program (tests/live/tests/live.ts).

def control(state_file, op, args):
    state = json.loads(Path(state_file).read_text())
    with open(Path(state['evidence']) / 'control.log', 'a') as log:
        log.write(f'{time.strftime("%H:%M:%S")} {shlex.join([op, *args])}\n')
    if op == 'host-start':
        host_start(state, __file__)
    elif op == 'host-stop':
        host_end(state, signal.SIGTERM, 130)
    elif op == 'host-kill':
        host_end(state, signal.SIGKILL, -signal.SIGKILL)
    elif op == 'natives':
        [name] = args
        found = machine_sandboxes(state, boat_of(state), name)
        print(json.dumps({'sandboxes': [{'id': sandbox['id'], 'state': sandbox['state']} for sandbox in found]}))
    elif op == 'snapshots':
        prefix = f'cbx-{state["host_id"]}-'
        print(json.dumps(sorted(snapshot['name'] for snapshot in boat_of(state).snapshots()
                                if snapshot['name'].startswith(prefix))))
    elif op == 'account':
        boat = boat_of(state)
        print(json.dumps({'sandboxes': len(boat.sandboxes()), 'snapshots': len(boat.snapshots())}))
    elif op == 'guest':
        name, command = args
        boat = boat_of(state)
        found = machine_sandboxes(state, boat, name)
        if len(found) != 1:
            print(f'{len(found)} sandboxes for machine {name}', file=sys.stderr)
            return 3
        # boat's command API runs bash as `user`, who has passwordless sudo.
        ran = boat.command(found[0]['id'], f'sudo -n /bin/sh -c {shlex.quote(command)}')
        sys.stdout.write(ran.get('stdout', ''))
        sys.stderr.write(ran.get('stderr', ''))
        return ran['exitCode'] if isinstance(ran.get('exitCode'), int) else 1
    elif op == 'probe':
        address, port = args
        try:
            with socket.create_connection((address, int(port)), timeout=5):
                print('reached')
        except OSError:
            print('unreachable')
    else:
        print(f'unknown op {op}', file=sys.stderr)
        return 2
    return 0


# Teardown, by the run's recorded IDs and its own names.

def database_sandboxes(state, log):
    """The sandbox IDs the host's database records. The host holds its database exclusively, so
    this reads it once the host is down, read-write: a host killed mid-write leaves a hot
    journal, which only a writer can roll back."""
    database = Path(state['state_dir']) / 'host.db'
    if not database.exists():
        return set()
    with closing(sqlite3.connect(str(database))) as db:
        ids = {row[0] for row in db.execute('SELECT native FROM machines WHERE native IS NOT NULL')}
    log(f'teardown: the host database records {len(ids)} sandboxes')
    return ids


def ledger_sandboxes(state):
    """The sandbox IDs the control program saw."""
    ledger = Path(state['evidence']) / 'sandbox-ids.txt'
    return {line.strip() for line in ledger.read_text().splitlines() if line.strip()} if ledger.exists() else set()


def delete_sandbox(boat, sandbox_id, log):
    boat.delete(sandbox_id)
    if not boat.gone(sandbox_id):
        raise RuntimeError(f'boat still has sandbox {sandbox_id} a minute after its delete')
    log(f'teardown: deleted sandbox {sandbox_id}')


def delete_snapshot(boat, name, log):
    boat.delete_snapshot(name)
    log(f'teardown: deleted named snapshot {name}')


def stop_left_processes(state, log):
    """A host killed mid-exec leaves its ssh child behind, holding the run's key: stops it. Only
    the PID and program go to the log, since a child's argv carries the exec's wrapper."""
    stopped = []
    for pid_text, program in scratch_processes(state['scratch']):
        try:
            os.kill(int(pid_text), signal.SIGTERM)
            stopped.append(f'{pid_text} {program}')
        except ProcessLookupError:
            pass
    if stopped:
        log(f'teardown: stopped processes the host left: {stopped}')
    deadline = time.monotonic() + 5
    while scratch_processes(state['scratch']) and time.monotonic() < deadline:
        time.sleep(0.2)
    mine = [f'{pid_text} {program}' for pid_text, program in scratch_processes(state['scratch'])]
    if mine:
        raise RuntimeError(f'processes left: {mine}')


def teardown(state, boat, before, log, record):
    step = Steps(log)
    pid = step('stop the host', stop_host, Path(state['scratch']), log)
    named_prefix = f'{state["host_id"]}_'
    snapshot_prefix = f'cbx-{state["host_id"]}-'

    # By ID first, so a failed listing can't keep a recorded sandbox; then by run name.
    ids = ((step('read the host database', database_sandboxes, state, log) or set())
           | (step('read the sandbox ledger', ledger_sandboxes, state) or set()))
    for sandbox_id in sorted(ids):
        step(f'delete sandbox {sandbox_id}', delete_sandbox, boat, sandbox_id, log)
    swept = {sandbox['id'] for sandbox in step('list sandboxes', boat.sandboxes) or []
             if sandbox['id'] not in ids and (sandbox.get('name') or '').startswith(named_prefix)}
    for sandbox_id in sorted(swept):
        step(f'delete sandbox {sandbox_id}', delete_sandbox, boat, sandbox_id, log)
    ids |= swept
    names = sorted(snapshot['name'] for snapshot in step('list named snapshots', boat.snapshots) or []
                   if snapshot['name'].startswith(snapshot_prefix))
    for name in names:
        step(f'delete named snapshot {name}', delete_snapshot, boat, name, log)

    listed = step('list sandboxes again', boat.sandboxes) or []
    left = [sandbox['id'] for sandbox in listed
            if sandbox['id'] in ids or (sandbox.get('name') or '').startswith(named_prefix)]
    if left:
        step.fail(f'sandboxes left: {left}')
    left_snapshots = [snapshot['name'] for snapshot in step('list named snapshots again', boat.snapshots) or []
                      if snapshot['name'].startswith(snapshot_prefix)]
    if left_snapshots:
        step.fail(f'named snapshots left: {left_snapshots}')
    # A sandbox made during the run that carries no run name may be one whose create the host
    # never recorded, or the operator's own: counted for the operator, never touched.
    unnamed = sum(1 for sandbox in listed if sandbox['id'] not in before['ids'] and sandbox['id'] not in ids
                  and sandbox.get('createdAt', '') >= before['at'])
    step("stop the processes the host left", stop_left_processes, state, log)

    limits = step('read limits', boat.limits)
    after = None if limits is None else starts_of(limits)
    suite_log = Path(state['evidence']) / 'suite.log'
    lines = re.findall(r'^\[start\] (\S+) (\S+) (\S+)\s*$', suite_log.read_text(), re.M) if suite_log.exists() else []
    record(starts={
        'suite': {'count': len(lines), 'refused_429': sum(1 for line in lines if line[2] == '429'),
                  'lines': [' '.join(line) for line in lines]},
        'account_before': before['starts'], 'account_after': after,
        'account_hour_delta': None if after is None else after['hour']['used'] - before['starts']['hour']['used'],
        'active_after': None if limits is None else limits.get('activeSandboxes'),
    })
    result = {'errors': step.errors, 'deleted_sandboxes': sorted(ids), 'deleted_snapshots': names,
              'unnamed_sandboxes_made_during_the_run': unnamed, 'host_pid': pid}
    (Path(state['evidence']) / 'teardown.json').write_text(json.dumps(result, indent=2) + '\n')
    log(f'teardown: {result}')
    step.done()


def redact_evidence(evidence, config, token, log):
    """The last step: removes the scratch copy of the key, then redacts the key from every
    evidence file, failing the run if any held it."""
    config.unlink(missing_ok=True)
    leaked = []
    for path in sorted(evidence.rglob('*')):
        if path.is_file() and token.encode() in path.read_bytes():
            path.write_bytes(path.read_bytes().replace(token.encode(), b'<redacted>'))
            leaked.append(str(path.relative_to(evidence)))
    if leaked:
        log(f'the API key was in {leaked}; redacted')
        raise RuntimeError(f'the API key reached evidence: {leaked}')


def preflight(boat, record, log):
    """Reads the account, changing nothing, and raises NoRoom unless the run fits. Returns what
    teardown compares against: the IDs already there, kept in memory only."""
    at = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    limits = boat.limits()
    sandboxes = boat.sandboxes()
    snapshots = boat.snapshots()
    starts = starts_of(limits)
    active, max_active = limits['activeSandboxes'], limits['currentLimits']['activeSandboxes']
    counts = {'access_tier': limits.get('accessTier'), 'sandboxes': len(sandboxes), 'active_sandboxes': active,
              'max_active_sandboxes': max_active, 'named_snapshots': len(snapshots), 'starts': starts,
              'needs': {'starts': STARTS, 'active': ACTIVE, 'snapshots': SNAPSHOTS}}
    skips = []
    if max_active != ACTIVE:
        # The suite's Capacity test fills the trial's two to provoke boat's 429; on another limit
        # it would make a third sandbox, so the suite skips that test and runs the rest.
        skips.append(f"the account allows {max_active} active sandboxes, not the trial's {ACTIVE}: "
                     'the suite skips its 429 test')
    if limits.get('accessTier') != 'trial':
        # The suite's large create expects the trial's 403; a plan that includes `large` would
        # make a sandbox, so the suite skips that test.
        skips.append(f"the account's tier is {limits.get('accessTier')}, not the trial: "
                     'the suite skips its large create')
    if skips:
        counts['skips'] = skips
    record(preflight=counts)
    log(f'pre-flight: {counts}')
    reasons = []
    if active + ACTIVE > max_active:
        reasons.append(f'{active} of the {max_active} active sandboxes are in use; the run needs {ACTIVE}')
    for window in ('hour', 'day'):
        if starts[window]['remaining'] < STARTS:
            reasons.append(f"{starts[window]['remaining']} starts remain this {window}; the run needs {STARTS}")
    if SNAPSHOT_CAP - len(snapshots) < SNAPSHOTS:
        reasons.append(f'the account holds {len(snapshots)} of its {SNAPSHOT_CAP} named snapshots; '
                       f'the run needs {SNAPSHOTS}')
    if reasons:
        record(preflight=dict(counts, refused=reasons))
        raise NoRoom('; '.join(reasons))
    return {'at': at, 'ids': {sandbox['id'] for sandbox in sandboxes}, 'starts': starts, 'max_active': max_active,
            'tier': limits.get('accessTier')}


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--key-file', type=Path, required=True, help='a file holding the boat API key alone')
    parser.add_argument('--address', help="this Mac's tailnet address; loopback when omitted or not assigned")
    parser.add_argument('--suite-args', default='', help='arguments for the suite run, such as -t PATTERN')
    options = parser.parse_args()

    if os.geteuid() == 0:
        sys.exit('a boat host needs no root; run this as yourself')
    token = read_key(options.key_file)
    commit = clean_commit()
    stop_on_signals()

    with WorkRun('live-boat') as run:
        rid = run.path.name.rsplit('-', 1)[1][:5]
        host_id = f'clankerbox-live-b{rid}'
        config = run.scratch / 'host.json'
        client_config = run.scratch / 'client.json'
        control_bin = run.scratch / 'host-control'
        binary = run.scratch / 'clankerbox'
        state_file = run.scratch / 'state.json'

        evidence = Evidence(run)
        log, record = evidence.log, evidence.record

        # Runs last, after teardown, which needs the key.
        run.on_cleanup(lambda: redact_evidence(run.evidence, config, token, log))

        boat = Boat(token, run.evidence / 'api.log')
        assigned = options.address is not None and re.search(
            rf'^\tinet {re.escape(options.address)} ',
            subprocess.run(['ifconfig'], capture_output=True, text=True).stdout, re.M)
        if assigned:
            address, why = options.address, 'the tailnet address, as production listens'
        else:
            address = '127.0.0.1'
            why = 'no address given' if options.address is None else f'{options.address} is not assigned on this Mac'
        api_port = free_port(address)
        state = {
            'scratch': str(run.scratch), 'evidence': str(run.evidence), 'state_file': str(state_file),
            'binary': str(binary), 'config': str(config), 'host_id': host_id,
            'state_dir': str(run.scratch / 'state'), 'address': address, 'api_port': api_port,
        }
        state_file.write_text(json.dumps(state, indent=2) + '\n')
        record(commit=commit, host_id=host_id, sandbox_display_name_prefix=f'{host_id}_',
               snapshot_prefix=f'cbx-{host_id}-', state_dir=state['state_dir'], config=str(config),
               address=address, address_reason=why, api_port=api_port,
               host_pid_file=str(run.scratch / 'host.pid'))
        log(f'run {run.path.name}: host {host_id} on {address}:{api_port} ({why})')

        before = preflight(boat, record, log)
        run.on_cleanup(lambda: teardown(state, boat, before, log, record))

        evidence.build_binary(binary)

        # The host reads its key from here: created 0600, never written wider.
        fd = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump({
                'id': host_id,
                'runtime': 'boat',
                'listen': {'address': address, 'port': api_port},
                'stateDir': 'state',
                'bases': {'boat': 'boat'},
                'boat': {'apiKey': token},
            }, f, indent=2)
            f.write('\n')
        client_config.write_text(json.dumps({'hosts': [{'id': host_id, 'url': f'http://{address}:{api_port}'}]},
                                            indent=2) + '\n')
        control_bin.write_text(f'#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(__file__)} control '
                               f'{shlex.quote(str(state_file))} "$@"\n')
        control_bin.chmod(0o755)

        log(f'host pid {host_start(state, __file__)}')
        evidence.suite('boat', binary, client_config, control_bin, f'r{rid[:3]}-', options.suite_args,
                       {'CLANKERBOX_LIVE_BOAT_ACTIVE_LIMIT': str(before['max_active']),
                        'CLANKERBOX_LIVE_BOAT_TIER': str(before['tier'])})


if __name__ == '__main__':
    if sys.argv[1:2] == ['keep']:
        keep(json.loads(Path(sys.argv[2]).read_text()))
    elif sys.argv[1:2] == ['control']:
        try:
            sys.exit(control(sys.argv[2], sys.argv[3], sys.argv[4:]))
        except RuntimeError as error:
            print(error, file=sys.stderr)
            sys.exit(1)
    else:
        try:
            main()
        except Failed as failure:
            sys.exit(failure.code)
        except NoRoom as refused:
            sys.exit(f'the account has no room for the run, so it made nothing: {refused}')
