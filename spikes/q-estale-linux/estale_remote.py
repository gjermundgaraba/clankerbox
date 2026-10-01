#!/usr/bin/env python3
"""Remote half of the ESTALE / hunk-3 spike (runs on the Linux KVM test host).

Uploaded into its own run directory `~/clankerbox-rewrite/runs/estale-<id>/` by
driver.py and invoked once per step over a single ssh session each:

  init          create the owned run layout (manifest.json, scratch/, evidence/)
  inventory TAG record smolvm/clankerbox processes, user units and home changes
  setup         download + verify upstream smolvm 1.22.0 linux-x86_64, extract
  exp-a TAG     bare VM on the stock Alpine agent rootfs: ESTALE reproduction
  exp-b TAG     ubuntu:24.04 image machine: same procedure inside the container
  exp-c         hunk 3: live fork, stop child, cold-restart source, state/stop
  teardown      stop+delete every machine in the private inventory, verify none
                remain and no process references this run's scratch
  finish        remove scratch (only after a verified teardown), mark cleaned

Isolation: every smolvm call gets a fresh environment whose HOME,
SMOLVM_DATA_DIR, XDG_* and TMPDIR all point inside this run's scratch/. The
VMM is spawned by smolvm in its own process group but in this session, so each
experiment creates and deletes its machines inside one invocation. SIGHUP,
SIGTERM, SIGINT and a broken stdout pipe (driver gone) all trigger teardown.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time

PREFIX = 'clankerbox-rewrite-estale-'
VERSION = '1.22.0'
ASSET = f'smolvm-{VERSION}-linux-x86_64.tar.gz'
BASE_URL = f'https://github.com/smol-machines/smolvm/releases/download/v{VERSION}/'
EXPECTED_PREFIX = '00d2f057'
OWNER = 'clankerbox-work-run-v1'
SUN_PATH_MAX = 107  # 108-byte sun_path including the NUL terminator


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
parser.add_argument('--no-pkg', action='store_true')
parser.add_argument('--prime2', action='store_true',
                    help='boot 2: look up the whole lower except /etc before touching the targets')
args = parser.parse_args()

RUN = Path(args.run).resolve()
if not RUN.name.startswith('estale-') or RUN.parent != Path.home() / 'clankerbox-rewrite' / 'runs':
    sys.exit(f'refusing run dir outside ~/clankerbox-rewrite/runs/estale-*: {RUN}')
SCRATCH = RUN / 'scratch'
EVIDENCE = RUN / 'evidence'
STATE = RUN / 'state.json'
os.chdir('/')
LOG = None


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def out(line):
    """Log to evidence; mirror to the driver while its ssh session is alive."""
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


def smol_env():
    s = str(SCRATCH)
    return {
        'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'LANG': 'C.UTF-8',
        'HOME': s,
        'SMOLVM_DATA_DIR': s,
        'XDG_DATA_HOME': s + '/.local/share',
        'XDG_CACHE_HOME': s + '/.cache',
        'XDG_CONFIG_HOME': s + '/.config',
        'XDG_RUNTIME_DIR': s + '/run',
        'TMPDIR': s + '/tmp',
    }


def run(cmd, *, env=None, timeout=600, quiet=False, input=None):
    smolvm = load_state().get('smolvm', '\0')
    shown = ' '.join(shlex.quote(str(c)) for c in cmd).replace(smolvm, 'smolvm')
    t0 = time.monotonic()
    try:
        r = subprocess.run([str(c) for c in cmd], env=env, capture_output=True, text=True,
                           timeout=timeout, input=input, stdin=None if input is not None else subprocess.DEVNULL)
        rc, so, se = r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired as e:
        rc = 'timeout'
        so = e.stdout.decode(errors='replace') if isinstance(e.stdout, bytes) else (e.stdout or '')
        se = e.stderr.decode(errors='replace') if isinstance(e.stderr, bytes) else (e.stderr or '')
    dt = time.monotonic() - t0
    lines = [f'{time.strftime("%H:%M:%S")} $ {shown}', f'  [rc={rc} {dt:.2f}s]']
    if so.strip():
        lines += ['  | ' + l for l in so.rstrip('\n').split('\n')[-400:]]
    if se.strip():
        lines += ['  ! ' + l for l in se.rstrip('\n').split('\n')[-80:]]
    if quiet:
        if LOG:
            with open(LOG, 'a') as f:
                f.write('\n'.join(lines) + '\n')
    else:
        for l in lines:
            out(l)
    return rc, so, se, round(dt, 2)


def smol(*a, **kw):
    return run([load_state()['smolvm'], *a], env=smol_env(), **kw)


def gx(name, script, **kw):
    return smol('machine', 'exec', '--name', name, '--', 'sh', '-c', script, **kw)


def machines():
    rc, so, se, _ = smol('machine', 'ls', '--json', quiet=True)
    if rc != 0:
        raise RuntimeError(f'machine ls failed rc={rc}: {se[-500:]}')
    data = json.loads(so or '[]')
    return data if isinstance(data, list) else data.get('machines', [])


def status(name):
    rc, so, se, _ = smol('machine', 'status', '--name', name, '--json')
    try:
        return json.loads(so)
    except ValueError:
        return {'rc': rc, 'stdout': so.strip(), 'stderr': se.strip()[-500:]}


def vm_dir(name):
    return SCRATCH / '.cache' / 'smolvm' / 'vms' / hashlib.sha256(name.encode()).hexdigest()[:16]


def save_console(name, label):
    """Copy the host-side VM console log (kernel console lines) into evidence."""
    src = vm_dir(name) / 'agent-console.log'
    if src.exists():
        data = src.read_bytes()[-2_000_000:]
        (EVIDENCE / f'console-{label}.log').write_bytes(data)
        hits = [l for l in data.decode(errors='replace').splitlines()
                if re.search(r'overlay|stale|-116', l, re.I)]
        note(f'console {label}: {len(data)} bytes, overlay/stale lines: {hits[-20:]}')
        return hits
    note(f'console {label}: {src} absent')
    return []


def record_sockets(label):
    socks = [str(p) for p in SCRATCH.rglob('*.sock')]
    info = [(len(s), s) for s in socks]
    (EVIDENCE / f'sockets-{label}.json').write_text(json.dumps(info, indent=2) + '\n')
    note(f'sockets {label}: {info}')
    if any(n > SUN_PATH_MAX for n, _ in info):
        raise RuntimeError(f'socket path over budget: {info}')


# ---------------------------------------------------------------- processes

def my_processes():
    """Processes of this uid whose exe/cwd/environ/open fds reference our scratch."""
    me, needle = os.getpid(), str(SCRATCH)
    found = []
    for p in Path('/proc').iterdir():
        if not p.name.isdigit() or int(p.name) == me:
            continue
        try:
            if p.stat().st_uid != os.getuid():
                continue
            hit = None
            for link in ('exe', 'cwd'):
                try:
                    if os.readlink(p / link).startswith(needle):
                        hit = link
                except OSError:
                    pass
            if not hit:
                try:
                    env = (p / 'environ').read_bytes()
                    if ('=' + needle).encode() in env:
                        hit = 'environ'
                except OSError:
                    pass
            if not hit:
                try:
                    for fd in (p / 'fd').iterdir():
                        try:
                            if os.readlink(fd).startswith(needle):
                                hit = 'fd'
                                break
                        except OSError:
                            pass
                except OSError:
                    pass
            if hit:
                cmd = (p / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
                found.append({'pid': int(p.name), 'match': hit, 'cmdline': cmd[:300]})
        except (OSError, FileNotFoundError):
            continue
    return found


def teardown_machines(names=None, label='teardown'):
    """Stop and delete our machines (children first); verify absence."""
    global TEARING_DOWN
    TEARING_DOWN = True
    if not load_state().get('smolvm'):
        procs = my_processes() if SCRATCH.exists() else []
        note(f'teardown: no smolvm installed yet; nothing to stop; processes={procs}')
        if procs:
            raise RuntimeError(f'processes reference scratch: {procs}')
        if label == 'teardown-final':
            (EVIDENCE / 'teardown-verified.json').write_text(json.dumps(
                {'at': now(), 'machines': [], 'processes': [], 'smolvm_installed': False}) + '\n')
        return
    report = []
    for attempt in range(4):
        ms = machines()
        if names is not None:
            ms = [m for m in ms if m.get('name') in names]
        report.append({'attempt': attempt, 'machines': ms})
        if not ms:
            break
        ms.sort(key=lambda m: 0 if (m.get('parent_machine') or m.get('golden') or
                                     'child' in str(m.get('name'))) else 1)
        for m in ms:
            name = m.get('name', '')
            if not name.startswith(PREFIX):
                raise RuntimeError(f'unexpected machine in private inventory: {m}')
            s = smol('machine', 'stop', '--name', name, timeout=180)
            d = smol('machine', 'delete', '--name', name, '--force', timeout=180)
            report.append({'name': name, 'stop': s[:3], 'delete': d[:3]})
    remaining = machines()
    with open(EVIDENCE / f'{label}.json', 'a') as f:
        f.write(json.dumps({'at': now(), 'names': names, 'report': report,
                            'remaining': remaining}, indent=2) + '\n')
    if names is not None:
        remaining = [m for m in remaining if m.get('name') in names]
    if remaining:
        raise RuntimeError(f'machines remain: {[m.get("name") for m in remaining]}')
    if names is None:
        procs = []
        for _ in range(30):
            procs = my_processes()
            if not procs:
                break
            time.sleep(1)
        if procs:
            note(f'processes referencing scratch survived stop/delete: {procs}; signalling only these')
            for sig in (signal.SIGTERM, signal.SIGKILL):
                for p in procs:
                    try:
                        os.kill(p['pid'], sig)
                    except ProcessLookupError:
                        pass
                time.sleep(5)
                procs = my_processes()
                if not procs:
                    break
            with open(EVIDENCE / f'{label}.json', 'a') as f:
                f.write(json.dumps({'signalled': True, 'remaining_processes': procs}) + '\n')
            if procs:
                raise RuntimeError(f'processes still reference scratch: {procs}')
        note('teardown verified: private inventory empty, no process references scratch')
        if label == 'teardown-final':
            (EVIDENCE / 'teardown-verified.json').write_text(json.dumps(
                {'at': now(), 'machines': remaining, 'processes': my_processes()}) + '\n')
    else:
        note(f'teardown of {names} verified')


# ---------------------------------------------------------------- commands

def cmd_init():
    RUN.mkdir(mode=0o700, exist_ok=True)
    if (RUN / 'manifest.json').exists():
        sys.exit('run already initialised')
    (RUN / 'manifest.json').write_text(json.dumps(dict(
        owner=OWNER, id=RUN.name, label='estale', created_at=now(), state='running',
        keep=False, driver='local spikes/q-estale-linux/driver.py'), indent=2) + '\n')
    SCRATCH.mkdir(mode=0o700)
    EVIDENCE.mkdir(mode=0o700)
    (RUN / '.start-marker').touch()
    save_state(created_at=now(), machine_prefix=PREFIX, scratch=str(SCRATCH))
    print(f'initialised {RUN}')


PROD_RE = re.compile(r'smolvm|clankerbox|krun|_boot-vm', re.I)


def cmd_inventory(tag):
    procs = []
    r = subprocess.run(['ps', '-eo', 'pid=,ppid=,user=,lstart=,args='], capture_output=True, text=True)
    mine = {p['pid'] for p in my_processes()} if SCRATCH.exists() else set()
    for line in r.stdout.splitlines():
        if PROD_RE.search(line) and 'estale_remote.py' not in line:
            f = line.split(None, 8)
            pid = int(f[0])
            procs.append({'pid': pid, 'ppid': int(f[1]), 'user': f[2], 'lstart': ' '.join(f[3:8]),
                          'args': f[8] if len(f) > 8 else '', 'ours': pid in mine})
    units = subprocess.run(['systemctl', '--user', 'list-units', '--all', '--no-pager', '--no-legend'],
                           capture_output=True, text=True).stdout
    units = [l.strip() for l in units.splitlines() if re.search(r'smolvm|clankerbox', l, re.I)]
    who = subprocess.run(['who'], capture_output=True, text=True).stdout
    sessions = subprocess.run(['ps', '-u', str(os.getuid()), '-o', 'pid=,lstart=,args='],
                              capture_output=True, text=True).stdout
    cache = subprocess.run(['ls', '-la', '--time-style=full-iso', str(Path.home() / '.cache' / 'smolvm' / 'vms')],
                           capture_output=True, text=True)
    marker = RUN / '.start-marker'
    newer = subprocess.run(['find', str(Path.home()), '-xdev', '-newer', str(marker),
                            '-not', '-path', str(Path.home() / 'clankerbox-rewrite') + '/*'],
                           capture_output=True, text=True).stdout.splitlines() if marker.exists() else []
    df = subprocess.run(['df', '-h', str(Path.home()), '/tmp'], capture_output=True, text=True).stdout
    data = dict(at=now(), tag=tag, processes=procs, user_units=units, who=who.splitlines(),
                my_processes=sorted(mine), uid_processes=sessions.splitlines(),
                home_cache_smolvm_vms=cache.stdout.splitlines() + cache.stderr.splitlines(),
                home_files_newer_than_run_start=newer, df=df.splitlines())
    EVIDENCE.mkdir(exist_ok=True)
    (EVIDENCE / f'inventory-{tag}.json').write_text(json.dumps(data, indent=2) + '\n')
    print(json.dumps({k: data[k] for k in ('tag', 'processes', 'user_units', 'who',
                                           'my_processes', 'home_files_newer_than_run_start', 'df')}, indent=2))


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
    rel = SCRATCH / 'rel'
    rel.mkdir()
    run(['tar', '-xzpf', dl / ASSET, '-C', rel])
    (dl / ASSET).unlink()
    listing = subprocess.run(['find', str(rel), '-maxdepth', '3', '-not', '-path', '*/agent-rootfs/*/*'],
                             capture_output=True, text=True).stdout
    (EVIDENCE / 'release-listing.txt').write_text(listing)
    wrapper = next(p for p in rel.rglob('smolvm') if p.is_file() and os.access(p, os.X_OK)
                   and p.parent.name != 'lib' and 'agent-rootfs' not in p.parts)
    (EVIDENCE / 'smolvm-wrapper.sh').write_text(wrapper.read_text())
    save_state(smolvm=str(wrapper), release=str(wrapper.parent), sha256=digest)
    note(f'wrapper {wrapper}')
    out(wrapper.read_text())
    run(['sha256sum', wrapper.parent / 'smolvm-bin', wrapper.parent / 'agent-rootfs/usr/local/bin/smolvm-agent'])
    run(['ls', '-la', wrapper.parent / 'agent-rootfs/etc', wrapper.parent / 'agent-rootfs/sbin/init'])
    run(['cat', wrapper.parent / 'agent-rootfs/etc/alpine-release'])
    run(['ls', '-la', wrapper.parent])
    smol('--version')
    for d in ('run', 'tmp'):
        (SCRATCH / d).mkdir(mode=0o700, exist_ok=True)
    base = len(str(vm_dir(PREFIX + 'x'))) + 1
    budget = {s: base + len(s) for s in ('agent.sock', 'control.sock', 'published.sock')}
    note(f'socket path lengths for this run: {budget} (max {SUN_PATH_MAX})')
    if max(budget.values()) > SUN_PATH_MAX:
        raise RuntimeError('socket path budget exceeded; shorten the run id')
    if machines():
        raise RuntimeError('fresh private inventory is not empty')
    note('setup ok; private inventory empty')


EXCLUDE = {'/etc/resolv.conf', '/etc/hostname', '/etc/hosts', '/etc/mtab', '/etc/passwd',
           '/etc/group', '/etc/shadow', '/etc/gshadow', '/etc/machine-id', '/etc/profile',
           '/etc/motd', '/etc/os-release', '/etc/ld.so.cache'}
EXTRA_CANDIDATES = ['/etc/shells', '/etc/inittab', '/etc/fstab', '/etc/issue', '/etc/alpine-release',
                    '/etc/sysctl.conf', '/etc/securetty', '/etc/nsswitch.conf', '/etc/debian_version',
                    '/etc/host.conf', '/etc/networks', '/etc/protocols', '/etc/services',
                    '/etc/login.defs', '/etc/environment', '/etc/bash.bashrc', '/etc/adduser.conf',
                    '/etc/issue.net', '/etc/legal', '/etc/modules', '/etc/crontab', '/etc/mke2fs.conf']
PARAMS = ('for p in index redirect_dir metacopy xino_auto redirect_always_follow; do '
          'echo "overlay.$p=$(cat /sys/module/overlay/parameters/$p 2>&1)"; done')


def pick_targets(name):
    """Choose regular, single-link /etc files from the guest's own view."""
    rc, so, *_ = gx(name, 'for f in /etc/* /etc/os-release; do [ -f "$f" ] && [ ! -L "$f" ] && '
                          'echo "REG $(stat -c %h "$f" 2>/dev/null || echo 1) $f"; '
                          '[ -L "$f" ] && echo "LNK $f -> $(readlink -f "$f")"; done; true')
    reg = {}
    links = {}
    for line in so.splitlines():
        p = line.split()
        if p[:1] == ['REG'] and len(p) == 3:
            reg[p[2]] = p[1]
        elif p[:1] == ['LNK'] and len(p) == 4:
            links[p[1]] = p[3]
    chmod_t = next((c for c in ('/etc/motd', '/etc/legal', '/etc/issue.net', '/etc/issue')
                    if reg.get(c) == '1'), None)
    append_t = '/etc/profile' if reg.get('/etc/profile') == '1' else None
    touch_t = '/etc/os-release'
    touch_real = links.get(touch_t, touch_t)
    # Every eligible regular single-link /etc file: each is an independent collision chance.
    ordered = [c for c in EXTRA_CANDIDATES if c in reg] + sorted(c for c in reg if c not in EXTRA_CANDIDATES)
    extras = [c for c in ordered if reg.get(c) == '1' and c not in EXCLUDE
              and c not in (chmod_t, append_t, touch_real)][:25]
    t = dict(chmod=chmod_t, append=append_t, touch=touch_t, touch_resolved=touch_real, extras=extras)
    note(f'targets: {t}')
    if not chmod_t or not append_t:
        raise RuntimeError(f'could not pick targets: {t}')
    return t


