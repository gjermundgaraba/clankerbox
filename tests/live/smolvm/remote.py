#!/usr/bin/env python3
"""The remote half of the smolvm live suite's run: a clankerbox host (the linux-x64 SEA) as root
in a transient system unit on the Linux test host, listening and publishing on its tailnet
address, with its smolvm inventory in the run's scratch. driver.py uploads this file into the
run directory, <owned root>/runs/l<3 hex>/, which has the work-run layout (manifest.json,
scratch/, evidence/), and runs it once per command:

  init ADDRESS PREFIX  manifest, "before" snapshot, CLEANUP.md entries
  setup HOSTID         check the binary, expand the prefix's disk templates, write the host
                       config, start the host unit
  control OP [ARGS]    what the live suite asks of the host (tests/live/tests/live.ts)
  reset                as teardown, but the inventory and its image seed stay; then a host on
                       an empty state, so the suite can run again
  teardown             stop the unit, then delete every VM of the run's inventory and stop every
                       scope of the run natively, by the run's own data dir, so it works with the
                       host down; keep the host's journal, and verify
  finish               remove what the run added to the prefix, remove scratch, restore
                       directory modes, "after" snapshot and diff, mark the CLEANUP.md entries

Every root command goes to evidence/root-runs.log with what it touched. Nothing here reads,
prints or stores a setup script or the preparation script: the host gets them from the CLI over
HTTP, and the control ops see only guest command output.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import socket
import subprocess
import sys
import time

OWNER = 'clankerbox-work-run-v1'
# Pulled from the mirror by digest, so neither the image seed nor a guest pull reaches Docker Hub.
IMAGE = 'mirror.gcr.io/library/ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7'
TEMPLATES = ('storage-template.ext4', 'overlay-template.ext4')
# Every live run's machines carry it; init refuses to start while any run's scope is there.
RUNS_PREFIX = 'clankerbox-rewrite-'
# The scopes of smolvm's image-seed builder VMs, whose names smolvm fixes (S@1.22.2:src/image_seed.rs:381).
HELPER_PATTERNS = ('smolvm-vm-image-seed-*',)
RAM_BUDGET_MIB = 8192
PATH_ENV = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
LEDGER_TAG = 'live suite'
SNAP_DIRS = ['/root', '/etc/systemd/system', '/run/systemd/transient', '/dev/shm', '/tmp', '/var/tmp']

parser = argparse.ArgumentParser()
parser.add_argument('--run', required=True)
parser.add_argument('cmd')
parser.add_argument('args', nargs='*')
args = parser.parse_args()

RUN = Path(args.run)
OWNED = RUN.parent.parent
if not re.fullmatch(r'l[0-9a-f]{3}', RUN.name) or RUN.parent.name != 'runs' or RUN.is_symlink():
    sys.exit(f'refusing a run dir that is not <owned root>/runs/l<3 hex>: {RUN}')
RID = RUN.name
# This run's machines carry its ID, so its teardown stops only its own scopes.
NAME_PREFIX = f'{RUNS_PREFIX}{RID}-'
SCOPE_PATTERN = f'smolvm-vm-{NAME_PREFIX}*'
LEDGER = OWNED / 'CLEANUP.md'
SCRATCH = RUN / 'scratch'
EVIDENCE = RUN / 'evidence'
STATE = RUN / 'state.json'
STATE_DIR = SCRATCH / 's'
DATA = STATE_DIR / 'smolvm'
BINARY = SCRATCH / 'clankerbox'
CONFIG = SCRATCH / 'host.json'
ROOTLOG = EVIDENCE / 'root-runs.log'
UNIT = f'clankerbox-rewrite-{RID}-host.service'
os.chdir('/')


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def note(msg):
    print(f'{time.strftime("%H:%M:%S")} # {msg}', flush=True)


def load_state():
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def save_state(**fields):
    data = load_state()
    data.update(fields)
    tmp = STATE.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, indent=2) + '\n')
    tmp.replace(STATE)


def address():
    return load_state()['address']


def prefix():
    return Path(load_state()['prefix'])


def run(cmd, *, timeout=600):
    try:
        r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, timeout=timeout,
                           stdin=subprocess.DEVNULL)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode(errors='replace') if isinstance(e.stdout, bytes) else (e.stdout or '')
        err = e.stderr.decode(errors='replace') if isinstance(e.stderr, bytes) else (e.stderr or '')
        return 'timeout', out, err


def root_log(shown, touched):
    with open(ROOTLOG, 'a') as f:
        f.write(f'{now()} | {shown} | {touched}\n')


def sudo(cmd, touched='read-only', **kw):
    root_log('sudo -n ' + shlex.join(str(c) for c in cmd), touched)
    return run(['sudo', '-n', *cmd], **kw)


def must(result, what):
    rc, so, se = result
    if rc != 0:
        raise RuntimeError(f'{what} failed rc={rc}: {se.strip()[-1500:]} {so.strip()[-500:]}')
    return so


# ---------------------------------------------------------------- smolvm, in the host's environment

def smol_env():
    """The host's own environment for smolvm (packages/host/src/smolvm.ts `environment`)."""
    return {
        'PATH': PATH_ENV,
        'HOME': str(DATA),
        'SMOLVM_DATA_DIR': str(DATA),
        'SMOLVM_AGENT_ROOTFS': str(prefix() / '.local/share/smolvm/agent-rootfs'),
        'SMOLVM_RESTORE_TMPFS': '0',
        'SMOLVM_VM_USE_SCOPE': '1',
        'SMOLVM_PUBLISH_ADDR': address(),
        'SMOLVM_EGRESS_FLOOR': 'strict',
        'NO_COLOR': '1',
    }


