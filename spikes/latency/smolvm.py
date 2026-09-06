#!/usr/bin/env python3
"""Scoped, offline patched-smolvm latency trials. See SMOLVM_NOTES.md."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import shlex
import shutil
import sqlite3
import subprocess
import threading
import time

STAGE = Path('/home/clanker/clankerbox-smolvm.Jf1bpB')
ROOT = Path('/home/clanker/clankerbox-latency.RPxPe6/smolvm')
BINARY = ROOT / 'bin/smolvm'
GRANT = 'latency-20260905'
CGROUP = Path('/sys/fs/cgroup/smlat20260905.slice')
CGROUP_LIMITS = {'memory.max': str(32 * 1024 ** 3), 'memory.swap.max': '0',
                 'pids.max': '2048', 'cpuset.cpus': '4-11', 'cpu.max': 'max 100000'}
GUEST = '/opt/latency/latency-guest'
SOCKET = '/tmp/clanker-latency.sock'
WORKSPACE = '/var/tmp/clanker-latency-workspace'
PROFILES = {'idle': (64, 0, 0, 0), 'resident': (1024, 0, 0, 0),
            'dirty': (1024, 64, 0, 0), 'workspace': (1024, 0, 2048, 1024)}
CASES = ('cold', 'warm', 'live-first', 'live-second', 'batch-1', 'batch-4')


def require(value, message):
    if not value:
        raise RuntimeError(message)


def validate_root(root):
    require(root == ROOT and root.resolve() == ROOT and not root.is_symlink(), 'unauthorized root')
    require(root.stat().st_uid == 1000, 'root must belong to clanker UID 1000')
    return root


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def branch_args(source, prefix, count, boundary):
    require(count in (1, 4), 'only fanout 1 or 4 is granted')
    argv = ['machine', 'branch', '--from', source]
    if count == 1:
        argv += ['--name', prefix + '-0']
    else:
        argv += ['--count', str(count), '--name-prefix', prefix, '--parallel', str(count)]
    if boundary:
        argv += ['--wait-ready', '--ready-timeout', '60s']
    return argv


def checkpoint_timings(stderr):
    clean = re.sub(r'\x1b\[[0-9;]*m', '', stderr)
    return [int(re.search(r'elapsed_ms[= ]+(\d+)', line).group(1))
            for line in clean.splitlines() if 'golden RAM checkpoint written' in line
            and re.search(r'elapsed_ms[= ]+(\d+)', line)]


def inspect_pid(pid, expected_start=None, proc_root=Path('/proc')):
    require(type(pid) is int and pid > 1, 'invalid PID')
    proc = proc_root / str(pid)
    executable = (proc / 'exe').resolve(strict=True)
    require(executable == BINARY.resolve(strict=True), 'foreign VMM executable')
    argv = (proc / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
    require(len(argv) == 3 and argv[1] == b'_boot-vm', 'unexpected VMM arguments')
    config = Path(os.fsdecode(argv[2]))
    require(config.is_relative_to(ROOT / 'c/smolvm/vms') and config.name == 'boot-config.json'
            and config.resolve() == config, 'VMM outside fresh scope')
    fields = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
    require(len(fields) >= 20 and fields[0] != 'Z', 'dead VMM')
    birth = fields[19]
    require(expected_start is None or birth == expected_start, 'PID birth changed')
    status = (proc / 'status').read_text()
    uids = next(line.split()[1:] for line in status.splitlines() if line.startswith('Uid:'))
    require(uids == ['1000'] * 4, 'foreign VMM UID')
    return {'pid': pid, 'start_time': birth, 'executable': str(executable),
            'argv': [os.fsdecode(arg) for arg in argv], 'status': status,
            'smaps_rollup': (proc / 'smaps_rollup').read_text()}


def inventory():
    found = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            if (proc / 'exe').resolve(strict=True) != BINARY.resolve(strict=True):
                continue
            argv = (proc / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
            if len(argv) == 3 and argv[1] == b'_boot-vm':
                found.append(inspect_pid(int(proc.name)))
        except (FileNotFoundError, ProcessLookupError):
            continue
    return found


def cgroup_authorized():
    authorization = json.loads((ROOT.parent / 'authorization.json').read_text())
    require(authorization.get('smolvm_cgroup') == str(CGROUP), 'missing exact cgroup authorization')


def prepare_cgroup():
    require(os.geteuid() == 0, 'cgroup setup requires root')
    cgroup_authorized()
    if CGROUP.exists():
        validate_cgroup_owner()
        validate_cgroup()
        return {'path': str(CGROUP), 'limits': CGROUP_LIMITS, 'already_prepared': True}
    CGROUP.mkdir()
    # Existing parent controller delegation is a prerequisite; never alter it.
    for name, value in CGROUP_LIMITS.items():
        require((CGROUP / name).is_file(), 'required controller is not already delegated')
        (CGROUP / name).write_text(value + '\n')
    validate_cgroup()
    metadata = {'path': str(CGROUP), 'inode': CGROUP.stat().st_ino, 'device': CGROUP.stat().st_dev,
                'status': 'prepared'}
    marker = ROOT / 'cgroup-owned.json'
    marker.write_text(json.dumps(metadata) + '\n')
    marker.chmod(0o644)
    return {'path': str(CGROUP), 'limits': CGROUP_LIMITS}


def validate_cgroup_owner():
    marker = ROOT / 'cgroup-owned.json'
    require(not marker.is_symlink() and marker.stat().st_uid == 0, 'missing root-owned cgroup identity')
    metadata = json.loads(marker.read_text())
    require(metadata.get('status') == 'prepared' and metadata.get('path') == str(CGROUP)
            and metadata.get('inode') == CGROUP.stat().st_ino
            and metadata.get('device') == CGROUP.stat().st_dev, 'cgroup identity changed')


def close_cgroup():
    require(os.geteuid() == 0, 'cgroup close requires root')
    validate_cgroup_owner()
    validate_cgroup()
    require(not (CGROUP / 'cgroup.procs').read_text().strip(), 'cgroup still has processes')
    require(not any(path.is_dir() for path in CGROUP.iterdir()), 'cgroup has unexpected children')
    require(not inventory(), 'owned VMM/guardian remains')
    CGROUP.rmdir()
    marker = ROOT / 'cgroup-owned.json'
    metadata = json.loads(marker.read_text())
    metadata['status'] = 'closed'
    marker.write_text(json.dumps(metadata) + '\n')
    return metadata


def validate_cgroup():
    cgroup_authorized()
    require(CGROUP.resolve() == CGROUP and not CGROUP.is_symlink(), 'redirected cgroup')
    for name, value in CGROUP_LIMITS.items():
        require((CGROUP / name).read_text().strip() == value, f'cgroup {name} changed')


def join_cgroup(pid, birth):
    require(os.geteuid() == 0 and type(pid) is int and pid > 1 and birth, 'invalid cgroup join request')
    validate_cgroup()
    validate_cgroup_owner()
    proc = Path('/proc', str(pid))
    require(proc.stat().st_uid == 1000, 'runner UID is not clanker')
    fields = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
    require(fields[0] != 'Z' and fields[19] == birth, 'runner PID birth changed')
    argv = [os.fsdecode(arg) for arg in (proc / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')]
    require(len(argv) > 2 and argv[1] == str(ROOT / 'smolvm.py'), 'foreign runner script')
    require('--root' in argv and argv[argv.index('--root') + 1] == str(ROOT)
            and '--host-slot' in argv and argv[argv.index('--host-slot') + 1] == GRANT,
            'runner argv missing authorized scope/grant')
    (CGROUP / 'cgroup.procs').write_text(str(pid) + '\n')
    return {'pid': pid, 'birth': birth, 'cgroup': str(CGROUP)}


def resources():
    return {'at_ns': time.monotonic_ns(),
            'pressure': {name: Path('/proc/pressure', name).read_text() for name in ('cpu', 'memory', 'io')},
            'cgroup': {name: (CGROUP / name).read_text() for name in
                       ('memory.current', 'memory.peak', 'memory.events', 'pids.current',
                        'cpu.stat', 'cpu.pressure', 'io.stat', 'memory.pressure', 'io.pressure')},
            'allocated_disk_bytes': int(subprocess.run(['sudo', '-n', '--', 'du', '-s', '-B1', str(ROOT.parent)],
                capture_output=True, text=True, check=True).stdout.split()[0])}


class Runner:
    def __init__(self, args):
        self.args = args
        self.root = validate_root(args.root)
        self.output = self.root / f'results-{args.profile}-{args.case}-{args.trial}'
        self.output.mkdir(mode=0o700)
        self.commands = (self.output / 'commands.jsonl').open('a')
        self.command_lock = threading.Lock()
        self.names = []
        self.identities = {}
        self.env = {key: os.environ[key] for key in ('PATH', 'USER', 'LOGNAME', 'HOME', 'LANG') if key in os.environ}
        self.env.update(XDG_DATA_HOME=str(self.root / 'd'), XDG_CACHE_HOME=str(self.root / 'c'),
            XDG_CONFIG_HOME=str(self.root / 'config'), XDG_RUNTIME_DIR=str(self.root / 'r'),
            DOCKER_CONFIG=str(self.root / 'empty-docker'),
            SMOLVM_LIB_DIR=str(STAGE / 'source/lib/linux-x86_64'),
            LD_LIBRARY_PATH=str(STAGE / 'source/lib/linux-x86_64'),
            SMOLVM_AGENT_ROOTFS=str(self.root / 'agent-rootfs'), RUST_LOG='smolvm=debug', NO_COLOR='1')
        for directory in ('d', 'c', 'config', 'r', 'empty-docker'):
            path = self.root / directory
            require(path.resolve() == path and not path.is_symlink(), 'redirected XDG directory')
            path.mkdir(mode=0o700, exist_ok=True)
        self.report = {'schema_version': 1, 'runtime': 'smolvm', 'profile': args.profile,
            'case': args.case, 'trial': args.trial, 'status': 'fail', 'metrics': {}, 'stages': [],
            'clock': 'host CLOCK_MONOTONIC nanoseconds', 'source_pause_ms': None,
            'limitations': ['Guest heartbeat gaps include scheduling and guest clock behavior; they are not exact VMM pause.',
                'Internal child restore duration is unavailable separately from boot/preparation; no inferred restore timer.',
                'Cached-image cold boot leaves host page cache intact.'], 'cleanup': []}

    def save(self, name, value):
        (self.output / name).write_text(json.dumps(value, indent=2) + '\n')

    def cli(self, *argv, check=True, timeout=300, phase=None):
        start = time.monotonic_ns()
        try:
            result = subprocess.run([str(BINARY), *argv], env=self.env, capture_output=True,
                                    text=True, timeout=timeout)
            record = {'argv': list(argv), 'start_ns': start, 'end_ns': time.monotonic_ns(),
                      'returncode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}
        except subprocess.TimeoutExpired as error:
            record = {'argv': list(argv), 'start_ns': start, 'end_ns': time.monotonic_ns(),
                      'returncode': None, 'error': 'timeout', 'stdout': str(error.stdout), 'stderr': str(error.stderr)}
            with self.command_lock:
                self.commands.write(json.dumps(record) + '\n'); self.commands.flush()
            raise
        with self.command_lock:
            self.commands.write(json.dumps(record) + '\n'); self.commands.flush()
        if phase:
            self.report['stages'].append({'phase': phase, **{k: record[k] for k in ('start_ns', 'end_ns', 'returncode')}})
        result.timing = record
        if check:
            result.check_returncode()
        return result

    def guest(self, name, *argv, **kwargs):
        require(name in self.records(), 'refusing exec on absent VM (upstream may create orphan directory)')
        return self.cli('machine', 'exec', '--name', name, '--', *argv, **kwargs)

    def call(self, name, op='status', *, require_release=False, **fields):
        argv = [GUEST, 'call', '--socket', SOCKET, json.dumps({'op': op, **fields})]
        if require_release:
            argv = ['/bin/sh', '-c', 'test -f /tmp/latency-branch-released && exec ' + shlex.join(argv)]
        result = self.guest(name, *argv, timeout=25)
        value = json.loads(result.stdout)
        require(value.get('ok') and value.get('ready') and value.get('memory_ok') and value.get('disk_ok'), 'invalid workload status')
        return value

    def records(self):
        path = self.root / 'd/smolvm/server/smolvm.db'
        if not path.exists():
            return {}
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
            return {name: json.loads(data) for name, data in db.execute('SELECT name,data FROM vms')}

    def directory(self, name):
        return self.root / 'c/smolvm/vms' / hashlib.sha256(name.encode()).hexdigest()[:16]

    def observe(self, name):
        pid = self.records()[name].get('pid')
        require(type(pid) is int, 'missing live VMM PID')
        before = self.identities.get(name)
        try:
            value = inspect_pid(pid, before['start_time'] if before else None)
        except PermissionError:
            argv = ['sudo', '-n', '--', 'python3', str(self.root / 'smolvm.py'),
                    '--root', str(self.root), '--observe', str(pid)]
            if before:
                argv += ['--expected-start', before['start_time']]
            value = json.loads(subprocess.run(argv, check=True, text=True, capture_output=True, timeout=15).stdout)
        self.identities[name] = value
        return value

    def ready(self, name, phase, require_release=False):
        start = time.monotonic_ns()
        deadline = time.monotonic() + 180
        errors = []
        while True:
            try:
                status = self.call(name, require_release=require_release)
                break
            except (subprocess.CalledProcessError, ValueError, RuntimeError) as error:
                errors.append(type(error).__name__)
                require(time.monotonic() < deadline, 'shared workload readiness deadline exceeded')
                time.sleep(.02)
        end = time.monotonic_ns()
        self.report['stages'].append({'phase': phase, 'name': name, 'start_ns': start, 'end_ns': end,
                                      'failed_probes': len(errors)})
        self.save(phase + '-' + name + '.json', status)
        return status, end

    def probe_ready(self, name, phase, boundary=False, prepare=None):
        # The workload endpoint and preparation never wait for a successful
        # /bin/true RPC. Its independent endpoint is joined only afterwards;
        # an exec failure still invalidates the trial.
        with ThreadPoolExecutor(max_workers=1) as pool:
            exec_future = pool.submit(self.guest, name, '/bin/true', phase=phase + '_first_exec')
            status, ready_ns = self.ready(name, phase + '_shared_ready', require_release=boundary)
            value = {'status': status, 'ready_ns': ready_ns}
            if prepare is not None:
                value['prepared'] = prepare(status)
                value['prepared_ns'] = time.monotonic_ns()
            value['first_exec_ns'] = exec_future.result().timing['end_ns']
        return value

    def create(self):
        name = f'lat-smol-{self.args.profile}-{self.args.case}-{self.args.trial}-source'
        self.names.append(name)
        memory, dirty, workspace, files = PROFILES[self.args.profile]
        serve = [GUEST, 'serve', '--memory-mib', str(memory), '--dirty-mib-s', str(dirty),
                 '--workspace-mib', str(workspace), '--workspace-files', str(files),
                 '--socket', SOCKET, '--workspace', WORKSPACE, '--reuse-workspace']
        self.cold_start_ns = time.monotonic_ns()
        self.cli('machine', 'create', '--name', name, '--image', str(self.root / 'image'),
                 '--cpus', '2', '--mem', '4096', '--storage', '5', '--overlay', '4', '--',
                 '/bin/sh', '-c', 'rm -f -- ' + SOCKET + '; exec ' + shlex.join(serve),
                 phase='create_record')
        return name

    def start(self, name, prefix):
        result = self.cli('machine', 'start', '--name', name, '--branchable', phase=prefix + '_cli')
        probed = self.probe_ready(name, prefix)
        value, end = probed['status'], probed['ready_ns']
        self.report['metrics'][prefix + '_shared_ready_ms'] = (end - result.timing['start_ns']) / 1e6
        request_start = self.cold_start_ns if prefix == 'cold' else result.timing['start_ns']
        self.report['metrics'][prefix + '_request_to_exec_ms'] = (probed['first_exec_ns'] - request_start) / 1e6
        self.report['metrics'][prefix + '_request_to_workload_ms'] = (end - request_start) / 1e6
        self.observe(name)
        return value

    def boundary(self, source):
        self.call(source, 'pause_writes')
        script = ('(/usr/local/bin/smolvm-branch-ready && touch /tmp/latency-branch-released) '
                  '>/tmp/latency-boundary.log 2>&1 </dev/null &')
        self.guest(source, '/bin/sh', '-c', script, phase='arm_branch_boundary')
        self.guest(source, '/bin/sh', '-c',
            'i=0; until test -f /run/smolvm/forkpoint/ready; do i=$((i+1)); test "$i" -lt 1000 || exit 1; sleep .02; done',
            phase='branch_boundary_ready')

    def release_source(self, source):
        self.guest(source, '/bin/sh', '-c',
            "generation=$(sed -n 's/^generation=//p' /run/smolvm/forkpoint/ready); "
            "test -n \"$generation\" && printf 'smolvm-forkpoint-release-v2:%s\\n' \"$generation\" > /run/smolvm/forkpoint/release",
            phase='release_source_boundary')

    def branch(self, source, label, count, boundary):
        prefix = f'lat-smol-{self.args.profile}-{self.args.case}-{self.args.trial}-{label}'
        children = [prefix + f'-{i}' for i in range(count)]
        self.names.extend(children)
        self.call(source, 'reset_metrics')
        time.sleep(1)  # Pre-capture heartbeat/dirty baseline for every capture.
        self.save(label + '-source-baseline-heartbeat.json', self.call(source))
        if boundary:
            setup_start = time.monotonic_ns()
            self.boundary(source)
            self.report['metrics']['fanout_cooperative_setup_ms'] = (time.monotonic_ns() - setup_start) / 1e6
        baseline = self.call(source, 'reset_metrics')
        result = self.cli(*branch_args(source, prefix, count, boundary), phase=label + '_branch_cli')
        captures = checkpoint_timings(result.stderr)
        require(len(captures) == 1, 'expected exactly one logged source checkpoint per branch invocation')
        self.report['metrics'][label + '_source_checkpoint_ms'] = captures[0]
        self.report['metrics'][('fanout' if boundary else 'fresh_' + label) + '_backend_capture_ms'] = captures[0]
        self.report['metrics'][label + '_branch_cli_ms'] = (result.timing['end_ns'] - result.timing['start_ns']) / 1e6
        self.report['metrics'][label + '_child_restore_ms'] = None
        def probe(child):
            def prepare(status):
                for key in ('pid', 'start_monotonic_ns', 'ram_marker', 'branch', 'disk_branch'):
                    require(status[key] == baseline[key], f'RAM/disk inheritance mismatch: {key}')
                prepared = self.call(child, 'mutate', branch=self.names.index(child) + 1)
                if prepared['writes_paused']:
                    prepared = self.call(child, 'resume_writes')
                return prepared
            value = self.probe_ready(child, label, boundary=boundary, prepare=prepare)
            self.observe(child)
            for phase in ('first_exec', 'ready', 'prepared'):
                value[phase + '_ms'] = (value[phase + '_ns'] - result.timing['start_ns']) / 1e6
            return child, value
        with ThreadPoolExecutor(max_workers=count + 1) as pool:
            source_future = pool.submit(self.call, source)
            values = dict(pool.map(probe, children))
            source_at_cli = source_future.result()
        self.save(label + '-source-at-cli-return.json', source_at_cli)
        self.report['metrics'][label + '_all_shared_ready_ms'] = max(v['ready_ms'] for v in values.values())
        self.report['metrics'][('fanout' if boundary else 'fresh_' + label) + '_total_ms'] = max(v['prepared_ms'] for v in values.values())
        source_after = self.call(source)
        for key in ('pid', 'start_monotonic_ns', 'ram_marker', 'branch', 'disk_branch'):
            require(source_after[key] == baseline[key], f'source continuity mismatch: {key}')
        for clock in ('monotonic', 'raw'):
            self.report['metrics'][label + '_source_heartbeat_max_gap_' + clock + '_ms'] = source_after['heartbeat']['max_gap_' + clock + '_ns'] / 1e6
            self.report['metrics'][label + '_source_heartbeat_at_cli_max_gap_' + clock + '_ms'] = source_at_cli['heartbeat']['max_gap_' + clock + '_ns'] / 1e6
        self.report['metrics'][label + '_source_dirty_bytes'] = source_after['dirty_bytes']
        self.save(label + '-source-heartbeat.json', {'before': baseline, 'after': source_after})
        self.save(label + '-children.json', values)
        if boundary:
            self.release_source(source)
            self.save(label + '-source-resumed.json', self.call(source, 'resume_writes'))
        return children

    def cleanup(self):
        for name in reversed(self.names):
            try:
                row = self.records().get(name)
                if row:
                    require(not any(r.get('golden') == name for r in self.records().values()), 'dependent children remain')
                    if row.get('pid'):
                        self.observe(name)
                    self.capture_logs(name)
                    result = self.cli('machine', 'delete', '--name', name, '--force', check=False, timeout=90)
                    require(result.returncode == 0, 'VM delete failed')
                directory = self.directory(name)
                # Upstream can leave a name-only orphan. Remove only this exact identity,
                # after proving both its DB record and recorded process are gone.
                old = self.identities.get(name)
                if old and Path('/proc', str(old['pid'])).exists():
                    try:
                        self.observe(name)
                    except (KeyError, FileNotFoundError, ProcessLookupError):
                        fields = Path('/proc', str(old['pid']), 'stat').read_text().rsplit(')', 1)[1].split()
                        require(fields[0] == 'Z' or fields[19] != old['start_time'], 'owned VMM still alive after delete')
                require(name not in self.records(), 'record remains after delete')
                if directory.exists():
                    surviving = subprocess.run(['sudo', '-n', '--', 'python3', str(self.root / 'smolvm.py'),
                        '--root', str(self.root), '--inventory'], capture_output=True, text=True, check=True, timeout=15)
                    require(not any(Path(v['argv'][2]).parent == directory for v in json.loads(surviving.stdout)),
                            'VMM or snapshot guardian still owns orphan directory')
                    require(directory.resolve() == directory and not directory.is_symlink()
                            and directory.stat().st_uid == 1000 and (directory / 'name').read_text().strip() == name,
                            'foreign orphan directory')
                    shutil.rmtree(directory)
                self.report['cleanup'].append({'name': name, 'status': 'clean'})
            except Exception as error:
                self.report['cleanup'].append({'name': name, 'status': 'failed', 'error': str(error)})
        require(all(row['status'] == 'clean' for row in self.report['cleanup']), 'cleanup incomplete')
        remaining = subprocess.run(['sudo', '-n', '--', 'python3', str(self.root / 'smolvm.py'),
            '--root', str(self.root), '--inventory'], capture_output=True, text=True, check=True, timeout=15)
        self.report['remaining_processes'] = json.loads(remaining.stdout)
        require(not self.report['remaining_processes'], 'owned VMM/guardian remains')

    def capture_logs(self, name):
        directory = self.directory(name)
        for path in directory.rglob('*.log') if directory.exists() else ():
            if path.is_file() and not path.is_symlink() and path.stat().st_size < 16 * 1024 * 1024:
                target = self.output / ('vmm-' + name + '-' + '-'.join(path.relative_to(directory).parts))
                shutil.copyfile(path, target)

    def run(self, preflight=None):
        self.report['variant'] = self.args.profile
        self.report['case'] = {'live-first': 'fresh', 'live-second': 'fresh',
                               'batch-1': 'fanout1', 'batch-4': 'fanout4'}.get(self.args.case, self.args.case)
        try:
            if preflight is not None:
                preflight()
            require(not self.records(), 'fresh private DB is not empty')
            self.report['resources_before'] = resources()
            allocated = self.report['resources_before']['allocated_disk_bytes']
            require(allocated < 76 * 1024 ** 3, 'insufficient room within 96 GiB private disk ceiling')
            self.report['allocated_disk_before_bytes'] = allocated
            inputs = [BINARY, self.root / 'image/opt/latency/latency-guest', self.root / 'smolvm.py',
                      self.root / 'agent-rootfs/usr/local/bin/smolvm-agent']
            inputs += sorted(path for path in (STAGE / 'source/lib/linux-x86_64').iterdir() if path.is_file())
            self.report['inputs'] = {str(path): digest(path) for path in inputs}
            self.report['rootfs_sha256'] = '0a64e8ef15c93ff146f10729750955a4b4a1938293260cbf983d99b5466c99ed'
            source = self.create()
            baseline = self.start(source, 'cold')
            require(baseline['branch'] == 0 and baseline['disk_branch'] == 0, 'cold image contains prior workload state')
            self.save('source-baseline.json', baseline)
            backing = self.guest(source, '/bin/sh', '-c',
                'stat -f -c "%T %s" ' + WORKSPACE + '; cat /proc/self/mountinfo').stdout
            self.save('workspace-backing.json', {'path': WORKSPACE, 'statfs_and_mountinfo': backing})
            require(backing.splitlines()[0].split()[0] not in ('tmpfs', 'ramfs'), 'workspace is not on VM disk')
            network = self.guest(source, '/bin/sh', '-c',
                'for p in /sys/class/net/*; do basename "$p"; done; cat /proc/net/route').stdout
            self.save('network.json', {'interfaces_and_routes': network})
            interfaces = network.split('Iface', 1)[0].split()
            require(all(name == 'lo' or name.startswith('dummy') for name in interfaces),
                    'unexpected external guest interface')
            if self.args.case == 'warm':
                self.call(source, 'mutate', branch=91)
                self.observe(source)
                self.cli('machine', 'stop', '--name', source, phase='warm_stop')
                self.identities.pop(source)
                warm = self.start(source, 'warm')
                require(warm['ram_marker'] != baseline['ram_marker'] and warm['disk_branch'] == 91,
                        'warm start must renew RAM identity and retain disk branch')
            elif self.args.case.startswith('live') or self.args.case.startswith('batch'):
                if self.args.case == 'live-second':
                    self.branch(source, 'first', 1, False)
                count = 4 if self.args.case == 'batch-4' else 1
                self.branch(source, 'second' if self.args.case == 'live-second' else 'first', count,
                            self.args.case.startswith('batch'))
                live = {name: self.observe(name) for name in self.names}
                require(len({v['pid'] for v in live.values()}) == len(live), 'VMM processes are not distinct')
                rss_bytes = sum(int(re.search(r'^Rss:\s+(\d+)', v['smaps_rollup'], re.M).group(1)) * 1024
                                for v in live.values())
                require(rss_bytes <= 32 * 1024 ** 3, 'runtime RSS exceeds 32 GiB reservation')
                self.report['metrics']['live_vmm_rss_sum_bytes'] = rss_bytes
                self.save('live-processes.json', live)
                self.save('live-records.json', self.records())
                for index, name in enumerate(self.names, 1):
                    self.call(name, 'mutate', branch=index)
                after = {name: self.call(name) for name in self.names}
                require(all(after[name]['branch'] == i and after[name]['disk_branch'] == i
                            for i, name in enumerate(self.names, 1)), 'sibling RAM/disk isolation failed')
                self.save('isolation.json', after)
            self.report['status'] = 'pass'
        except Exception as error:
            self.report['error'] = f'{type(error).__name__}: {error}'
        finally:
            self.record_resources('resources_live')
            try:
                self.cleanup()
            except Exception as error:
                self.report['cleanup_error'] = str(error)
                self.report['status'] = 'fail'
            self.record_resources('resources_after')
            self.save('report.json', self.report)
            with (self.root / 'samples.jsonl').open('a') as samples:
                samples.write(json.dumps(self.report) + '\n')
            self.commands.close()
        print(json.dumps({'report': str(self.output / 'report.json'), 'status': self.report['status']}), flush=True)
        return 0 if self.report['status'] == 'pass' else 1

    def record_resources(self, phase):
        try:
            observed = resources()
            self.report[phase] = observed
            require(observed['allocated_disk_bytes'] <= 96 * 1024 ** 3,
                    '96 GiB allocated disk ceiling exceeded')
        except Exception as error:
            self.report['status'] = 'fail'
            self.report[phase + '_error'] = f'{type(error).__name__}: {error}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--observe', type=int)
    parser.add_argument('--inventory', action='store_true')
    parser.add_argument('--prepare-cgroup', action='store_true')
    parser.add_argument('--close-cgroup', action='store_true')
    parser.add_argument('--join-cgroup', type=int)
    parser.add_argument('--expected-start')
    parser.add_argument('--host-slot')
    parser.add_argument('--profile', choices=PROFILES)
    parser.add_argument('--case', choices=CASES)
    parser.add_argument('--trial', type=int)
    args = parser.parse_args()
    validate_root(args.root)
    if args.observe is not None:
        print(json.dumps(inspect_pid(args.observe, args.expected_start)))
        return 0
    if args.inventory:
        print(json.dumps(inventory()))
        return 0
    if args.prepare_cgroup:
        print(json.dumps(prepare_cgroup()))
        return 0
    if args.close_cgroup:
        print(json.dumps(close_cgroup()))
        return 0
    if args.join_cgroup is not None:
        print(json.dumps(join_cgroup(args.join_cgroup, args.expected_start)))
        return 0
    require(GRANT != 'UNGRANTED' and args.host_slot == GRANT, 'coordinator grant required')
    require(os.geteuid() == 1000 and os.access('/dev/kvm', os.R_OK | os.W_OK), 'clanker:kvm execution required')
    require(args.profile and args.case and args.trial is not None and 0 <= args.trial <= 99999, 'trial arguments required')
    require(os.sched_getaffinity(0) == set(range(4, 12)), 'runner must inherit exact CPU affinity 4-11')
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    authorization = json.loads((ROOT.parent / 'authorization.json').read_text())
    require(authorization.get('timing_authorized') is True, 'coordinator timing gate is closed')
    with (ROOT.parent / 'measure.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        def preflight():
            birth = Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19]
            subprocess.run(['sudo', '-n', '--', 'python3', str(ROOT / 'smolvm.py'), '--root', str(ROOT),
                            '--join-cgroup', str(os.getpid()), '--expected-start', birth], check=True,
                           capture_output=True, text=True, timeout=15)
            validate_cgroup()
            require(Path('/proc/self/cgroup').read_text().strip() == '0::/smlat20260905.slice', 'runner did not join exact cgroup')
        return Runner(args).run(preflight=preflight)


if __name__ == '__main__':
    raise SystemExit(main())