def all_paths(t):
    paths = [t['chmod'], t['append'], t['touch']]
    if t['touch_resolved'] != t['touch']:
        paths.append(t['touch_resolved'])
    return paths + t['extras']


def modify_script(t):
    extras = ' '.join(t['extras'])
    return (f'set -u; ls -R /usr /lib >/dev/null 2>&1; echo primed; '
            f'chmod 0600 {t["chmod"]} && echo "chmod ok"; '
            f'echo "# estale" >> {t["append"]} && echo "append ok"; '
            f'touch {t["touch"]} && echo "touch ok"; '
            f'for f in {extras}; do touch "$f" && echo "touch extra $f ok"; done; sync; echo synced; '
            f'for f in {" ".join(all_paths(t))}; do ls -lin "$f"; done; '
            'echo ---dmesg-overlay; dmesg 2>&1 | grep -iE "overlay|stale|-116|origin" || echo "(none)"')


AGENT_FILES = '/etc/resolv.conf /etc/hostname /etc/hosts'
# Boot-2 priming: allocate fresh FUSE nodeids in a different order than boot 1, so that
# the nodeids stored in the targets' origin handles name *other* live lower inodes.
PRIME2 = ('n=$(ls -laR /usr /lib /bin /sbin /var /opt /root /home /srv /mnt /media 2>/dev/null | wc -l); '
          'echo "primed2 lines=$n"; ')