SMOL_TOUCH = ("smolvm as root in the run's inventory (run scratch); systemd scope smolvm-vm-<name>.scope; "
              'VMM under a per-VM uid >= 2000000; o+x on ancestors of the data root and agent rootfs')


def smol(*a, timeout=600, touched=SMOL_TOUCH):
    argv = ['env', '-i', *[f'{k}={v}' for k, v in smol_env().items()], str(prefix() / 'smolvm'), *map(str, a)]
    root_log('sudo smolvm ' + shlex.join(str(x) for x in a), touched)
    return run(['timeout', '-k', '15', str(timeout), 'sudo', '-n', *argv], timeout=timeout + 60)


def machines():
    """The run's inventory, read natively: the host may be down. Every smolvm call makes its data
    dir, and the host's runtime calls smolvm before it makes forks/, so forks/ without DATA means
    DATA no longer matches the host's (smolvm.ts `pathsIn`), and the VMs can't be found here."""
    if not DATA.exists():
        if (STATE_DIR / 'forks').exists():
            raise RuntimeError(f'the host ran but {DATA} is missing: remote.py\'s copy of smolvm.ts pathsIn is stale')
        return []
    rc, so, se = smol('machine', 'ls', '--json', touched='read-only')
    if rc != 0:
        raise RuntimeError(f'machine ls failed rc={rc}: {se[-500:]}')
    data = json.loads(so or '[]')
    return data if isinstance(data, list) else data.get('machines', [])


def list_units(pattern):
    so = must(run(['systemctl', 'list-units', '--all', '--no-legend', '--plain', '--no-pager', pattern]),
              f'systemctl list-units {pattern}')
    return [line.split()[0] for line in so.splitlines() if line.strip()]


def helper_units():
    return sorted(u for p in HELPER_PATTERNS for u in list_units(p))


def new_helper_units():
    """Helper scopes that weren't there when the run started; none without that record."""
    before = load_state().get('helper_units_before')
    return [] if before is None else [u for u in helper_units() if u not in set(before)]


def initialised():
    if not load_state().get('initialised'):
        sys.exit('the run was never initialised, so it owns nothing to tear down')


def vm_uid_processes():
    so = must(run(['ps', '-eo', 'pid=,uid=,args=']), 'ps')
    found = []
    for line in so.splitlines():
        fields = line.split(None, 2)
        if len(fields) >= 2 and int(fields[1]) >= 2000000:
            found.append(line.strip()[:300])
    return found


def run_processes():
    """Processes whose command line names the run, other than this program and its ps."""
    so = must(run(['ps', '-eo', 'pid=,uid=,args=']), 'ps')
    return [line.strip()[:300] for line in so.splitlines()
            if str(RUN) in line and 'remote.py' not in line and 'ps -eo' not in line]


def host_main_pid():
    _, so, _ = run(['systemctl', 'show', '-p', 'MainPID', '--value', UNIT])
    return int(so.strip() or 0) or None


def tailnet_listeners():
    so = must(run(['ss', '-ltnH']), 'ss')
    return sorted({line.split()[3] for line in so.splitlines() if address() in line})


# ---------------------------------------------------------------- snapshot and ledger

def mode_dirs():
    """Every ancestor of the run dir and of the agent rootfs: smolvm as root adds o+x to those of
    its data root and agent rootfs (S@1.22.2:src/agent/manager.rs:2398-2413,
    src/process.rs:1634-1648)."""
    found = set()
    for leaf in (STATE_DIR, prefix() / '.local/share/smolvm/agent-rootfs'):
        for parent in [leaf, *leaf.parents]:
            found.add(str(parent))
    return sorted(found)


