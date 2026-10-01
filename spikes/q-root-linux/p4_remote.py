#!/usr/bin/env python3
"""Remote half of plan spike P4 ("smolvm as root") on the Linux KVM test host.

Uploaded by driver.py into its own run directory
`~/clankerbox-rewrite/runs/p4-root-<3 hex>/` and invoked once per step:

  init            owned run layout, read-only "before" snapshot of root locations,
                  ledger entries (CLEANUP.md) for every expected outside change
  inventory TAG   production processes/units (PID + start time), home changes
  setup           download + verify smolvm 1.22.0, extract (root copy + user copy)
  q1q2            root: stock ubuntu:24.04 + sshd over 127.0.0.2, uid drop facts,
                  canary, RAM fork, checkpoint, two restores (port swap)
  unpriv          the same capture + one restore as clanker (comparison)
  q3              SMOLVM_VM_USE_SCOPE vs none, VM launched from a transient
                  system unit that is then stopped
  teardown        stop+delete every machine in both private inventories, stop
                  clankerbox-rewrite-p4-* units, verify no process references scratch
  finish          revert outside changes, sudo rm -rf scratch (exact path),
                  "after" snapshot + diff, mark ledger entries

Every smolvm call as root is `sudo -n env -i <isolated env> <scratch>/smolvm-1.22.0-linux-x86_64/smolvm`.
The data roots are `<scratch>/r` (root) and `<scratch>/u` (clanker): smolvm turns
SMOLVM_DATA_DIR into HOME, and its per-VM sockets at
`<data>/.cache/smolvm/vms/<hash16>/control.sock` must fit Linux's 108-byte sun_path.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import random
import re
import shlex
import signal
import socket
import subprocess
import sys
import time

PREFIX = 'clankerbox-rewrite-p4-'
UNIT_PREFIX = 'clankerbox-rewrite-p4-'
VERSION = '1.22.0'
ASSET = f'smolvm-{VERSION}-linux-x86_64.tar.gz'
BASE_URL = f'https://github.com/smol-machines/smolvm/releases/download/v{VERSION}/'
EXPECTED_PREFIX = '00d2f057'
OWNER = 'clankerbox-work-run-v1'
SUN_PATH_MAX = 107
PUBLISH_ADDR = '127.0.0.2'
EGRESS_FLOOR = 'strict'
HOME = Path('/home/clanker')
OWNED = HOME / 'clankerbox-rewrite'
LEDGER = OWNED / 'CLEANUP.md'
PATH_ENV = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'


class Stop(BaseException):
    pass


TEARING_DOWN = False
STDOUT_OK = True


def raise_stop(signum, frame):
    if not TEARING_DOWN:
        raise Stop(f'signal {signum}')


for _sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
    signal.signal(_sig, raise_stop)

parser = argparse.ArgumentParser()
parser.add_argument('--run', required=True)
parser.add_argument('cmd')
parser.add_argument('tag', nargs='?')
args = parser.parse_args()

RUN = Path(args.run)
if (not re.fullmatch(r'p4-root-[0-9a-f]{3}', RUN.name) or RUN.parent != OWNED / 'runs'
        or RUN.is_symlink()):
    sys.exit(f'refusing run dir outside ~/clankerbox-rewrite/runs/p4-root-<3 hex>: {RUN}')
RID = RUN.name
SCRATCH = RUN / 'scratch'
EVIDENCE = RUN / 'evidence'
STATE = RUN / 'state.json'
REL_ROOT = SCRATCH / f'smolvm-{VERSION}-linux-x86_64'          # extracted by root
REL_USER = SCRATCH / 'ur' / f'smolvm-{VERSION}-linux-x86_64'   # extracted by clanker
DATA = {'root': SCRATCH / 'r', 'user': SCRATCH / 'u'}
KEY = SCRATCH / 'k' / 'id_ed25519'
KNOWN = SCRATCH / 'k' / 'known_hosts'
os.chdir('/')
LOG = None


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def out(line):
    global STDOUT_OK
    if LOG:
        with open(LOG, 'a') as f:
            f.write(line + '\n')
    if STDOUT_OK:
        try:
            print(line, flush=True)
        except (BrokenPipeError, OSError):
            STDOUT_OK = False
            try:
                sys.stdout = open(os.devnull, 'w')
            except OSError:
                pass
            if not TEARING_DOWN:
                raise Stop('driver ssh session gone (broken pipe)')


def note(msg):
    out(f'{time.strftime("%H:%M:%S")} # {msg}')


def load_state():
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def save_state(**fields):
    data = load_state()
    data.update(fields)
    STATE.write_text(json.dumps(data, indent=2) + '\n')


def run(cmd, *, timeout=600, quiet=False, input=None, shown=None):
    cmd = [str(c) for c in cmd]
    if shown is None:
        shown = ' '.join(shlex.quote(c) for c in cmd)
    t0 = time.monotonic()
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, input=input,
                           stdin=None if input is not None else subprocess.DEVNULL)
        rc, so, se = r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired as e:
        rc = 'timeout'
        so = e.stdout.decode(errors='replace') if isinstance(e.stdout, bytes) else (e.stdout or '')
        se = e.stderr.decode(errors='replace') if isinstance(e.stderr, bytes) else (e.stderr or '')
    dt = time.monotonic() - t0
    lines = [f'{time.strftime("%H:%M:%S")} $ {shown}', f'  [rc={rc} {dt:.2f}s]']
    if so.strip():
        lines += ['  | ' + l for l in so.rstrip('\n').split('\n')[-300:]]
    if se.strip():
        lines += ['  ! ' + l for l in se.rstrip('\n').split('\n')[-150:]]
    if quiet:
        if LOG:
            with open(LOG, 'a') as f:
                f.write('\n'.join(lines) + '\n')
    else:
        for l in lines:
            out(l)
    return rc, so, se, round(dt, 2)


def sudo(cmd, **kw):
    return run(['sudo', '-n', *cmd], **kw)


def sh_root(script, **kw):
    return sudo(['sh', '-c', script], **kw)


# ---------------------------------------------------------------- smolvm envs

def smol_env(mode, extra=None):
    s = str(SCRATCH)
    d = str(DATA[mode])
    env = {
        'PATH': PATH_ENV, 'LANG': 'C.UTF-8',
        'HOME': f'{s}/home-{mode[0]}',
        'SMOLVM_DATA_DIR': d,
        'XDG_DATA_HOME': f'{s}/xdg-{mode[0]}/data', 'XDG_CACHE_HOME': f'{s}/xdg-{mode[0]}/cache',
        'XDG_CONFIG_HOME': f'{s}/xdg-{mode[0]}/config', 'XDG_RUNTIME_DIR': f'{s}/xr-{mode[0]}',
        'TMPDIR': f'{s}/tmp-{mode[0]}',
        'SMOLVM_PUBLISH_ADDR': PUBLISH_ADDR,
        'SMOLVM_EGRESS_FLOOR': EGRESS_FLOOR,
        'RUST_LOG': 'smolvm=info,smolvm_pack=info,smolvm_network=info',
    }
    env.update(extra or {})
    return env


def smol_argv(mode, *a, extra=None):
    env = smol_env(mode, extra)
    binary = (REL_ROOT if mode == 'root' else REL_USER) / 'smolvm'
    argv = ['env', '-i', *[f'{k}={v}' for k, v in env.items()], str(binary), *map(str, a)]
    return ['sudo', '-n', *argv] if mode == 'root' else argv


def smol(mode, *a, extra=None, **kw):
    argv = smol_argv(mode, *a, extra=extra)
    tag = ('sudo smolvm' if mode == 'root' else 'smolvm')
    ex = ' '.join(f'{k}={v}' for k, v in (extra or {}).items())
    shown = f'[{mode}] {ex + " " if ex else ""}{tag} ' + ' '.join(shlex.quote(str(x)) for x in a)
    return run(argv, shown=shown, **kw)


def gx(mode, name, script, **kw):
    return smol(mode, 'machine', 'exec', '--name', name, '--', 'sh', '-c', script, **kw)


def machines(mode):
    binary = (REL_ROOT if mode == 'root' else REL_USER) / 'smolvm'
    if not (binary.exists() if mode == 'user' else sudo(['test', '-x', str(binary)], quiet=True)[0] == 0):
        return []
    rc, so, se, _ = smol(mode, 'machine', 'ls', '--json', quiet=True)
    if rc != 0:
        raise RuntimeError(f'machine ls ({mode}) failed rc={rc}: {se[-500:]}')
    data = json.loads(so or '[]')
    return data if isinstance(data, list) else data.get('machines', [])


def status(mode, name):
    rc, so, se, _ = smol(mode, 'machine', 'status', '--name', name, '--json', quiet=True)
    try:
        return json.loads(so)
    except ValueError:
        return {'rc': rc, 'stdout': so.strip()[-300:], 'stderr': se.strip()[-500:]}


def data_dir(mode, name):
    return smol(mode, 'machine', 'data-dir', '--name', name, quiet=True)[1].strip()


def host_port(mode, name):
    _, so, _, _ = smol(mode, 'machine', 'ls', '-v', quiet=True)
    for b in re.split(r'\n(?=\S)', so):
        if b.split() and b.split()[0] == name:
            m = re.search(r'Port: (\d+) -> 22', b)
            return int(m.group(1)) if m else None
    return None


def free_port(lo=10000, hi=19999):
    for _ in range(300):
        p = random.randint(lo, hi)
        ok = True
        for addr in (PUBLISH_ADDR, '127.0.0.1'):
            s = socket.socket()
            try:
                s.bind((addr, p))
            except OSError:
                ok = False
            finally:
                s.close()
        if ok:
            return p
    raise RuntimeError('no free port')


def ssh_guest(port, command, timeout=60):
    return run(['ssh', '-F', '/dev/null', '-i', KEY, '-p', port, '-o', 'IdentitiesOnly=yes',
                '-o', 'BatchMode=yes', '-o', f'UserKnownHostsFile={KNOWN}',
                '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10',
                f'root@{PUBLISH_ADDR}', command], timeout=timeout)


def du(path):
    """Actual and apparent size (MiB) of a path, as root."""
    _, a, _, _ = sudo(['du', '-s', '--block-size=1M', str(path)], quiet=True)
    _, b, _, _ = sudo(['du', '-s', '--block-size=1M', '--apparent-size', str(path)], quiet=True)
    try:
        return {'actual_mib': int(a.split()[0]), 'apparent_mib': int(b.split()[0])}
    except (IndexError, ValueError):
        return {'error': (a + b).strip()[-200:]}


# ---------------------------------------------------------------- processes

PROC_SCAN = r'''
import json, os, sys
needle = sys.argv[1]
me = os.getpid()
found = []
for name in os.listdir('/proc'):
    if not name.isdigit() or int(name) in (me, os.getppid()):
        continue
    p = '/proc/' + name
    hit = None
    try:
        for link in ('exe', 'cwd'):
            try:
                if os.readlink(p + '/' + link).startswith(needle):
                    hit = link
            except OSError:
                pass
        if not hit:
            try:
                if needle.encode() in open(p + '/cmdline', 'rb').read():
                    hit = 'cmdline'
            except OSError:
                pass
        if not hit:
            try:
                if ('=' + needle).encode() in open(p + '/environ', 'rb').read():
                    hit = 'environ'
            except OSError:
                pass
        if not hit:
            try:
                for fd in os.listdir(p + '/fd'):
                    try:
                        if os.readlink(p + '/fd/' + fd).startswith(needle):
                            hit = 'fd'
                            break
                    except OSError:
                        pass
            except OSError:
                pass
        if hit:
            cmd = open(p + '/cmdline', 'rb').read().replace(b'\0', b' ').decode(errors='replace')
            st = os.stat(p)
            found.append({'pid': int(name), 'uid': st.st_uid, 'match': hit, 'cmdline': cmd[:300]})
    except OSError:
        continue
print(json.dumps(found))
'''


def my_processes():
    """Processes of any uid whose exe/cwd/cmdline/environ/fds reference this run's scratch."""
    rc, so, se, _ = sudo(['python3', '-c', PROC_SCAN, str(SCRATCH)], quiet=True)
    if rc != 0:
        raise RuntimeError(f'process scan failed: {se[-300:]}')
    return [p for p in json.loads(so) if 'p4_remote.py' not in p['cmdline']
            and not p['cmdline'].startswith('sudo -n python3 -c')]


