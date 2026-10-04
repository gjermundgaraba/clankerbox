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
                       host down; verify, and count image pulls and fork-ready failures
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
IMAGE = 'ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7'
TEMPLATES = ('storage-template.ext4', 'overlay-template.ext4')
# Every native machine of the run carries it; init refuses to start while any scope has it.
NAME_PREFIX = 'clankerbox-rewrite-'
SCOPE_PATTERN = f'smolvm-vm-{NAME_PREFIX}*'
# smolvm's own helper VMs, whose scope names smolvm fixes (S@1.22.2:src/image_seed.rs:381,
# src/pack_export.rs:419-426); a failed pack export leaks its helper's scope.
HELPER_PATTERNS = ('smolvm-vm-image-seed-*', 'smolvm-vm-pack-fromvm-*')
RAM_BUDGET_MIB = 8192
PATH_ENV = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
LEDGER_TAG = 'live suite'
SNAP_DIRS = ['/root', '/etc/systemd/system', '/run/systemd/transient', '/dev/shm', '/tmp', '/var/tmp']
DOCKER_RATE = r'''
T=$(curl -s --max-time 20 "https://auth.docker.io/token?service=registry.docker.io&scope=repository:ratelimitpreview/test:pull" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
for f in 4 6; do curl -$f -s --max-time 20 --head -H "Authorization: Bearer $T" https://registry-1.docker.io/v2/ratelimitpreview/test/manifests/latest | grep -i -E "^ratelimit-limit|^ratelimit-remaining" | tr -d '\r' | tr '\n' ' '; echo; done
'''

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
    """The run's inventory, read natively: the host may be down."""
    if not DATA.exists():
        return []
    rc, so, se = smol('machine', 'ls', '--json', touched='read-only')
    if rc != 0:
        raise RuntimeError(f'machine ls failed rc={rc}: {se[-500:]}')
    data = json.loads(so or '[]')
    return data if isinstance(data, list) else data.get('machines', [])


def list_units(pattern):
    _, so, _ = run(['systemctl', 'list-units', '--all', '--no-legend', '--plain', '--no-pager', pattern])
    return [line.split()[0] for line in so.splitlines() if line.strip()]


def helper_units():
    return sorted(u for p in HELPER_PATTERNS for u in list_units(p))


def new_helper_units():
    before = set(load_state().get('helper_units_before', []))
    return [u for u in helper_units() if u not in before]


def vm_uid_processes():
    _, so, _ = run(['ps', '-eo', 'pid=,uid=,args='])
    found = []
    for line in so.splitlines():
        fields = line.split(None, 2)
        if len(fields) >= 2 and int(fields[1]) >= 2000000:
            found.append(line.strip()[:300])
    return found


def run_processes():
    """Processes whose command line names the run, other than this program and its ps."""
    _, so, _ = run(['ps', '-eo', 'pid=,uid=,args='])
    return [line.strip()[:300] for line in so.splitlines()
            if str(RUN) in line and 'remote.py' not in line and 'ps -eo' not in line]


def host_main_pid():
    _, so, _ = run(['systemctl', 'show', '-p', 'MainPID', '--value', UNIT])
    return int(so.strip() or 0) or None


def tailnet_listeners():
    _, so, _ = run(['ss', '-ltnH'])
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
    _, so, _ = sudo(['find', str(prefix()), '-printf', '%y %m %u:%g %s %P\\n'])
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