def prefix_tree():
    so = must(sudo(['find', str(prefix()), '-printf', '%y %m %u:%g %s %P\\n']), 'find in the prefix')
    return sorted(so.splitlines())


def snapshot(tag):
    snap = {'at': now(), 'tag': tag, 'dirs': {}, 'modes': {}}
    for d in SNAP_DIRS:
        rc, so, se = sudo(['find', d, '-maxdepth', '2', '-printf', '%M %u:%g %p\\n'])
        snap['dirs'][d] = sorted(so.splitlines()) if rc == 0 else [f'unreadable: {se.strip()[-200:]}']
    for d in mode_dirs():
        rc, mode, _ = sudo(['stat', '-c', '%a %U:%G', d])
        _, acl, _ = sudo(['getfacl', '-p', '--absolute-names', d])
        snap['modes'][d] = {'stat': mode.strip(), 'acl': acl.strip()} if rc == 0 else None
    snap['prefix_tree'] = prefix_tree()
    _, so, _ = run(['systemctl', 'list-units', '--all', '--no-legend', '--plain', '--no-pager'])
    snap['units_matching'] = sorted(line for line in so.splitlines() if re.search(r'smolvm|clankerbox', line))
    snap['tailnet_listeners'] = tailnet_listeners()
    snap['vm_uid_processes'] = vm_uid_processes()
    (EVIDENCE / f'snapshot-{tag}.json').write_text(json.dumps(snap, indent=2) + '\n')
    return snap


def ledger_add(key, text):
    with open(LEDGER, 'a') as f:
        f.write(f'- {time.strftime("%Y-%m-%d %H:%M")} ({LEDGER_TAG}, run {RID}) [{key}] {text} STATUS: pending\n')
    note(f'ledger + {key}')


def ledger_mark(key, status):
    text = LEDGER.read_text()
    pattern = re.compile(rf'(\({re.escape(LEDGER_TAG)}, run {re.escape(RID)}\) \[{re.escape(key)}\] .*?)STATUS: pending')
    new, n = pattern.subn(lambda m: m.group(1) + 'STATUS: ' + status, text)
    if n:
        LEDGER.write_text(new)
    note(f'ledger {key}: {status} ({n} line)')


# ---------------------------------------------------------------- init and setup

def cmd_init(tailnet, smolvm_prefix):
    RUN.mkdir(mode=0o700, exist_ok=True)
    if (RUN / 'manifest.json').exists():
        sys.exit('run already initialised')
    (RUN / 'manifest.json').write_text(json.dumps(dict(
        owner=OWNER, id=RID, label='live-smolvm', created_at=now(), state='running', keep=False,
        driver='tests/live/smolvm/driver.py'), indent=2) + '\n')
    SCRATCH.mkdir(mode=0o700)
    EVIDENCE.mkdir(mode=0o700)
    root_log('(legend)', 'every sudo command of this run follows; "read-only" means it changed nothing')
    save_state(address=tailnet, prefix=smolvm_prefix, helper_units_before=helper_units())
    if not (prefix() / 'READY').exists():
        sys.exit(f'{prefix()}/READY is missing')
    if list_units(f'smolvm-vm-{RUNS_PREFIX}*') or vm_uid_processes():
        sys.exit(f'smolvm-vm-{RUNS_PREFIX}* scopes or VM-uid processes exist before the run; another run is live')
    snap = snapshot('before')
    save_state(modes_before={d: v for d, v in snap['modes'].items()}, prefix_tree_before=snap['prefix_tree'],
               tailnet_listeners_before=snap['tailnet_listeners'],
               shm_restore_before=os.path.exists('/dev/shm/smolvm-restore'))
    ledger_add('dirmodes', 'smolvm running as root adds others-execute to every ancestor of its data root and of '
               'its agent rootfs (S@1.22.2:src/agent/manager.rs:2398-2413, src/process.rs:1634-1648): the home '
               f'directory and, inside the owned root, the directories down to runs/{RID}/scratch and the prefix. '
               'Revert: chmod back to the recorded modes; verify stat and getfacl identical.')
    ledger_add('units', f'transient system unit {UNIT} (sudo systemd-run --collect) running the clankerbox host as '
               f'root; smolvm-created scopes {SCOPE_PATTERN}.scope (SMOLVM_VM_USE_SCOPE=1); and scopes of '
               "smolvm's image-seed builder VMs, whose names the run cannot prefix: "
               'smolvm-vm-image-seed-<key16>-<pid>.scope. Revert: stop the unit, delete every VM of the run\'s '
               'inventory natively, stop/reset-failed the run\'s scopes and helper scopes that were not there '
               'before; verify none listed by systemctl list-units --all.')
    ledger_add('shm', '/dev/shm/smolvm-restore: not expected (the host sets SMOLVM_RESTORE_TMPFS=0 on every smolvm '
               'call). Revert: remove it if this run created it.')
    ledger_add('procs', 'the root host process, root smolvm processes and VMM processes under per-VM uids 2000000+. '
               'Revert: stop every VM and the host; verify no process names the run and no uid>=2000000 process.')
    ledger_add('published', f'the host API listener on {tailnet}:<api port> (state.json) and smolvm published '
               f'listeners on {tailnet}:<port> (10000-19999), one per running machine; reachable by whatever the '
               "tailnet policy allows; guests' sshd accept only the run's ephemeral key. Revert: delete every VM "
               'and stop the host; verify the tailnet listener set equals the one recorded before the run.')
    save_state(initialised=True)
    print(f'initialised {RUN}')