def p4_units():
    _, so, _, _ = run(['systemctl', 'list-units', '--all', '--no-legend', '--plain', '--no-pager',
                       f'{UNIT_PREFIX}*', f'smolvm-vm-{PREFIX}*'], quiet=True)
    return [l.split()[0] for l in so.splitlines() if l.strip()]


def vmm_facts(mode, name, label):
    """VMM process identity, cgroup and the uid-range processes."""
    st = status(mode, name)
    pid = st.get('pid')
    facts = {'status': {k: st.get(k) for k in ('state', 'pid', 'parent_machine', 'network', 'ports')}}
    if pid:
        _, facts['ps'], _, _ = sudo(['ps', '-o', 'pid,ppid,pgid,uid,gid,supgid,user,lstart,args', '-p', str(pid)],
                                    quiet=True)
        _, facts['proc_status'], _, _ = sh_root(
            f'grep -E "^(Uid|Gid|Groups|CapEff|CapPrm|NoNewPrivs|Seccomp):" /proc/{pid}/status', quiet=True)
        _, facts['cgroup'], _, _ = sudo(['cat', f'/proc/{pid}/cgroup'], quiet=True)
    _, facts['vm_uid_processes'], _, _ = sh_root(
        'ps -eo pid=,ppid=,uid=,gid=,args= | awk \'$3>=2000000 && $3<102000000\'', quiet=True)
    note(f'vmm {label}: {json.dumps(facts)}')
    return facts


# ---------------------------------------------------------------- teardown