def boot2_script(t, prime2=False):
    paths = ' '.join(all_paths(t))
    return ((PRIME2 if prime2 else '') +
            f'for f in {paths} {AGENT_FILES}; do r=$(ls -lin "$f" 2>&1) && echo "OK   $r" || echo "FAIL $f: $r"; done; '
            f'for f in {t["append"]} {t["touch"]} {t["chmod"]}; do '
            'r=$(cat "$f" 2>&1 >/dev/null) && echo "OK   read $f" || echo "FAIL read $f: $r"; done; '
            'echo ---dmesg-overlay; dmesg 2>&1 | grep -iE "overlay|stale|-116|origin" || echo "(none)"')


def stale_in(*texts):
    hits = []
    for t in texts:
        for line in t.splitlines():
            if re.search(r'stale file handle|err=-116|failed to verify|^\s*FAIL', line, re.I):
                hits.append(line.strip())
    return hits


def mechanism_in(*texts):
    """Type-mismatch collisions: the stale handle decoded to another inode, lookup survived."""
    return sorted({l.strip() for t in texts for l in t.splitlines() if re.search(r'invalid origin', l, re.I)})


def acquire_lock():
    handle = open(RUN / '.exp-lock', 'a')
    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    (RUN / 'active.pid').write_text(f'{os.getpid()}\n')
    return handle