def port_free(port):
    s = socket.socket()
    try:
        s.bind((address(), port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def answers(port):
    """A bind probe can't tell: TIME_WAIT connections of the last host keep the port unbindable."""
    try:
        with socket.create_connection((address(), port), timeout=1):
            return True
    except OSError:
        return False


def check_binary():
    sha = load_state().get('binary_sha256')
    _, so, _ = run(['sha256sum', BINARY])
    if not sha or so.split()[0] != sha:
        raise RuntimeError(f'binary sha256 {so.split()[0] if so else "?"} != expected {sha}')
    os.chmod(BINARY, 0o755)


def cmd_setup(host_id):
    # Outside 10000-19999 (machine ports), smolvm's 20000-32000 and the ephemeral range.
    port = next(p for p in range(9460, 9500) if port_free(p))
    check_binary()
    must(run([BINARY, '--version']), 'binary --version')
    # The host refuses a prefix without expanded templates (P12). As the prefix's owner, so
    # nothing root-owned lands there; finish removes them.
    for name in TEMPLATES:
        target = prefix() / name
        if not target.exists():
            t0 = time.monotonic()
            must(run(['zstd', '-q', '-d', '--sparse', f'{target}.zst', '-o', target], timeout=600), f'zstd {name}')
            note(f'expanded {name} in {time.monotonic() - t0:.2f}s')
    CONFIG.write_text(json.dumps({
        'id': host_id, 'runtime': 'smolvm', 'listen': {'address': address(), 'port': port}, 'stateDir': 's',
        'bases': {'ubuntu': IMAGE},
        'smolvm': {'prefix': str(prefix()), 'ramBudgetMib': RAM_BUDGET_MIB},
    }, indent=2) + '\n')
    (EVIDENCE / 'host.json').write_text(CONFIG.read_text())
    save_state(api_port=port, host_id=host_id)
    host_start()


def host_start():
    port = load_state()['api_port']
    check_binary()
    sudo(['systemctl', 'reset-failed', UNIT], touched=f'clears {UNIT} if it is left failed')
    # A global flag before `host`, which mustn't change the exit code host-stop checks.
    must(sudo(['systemd-run', f'--unit={UNIT}', '--collect', '--property=Type=exec',
               f'--property=WorkingDirectory={SCRATCH}', '--property=KillMode=control-group',
               str(BINARY), '--log-level', 'info', 'host', '--config', str(CONFIG)],
              touched=f'starts transient system unit {UNIT} (the clankerbox host as root)'), 'systemd-run')
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if answers(port):
            note(f'host listening on {address()}:{port}, MainPID {host_main_pid()}')
            return
        _, so, _ = run(['systemctl', 'is-active', UNIT])
        if so.strip() not in ('active', 'activating'):
            break
        time.sleep(0.2)
    journal()
    raise RuntimeError(f'host did not listen on {port}; see evidence/journal.log')


def journal():
    _, so, _ = sudo(['journalctl', '-u', UNIT, '--no-pager', '-o', 'short-iso-precise'])
    (EVIDENCE / 'journal.log').write_text(so)
    return so


def unit_active():
    _, so, _ = run(['systemctl', 'is-active', UNIT])
    return so.strip() in ('active', 'activating', 'deactivating')


def wait_unit_gone(timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not unit_active():
            return
        time.sleep(0.2)
    raise RuntimeError(f'{UNIT} still active after {timeout}s')


# ---------------------------------------------------------------- control ops

def native_for(name):
    """The one native machine whose name is <name>-<8 hex>."""
    pattern = re.compile(rf'{re.escape(name)}-[0-9a-f]{{8}}')
    hits = [m['name'] for m in machines() if pattern.fullmatch(str(m.get('name', '')))]
    if len(hits) != 1:
        raise RuntimeError(f'expected one native machine for {name}, found {hits}')
    return hits[0]


def control(op, rest):
    if op == 'host-start':
        host_start()
    elif op == 'host-stop':
        host_stop()
    elif op == 'stop-host-at':
        name, limit = rest
        deadline = time.monotonic() + float(limit)
        while True:
            caught = [(verb, pid) for verb in ('update', 'start') for pid in host_calls(name, verb)]
            if caught:
                break
            if time.monotonic() > deadline:
                raise RuntimeError(f'the host made no VM for {name} within {limit}s')
            time.sleep(0.02)
        verb, pid = caught[0]
        # Held, so the stop lands while the VM is made but not booted; systemd's SIGTERM comes
        # with a SIGCONT, so the held call then ends like the rest of the host's.
        must(sudo(['kill', '-STOP', pid], touched=f'holds the host\'s smolvm machine {verb} of {name} (pid {pid})'),
             'kill -STOP')
        note(f'held the host\'s machine {verb} of {name}')
        host_stop()
    elif op == 'host-kill':
        pid = host_main_pid()
        must(sudo(['systemctl', 'kill', '--signal=SIGKILL', '--kill-whom=main', UNIT],
                  touched=f'SIGKILLs the main process of {UNIT} (pid {pid})'), 'systemctl kill')
        wait_unit_gone()
        note(f'host pid {pid} killed; unit gone')
    elif op == 'natives':
        found = [{'name': m.get('name'), 'state': m.get('state')} for m in machines()
                 if str(m.get('name', '')).startswith(rest[0])]
        print(json.dumps({'machines': found, 'scopes': list_units(f'smolvm-vm-{rest[0]}*')}))
    elif op == 'guest':
        name, command = rest
        native = native_for(name)
        rc, so, se = smol('machine', 'exec', '--name', native, '--', '/bin/sh', '-c', command,
                          touched=f'runs a command in guest {native}', timeout=120)
        sys.stdout.write(so)
        sys.stderr.write(se)
        return rc if isinstance(rc, int) else 124
    elif op == 'decoy':
        native = f'{rest[0]}-{secrets.token_hex(4)}'
        must(smol('machine', 'create', '--name', native, '--image', IMAGE, '--cpus', 1, '--mem', 512, '--net',
                  '--net-backend', 'virtio-net', '--storage', 20,
                  touched=f'creates decoy machine {native} in the run inventory'), 'decoy create')
        must(smol('machine', 'start', '--name', native, touched=f'starts decoy {native} (scope)'), 'decoy start')
        print(native)
    elif op == 'remove-native':
        native = rest[0]
        if not native.startswith(NAME_PREFIX):
            raise RuntimeError(f'refusing to remove {native}')
        smol('machine', 'stop', '--name', native, touched=f'stops {native}')
        must(smol('machine', 'delete', '--name', native, '--force', touched=f'deletes {native}'), 'delete')
    elif op == 'freeze':
        native = native_for(rest[0])
        # The exec doesn't return once its own guest filesystem is frozen; the freeze holds.
        rc, so, se = smol('machine', 'exec', '--name', native, '--', '/bin/sh', '-c',
                          'fsfreeze -f /storage && echo frozen', touched=f'freezes /storage in guest {native}',
                          timeout=10)
        note(f'freeze exec rc={rc} {so.strip()} {se.strip()[-300:]}')
    elif op == 'wait-host-exec':
        name, limit = rest
        deadline = time.monotonic() + float(limit)
        while not host_calls(name, 'exec'):
            if time.monotonic() > deadline:
                raise RuntimeError(f'the host ran no guest command in {name} within {limit}s')
            time.sleep(0.2)
    elif op == 'forks':
        # The host's startup makes forks/ and the checkpoint store, so a missing one fails.
        print(json.dumps(must(sudo(['ls', '-A', str(STATE_DIR / 'forks')]), 'ls forks').split()))
    elif op == 'plant-fork':
        leftover = STATE_DIR / 'forks' / rest[0]
        if not rest[0].startswith(NAME_PREFIX):
            raise RuntimeError(f'refusing to plant {rest[0]}')
        must(sudo(['mkdir', str(leftover)], touched=f'makes {leftover}, a leftover fork store in the run\'s state dir'),
             'mkdir')
        must(sudo(['touch', str(leftover / 'leftover')], touched=f'makes a file in {leftover}'), 'touch')
    elif op == 'store':
        checkpoints = must(sudo(['ls', '-A', str(STATE_DIR / 'checkpoints')]), 'ls checkpoints')
        print(json.dumps({'checkpoints': checkpoints.split()}))
    elif op == 'probe':
        try:
            with socket.create_connection((rest[0], int(rest[1])), timeout=5):
                print('reached')
        except OSError:
            print('unreachable')
    elif op == 'route':
        print(must(run(['ip', 'route', 'get', rest[0]]), 'ip route get').strip())
    else:
        raise RuntimeError(f'unknown control op {op}')
    return 0


def host_calls(name, verb):
    """The PIDs of the host's own `smolvm machine VERB` calls for the machine NAME-<8 hex>. Only
    pgrep's PIDs are read: an exec's arguments can carry the preparation script."""
    if not re.fullmatch(r'[a-z0-9-]+', name):
        raise RuntimeError(f'unexpected machine name {name}')
    host = host_main_pid()
    if host is None:
        return []
    rc, so, se = run(['pgrep', '-P', str(host), '-f', f'machine {verb} --name {name}-[0-9a-f]{{8}}( |$)'])
    if rc not in (0, 1):
        raise RuntimeError(f'pgrep failed rc={rc}: {se.strip()}')
    return so.split()


def host_stop():
    """Stops the host with SIGTERM, as its unit's stop does, and checks it exited 0."""
    since = int(time.time())
    t0 = time.monotonic()
    must(sudo(['systemctl', 'stop', UNIT], touched=f'stops {UNIT} (SIGTERM)'), 'systemctl stop')
    wait_unit_gone()
    note(f'host stopped in {time.monotonic() - t0:.2f}s')
    # The unit is collected once it stops, so its result is read from systemd's journal lines.
    deadline = time.monotonic() + 10
    while True:
        _, so, _ = sudo(['journalctl', '-u', UNIT, '--since', f'@{since}', '--no-pager', '-o', 'cat'])
        ended = [line for line in so.splitlines()
                 if line.startswith(f'{UNIT}: ') and re.search(r'Deactivated|Failed|Main process', line)]
        clean = any('Deactivated successfully' in line for line in ended)
        failed = any('Failed' in line for line in ended)
        if clean or failed or time.monotonic() > deadline:
            break
        time.sleep(0.5)
    if failed or not clean:
        raise RuntimeError(f'the host did not exit 0 on SIGTERM: {ended}')


# ---------------------------------------------------------------- teardown and finish

def attempt(report, what, action):
    """Runs one teardown item, best effort: a failure is recorded and the next item still runs."""
    try:
        return action()
    except Exception as error:  # noqa: BLE001 - recorded; teardown goes on with the rest
        report['errors'].append(f'{what}: {error}')
        return None


def remove_machine(report, name):
    stopped = smol('machine', 'stop', '--name', name, touched=f'teardown: stops leftover {name}')
    deleted = smol('machine', 'delete', '--name', name, '--force', touched=f'teardown: deletes leftover {name}')
    report['steps'].append({'leftover': name, 'stop': stopped[0], 'delete': deleted[0]})
    if deleted[0] != 0:
        scope = f'smolvm-vm-{name}.scope'
        sudo(['systemctl', 'kill', '--signal=SIGKILL', scope], touched=f'teardown: kills the run\'s scope {scope}')
        deleted = smol('machine', 'delete', '--name', name, '--force', touched=f'teardown: deletes leftover {name}')
        report['steps'].append({'leftover': name, 'scope_killed': scope, 'delete_retry': deleted[0]})


def stop_scope(report, unit):
    sudo(['systemctl', 'stop', unit], touched=f'teardown: stops the run\'s scope {unit}')
    sudo(['systemctl', 'reset-failed', unit], touched=f'teardown: resets the run\'s scope {unit}')
    report['steps'].append({'scope': unit})


def remove_natives(report):
    """Stops the host, then deletes every VM of the run's inventory and stops the run's scopes,
    natively, each item best effort; what is left, and every failure, goes into `report`."""
    def stop_unit():
        if unit_active():
            sudo(['systemctl', 'stop', UNIT], touched=f'stops {UNIT}')
            report['steps'].append('unit stopped')
        wait_unit_gone()

    attempt(report, 'stop the host unit', stop_unit)
    for m in attempt(report, 'list the inventory', machines) or []:
        name = str(m.get('name'))
        if not name.startswith(NAME_PREFIX):
            report['errors'].append(f'left alone: {name} in the run inventory lacks {NAME_PREFIX}')
            continue
        attempt(report, f'remove {name}', lambda: remove_machine(report, name))
    scopes = attempt(report, 'list the run\'s scopes', lambda: list_units(SCOPE_PATTERN) + new_helper_units())
    for unit in scopes or []:
        attempt(report, f'stop {unit}', lambda: stop_scope(report, unit))
    for unit in attempt(report, 'list the run\'s units', lambda: list_units(f'clankerbox-rewrite-{RID}*')) or []:
        attempt(report, f'reset {unit}',
                lambda: sudo(['systemctl', 'reset-failed', unit], touched=f'teardown: resets {unit}'))
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and (vm_uid_processes() or run_processes()):
        time.sleep(1)
    left = attempt(report, 'list the inventory again', lambda: [m.get('name') for m in machines()])
    report.update(machines_left=left,
                  scopes_left=attempt(report, 'list the run\'s scopes again',
                                      lambda: list_units(SCOPE_PATTERN) + new_helper_units()),
                  units_left=attempt(report, 'list the run\'s units again',
                                     lambda: list_units(f'clankerbox-rewrite-{RID}*')),
                  vm_uid_processes=vm_uid_processes(), run_processes=run_processes(),
                  tailnet_listeners=tailnet_listeners())
    return not (report['errors'] or left or report['scopes_left'] or report['units_left']
                or report['vm_uid_processes'] or report['run_processes'])


def cmd_teardown():
    initialised()
    report = {'at': now(), 'steps': [], 'errors': []}
    clean = remove_natives(report)
    attempt(report, 'keep the host\'s journal', journal)
    (EVIDENCE / 'teardown.json').write_text(json.dumps(report, indent=2) + '\n')
    if not clean:
        raise RuntimeError(f'teardown incomplete: {report}')
    (EVIDENCE / 'teardown-verified.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


def cmd_reset():
    """Teardown that keeps the inventory, and so its image seed, then a host on an empty state:
    the suite can run again without pulling the image again."""
    initialised()
    report = {'at': now(), 'steps': [], 'errors': []}
    attempt(report, 'keep the host\'s journal', journal)
    clean = remove_natives(report)
    with open(EVIDENCE / 'resets.jsonl', 'a') as f:
        f.write(json.dumps(report) + '\n')
    if not clean:
        raise RuntimeError(f'reset incomplete: {report}')
    for name in ('host.db', 'host.db-wal', 'host.db-shm', 'checkpoints', 'forks'):
        sudo(['rm', '-rf', '--one-file-system', str(STATE_DIR / name)],
             touched=f'reset: removes {STATE_DIR / name}, the host\'s state but not its smolvm inventory')
    host_start()


def cmd_finish():
    initialised()
    data = json.loads((RUN / 'manifest.json').read_text())
    if data.get('owner') != OWNER or data.get('id') != RID:
        sys.exit('not an owned run')
    if not (EVIDENCE / 'teardown-verified.json').exists():
        sys.exit('no verified teardown; scratch and outside changes retained')
    st = load_state()
    result = {}
    units = list_units(SCOPE_PATTERN) + list_units(f'clankerbox-rewrite-{RID}*') + new_helper_units()
    result['units'] = (f'REVERTED {now()} (no {UNIT}, no {SCOPE_PATTERN} scope and no image-seed '
                       'helper scope that was not there before, per systemctl list-units --all)'
                       if not units else f'NOT REVERTED: {units}')
    shm = os.path.exists('/dev/shm/smolvm-restore')
    if shm and not st.get('shm_restore_before'):
        sudo(['rmdir', '/dev/shm/smolvm-restore'], touched='removes /dev/shm/smolvm-restore, made during the run')
    result['shm'] = (f'REVERTED {now()} (never made; verified absent)' if not shm
                     else f'REVERTED {now()} (made during the run; removed)'
                     if not os.path.exists('/dev/shm/smolvm-restore') else 'NOT REVERTED: present')
    procs = vm_uid_processes() + run_processes()
    result['procs'] = (f'REVERTED {now()} (no process names the run; no uid>=2000000 process)'
                       if not procs else f'NOT REVERTED: {procs}')
    listeners = tailnet_listeners()
    result['published'] = (f'REVERTED {now()} (tailnet listeners identical to before the run: {listeners})'
                           if listeners == st.get('tailnet_listeners_before')
                           else f'NOT REVERTED: before {st.get("tailnet_listeners_before")}, now {listeners}')
    # What the run added inside the prefix: the expanded templates, and anything root smolvm wrote.
    before = {line.split(' ', 4)[4] for line in st.get('prefix_tree_before', []) if len(line.split(' ', 4)) == 5}
    removed, new_dirs = [], []
    for line in prefix_tree():
        parts = line.split(' ', 4)
        if len(parts) < 5 or parts[4] in before or '..' in parts[4].split('/'):
            continue
        path = prefix() / parts[4]
        if parts[0] == 'd':
            new_dirs.append(path)
            continue
        sudo(['rm', '-f', str(path)], touched=f'removes {path} ({parts[2]}, {parts[3]} bytes), added to the prefix')
        removed.append(line)
    for path in sorted(new_dirs, key=lambda p: -len(str(p))):
        sudo(['rmdir', str(path)], touched=f'removes empty dir {path}, added to the prefix')
        removed.append(f'd {path}')
    (EVIDENCE / 'prefix-files-removed.txt').write_text('\n'.join(removed) + '\n')
    scratch = Path(os.path.realpath(SCRATCH))
    if scratch != SCRATCH or scratch.parent != RUN:
        sys.exit(f'refusing to delete unexpected scratch path {scratch}')
    if SCRATCH.exists():
        _, so, _ = sudo(['du', '-sh', str(SCRATCH)])
        note(f'scratch before removal: {so.strip()}')
        rc, _, se = sudo(['rm', '-rf', '--one-file-system', str(SCRATCH)], touched=f'removes {SCRATCH}',
                         timeout=900)
        if rc != 0 or SCRATCH.exists():
            sys.exit(f'scratch removal failed: {se}')
    for d, recorded in st.get('modes_before', {}).items():
        if recorded is None or not os.path.exists(d):
            continue
        mode = recorded['stat'].split()[0]
        _, current, _ = sudo(['stat', '-c', '%a', d])
        if current.strip() != mode:
            sudo(['chmod', mode, d], touched=f'restores mode {mode} on {d}')
    snap = snapshot('after')
    b = json.loads((EVIDENCE / 'snapshot-before.json').read_text())
    diff = {}
    for d in SNAP_DIRS:
        old, new = set(b['dirs'][d]), set(snap['dirs'][d])
        if old != new:
            diff[d] = {'added': sorted(new - old), 'removed': sorted(old - new)}
    for key in ('units_matching', 'prefix_tree'):
        if set(b[key]) != set(snap[key]):
            diff[key] = {'added': sorted(set(snap[key]) - set(b[key])), 'removed': sorted(set(b[key]) - set(snap[key]))}
    # Scratch and everything under it is gone; every other directory must be as it was.
    kept = [d for d, v in b['modes'].items() if v is not None and not d.startswith(str(SCRATCH))]
    modes_ok = all(snap['modes'].get(d) == b['modes'][d] for d in kept)
    diff['modes_identical'] = modes_ok
    if not modes_ok:
        diff['modes'] = {d: {'before': b['modes'][d], 'after': snap['modes'].get(d)} for d in kept
                         if snap['modes'].get(d) != b['modes'][d]}
    diff['prefix_identical'] = 'prefix_tree' not in diff
    (EVIDENCE / 'snapshot-diff.json').write_text(json.dumps(diff, indent=2) + '\n')
    result['dirmodes'] = (f'REVERTED {now()} (stat and getfacl identical to before; prefix tree identical)'
                          if modes_ok and diff['prefix_identical'] else 'NOT REVERTED: see evidence/snapshot-diff.json')
    for key, value in result.items():
        ledger_mark(key, value)
    reverted = not any(value.startswith('NOT REVERTED') for value in result.values())
    data.update(state='cleaned' if reverted else 'not_reverted', cleaned_at=now())
    (RUN / 'manifest.json').write_text(json.dumps(data, indent=2) + '\n')
    print(json.dumps({'result': result, 'diff': diff}, indent=2))
    if not reverted:
        sys.exit('NOT REVERTED: see CLEANUP.md and evidence/snapshot-diff.json')


def main():
    if args.cmd == 'init':
        return cmd_init(*args.args)
    if args.cmd == 'set-binary-sha':
        return save_state(binary_sha256=args.args[0])
    if args.cmd == 'setup':
        return cmd_setup(*args.args)
    if args.cmd == 'control':
        sys.exit(control(args.args[0], args.args[1:]))
    if args.cmd == 'teardown':
        return cmd_teardown()
    if args.cmd == 'reset':
        return cmd_reset()
    if args.cmd == 'finish':
        return cmd_finish()
    sys.exit(f'unknown command {args.cmd}')


if __name__ == '__main__':
    main()