def teardown_machines(label='teardown'):
    global TEARING_DOWN
    TEARING_DOWN = True
    report = []
    for mode in ('root', 'user'):
        for attempt in range(4):
            try:
                ms = machines(mode)
            except Exception as e:  # noqa: BLE001
                report.append({'mode': mode, 'ls_error': repr(e)})
                break
            report.append({'mode': mode, 'attempt': attempt, 'machines': [m.get('name') for m in ms]})
            if not ms:
                break
            ms.sort(key=lambda m: 0 if m.get('parent_machine') else 1)
            for m in ms:
                name = m.get('name', '')
                if not name.startswith(PREFIX):
                    raise RuntimeError(f'unexpected machine in private inventory: {m}')
                s = smol(mode, 'machine', 'stop', '--name', name, timeout=180)
                d = smol(mode, 'machine', 'delete', '--name', name, '--force', timeout=180)
                report.append({'name': name, 'stop': s[:1], 'delete': d[:1]})
    remaining = {m: [x.get('name') for x in machines(m)] for m in ('root', 'user')}
    units = p4_units()
    for u in units:
        sudo(['systemctl', 'stop', u], timeout=120)
        sudo(['systemctl', 'reset-failed', u], timeout=60)
    units_after = p4_units()
    procs = []
    for _ in range(30):
        procs = my_processes()
        if not procs:
            break
        time.sleep(1)
    rec = {'at': now(), 'report': report, 'remaining': remaining, 'units_before_stop': units,
           'units_after': units_after, 'processes': procs}
    with open(EVIDENCE / f'{label}.json', 'a') as f:
        f.write(json.dumps(rec, indent=2) + '\n')
    if any(remaining.values()) or units_after or procs:
        raise RuntimeError(f'teardown incomplete: {rec}')
    note(f'{label}: verified no machines, no p4 units, no process references scratch')
    return rec


def delete_now(mode, *names):
    for n in names:
        smol(mode, 'machine', 'stop', '--name', n, timeout=180)
        smol(mode, 'machine', 'delete', '--name', n, '--force', timeout=180)


# ---------------------------------------------------------------- snapshot + ledger

SNAP_DIRS = ['/var/lib/smolvm', '/root/.local/share/smolvm', '/root/.cache', '/run/smolvm',
             '/etc/systemd/system', '/run/systemd/transient', '/dev/shm', '/tmp', '/root', '/var/tmp']
MODE_DIRS = [str(HOME), str(OWNED), str(OWNED / 'runs')]


def snapshot(tag):
    snap = {'at': now(), 'tag': tag, 'dirs': {}}
    for d in SNAP_DIRS:
        rc, so, se, _ = sudo(['find', d, '-maxdepth', '3', '-printf', '%M %u:%g %s %TY-%Tm-%Td %TH:%TM %p\\n'],
                             quiet=True)
        snap['dirs'][d] = sorted(so.splitlines()) if rc == 0 else [f'absent/unreadable: {se.strip()[-200:]}']
    snap['modes'] = {}
    for d in MODE_DIRS:
        _, a, _, _ = sudo(['stat', '-c', '%a %U:%G', d], quiet=True)
        _, acl, _, _ = sudo(['getfacl', '-p', '--absolute-names', d], quiet=True)
        snap['modes'][d] = {'stat': a.strip(), 'acl': acl.strip()}
    _, so, _, _ = run(['systemctl', 'list-units', '--all', '--no-legend', '--plain', '--no-pager'], quiet=True)
    snap['system_units_matching'] = [l for l in so.splitlines() if re.search(r'smolvm|clankerbox-rewrite', l)]
    _, so, _, _ = sudo(['find', '/sys/fs/cgroup', '-maxdepth', '2', '-type', 'd', '-name', '*smolvm*'], quiet=True)
    snap['cgroups_smolvm'] = so.splitlines()
    _, so, _, _ = sudo(['find', '/sys/fs/cgroup/system.slice', '-maxdepth', '1', '-type', 'd'], quiet=True)
    snap['system_slice'] = sorted(so.splitlines())
    marker = RUN / '.start-marker'
    if marker.exists():
        _, so, _, _ = sudo(['find', '/', '/run', '/tmp', '/dev/shm', '-xdev', '-newer', str(marker),
                            '-not', '-path', f'{OWNED}/*', '-not', '-path', '/proc/*', '-not', '-path', '/sys/*',
                            '-not', '-path', '/var/log/*', '-not', '-path', '/run/log/*',
                            '-not', '-path', '/home/clanker/clankerbox/*', '-not', '-path', '/run/user/*'],
                           quiet=True, timeout=900)
        snap['newer_than_start_outside_owned'] = so.splitlines()[:3000]
    (EVIDENCE / f'snapshot-{tag}.json').write_text(json.dumps(snap, indent=2) + '\n')
    return snap


def ledger_add(key, text):
    """Append one ledger line (as clanker; CLEANUP.md is ours, inside the owned root)."""
    stamp = time.strftime('%Y-%m-%d %H:%M')
    line = f'- {stamp} (spike P4, run {RID}) [{key}] {text} STATUS: pending\n'
    if not LEDGER.exists():
        LEDGER.write_text('# clankerbox rewrite: machine changes outside ~/clankerbox-rewrite\n\n')
    with open(LEDGER, 'a') as f:
        f.write(line)
    note(f'ledger + {key}')


def ledger_mark(key, status_text):
    text = LEDGER.read_text()
    pat = re.compile(rf'(\(spike P4, run {re.escape(RID)}\) \[{re.escape(key)}\] .*?)STATUS: pending')
    new, n = pat.subn(lambda m: m.group(1) + 'STATUS: ' + status_text, text)
    if n:
        LEDGER.write_text(new)
    note(f'ledger {key}: {status_text} ({n} line)')


# ---------------------------------------------------------------- commands

def cmd_init():
    RUN.mkdir(mode=0o700, exist_ok=True)
    if (RUN / 'manifest.json').exists():
        sys.exit('run already initialised')
    (RUN / 'manifest.json').write_text(json.dumps(dict(
        owner=OWNER, id=RID, label='p4-root', created_at=now(), state='running', keep=False,
        driver='local spikes/q-root-linux/driver.py'), indent=2) + '\n')
    SCRATCH.mkdir(mode=0o700)
    EVIDENCE.mkdir(mode=0o700)
    save_state(created_at=now(), machine_prefix=PREFIX, scratch=str(SCRATCH))
    snap = snapshot('before')
    save_state(modes_before={d: v['stat'] for d, v in snap['modes'].items()},
               shm_restore_before=any('/dev/shm/smolvm-restore' in l for l in snap['dirs']['/dev/shm']))
    (RUN / '.start-marker').touch()
    ledger_add('dirmodes', f'smolvm running as root adds others-execute to every ancestor of its data root '
               f'(S@1.22.0:src/process.rs ensure_traversable; src/agent/manager.rs:2398-2413). Expected: '
               f'/home/clanker {snap["modes"][str(HOME)]["stat"].split()[0]} -> +o+x, and inside the owned root '
               f'~/clankerbox-rewrite and runs/ 0700 -> 0701. Revert: chmod back to the recorded modes.')
    ledger_add('units', f'transient system units {UNIT_PREFIX}host-<n>.service (sudo systemd-run --collect) '
               f'and smolvm-created transient scopes smolvm-vm-{PREFIX}*.scope (SMOLVM_VM_USE_SCOPE=1), with their '
               f'cgroups. Revert: systemctl stop / reset-failed; verify none listed.')
    ledger_add('shm', '/dev/shm/smolvm-restore (root, 0700) may be created by smolvm restore as root '
               '(S@1.22.0:src/portable_checkpoint.rs:55-82). Revert: remove it if this run created it.')
    ledger_add('procs', 'root processes (sudo smolvm) and VMM processes under per-VM uids 2000000+ '
               '(no passwd entries; S@1.22.0:src/process.rs VM_UID_BASE). Revert: stop every VM; verify no '
               'process references the run scratch.')
    print(f'initialised {RUN}')