def stop_and_status(name, facts, key):
    rc, so, se, dt = smol('machine', 'stop', '--name', name, timeout=180)
    facts[key] = {'rc': rc, 'stdout': so.strip(), 'stderr': se.strip()[-800:], 'seconds': dt}
    st = status(name)
    facts[key]['status_after'] = st.get('state', st)
    if rc != 0:
        raise RuntimeError(f'stop of {name} failed: {se[-500:]}')
    if str(st.get('state', '')).lower() != 'stopped':
        raise RuntimeError(f'{name} not Stopped after stop: {st}')


UPPER_A = ('echo ---agent-root-workdir; ls -la /oldroot/mnt/overlay/work /oldroot/mnt/overlay/work/index 2>&1 | head -20; '
           'echo ---agent-root-upper; find /oldroot/mnt/overlay/upper -xdev 2>&1 | head -80; '
           'command -v getfattr >/dev/null && getfattr -R -h -d -m "^trusted\\.overlay" -e hex '
           '/oldroot/mnt/overlay/upper/etc 2>&1 | head -60; true')


def exp_a(tag, prime2=False):
    name = PREFIX + tag
    facts = {'experiment': 'A', 'tag': tag, 'machine': name, 'started_at': now(), 'prime2': prime2}
    try:
        smol('machine', 'create', '--name', name, '--cpus', '1', '--mem', '1024',
             '--storage', '20', '--overlay', '10', timeout=300)
        rc, so, se, dt = smol('machine', 'start', '--name', name, timeout=300)
        facts['start1'] = {'rc': rc, 'seconds': dt, 'stderr': se.strip()[-500:]}
        if rc != 0:
            raise RuntimeError('start 1 failed')
        record_sockets(tag)
        _, so, *_ = gx(name, f'{PARAMS}; uname -r; head -2 /etc/os-release; echo ---mounts; '
                             'grep -E " / |overlay|virtiofs" /proc/mounts; echo ---mountinfo-root; '
                             'grep -E " / / " /proc/self/mountinfo; echo ---blk; ls -l /dev/vd* 2>&1; '
                             'echo ---dmesg-overlay; dmesg 2>&1 | grep -iE "overlay|virtiofs|fuse" || echo "(none)"')
        facts['boot1_probe'] = so
        t = pick_targets(name)
        facts['targets'] = t
        _, so, se, _ = gx(name, modify_script(t) + '; ' + UPPER_A)
        facts['boot1_modify'] = so + se
        stop_and_status(name, facts, 'stop1')
        save_console(name, f'{tag}-boot1')
        rc, so, se, dt = smol('machine', 'start', '--name', name, timeout=300)
        facts['start2'] = {'rc': rc, 'seconds': dt, 'stderr': se.strip()[-500:]}
        if rc != 0:
            raise RuntimeError('start 2 failed')
        _, so1, se1, _ = gx(name, boot2_script(t, prime2))
        facts['boot2_first'] = so1 + se1
        _, so2, se2, _ = gx(name, f'{PARAMS}; echo ---mounts; grep -E " / |overlay" /proc/mounts; '
                                  + UPPER_A + '; echo ---dmesg-full; dmesg 2>&1 | tail -n 400')
        facts['boot2_second'] = so2 + se2
        (EVIDENCE / f'dmesg-{tag}-boot2.txt').write_text(so2)
        console = save_console(name, f'{tag}-boot2')
        hits = stale_in(facts['boot2_first'], facts['boot2_second'], '\n'.join(console))
        facts['stale_hits'] = sorted(set(hits))
        facts['reproduced'] = bool(hits)
        facts['mechanism_hits'] = mechanism_in(facts['boot2_first'], facts['boot2_second'], '\n'.join(console))
        note(f'A {tag}: reproduced={facts["reproduced"]} hits={facts["stale_hits"]}')
        stop_and_status(name, facts, 'stop2')
    except Exception as e:
        facts['error'] = repr(e)
        note(f'A {tag} error: {e!r}')
    finally:
        facts['finished_at'] = now()
        (EVIDENCE / f'exp-{tag}.json').write_text(json.dumps(facts, indent=2) + '\n')
        teardown_machines([name], label=f'teardown-{tag}')