def docker_rate():
    """Docker Hub's anonymous pull budget for this host's addresses; HEAD requests aren't counted."""
    _, so, _ = run(['sh', '-c', DOCKER_RATE], timeout=90)
    return so.strip().splitlines()


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
    save_state(address=tailnet, prefix=smolvm_prefix, started_epoch=int(time.time()))
    if not (prefix() / 'READY').exists():
        sys.exit(f'{prefix()}/READY is missing')
    if len(str(STATE_DIR)) > 52:
        sys.exit(f'state dir {STATE_DIR} is past the 52 bytes smolvm\'s socket paths allow')
    if list_units(SCOPE_PATTERN) or vm_uid_processes():
        sys.exit(f'{SCOPE_PATTERN} scopes or VM-uid processes exist before the run; another run is live')
    snap = snapshot('before')
    save_state(modes_before={d: v for d, v in snap['modes'].items()}, prefix_tree_before=snap['prefix_tree'],
               tailnet_listeners_before=snap['tailnet_listeners'], helper_units_before=helper_units(),
               shm_restore_before=os.path.exists('/dev/shm/smolvm-restore'), docker_rate_before=docker_rate())
    ledger_add('dirmodes', 'smolvm running as root adds others-execute to every ancestor of its data root and of '
               'its agent rootfs (S@1.22.2:src/agent/manager.rs:2398-2413, src/process.rs:1634-1648): the home '
               f'directory and, inside the owned root, the directories down to runs/{RID}/scratch and the prefix. '
               'Revert: chmod back to the recorded modes; verify stat and getfacl identical.')
    ledger_add('units', f'transient system unit {UNIT} (sudo systemd-run --collect) running the clankerbox host as '
               f'root; smolvm-created scopes {SCOPE_PATTERN}.scope (SMOLVM_VM_USE_SCOPE=1); and scopes of '
               "smolvm's helper VMs whose names the run cannot prefix: smolvm-vm-image-seed-<key16>-<pid>.scope "
               'and smolvm-vm-pack-fromvm-<pid>-<ns>.scope, which a failed export leaks (P12, P9). Revert: stop '
               'the unit, delete every VM natively, stop/reset-failed the run\'s scopes and helper scopes that were '
               'not there before; verify none listed by systemctl list-units --all.')
    ledger_add('shm', '/dev/shm/smolvm-restore: not expected (the host sets SMOLVM_RESTORE_TMPFS=0 on every smolvm '
               'call). Revert: remove it if this run created it.')
    ledger_add('procs', 'the root host process, root smolvm processes and VMM processes under per-VM uids 2000000+. '
               'Revert: stop every VM and the host; verify no process names the run and no uid>=2000000 process.')
    ledger_add('published', f'the host API listener on {tailnet}:<api port> (state.json) and smolvm published '
               f'listeners on {tailnet}:<port> (10000-19999), one per running machine; reachable by whatever the '
               "tailnet policy allows; guests' sshd accept only the run's ephemeral key. Revert: delete every VM "
               'and stop the host; verify the tailnet listener set equals the one recorded before the run.')
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
    must(sudo(['systemd-run', f'--unit={UNIT}', '--collect', '--property=Type=exec',
               f'--property=WorkingDirectory={SCRATCH}', '--property=KillMode=control-group',
               str(BINARY), 'host', '--config', str(CONFIG)],
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
        t0 = time.monotonic()
        must(sudo(['systemctl', 'stop', UNIT], touched=f'stops {UNIT} (SIGTERM)'), 'systemctl stop')
        wait_unit_gone()
        note(f'host stopped in {time.monotonic() - t0:.2f}s')
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
        native = name if re.search(r'-[0-9a-f]{8}$', name) else native_for(name)
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
        while not host_execs(name):
            if time.monotonic() > deadline:
                raise RuntimeError(f'the host ran no guest command in {name} within {limit}s')
            time.sleep(0.2)
    elif op == 'forks':
        _, so, _ = sudo(['ls', '-A', str(STATE_DIR / 'forks')])
        print(json.dumps(so.split()))
    elif op == 'plant-fork':
        leftover = STATE_DIR / 'forks' / rest[0]
        if not rest[0].startswith(NAME_PREFIX):
            raise RuntimeError(f'refusing to plant {rest[0]}')
        must(sudo(['mkdir', str(leftover)], touched=f'makes {leftover}, a leftover fork store in the run\'s state dir'),
             'mkdir')
        must(sudo(['touch', str(leftover / 'leftover')], touched=f'makes a file in {leftover}'), 'touch')
    elif op == 'set-pin':
        if unit_active():
            raise RuntimeError('the host holds its database while it runs; stop it first')
        name, pin = rest
        must(sudo(['python3', '-c', SET_PIN, str(STATE_DIR / 'host.db'), name, pin],
                  touched=f'sets the pin of checkpoint {name} in the run\'s host database'), 'set-pin')
    elif op == 'store':
        _, checkpoints, _ = sudo(['ls', '-A', str(STATE_DIR / 'checkpoints')])
        _, packs, _ = sudo(['ls', '-A', str(STATE_DIR / 'packs')])
        print(json.dumps({'checkpoints': checkpoints.split(), 'packs': packs.split()}))
    elif op == 'usage':
        print(json.dumps(usage(native_for(rest[0]))))
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


def host_execs(name):
    """Whether a process under the host runs `smolvm machine exec` in the machine NAME-<8 hex>."""
    host = host_main_pid()
    pattern = re.compile(rf'machine\0exec\0--name\0{re.escape(name)}-[0-9a-f]{{8}}\0'.encode())
    for pid in filter(str.isdigit, os.listdir('/proc')):
        try:
            if not pattern.search(Path(f'/proc/{pid}/cmdline').read_bytes()):
                continue
            ancestor = pid
            while ancestor not in ('0', '1'):
                if host is not None and ancestor == str(host):
                    return True
                status = Path(f'/proc/{ancestor}/status').read_text()
                ancestor = re.search(r'^PPid:\s+(\d+)', status, re.M).group(1)
        except (OSError, AttributeError):
            continue
    return False


# The checkpoint's row in the host's database; sqlite3 holds no other lock on it.
SET_PIN = """
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
changed = db.execute('UPDATE checkpoints SET pin = ? WHERE name = ?', (sys.argv[3], sys.argv[2])).rowcount
db.commit()
sys.exit(0 if changed == 1 else f'{changed} rows')
"""


def usage(native):
    """A machine's own disk in KiB, from its smolvm directory, and the shared pack extractions'.
    An unlinked file the VMM still holds, such as a restore's RAM file, isn't counted."""
    vms = DATA / '.cache/smolvm/vms'
    _, so, _ = sudo(['sh', '-c', f'for f in {vms}/*/name; do [ "$(cat "$f")" = {shlex.quote(native)} ] '
                                 '&& dirname "$f"; done; true'])
    dirs = so.split()
    if len(dirs) != 1:
        raise RuntimeError(f'expected one smolvm directory for {native}, found {dirs}')
    _, own, _ = sudo(['du', '-sk', dirs[0]])
    _, shared, _ = sudo(['sh', '-c', f'du -sk {vms}/_shared 2>/dev/null || echo 0'])
    return {'native': native, 'own_kib': int(own.split()[0]), 'shared_kib': int(shared.split()[0])}


# ---------------------------------------------------------------- teardown and finish

def counters():
    """Image pulls and the intermittent fork-ready start failure. The host keeps no smolvm output
    from a call that succeeds, so pulls are counted from what smolvm leaves: the seed builder's
    scopes the journal saw start, the inventory's image seeds, and Docker Hub's counters."""
    since = load_state()['started_epoch']
    _, so, _ = sudo(['journalctl', '--since', f'@{since}', '--no-pager', '-o', 'cat', '-u', 'smolvm-vm-image-seed-*'])
    seed_scopes = sorted({m for m in re.findall(r'smolvm-vm-image-seed-[0-9a-f]+-\d+\.scope', so)})
    _, seeds, _ = sudo(['ls', '-A', str(DATA / '.cache/smolvm/image-seeds')])
    host_log = journal()
    found = {
        'seed_builder_scopes': seed_scopes,
        'image_seeds': seeds.split(),
        'docker_rate_before': load_state().get('docker_rate_before'),
        'docker_rate_after': docker_rate(),
        'fork_ready_failures_in_host_journal': host_log.count('smolvm-fork-ready'),
    }
    (EVIDENCE / 'counters.json').write_text(json.dumps(found, indent=2) + '\n')
    return found


def remove_natives(report):
    """Stops the host, then deletes every VM of the run's inventory and stops the run's scopes,
    natively; what is left goes into `report`."""
    if unit_active():
        sudo(['systemctl', 'stop', UNIT], touched=f'stops {UNIT}')
        report['steps'].append('unit stopped')
    wait_unit_gone()
    for m in machines():
        name = str(m.get('name'))
        if not name.startswith(NAME_PREFIX):
            raise RuntimeError(f'unexpected machine in the run inventory: {name}')
        stopped = smol('machine', 'stop', '--name', name, touched=f'teardown: stops leftover {name}')
        deleted = smol('machine', 'delete', '--name', name, '--force', touched=f'teardown: deletes leftover {name}')
        report['steps'].append({'leftover': name, 'stop': stopped[0], 'delete': deleted[0]})
        if deleted[0] != 0:
            scope = f'smolvm-vm-{name}.scope'
            sudo(['systemctl', 'kill', '--signal=SIGKILL', scope], touched=f'teardown: kills the run\'s scope {scope}')
            deleted = smol('machine', 'delete', '--name', name, '--force', touched=f'teardown: deletes leftover {name}')
            report['steps'].append({'leftover': name, 'scope_killed': scope, 'delete_retry': deleted[0]})
    left = [m.get('name') for m in machines()]
    for unit in list_units(SCOPE_PATTERN) + new_helper_units():
        sudo(['systemctl', 'stop', unit], touched=f'teardown: stops the run\'s scope {unit}')
        sudo(['systemctl', 'reset-failed', unit], touched=f'teardown: resets the run\'s scope {unit}')
        report['steps'].append({'scope': unit})
    for unit in list_units(f'clankerbox-rewrite-{RID}*'):
        sudo(['systemctl', 'reset-failed', unit], touched=f'teardown: resets {unit}')
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and (vm_uid_processes() or run_processes()):
        time.sleep(1)
    report.update(machines_left=left, scopes_left=list_units(SCOPE_PATTERN) + new_helper_units(),
                  units_left=list_units(f'clankerbox-rewrite-{RID}*'), vm_uid_processes=vm_uid_processes(),
                  run_processes=run_processes(), tailnet_listeners=tailnet_listeners())
    return not (left or report['scopes_left'] or report['units_left'] or report['vm_uid_processes']
                or report['run_processes'])


def cmd_teardown():
    report = {'at': now(), 'steps': [], 'counters': counters()}
    clean = remove_natives(report)
    (EVIDENCE / 'teardown.json').write_text(json.dumps(report, indent=2) + '\n')
    if not clean:
        raise RuntimeError(f'teardown incomplete: {report}')
    (EVIDENCE / 'teardown-verified.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


def cmd_reset():
    """Teardown that keeps the inventory, and so its image seed, then a host on an empty state:
    the suite can run again without pulling the image again."""
    report = {'at': now(), 'steps': [], 'counters': counters()}
    clean = remove_natives(report)
    with open(EVIDENCE / 'resets.jsonl', 'a') as f:
        f.write(json.dumps(report) + '\n')
    if not clean:
        raise RuntimeError(f'reset incomplete: {report}')
    for name in ('host.db', 'host.db-wal', 'host.db-shm', 'checkpoints', 'packs', 'forks'):
        sudo(['rm', '-rf', '--one-file-system', str(STATE_DIR / name)],
             touched=f'reset: removes {STATE_DIR / name}, the host\'s state but not its smolvm inventory')
    host_start()


def cmd_finish():
    data = json.loads((RUN / 'manifest.json').read_text())
    if data.get('owner') != OWNER or data.get('id') != RID:
        sys.exit('not an owned run')
    if not (EVIDENCE / 'teardown-verified.json').exists():
        sys.exit('no verified teardown; scratch and outside changes retained')
    st = load_state()
    result = {}
    units = list_units(SCOPE_PATTERN) + list_units(f'clankerbox-rewrite-{RID}*') + new_helper_units()
    result['units'] = (f'REVERTED {now()} (no {UNIT}, no {SCOPE_PATTERN} scope and no image-seed or pack-fromvm '
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
    data.update(state='cleaned', cleaned_at=now())
    (RUN / 'manifest.json').write_text(json.dumps(data, indent=2) + '\n')
    print(json.dumps({'result': result, 'diff': diff}, indent=2))


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