PROD_RE = re.compile(r'smolvm|clankerbox|krun|_boot-vm', re.I)


def cmd_inventory(tag):
    procs = []
    r = subprocess.run(['ps', '-eo', 'pid=,ppid=,user=,lstart=,args='], capture_output=True, text=True)
    mine = {p['pid'] for p in my_processes()} if SCRATCH.exists() else set()
    for line in r.stdout.splitlines():
        if PROD_RE.search(line) and 'p4_remote.py' not in line and 'sudo -n python3' not in line:
            f = line.split(None, 8)
            pid = int(f[0])
            procs.append({'pid': pid, 'ppid': int(f[1]), 'user': f[2], 'lstart': ' '.join(f[3:8]),
                          'args': f[8] if len(f) > 8 else '', 'ours': pid in mine})
    units = subprocess.run(['systemctl', '--user', 'list-units', '--all', '--no-pager', '--no-legend'],
                           capture_output=True, text=True).stdout
    units = [l.strip() for l in units.splitlines() if re.search(r'smolvm|clankerbox', l, re.I)]
    host_unit = subprocess.run(['systemctl', '--user', 'show', 'clankerbox-host.service', '-p',
                                'MainPID,ExecMainStartTimestamp,ActiveState,SubState,NRestarts'],
                               capture_output=True, text=True).stdout.splitlines()
    sysunits = subprocess.run(['systemctl', 'list-units', '--all', '--no-pager', '--no-legend', '--plain'],
                              capture_output=True, text=True).stdout
    sysunits = [l.strip() for l in sysunits.splitlines() if re.search(r'smolvm|clankerbox', l, re.I)]
    marker = RUN / '.start-marker'
    newer = subprocess.run(['find', str(HOME), '-xdev', '-newer', str(marker), '-not', '-path', f'{OWNED}/*',
                            '-not', '-path', f'{HOME}/clankerbox/*'],
                           capture_output=True, text=True).stdout.splitlines() if marker.exists() else []
    df = subprocess.run(['df', '-h', str(HOME), '/tmp', '/dev/shm'], capture_output=True, text=True).stdout
    data = dict(at=now(), tag=tag, processes=procs, user_units=units, host_unit=host_unit,
                system_units_matching=sysunits, my_processes=sorted(mine),
                home_files_newer_than_run_start=newer, df=df.splitlines())
    EVIDENCE.mkdir(exist_ok=True)
    (EVIDENCE / f'inventory-{tag}.json').write_text(json.dumps(data, indent=2) + '\n')
    print(json.dumps(data, indent=2))