def mount_disks_script(body):
    """Mount the VM's block devices (same superblocks, no -o ro: EBUSY) under /run inside
    the privileged container, run `body`, then unmount."""
    return ('set -u; for d in vda vdb; do mkdir -p /run/estale-$d; dev=/dev/$d; '
            'if [ ! -b $dev ]; then dev=/dev/estale-$d; '
            '[ -b $dev ] || mknod $dev b $(cut -d: -f1 /sys/block/$d/dev) $(cut -d: -f2 /sys/block/$d/dev); fi; '
            'mountpoint -q /run/estale-$d || mount $dev /run/estale-$d 2>&1 || echo "mount $d failed"; done; '
            + body +
            '; sync; for d in vda vdb; do umount /run/estale-$d 2>&1; done; true')


def exp_b(tag, pkg, prime2=False):
    name = PREFIX + tag
    facts = {'experiment': 'B', 'tag': tag, 'machine': name, 'started_at': now(), 'package_probe': pkg,
             'prime2': prime2}
    upper_c = f'/run/estale-vda/overlays/persistent-{name}/upper'
    try:
        smol('machine', 'create', '--name', name, '--image', 'ubuntu:24.04', '--cpus', '1', '--mem', '1024',
             '--storage', '20', '--overlay', '10', '--net', timeout=300)
        rc, so, se, dt = smol('machine', 'start', '--name', name, timeout=900)
        facts['start1'] = {'rc': rc, 'seconds': dt, 'stderr': se.strip()[-500:]}
        if rc != 0:
            raise RuntimeError('start 1 failed')
        record_sockets(tag)
        _, so, se, _ = gx(name, f'{PARAMS}; uname -r; head -2 /etc/os-release; '
                                'echo "pid1=$(tr "\\0" " " </proc/1/cmdline)"; grep Cap /proc/self/status; '
                                'echo ---mounts; grep -E " / |overlay|virtiofs" /proc/mounts; '
                                'echo ---mountinfo-root; grep -E " / / " /proc/self/mountinfo; '
                                'echo ---blk; ls -l /dev/vd* 2>&1; cat /sys/block/vd*/dev 2>&1; '
                                'echo ---dmesg-overlay; dmesg 2>&1 | grep -iE "overlay|virtiofs|fuse" || echo "dmesg rc=$?"')
        facts['boot1_probe'] = so + se
        _, so, se, _ = gx(name, mount_disks_script(
            'echo ---vda-top; ls -la /run/estale-vda; ls -la /run/estale-vda/overlays 2>&1; '
            'echo ---vdb-top; ls -la /run/estale-vdb; find /run/estale-vdb -maxdepth 2 | head -50; '
            'echo ---vdb-workdir; ls -la /run/estale-vdb/work /run/estale-vdb/work/index 2>&1 | head -20; '
            'echo ---vdb-upper-listing; find /run/estale-vdb -xdev -not -path "*/lost+found*" '
            '-printf "%T@ %y %p\\n" | sort | tail -n 300'))
        facts['boot1_disks'] = so + se
        t = pick_targets(name)
        facts['targets'] = t
        _, so, se, _ = gx(name, 'date +%s > /run/estale-t0; ' + modify_script(t))
        facts['boot1_modify'] = so + se
        if pkg:
            _, so, se, _ = gx(name, 'cat /run/estale-t0; export DEBIAN_FRONTEND=noninteractive; '
                                    'apt-get update -qq 2>&1 | tail -3; '
                                    'apt-get install -y -qq --no-install-recommends attr 2>&1 | tail -5; '
                                    'echo "getfattr=$(command -v getfattr)"; sync', timeout=900)
            facts['package_install'] = so + se
        _, so, se, _ = gx(name, mount_disks_script(
            't0=$(cat /run/estale-t0); echo t0=$t0; '
            'echo ---vdb-changed-since-t0; find /run/estale-vdb -xdev -newermt @$t0 -not -path "*/lost+found*" '
            '-printf "%T@ %y %p\\n" | sort; '
            f'echo ---container-upper-changed-since-t0-count; find {upper_c} -xdev -newermt @$t0 | wc -l; '
            f'echo ---container-upper-etc; ls -la {upper_c}/etc 2>&1 | head -40; '
            f'echo ---container-upper-sample; find {upper_c} -xdev -newermt @$t0 | head -40; '
            f'echo ---xattrs-container-upper; for f in {" ".join(all_paths(t))}; do '
            f'command -v getfattr >/dev/null && getfattr -h -d -m "^trusted\\.overlay" -e hex {upper_c}$f 2>&1; done; '
            'echo ---xattrs-vdb-upper-etc; command -v getfattr >/dev/null && '
            'getfattr -R -h -d -m "^trusted\\.overlay" -e hex /run/estale-vdb 2>/dev/null | head -60'))
        facts['boot1_where_writes_landed'] = so + se
        stop_and_status(name, facts, 'stop1')
        save_console(name, f'{tag}-boot1')
        rc, so, se, dt = smol('machine', 'start', '--name', name, timeout=600)
        facts['start2'] = {'rc': rc, 'seconds': dt, 'stderr': se.strip()[-500:]}
        if rc != 0:
            raise RuntimeError('start 2 failed')
        _, so1, se1, _ = gx(name, boot2_script(t, prime2))
        facts['boot2_first'] = so1 + se1
        _, so, se, _ = gx(name, mount_disks_script(
            't0=$(cat /run/estale-t0 2>/dev/null || echo 0); '
            'echo ---vdb-upper-after-restart; find /run/estale-vdb -xdev -not -path "*/lost+found*" '
            '-printf "%T@ %y %p\\n" | sort | tail -n 200; '
            'echo ---xattrs-vdb; command -v getfattr >/dev/null && '
            'getfattr -R -h -d -m "^trusted\\.overlay" -e hex /run/estale-vdb 2>/dev/null | head -80'))
        facts['boot2_disks'] = so + se
        _, so2, se2, _ = gx(name, f'{PARAMS}; echo "getfattr=$(command -v getfattr)"; echo ---mounts; '
                                  'grep -E " / |overlay" /proc/mounts; echo ---dmesg-full; dmesg 2>&1 | tail -n 400')
        facts['boot2_second'] = so2 + se2
        (EVIDENCE / f'dmesg-{tag}-boot2.txt').write_text(so2 + se2)
        console = save_console(name, f'{tag}-boot2')
        hits = stale_in(facts['boot2_first'], facts['boot2_second'], '\n'.join(console))
        facts['stale_hits'] = sorted(set(hits))
        facts['reproduced'] = bool(hits)
        facts['mechanism_hits'] = mechanism_in(facts['boot2_first'], facts['boot2_second'], '\n'.join(console))
        note(f'B {tag}: reproduced={facts["reproduced"]} hits={facts["stale_hits"]}')
        stop_and_status(name, facts, 'stop2')
    except Exception as e:
        facts['error'] = repr(e)
        note(f'B {tag} error: {e!r}')
    finally:
        facts['finished_at'] = now()
        (EVIDENCE / f'exp-{tag}.json').write_text(json.dumps(facts, indent=2) + '\n')
        teardown_machines([name], label=f'teardown-{tag}')