def cmd_setup():
    dl = SCRATCH / 'dl'
    dl.mkdir(exist_ok=True)
    for name in (ASSET, 'checksums.sha256'):
        rc, *_ = run(['curl', '-fsSL', '--retry', '3', '-o', dl / name, BASE_URL + name], timeout=600)
        if rc != 0:
            raise RuntimeError(f'download failed: {name}')
    sums = (dl / 'checksums.sha256').read_text()
    (EVIDENCE / 'checksums.sha256').write_text(sums)
    expected = next(l.split()[0] for l in sums.splitlines() if l.strip().endswith(ASSET))
    h = hashlib.sha256()
    with open(dl / ASSET, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    digest = h.hexdigest()
    note(f'{ASSET} sha256={digest} expected={expected}')
    if digest != expected or not digest.startswith(EXPECTED_PREFIX):
        raise RuntimeError(f'digest mismatch: {digest} vs {expected} / prefix {EXPECTED_PREFIX}')
    run(['sh', '-c', f'tar -tvzf {dl / ASSET} | head -12; tar -tvzf {dl / ASSET} | '
                     "awk '{print $2}' | sort | uniq -c"])
    # Root copy: what a root-run host would install (tar as root keeps header owners).
    rc, *_ = sudo(['tar', '-xzf', str(dl / ASSET), '-C', str(SCRATCH)], timeout=600)
    if rc != 0:
        raise RuntimeError('root extract failed')
    (SCRATCH / 'ur').mkdir()
    rc, *_ = run(['tar', '-xzf', dl / ASSET, '-C', SCRATCH / 'ur'], timeout=600)
    if rc != 0:
        raise RuntimeError('user extract failed')
    (dl / ASSET).unlink()
    sudo(['ls', '-lan', str(REL_ROOT), str(REL_ROOT / 'agent-rootfs')])
    sudo(['sha256sum', str(REL_ROOT / 'smolvm-bin'), str(REL_ROOT / 'agent-rootfs/usr/local/bin/smolvm-agent')])
    sh_root(f'echo "rootfs entries not world-readable:"; find {REL_ROOT}/agent-rootfs ! -perm -o+r '
            f'-printf "%M %u:%g %p\\n" | head -40; echo "count=$(find {REL_ROOT}/agent-rootfs ! -perm -o+r | wc -l)"; '
            f'echo "owners:"; find {REL_ROOT}/agent-rootfs -printf "%u:%g\\n" | sort | uniq -c')
    for mode in ('root', 'user'):
        for d in (f'home-{mode[0]}', f'xdg-{mode[0]}', f'xr-{mode[0]}', f'tmp-{mode[0]}'):
            (SCRATCH / d).mkdir(mode=0o700, exist_ok=True)
    (SCRATCH / 'k').mkdir(mode=0o700, exist_ok=True)
    run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', f'p4-{RID}', '-f', KEY])
    smol('root', '--version')
    smol('user', '--version')
    budget = {}
    for mode, d in DATA.items():
        base = len(str(d)) + len('/.cache/smolvm/vms/') + 16 + 1
        budget[mode] = {s: base + len(s) for s in ('agent.sock', 'control.sock')}
    note(f'socket path lengths: {budget} (max {SUN_PATH_MAX})')
    if max(v for b in budget.values() for v in b.values()) > SUN_PATH_MAX:
        raise RuntimeError('socket path budget exceeded')
    if machines('root') or machines('user'):
        raise RuntimeError('fresh private inventory is not empty')
    rc, so, _, _ = sudo(['nft', 'list', 'ruleset'], quiet=True)
    (EVIDENCE / 'nft-ruleset.txt').write_text(so)
    note('setup ok')


def acquire_lock():
    handle = open(RUN / '.exp-lock', 'a')
    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    (RUN / 'active.pid').write_text(f'{os.getpid()}\n')
    return handle


def write_facts(name, facts):
    (EVIDENCE / f'{name}.json').write_text(json.dumps(facts, indent=2, default=str) + '\n')


def storage_facts(mode, name, label):
    d = data_dir(mode, name)
    f = {'data_dir': d}
    _, f['ls'], _, _ = sudo(['ls', '-lani', '--time-style=+', d], quiet=True)
    _, f['chain'], _, _ = sh_root(
        f'p={shlex.quote(d)}; while [ "$p" != / ]; do stat -c "%a %u:%g %n" "$p"; p=$(dirname "$p"); done', quiet=True)
    f['du'] = du(d)
    note(f'storage {label}: {json.dumps(f)}')
    return f


def apt_sshd(mode, name):
    rc, so, se, dt = gx(mode, name, 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && '
                                    'apt-get install -y -qq --no-install-recommends openssh-server >/tmp/apt.log 2>&1; '
                                    'rc=$?; tail -4 /tmp/apt.log; ls -la /etc/resolv.conf; exit $rc', timeout=900)
    pub = (KEY.parent / 'id_ed25519.pub').read_text().strip()
    gx(mode, name, f'ssh-keygen -A >/dev/null && mkdir -p /root/.ssh /run/sshd && chmod 700 /root/.ssh && '
                   f'echo "{pub}" > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys')
    return {'rc': rc, 'seconds': dt, 'tail': so.strip()[-600:]}


def start_sshd(mode, name):
    gx(mode, name, 'mkdir -p /run/sshd; pkill -x sshd; true')
    r = smol(mode, 'machine', 'exec', '--name', name, '--detach', '--',
             'sh', '-c', 'exec /usr/sbin/sshd -D -e >>/var/log/sshd.out 2>&1')
    time.sleep(1)
    return r[0]


def ssh_check(port, label):
    rc, so, se, dt = ssh_guest(port, 'echo SSH_OK $(hostname) $(cat /proc/sys/kernel/random/boot_id)')
    r = {'port': port, 'rc': rc, 'ok': 'SSH_OK' in so, 'out': so.strip(), 'err': se.strip()[-300:], 's': dt}
    note(f'ssh {label}: {r}')
    return r


def listeners(port):
    return sudo(['ss', '-ltnpH', f'sport = :{port}'], quiet=True)[1].strip()


def restore(mode, ckpt, name, src_port, label):
    """create --from + port swap + start; logs carry the install method."""
    r = {}
    rc, so, se, dt = smol(mode, 'machine', 'create', '--name', name, '--from', str(ckpt), timeout=900)
    r['create'] = {'rc': rc, 's': dt, 'stderr_tail': se.strip()[-4000:]}
    r['recorded_port'] = host_port(mode, name)
    new = free_port()
    old = r['recorded_port'] or src_port
    rc2, _, se2, dt2 = smol(mode, 'machine', 'update', '--name', name, '--remove-port', f'{old}:22', '-p', f'{new}:22')
    r['update'] = {'rc': rc2, 's': dt2, 'err': se2.strip()[-600:], 'new_port': new}
    r['port_after_update'] = host_port(mode, name)
    r['pre_start_storage'] = storage_facts(mode, name, f'{label}-before-start')
    rc, so, se, dt = smol(mode, 'machine', 'start', '--name', name, timeout=900)
    r['start'] = {'rc': rc, 's': dt, 'stderr_tail': se.strip()[-6000:]}
    logs = r['create']['stderr_tail'] + '\n' + r['start']['stderr_tail']
    r['install_method_lines'] = [l for l in logs.splitlines()
                                 if re.search(r'installed|readonly|cow|copy|restore|resume|tmpfs|uid isolation', l, re.I)][:60]
    r['vmm'] = vmm_facts(mode, name, label)
    r['storage'] = storage_facts(mode, name, label)
    pid = r['vmm']['status'].get('pid')
    if pid:
        _, r['maps_memory'], _, _ = sh_root(f'grep -E "memory|checkpoint|memfd|readonly" /proc/{pid}/maps | '
                                            'awk \'{print $2, $6, $7}\' | sort | uniq -c | head -20', quiet=True)
    if rc == 0:
        start_sshd(mode, name)
        r['ssh'] = ssh_check(new, label)
        r['listeners'] = listeners(new)
    return r


def exp_q1q2():
    src, fork, r1, r2 = (PREFIX + n for n in ('src', 'fork', 'r1', 'r2'))
    facts = {'started_at': now(), 'publish_addr': PUBLISH_ADDR, 'egress_floor': EGRESS_FLOOR}
    try:
        port = free_port()
        facts['src_port'] = port
        rc, _, se, dt = smol('root', 'machine', 'create', '--name', src, '--image', 'ubuntu:24.04',
                             '--cpus', '1', '--mem', '1024', '--net', '--net-backend', 'virtio-net',
                             '-p', f'{port}:22', timeout=300)
        facts['create'] = {'rc': rc, 's': dt, 'err': se.strip()[-1500:]}
        if rc != 0:
            raise RuntimeError('create failed')
        sh_root(f'for d in {" ".join(MODE_DIRS)}; do stat -c "%a %U:%G %n" $d; done')
        rc, _, se, dt = smol('root', 'machine', 'start', '--name', src, '--branchable', timeout=900)
        facts['start'] = {'rc': rc, 's': dt, 'stderr_tail': se.strip()[-5000:]}
        _, facts['modes_after_first_root_start'], _, _ = sh_root(
            f'for d in {" ".join(MODE_DIRS)} {RUN} {SCRATCH} {DATA["root"]}; do stat -c "%a %U:%G %n" $d; done')
        if rc != 0:
            raise RuntimeError('start failed')
        facts['vmm_src'] = vmm_facts('root', src, 'src')
        facts['storage_src'] = storage_facts('root', src, 'src')
        _, facts['uid_registry'], _, _ = sh_root(
            f'ls -lan {DATA["root"]}/.cache/smolvm/uids; for f in {DATA["root"]}/.cache/smolvm/uids/[0-9]*; do '
            f'echo "$f -> $(cat $f)"; done')
        _, facts['data_root_tree'], _, _ = sh_root(
            f'find {DATA["root"]} -maxdepth 4 -printf "%M %u:%g %p\\n" | head -80')
        rootfs = REL_ROOT / 'agent-rootfs'
        _, facts['rootfs'], _, _ = sh_root(
            f'p={rootfs}; while [ "$p" != / ]; do stat -c "%a %u:%g %n" "$p"; p=$(dirname "$p"); done; '
            f'ls -lan {rootfs}; echo "files owned by a VM uid:"; '
            f'find {rootfs} -uid +1999999 -printf "%M %u:%g %p\\n" | head')
        _, facts['guest_probe'], _, _ = gx('root', src, 'id; cat /etc/os-release | head -2; '
                                                        'tr "\\0" " " </proc/1/cmdline; echo; '
                                                        'grep -E "Cap(Eff|Bnd)" /proc/self/status; '
                                                        'cat /proc/self/uid_map; grep -E " / " /proc/mounts')
        # Q4 egress: sample host sockets of the VMM uid while the guest runs apt.
        sampler = subprocess.Popen(['sudo', '-n', 'sh', '-c',
                                    'for i in $(seq 1 60); do ss -tnpeH state established 2>/dev/null | '
                                    'grep -v "127.0.0" ; sleep 0.5; done | sort -u'],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        facts['apt'] = apt_sshd('root', src)
        try:
            so, _ = sampler.communicate(timeout=60)
        except subprocess.TimeoutExpired:
            sampler.kill()
            so, _ = sampler.communicate()
        facts['egress_sockets_during_apt'] = [l for l in so.splitlines() if 'uid:' in l][:40]
        start_sshd('root', src)
        facts['ssh_src'] = ssh_check(port, 'src')
        facts['listeners_src'] = listeners(port)
        _, facts['listeners_loopback1'], _, _ = run(['sh', '-c', f'nc -z -w2 127.0.0.1 {port}; echo rc=$?'],
                                                    quiet=True)
        # Informational: can the guest still write the shared agent rootfs via virtiofs?
        canary = f'CANARY-{RID}'
        _, facts['canary'], se, _ = gx('root', src,
            f'mkdir -p /mnt/vfs && mount -t virtiofs /dev/root /mnt/vfs; echo mount_rc=$?; '
            f'grep " /mnt/vfs " /proc/mounts; ls -lan /mnt/vfs | head -40; '
            f'touch /mnt/vfs/{canary}; echo touch_rc=$?; '
            f': >> /mnt/vfs/sbin/init 2>&1; echo open_init_for_append_rc=$?; '
            f'mkdir /mnt/vfs/tmp/{canary} 2>&1; echo mkdir_tmp_rc=$?; '
            f'for m in /mnt/vfs/.smolvm*; do ls -lan "$m"; : >> "$m" && echo "opened for write: $m"; done 2>&1; '
            f'umount /mnt/vfs; echo umount_rc=$?')
        facts['canary'] += se
        _, facts['canary_host'], _, _ = sh_root(
            f'find {rootfs} -name "{canary}*" -printf "%M %u:%g %p\\n"; ls -lan {rootfs} | grep -i smolvm; '
            f'tail -c 64 {rootfs}/sbin/init | od -c | tail -3')
        sh_root(f'find {rootfs} -maxdepth 2 -name "{canary}*" -exec rm -rf {{}} +; '
                f'find {rootfs} -name "{canary}*" | wc -l')
        # Q2: RAM fork
        rc, so, se, dt = smol('root', 'machine', 'branch', '--from', src, '--name', fork, timeout=600)
        facts['branch'] = {'rc': rc, 's': dt, 'stderr_tail': se.strip()[-3000:], 'stdout': so.strip()[-800:]}
        if rc == 0:
            fp = host_port('root', fork)
            facts['fork_port'] = fp
            facts['vmm_fork'] = vmm_facts('root', fork, 'fork')
            facts['storage_fork'] = storage_facts('root', fork, 'fork')
            facts['ssh_fork_inherited_sshd'] = ssh_check(fp, 'fork') if fp else None
            facts['listeners_fork'] = listeners(fp) if fp else None
            facts['ssh_src_after_fork'] = ssh_check(port, 'src-after-fork')
        delete_now('root', fork)
        # Checkpoint
        ck = SCRATCH / 'ck-r'
        sudo(['mkdir', '-p', str(ck)])
        ckpt = ck / 'src.checkpoint'
        rc, so, se, dt = smol('root', 'machine', 'checkpoint', '--name', src, '--output', str(ckpt), timeout=900)
        facts['checkpoint'] = {'rc': rc, 's': dt, 'stderr_tail': se.strip()[-3000:]}
        _, facts['checkpoint']['ls'], _, _ = sudo(['ls', '-lan', str(ck)])
        facts['checkpoint']['du'] = du(ckpt)
        facts['data_root_du_before_restores'] = du(DATA['root'])
        if rc == 0:
            facts['restore1'] = restore('root', ckpt, r1, port, 'r1')
            facts['data_root_du_with_r1'] = du(DATA['root'])
            _, facts['multi_link_files_r1'], _, _ = sh_root(
                f'find {DATA["root"]} -type f -links +1 -printf "%i %n %s %b %U %m %p\\n" | sort | head -40')
            delete_now('root', r1)
            facts['restore2'] = restore('root', ckpt, r2, port, 'r2')
            facts['data_root_du_with_r2'] = du(DATA['root'])
            _, facts['multi_link_files_r2'], _, _ = sh_root(
                f'find {DATA["root"]} -type f -links +1 -printf "%i %n %s %b %U %m %p\\n" | sort | head -40')
            _, facts['shm_after_restores'], _, _ = sudo(['ls', '-lan', '/dev/shm'])
            delete_now('root', r2)
            facts['data_root_du_after_restores_deleted'] = du(DATA['root'])
            _, facts['data_root_files_after'], _, _ = sh_root(
                f'find {DATA["root"]} -type f -size +1M -printf "%i %n %s %b %U %m %p\\n" | sort -k7 | head -60')
    except Exception as e:  # noqa: BLE001
        facts['error'] = repr(e)
        note(f'q1q2 error: {e!r}')
    finally:
        facts['finished_at'] = now()
        write_facts('q1q2', facts)
        delete_now('root', fork, r2, r1, src)
        if machines('root'):
            raise RuntimeError('root machines remain after q1q2')


def exp_unpriv():
    src, r1 = PREFIX + 'usrc', PREFIX + 'ur1'
    facts = {'started_at': now()}
    try:
        port = free_port()
        facts['src_port'] = port
        rc, *_ = smol('user', 'machine', 'create', '--name', src, '--image', 'ubuntu:24.04', '--cpus', '1',
                      '--mem', '1024', '--net', '--net-backend', 'virtio-net', '-p', f'{port}:22', timeout=300)
        rc, _, se, dt = smol('user', 'machine', 'start', '--name', src, '--branchable', timeout=900)
        facts['start'] = {'rc': rc, 's': dt, 'stderr_tail': se.strip()[-3000:]}
        if rc != 0:
            raise RuntimeError('start failed')
        facts['vmm_src'] = vmm_facts('user', src, 'usrc')
        facts['storage_src'] = storage_facts('user', src, 'usrc')
        facts['apt'] = apt_sshd('user', src)
        start_sshd('user', src)
        facts['ssh_src'] = ssh_check(port, 'usrc')
        ck = SCRATCH / 'ck-u'
        ck.mkdir()
        ckpt = ck / 'src.checkpoint'
        rc, so, se, dt = smol('user', 'machine', 'checkpoint', '--name', src, '--output', ckpt, timeout=900)
        facts['checkpoint'] = {'rc': rc, 's': dt, 'stderr_tail': se.strip()[-3000:], 'du': du(ckpt)}
        facts['data_root_du_before_restore'] = du(DATA['user'])
        if rc == 0:
            facts['restore1'] = restore('user', ckpt, r1, port, 'ur1')
            facts['data_root_du_with_r1'] = du(DATA['user'])
            _, facts['multi_link_files_r1'], _, _ = sh_root(
                f'find {DATA["user"]} -type f -links +1 -printf "%i %n %s %b %U %m %p\\n" | sort | head -40')
    except Exception as e:  # noqa: BLE001
        facts['error'] = repr(e)
        note(f'unpriv error: {e!r}')
    finally:
        facts['finished_at'] = now()
        write_facts('unpriv', facts)
        delete_now('user', r1, src)
        if machines('user'):
            raise RuntimeError('user machines remain after unpriv')


def unit_props(unit):
    return sudo(['systemctl', 'show', unit, '-p',
                 'ActiveState,SubState,KillMode,ControlGroup,MainPID,Result'], quiet=True)[1].strip()


def scope_units():
    return run(['systemctl', 'list-units', '--all', '--no-legend', '--plain', '--no-pager', '--type=scope',
                'smolvm-vm-*'], quiet=True)[1].strip()


def wait_running(name, timeout=180):
    deadline = time.time() + timeout
    st = {}
    while time.time() < deadline:
        st = status('root', name)
        if st.get('state') == 'running' and st.get('pid'):
            return st
        time.sleep(2)
    return st


def alive(pid):
    return sudo(['kill', '-0', str(pid)], quiet=True)[0] == 0


def q3_scenario(n, scope, killmode, branch=False):
    name, child = PREFIX + 'q3', PREFIX + 'q3c'
    unit = f'{UNIT_PREFIX}host-{n}'
    extra = {'SMOLVM_VM_USE_SCOPE': '1'} if scope else {}
    f = {'n': n, 'unit': unit, 'scope': scope, 'killmode': killmode or 'default', 'branch': branch}
    log = EVIDENCE / f'q3-unit-{n}.log'
    argv = smol_argv('root', 'machine', 'start', '--name', name, *(['--branchable'] if branch else []),
                     extra=extra)[2:]  # drop sudo -n; systemd-run runs it as root
    inner = ' '.join(shlex.quote(a) for a in argv)
    script = f'{inner} >>{log} 2>&1; echo "machine start rc=$?" >>{log}; exec sleep infinity'
    props = ['--property', f'KillMode={killmode}'] if killmode else []
    rc, so, se, _ = sudo(['systemd-run', '--unit', unit, '--collect', '--description',
                          f'clankerbox rewrite P4 simulated host {n}', *props, '--', '/bin/sh', '-c', script])
    f['systemd_run'] = {'rc': rc, 'out': (so + se).strip()[-400:]}
    st = wait_running(name)
    f['status_running'] = {k: st.get(k) for k in ('state', 'pid')}
    pid = st.get('pid')
    f['unit_before'] = unit_props(unit + '.service')
    f['scopes_before'] = scope_units()
    if pid:
        _, f['cgroup_before'], _, _ = sudo(['cat', f'/proc/{pid}/cgroup'], quiet=True)
        _, f['ps_before'], _, _ = sudo(['ps', '-o', 'pid,ppid,pgid,uid,lstart,args', '-p', str(pid)], quiet=True)
    _, f['unit_cgroup_procs'], _, _ = sh_root(
        f'cg=$(systemctl show {unit}.service -p ControlGroup --value); '
        f'cat /sys/fs/cgroup$cg/cgroup.procs 2>/dev/null | while read p; do ps -o pid=,uid=,args= -p $p; done')
    if scope:
        _, f['scope_show'], _, _ = sudo(['systemctl', 'show', f'smolvm-vm-{name}.scope', '-p',
                                         'ActiveState,ControlGroup,MemoryMax,MemoryHigh,CPUQuotaPerSecUSec,TasksMax'],
                                        quiet=True)
    cpid = None
    if branch and pid:
        rc, so, se, dt = smol('root', 'machine', 'branch', '--from', name, '--name', child, extra=extra, timeout=600)
        f['branch'] = {'rc': rc, 's': dt, 'stderr_tail': se.strip()[-1500:]}
        cst = status('root', child)
        cpid = cst.get('pid')
        f['child_pid'] = cpid
        if cpid:
            _, f['child_cgroup'], _, _ = sudo(['cat', f'/proc/{cpid}/cgroup'], quiet=True)
            _, f['child_ps'], _, _ = sudo(['ps', '-o', 'pid,ppid,pgid,uid,args', '-p', str(cpid)], quiet=True)
        f['scopes_after_branch'] = scope_units()
    # The simulated host dies.
    t0 = time.monotonic()
    rc, so, se, _ = sudo(['systemctl', 'stop', unit + '.service'], timeout=180)
    f['unit_stop'] = {'rc': rc, 's': round(time.monotonic() - t0, 2), 'err': se.strip()[-300:]}
    time.sleep(3)
    f['unit_after'] = unit_props(unit + '.service')
    f['vmm_alive_after_unit_stop'] = alive(pid) if pid else None
    if pid and f['vmm_alive_after_unit_stop']:
        _, f['cgroup_after'], _, _ = sudo(['cat', f'/proc/{pid}/cgroup'], quiet=True)
    st = status('root', name)
    f['status_after'] = {k: st.get(k) for k in ('state', 'pid')}
    rc, so, se, dt = gx('root', name, 'echo EXEC_OK $(cat /proc/uptime)', timeout=60)
    f['exec_after'] = {'rc': rc, 'out': so.strip(), 'err': se.strip()[-300:], 's': dt}
    if cpid:
        f['child_alive_after_unit_stop'] = alive(cpid)
        rc, so, se, _ = gx('root', child, 'echo EXEC_OK', timeout=60)
        f['child_exec_after'] = {'rc': rc, 'out': so.strip(), 'err': se.strip()[-300:]}
    f['scopes_after'] = scope_units()
    if branch:
        delete_now('root', child)
    rc, so, se, dt = smol('root', 'machine', 'stop', '--name', name, timeout=180)
    f['machine_stop'] = {'rc': rc, 's': dt, 'out': (so + se).strip()[-500:]}
    f['status_after_stop'] = status('root', name).get('state')
    time.sleep(1)
    f['scopes_after_machine_stop'] = scope_units()
    f['p4_units_after'] = p4_units()
    note(f'q3 scenario {n}: {json.dumps(f, default=str)[:3000]}')
    return f


def exp_q3():
    name = PREFIX + 'q3'
    facts = {'started_at': now(), 'scenarios': []}
    try:
        rc, *_ = smol('root', 'machine', 'create', '--name', name, '--image', 'ubuntu:24.04', '--cpus', '1',
                      '--mem', '1024', '--net', timeout=300)
        if rc != 0:
            raise RuntimeError('create failed')
        _, facts['default_killmode'], _, _ = run(['systemctl', 'show', '-p', 'DefaultKillMode'], quiet=True)
        plan = [(1, True, 'control-group', False), (2, True, None, False),
                (3, False, 'control-group', False), (4, False, None, False),
                (5, False, 'process', False), (6, True, 'control-group', True)]
        for n, scope, km, br in plan:
            try:
                facts['scenarios'].append(q3_scenario(n, scope, km, br))
            except Exception as e:  # noqa: BLE001
                facts['scenarios'].append({'n': n, 'error': repr(e)})
                note(f'q3 scenario {n} error: {e!r}')
            finally:
                for u in p4_units():
                    if u.startswith(UNIT_PREFIX):
                        sudo(['systemctl', 'stop', u], timeout=120)
                st = status('root', name).get('state')
                if st not in ('stopped', None):
                    smol('root', 'machine', 'stop', '--name', name, timeout=180)
                write_facts('q3', facts)
    except Exception as e:  # noqa: BLE001
        facts['error'] = repr(e)
        note(f'q3 error: {e!r}')
    finally:
        facts['finished_at'] = now()
        write_facts('q3', facts)
        delete_now('root', PREFIX + 'q3c', name)


def cmd_teardown():
    pidfile = RUN / 'active.pid'
    if pidfile.exists():
        pid = int(pidfile.read_text().strip() or 0)
        try:
            cmd = Path(f'/proc/{pid}/cmdline').read_bytes().decode(errors='replace')
            if pid != os.getpid() and 'p4_remote.py' in cmd and str(RUN) in cmd:
                note(f'signalling active experiment pid {pid}')
                os.kill(pid, signal.SIGTERM)
        except (OSError, ValueError):
            pass
    handle = open(RUN / '.exp-lock', 'a')
    deadline = time.time() + 900
    while True:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.time() > deadline:
                raise RuntimeError('experiment lock still held after 900 s')
            time.sleep(2)
    rec = teardown_machines('teardown-final')
    (EVIDENCE / 'teardown-verified.json').write_text(json.dumps(rec, indent=2) + '\n')


def cmd_finish():
    global TEARING_DOWN
    TEARING_DOWN = True
    data = json.loads((RUN / 'manifest.json').read_text())
    if data.get('owner') != OWNER or data.get('id') != RID:
        sys.exit('not an owned run')
    if not (EVIDENCE / 'teardown-verified.json').exists():
        sys.exit('no verified final teardown; scratch and outside changes retained')
    st = load_state()
    result = {}
    # 1. Remove /dev/shm/smolvm-restore only if this run created it.
    shm = Path('/dev/shm/smolvm-restore')
    exists = sudo(['test', '-e', str(shm)], quiet=True)[0] == 0
    if exists and not st.get('shm_restore_before'):
        sudo(['ls', '-lan', str(shm)])
        rc, *_ = sudo(['rm', '-rf', '--one-file-system', str(shm)])
        result['shm'] = f'REVERTED {now()} (created by this run; removed rc={rc})'
    elif exists:
        result['shm'] = f'n/a {now()} (pre-existing; left alone)'
    else:
        result['shm'] = f'REVERTED {now()} (never created by this run; verified absent)'
    # 2. Units / scopes: verified absent by teardown; check again.
    units = p4_units()
    result['units'] = (f'REVERTED {now()} (all stopped; none listed by systemctl list-units --all)' if not units
                       else f'NOT REVERTED: {units}')
    procs = my_processes()
    result['procs'] = (f'REVERTED {now()} (no process references the run; no uid>=2000000 process)'
                       if not procs else f'NOT REVERTED: {procs}')
    # 3. Scratch: exact path, root rm.
    scratch = Path(os.path.realpath(SCRATCH))
    if not (re.fullmatch(r'/home/clanker/clankerbox-rewrite/runs/p4-root-[0-9a-f]{3}/scratch', str(scratch))
            and scratch == SCRATCH and not SCRATCH.is_symlink()):
        sys.exit(f'refusing to delete unexpected scratch path {scratch}')
    if SCRATCH.exists():
        sudo(['du', '-sh', str(SCRATCH)])
        rc, *_ = sudo(['rm', '-rf', '--one-file-system', str(SCRATCH)], timeout=900)
        if rc != 0 or SCRATCH.exists():
            sys.exit('scratch removal failed')
    # 4. Directory modes back to the recorded values (after every root VM is gone).
    before = st.get('modes_before', {})
    for d, s in before.items():
        mode = s.split()[0]
        _, cur, _, _ = sudo(['stat', '-c', '%a', d], quiet=True)
        if cur.strip() != mode:
            sudo(['chmod', mode, d])
    sudo(['chmod', '0700', str(RUN)])
    sudo(['chown', '-R', 'clanker:clanker', str(EVIDENCE)])
    snap = snapshot('after')
    b = json.loads((EVIDENCE / 'snapshot-before.json').read_text())
    diff = {}
    for d in SNAP_DIRS:
        old, new = set(b['dirs'][d]), set(snap['dirs'][d])
        if old != new:
            diff[d] = {'added': sorted(new - old), 'removed': sorted(old - new)}
    for k in ('system_units_matching', 'cgroups_smolvm', 'system_slice'):
        if set(b[k]) != set(snap[k]):
            diff[k] = {'added': sorted(set(snap[k]) - set(b[k])), 'removed': sorted(set(b[k]) - set(snap[k]))}
    modes_ok = all(snap['modes'][d] == b['modes'][d] for d in MODE_DIRS)
    diff['modes_identical'] = modes_ok
    if not modes_ok:
        diff['modes'] = {'before': b['modes'], 'after': snap['modes']}
    (EVIDENCE / 'snapshot-diff.json').write_text(json.dumps(diff, indent=2) + '\n')
    result['dirmodes'] = (f'REVERTED {now()} (stat and getfacl identical to before)' if modes_ok
                          else 'NOT REVERTED: see evidence/snapshot-diff.json')
    for k, v in result.items():
        ledger_mark(k, v)
    data.update(state='cleaned', cleaned_at=now())
    (RUN / 'manifest.json').write_text(json.dumps(data, indent=2) + '\n')
    for f in ('.exp-lock', 'active.pid'):
        (RUN / f).unlink(missing_ok=True)
    print(json.dumps({'result': result, 'diff': diff}, indent=2))
    print(subprocess.run(['du', '-sh', str(RUN)], capture_output=True, text=True).stdout.strip())


def main():
    global LOG
    if args.cmd not in ('init', 'inventory', 'finish'):
        LOG = EVIDENCE / f'{args.cmd}{"-" + args.tag if args.tag else ""}.log'
    if args.cmd == 'init':
        return cmd_init()
    if args.cmd == 'inventory':
        return cmd_inventory(args.tag)
    if args.cmd == 'finish':
        LOG = EVIDENCE / 'finish.log'
        return cmd_finish()
    if args.cmd == 'teardown':
        return cmd_teardown()
    lock = acquire_lock()
    try:
        {'setup': cmd_setup, 'q1q2': exp_q1q2, 'unpriv': exp_unpriv, 'q3': exp_q3}[args.cmd]()
    except Stop as stop:
        note(f'stopped: {stop}; tearing down this run')
        teardown_machines('teardown-on-stop')
        raise SystemExit(2)
    finally:
        (RUN / 'active.pid').unlink(missing_ok=True)
        lock.close()


if __name__ == '__main__':
    main()