def exp_c():
    src, child = PREFIX + 'c-src', PREFIX + 'c-child'
    facts = {'experiment': 'C', 'source': src, 'child': child, 'started_at': now(), 'steps': []}

    def step(label, *a, timeout=300):
        rc, so, se, dt = smol(*a, timeout=timeout)
        facts['steps'].append({'label': label, 'cmd': ' '.join(a), 'rc': rc, 'stdout': so.strip()[-3000:],
                               'stderr': se.strip()[-1500:], 'seconds': dt})
        return rc, so, se

    def snap(label):
        facts['steps'].append({'label': label, 'status_src': status(src), 'status_child': status(child)})
        step(label + ': ls', 'machine', 'ls')
        step(label + ': ls --json', 'machine', 'ls', '--json')

    try:
        step('create source', 'machine', 'create', '--name', src, '--cpus', '1', '--mem', '512',
             '--storage', '20', '--overlay', '10')
        rc, *_ = step('start source --branchable', 'machine', 'start', '--name', src, '--branchable')
        if rc != 0:
            raise RuntimeError('source start failed')
        record_sockets('c')
        gx(src, 'echo source-boot1 $(cat /proc/sys/kernel/random/boot_id); echo hello > /root/c-marker; sync')
        rc, *_ = step('branch (live fork, source continues)', 'machine', 'branch', '--from', src, '--name', child,
                      timeout=600)
        if rc != 0:
            raise RuntimeError('branch failed')
        gx(child, 'echo child $(cat /proc/sys/kernel/random/boot_id); cat /root/c-marker')
        gx(src, 'echo source-still-running $(cat /proc/sys/kernel/random/boot_id)')
        snap('after branch')
        step('stop child (kept)', 'machine', 'stop', '--name', child, timeout=180)
        snap('after child stop')
        rc, *_ = step('stop source (before restart)', 'machine', 'stop', '--name', src, timeout=180)
        snap('after source stop')
        rc, *_ = step('cold start source', 'machine', 'start', '--name', src, timeout=300)
        time.sleep(3)
        snap('after source cold start')
        gx(src, 'echo source-boot2 $(cat /proc/sys/kernel/random/boot_id)')
        step('machine status source (text)', 'machine', 'status', '--name', src)
        rc, *_ = step('stop source (after restart, child retained)', 'machine', 'stop', '--name', src, timeout=180)
        snap('after stop attempt')
        facts['source_state_after_restart'] = next(
            (s['status_src'].get('state') for s in facts['steps'] if s.get('label') == 'after source cold start'),
            None)
        facts['stop_after_restart_rc'] = rc
        rc, *_ = step('delete source first (child retained)', 'machine', 'delete', '--name', src, '--force')
        facts['delete_source_first_rc'] = rc
        snap('after delete-source attempt')
        step('delete child', 'machine', 'delete', '--name', child, '--force')
        snap('after child delete')
        rc, *_ = step('stop source (child gone)', 'machine', 'stop', '--name', src, timeout=180)
        facts['stop_after_child_delete_rc'] = rc
        step('delete source', 'machine', 'delete', '--name', src, '--force')
        snap('end')
    except Exception as e:
        facts['error'] = repr(e)
        note(f'C error: {e!r}')
    finally:
        facts['finished_at'] = now()
        (EVIDENCE / 'exp-c.json').write_text(json.dumps(facts, indent=2) + '\n')
        teardown_machines([child, src], label='teardown-c')


def cmd_teardown():
    # A dropped driver may leave an experiment process tearing down its own VMs:
    # signal only the recorded estale_remote.py PID of this run, then wait for its lock.
    pidfile = RUN / 'active.pid'
    if pidfile.exists():
        pid = int(pidfile.read_text().strip() or 0)
        try:
            cmd = Path(f'/proc/{pid}/cmdline').read_bytes().decode(errors='replace')
            if pid != os.getpid() and 'estale_remote.py' in cmd and str(RUN) in cmd:
                note(f'signalling active experiment pid {pid}')
                os.kill(pid, signal.SIGTERM)
        except (OSError, ValueError):
            pass
    handle = open(RUN / '.exp-lock', 'a')
    deadline = time.time() + 600
    while True:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.time() > deadline:
                raise RuntimeError('experiment lock still held after 600 s')
            time.sleep(2)
    teardown_machines(None, label='teardown-final')


def cmd_finish():
    data = json.loads((RUN / 'manifest.json').read_text())
    if data.get('owner') != OWNER or data.get('id') != RUN.name:
        sys.exit('not an owned run')
    if not (EVIDENCE / 'teardown-verified.json').exists():
        sys.exit('no verified final teardown; scratch retained')
    if SCRATCH.exists() and not SCRATCH.is_symlink():
        shutil.rmtree(SCRATCH)
    for f in ('.exp-lock', 'active.pid'):
        (RUN / f).unlink(missing_ok=True)
    data.update(state='cleaned', cleaned_at=now())
    (RUN / 'manifest.json').write_text(json.dumps(data, indent=2) + '\n')
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
        return cmd_finish()
    if args.cmd == 'teardown':
        return cmd_teardown()
    lock = acquire_lock()
    try:
        if args.cmd == 'setup':
            cmd_setup()
        elif args.cmd == 'exp-a':
            exp_a(args.tag, args.prime2)
        elif args.cmd == 'exp-b':
            exp_b(args.tag, not args.no_pkg, args.prime2)
        elif args.cmd == 'exp-c':
            exp_c()
        else:
            sys.exit(f'unknown command {args.cmd}')
    except Stop as stop:
        note(f'stopped: {stop}; tearing down this run')
        teardown_machines(None, label='teardown-on-stop')
        raise SystemExit(2)
    finally:
        (RUN / 'active.pid').unlink(missing_ok=True)
        lock.close()


if __name__ == '__main__':
    main()
