#!/usr/bin/env python3
"""Process-independent portable recovery spike; scope and execution gate fail closed."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import socket
import sqlite3
import struct
import subprocess
import time
import zlib
import profile_inputs

ROOT = Path('/home/clanker/clankerbox-recovery.AsnzhP/smolvm')
COMMON = ROOT.parent
CGROUP = Path('/sys/fs/cgroup/smrec20260906.slice')
SCRIPT = ROOT / 'run.py'
BINARY = ROOT / 'runtime/bin/smolvm'
GRANT = 'recovery-20260906'
GUEST = '/opt/recovery/latency-guest'
PROBE = '/opt/recovery/disk_probe.py'
SOCKET = '/tmp/clanker-recovery.sock'
LIMITS = {'memory.max': str(32 * 1024**3), 'memory.swap.max': '0',
          'pids.max': '2048', 'cpuset.cpus': '4-11', 'cpu.max': 'max 100000'}


class IntegrityError(Exception):
    """A received workload status is corrupt, not merely not-ready."""


def interrupted_signal(signum, frame):
    raise RuntimeError(f'runner interrupted by signal {signum}')


def need(value, message):
    if not value:
        raise RuntimeError(message)


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def persisted_launch_config(transient):
    return json.loads(Path(transient).with_name('agent.config.json').read_text())


def validate_network(value):
    need(set(value['interfaces']) <= {'lo', 'dummy0'} and 'lo' in value['interfaces'],
         'unexpected guest interface')
    for link in value['addresses']:
        if link['ifname'] != 'lo':
            need(link['ifname'] == 'dummy0' and link.get('linkinfo', {}).get('info_kind') == 'dummy'
                 and not link.get('addr_info'), 'non-loopback device is not an unaddressed dummy')
    need(len(value['route'].strip().splitlines()) <= 1, 'unexpected IPv4 guest route')
    need(all(line.split()[-1] == 'lo' for line in value['ipv6_route'].splitlines() if line.strip()),
         'unexpected non-loopback IPv6 route')


def scope(path):
    path = Path(path)
    need(path.is_absolute() and path.is_relative_to(ROOT) and path != ROOT,
         'path outside exact private subtree')
    need(path.resolve() == path and not path.is_symlink(), 'redirected owned path')
    return path


def authorize(execution=True):
    need(ROOT.resolve() == ROOT and ROOT.stat().st_uid == 1000, 'private root owner/path changed')
    auth = json.loads((COMMON / 'authorization.json').read_text())
    need(auth['grant'] == GRANT and auth['smolvm_root'] == str(ROOT)
         and auth['smolvm_cgroup'] == str(CGROUP)
         and auth['lock_path'] == str(COMMON / 'execute.lock'), 'scope authorization mismatch')
    if execution:
        need(auth['execution_authorized_runtime'] == 'smolvm', 'execution slot is closed')
    need(auth['max_live_vms'] == 5 and auth['guest_memory_mib'] == 2048
         and auth['guest_vcpus'] == 2 and auth['external_guest_network'] is False,
         'resource/network contract changed')
    return auth


def birth(pid):
    fields = Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()
    return fields[19], fields[0]


def inspect(pid, expected=None):
    need(type(pid) is int and pid > 1, 'invalid PID')
    proc = Path('/proc', str(pid))
    need((proc / 'exe').resolve(strict=True) == BINARY.resolve(strict=True), 'foreign executable')
    argv = [os.fsdecode(v) for v in (proc / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')]
    need(len(argv) == 3 and argv[1] == '_boot-vm', 'not an owned VMM/guardian')
    config = scope(argv[2])
    need(config.name == 'boot-config.json' and '/c/smolvm/vms/' in str(config), 'foreign VM config')
    start, state = birth(pid)
    need(state != 'Z' and (expected is None or start == str(expected)), 'dead/reused PID')
    uids = next(v.split()[1:] for v in (proc / 'status').read_text().splitlines() if v.startswith('Uid:'))
    need(uids == ['1000'] * 4, 'foreign UID')
    need((proc / 'cgroup').read_text().strip() == '0::/' + CGROUP.name, 'foreign cgroup')
    return {'pid': pid, 'start_ticks': start, 'owned': True, 'argv': argv,
            'executable': str(BINARY), 'cgroup': str(CGROUP)}


def inventory():
    result = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            if (proc / 'exe').resolve(strict=True) != BINARY.resolve(strict=True):
                continue
            argv = (proc / 'cmdline').read_bytes().split(b'\0')
            if len(argv) > 1 and argv[1] == b'_boot-vm':
                result.append(inspect(int(proc.name)))
        except (FileNotFoundError, ProcessLookupError):
            pass
    return result


def inspect_controller(pid, expected):
    proc = Path('/proc', str(pid))
    need((proc / 'exe').resolve(strict=True) == BINARY.resolve(strict=True), 'foreign controller executable')
    argv = [os.fsdecode(v) for v in (proc / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')]
    need(len(argv) == 9 and argv[1:3] == ['machine', 'checkpoint'] and argv[3] == '--name'
         and argv[5] == '--output' and argv[7] == '--staging-dir', 'foreign controller arguments')
    output, staging = scope(argv[6]), scope(argv[8])
    need(output.name == 'interrupted.smolcheckpoint' and staging.name == 'interrupt-stage',
         'controller not the bounded interruption case')
    start, state = birth(pid)
    need(start == str(expected) and state != 'Z', 'controller PID reused/dead')
    uids = next(v.split()[1:] for v in (proc / 'status').read_text().splitlines() if v.startswith('Uid:'))
    need(uids == ['1000'] * 4 and (proc / 'cgroup').read_text().strip() == '0::/' + CGROUP.name,
         'foreign controller UID/cgroup')
    return {'pid': pid, 'start_ticks': start, 'owned': True, 'argv': argv, 'cgroup': str(CGROUP)}


def terminate(pid, expected, controller=False):
    authorize()
    inspector = inspect_controller if controller else inspect
    before = inspector(pid, expected)
    fd = os.pidfd_open(pid)
    try:
        inspector(pid, expected)
        signal.pidfd_send_signal(fd, signal.SIGKILL)
    finally:
        os.close(fd)
    deadline = time.monotonic() + 15
    while True:
        try:
            start, state = birth(pid)
            if start != str(expected) or state == 'Z':
                break
        except FileNotFoundError:
            break
        need(time.monotonic() < deadline, 'verified process did not exit')
        time.sleep(.05)
    return {'identity': before, 'signal': 'SIGKILL', 'pidfd': True, 'absent_or_zombie': True,
            'end_ns': time.monotonic_ns()}


def cgroup_check():
    marker = ROOT / 'cgroup-owned.json'
    need(marker.stat().st_uid == 0 and not marker.is_symlink(), 'missing root-owned cgroup marker')
    data = json.loads(marker.read_text())
    need(CGROUP.resolve() == CGROUP and data['inode'] == CGROUP.stat().st_ino
         and data['device'] == CGROUP.stat().st_dev and data['path'] == str(CGROUP), 'cgroup identity changed')
    for name, value in LIMITS.items():
        need((CGROUP / name).read_text().strip() == value, 'cgroup limit changed: ' + name)


def privileged(args):
    need(os.geteuid() == 0, 'observer/cgroup/signal helper needs root')
    authorize()
    if args.helper == 'prepare-cgroup':
        need(not CGROUP.exists(), 'new cgroup already exists; do not adopt')
        CGROUP.mkdir()
        for name, value in LIMITS.items():
            need((CGROUP / name).is_file(), 'host parent has not delegated required controller')
            (CGROUP / name).write_text(value + '\n')
        marker = ROOT / 'cgroup-owned.json'
        marker.write_text(json.dumps({'path': str(CGROUP), 'inode': CGROUP.stat().st_ino,
                                      'device': CGROUP.stat().st_dev}) + '\n')
        marker.chmod(0o644)
    cgroup_check()
    if args.helper == 'join':
        start, state = birth(args.pid)
        proc = Path('/proc', str(args.pid))
        argv = [os.fsdecode(v) for v in (proc / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')]
        need(start == args.birth and state != 'Z' and proc.stat().st_uid == 1000,
             'runner PID identity changed')
        need(len(argv) > 2 and argv[1] == str(SCRIPT) and '--grant' in argv
             and argv[argv.index('--grant') + 1] == GRANT, 'foreign runner')
        (CGROUP / 'cgroup.procs').write_text(str(args.pid) + '\n')
        return {'joined': args.pid}
    if args.helper == 'observe':
        return inspect(args.pid, args.birth)
    if args.helper == 'inventory':
        return inventory()
    if args.helper == 'kill':
        return terminate(args.pid, args.birth)
    if args.helper == 'kill-controller':
        return terminate(args.pid, args.birth, controller=True)
    if args.helper == 'close-cgroup':
        need(not (CGROUP / 'cgroup.procs').read_text().strip() and not inventory(), 'owned processes remain')
        CGROUP.rmdir()
        return {'closed': str(CGROUP)}
    return {'prepared': str(CGROUP)}


def make_bad(source, output, kind):
    """Controlled negative inputs; compatibility mutation has a VALID CRC32."""
    shutil.copyfile(source, output)
    with output.open('r+b') as stream:
        size = stream.seek(0, 2)
        need(size >= 64, 'artifact missing footer')
        stream.seek(-64, 2)
        footer = bytearray(stream.read(64))
        need(footer[:8] == b'SMOLPACK', 'unexpected artifact footer')
        if kind == 'truncated':
            stream.truncate(size - 37)
        elif kind == 'corrupt':
            stream.seek(0)
            byte = stream.read(1)
            stream.seek(0)
            stream.write(bytes([byte[0] ^ 0x80]))
        elif kind == 'incompatible':
            offset, length = struct.unpack_from('<QQ', footer, 36)
            stream.seek(offset)
            manifest = stream.read(length)
            decoded = json.loads(manifest)
            need(decoded['checkpoint']['runtime_abi'] == 'libkrun-portable-snapshot-v1', 'unexpected ABI')
            changed = manifest.replace(b'libkrun-portable-snapshot-v1', b'libkrun-portable-snapshot-v9')
            need(changed != manifest and len(changed) == length, 'ABI mutation failed')
            stream.seek(offset)
            stream.write(changed)
            stream.flush()
            stream.seek(0)
            checksum, remain = 0, size - 64
            while remain:
                data = stream.read(min(remain, 1024 * 1024))
                need(data, 'short checksum read')
                checksum = zlib.crc32(data, checksum)
                remain -= len(data)
            struct.pack_into('<I', footer, 52, checksum)
            stream.seek(-64, 2)
            stream.write(footer)
        else:
            raise ValueError(kind)
        stream.flush()
        os.fsync(stream.fileno())
    return {'kind': kind, 'path': str(output), 'sha256': sha(output), 'size_bytes': output.stat().st_size}


class Runner:
    def __init__(self, label, profile='host-image'):
        need(re.fullmatch(r'[a-z0-9][a-z0-9-]{0,30}', label), 'invalid run label')
        self.label = label
        self.profile = profile
        # Linux sockaddr_un is 108 bytes including NUL. Human-readable nested
        # labels would make control.sock exceed that limit on this exact root.
        self.work = scope(ROOT / 'x' / hashlib.sha256(label.encode()).hexdigest()[:6])
        self.work.mkdir(parents=True, exist_ok=False)
        self.output = scope(ROOT / 'results' / label)
        self.output.mkdir(parents=True, exist_ok=False)
        self.artifacts = scope(ROOT / 'artifacts' / label)
        self.artifacts.mkdir(parents=True, exist_ok=False)
        self.journal = (self.output / 'commands.jsonl').open('a')
        self.spaces = {}
        self.report = {'schema_version': 1, 'runtime': 'smolvm', 'status': 'fail',
                       'label': label, 'cleanup': [], 'stages': {}}

    def save(self, name, value):
        (self.output / name).write_text(json.dumps(value, indent=2) + '\n')

    def command(self, argv, env=None, timeout=180, check=True):
        start = time.monotonic_ns()
        record = {'argv': [str(v) for v in argv], 'start_ns': start}
        try:
            result = subprocess.run(argv, env=env, text=True, capture_output=True, timeout=timeout)
            record.update(returncode=result.returncode, stdout=result.stdout, stderr=result.stderr)
        except Exception as error:
            record.update(error=repr(error), returncode=None)
            raise
        finally:
            record['end_ns'] = time.monotonic_ns()
            self.journal.write(json.dumps(record) + '\n')
            self.journal.flush()
        if check:
            result.check_returncode()
        return result

    def helper(self, action, identity=None):
        argv = ['sudo', '-n', '--', 'python3', str(SCRIPT), '--helper', action]
        if identity:
            argv += ['--pid', str(identity['pid']), '--birth', str(identity['start_ticks'])]
        return json.loads(self.command(argv, timeout=30).stdout)

    def resources(self):
        data = {'at_ns': time.monotonic_ns(), 'cgroup': {name: (CGROUP / name).read_text() for name in
            ('memory.current', 'memory.peak', 'memory.events', 'pids.current', 'cpu.stat',
             'cpu.pressure', 'io.stat', 'memory.pressure', 'io.pressure')}}
        data['allocated_disk_bytes'] = int(self.command(['sudo', '-n', '--', 'du', '-s', '-B1', str(COMMON)]).stdout.split()[0])
        need(data['allocated_disk_bytes'] < 128 * 1024**3, 'whole-root disk limit exceeded')
        return data

    def space(self, key):
        path = scope(self.work / f's{len(self.spaces)}')
        need(len(os.fsencode(path / 'c/smolvm/vms' / ('0' * 16) / 'control.sock')) < 108,
             'owned Unix socket path would exceed sockaddr_un')
        path.mkdir()
        (path / 'owned.json').write_text(json.dumps({'label': self.label, 'space': key}) + '\n')
        for name in ('d', 'c', 'config', 'r', 'empty-docker'):
            (path / name).mkdir(mode=0o700)
        template = (ROOT / 'profiles/ubuntu-bare/agent-rootfs' if self.profile == 'ubuntu-bare'
                    else ROOT / 'runtime/agent-rootfs')
        shutil.copytree(template, path / 'agent-rootfs', symlinks=True)
        env = {k: os.environ[k] for k in ('PATH', 'HOME', 'USER', 'LANG') if k in os.environ}
        env.update(XDG_DATA_HOME=str(path / 'd'), XDG_CACHE_HOME=str(path / 'c'),
                   XDG_CONFIG_HOME=str(path / 'config'), XDG_RUNTIME_DIR=str(path / 'r'),
                   DOCKER_CONFIG=str(path / 'empty-docker'), SMOLVM_LIB_DIR=str(ROOT / 'runtime/lib'),
                   LD_LIBRARY_PATH=str(ROOT / 'runtime/lib'), SMOLVM_AGENT_ROOTFS=str(path / 'agent-rootfs'),
                   RUST_LOG='smolvm=debug', NO_COLOR='1')
        self.spaces[key] = {'path': path, 'env': env, 'names': []}
        return key

    def cli(self, space, *argv, **kw):
        return self.command([str(BINARY), *argv], env=self.spaces[space]['env'], **kw)

    def records(self, key):
        dbpath = self.spaces[key]['path'] / 'd/smolvm/server/smolvm.db'
        if not dbpath.exists():
            return {}
        with sqlite3.connect(f'file:{dbpath}?mode=ro', uri=True) as db:
            return {name: json.loads(data) for name, data in db.execute('SELECT name,data FROM vms')}

    def guest(self, key, name, *argv, **kw):
        need(name in self.records(key), 'refusing exec on missing VM')
        return self.cli(key, 'machine', 'exec', '--name', name, '--', *argv, **kw)

    def ram(self, key, name, op='status', **fields):
        result = self.guest(key, name, GUEST, 'call', '--socket', SOCKET,
                            json.dumps({'op': op, **fields}), timeout=25, check=False)
        value = json.loads(result.stdout)
        if any(value.get(k) is False for k in ('memory_ok', 'disk_ok')):
            raise IntegrityError('guest integrity failure, including nonzero-exit reply: ' + json.dumps(value))
        result.check_returncode()
        if not all(value.get(k) is True for k in ('ok', 'ready', 'memory_ok', 'disk_ok')):
            raise IntegrityError('guest RAM proof failed: ' + json.dumps(value))
        return value

    def disk(self, key, name, operation, phase, counter, prior=None):
        argv = ['python3', PROBE, operation, '--namespace', self.label, '--phase', phase, '--counter', str(counter)]
        if prior:
            argv += ['--expect-phase', prior[0], '--expect-counter', str(prior[1])]
        value = json.loads(self.guest(key, name, *argv).stdout)
        need(value['ok'] and value['method'] == 'O_DIRECT+mmap+readv', 'direct disk proof failed')
        return value

    def observe(self, key, name):
        self.config_policy(key, name)
        pid = self.records(key)[name].get('pid')
        need(type(pid) is int, 'missing VMM PID')
        identity = self.helper('observe', {'pid': pid, 'start_ticks': birth(pid)[0]})
        # _boot-vm unlinks its transient config after parsing (upstream
        # internal_boot.rs). Its persisted launch configuration keeps actual
        # resources/mounts/ports; the VM DB separately records all forwarding.
        boot = persisted_launch_config(identity['argv'][2])
        resources = boot['resources']
        need(resources['network'] is False and resources['cpus'] == 2 and resources['memory_mib'] == 2048,
             'live boot resource/network policy differs')
        for field in ('mounts', 'ports'):
            need(not boot.get(field), 'live boot enables ungranted field: ' + field)
        for field in ('gpu', 'cuda', 'rosetta'):
            need(resources.get(field) is False, 'live resources enable ungranted device: ' + field)
        self.save('boot-policy-' + key + '-' + name + '.json', boot)
        return identity

    def config_policy(self, key, name):
        row = self.records(key)[name]
        need(row['network'] is False and row['cpus'] == 2 and row['mem'] == 2048,
             'VM record resource/network policy differs')
        for field in ('mounts', 'staged_mounts', 'ports', 'published_sockets', 'remote_volumes',
                      'secret_refs', 'ssh_agent', 'docker_socket', 'cuda', 'gpu', 'network_name'):
            need(not row.get(field), 'VM record enables ungranted field: ' + field)
        if self.profile == 'ubuntu-bare':
            need(not row.get('image') and not row.get('source_smolmachine'),
                 'bare profile unexpectedly acquired host-backed image state')
        self.save('record-policy-' + key + '-' + name + '.json', row)

    def network_proof(self, key, name):
        script = ('import json,pathlib,subprocess; p=pathlib.Path; '
                  'print(json.dumps({"interfaces": sorted(x.name for x in p("/sys/class/net").iterdir()), '
                  '"addresses": json.loads(subprocess.check_output(["ip","-j","-d","address"])), '
                  '"route": p("/proc/net/route").read_text(), '
                  '"ipv6_route": p("/proc/net/ipv6_route").read_text()}))')
        value = json.loads(self.guest(key, name, 'python3', '-c', script).stdout)
        self.save('guest-network-' + key + '-' + name + '.json', value)
        validate_network(value)
        return value

    def ready(self, key, name):
        deadline = time.monotonic() + 150
        while True:
            try:
                value = self.ram(key, name)
                self.observe(key, name)
                return value
            except (subprocess.CalledProcessError, ValueError) as error:
                need(time.monotonic() < deadline, 'workload ready deadline exceeded: ' + str(error))
                time.sleep(.1)

    def create(self, key, name):
        need(len(self.helper('inventory')) < 5, 'five VMM/guardian limit reached')
        self.spaces[key]['names'].append(name)
        image_args = []
        if self.profile == 'host-image':
            image = self.spaces[key]['path'] / 'image'
            shutil.copytree(ROOT / 'image', image, symlinks=True)
            image_args = ['--image', str(image)]
        serve = [GUEST, 'serve', '--memory-mib', '64', '--dirty-mib-s', '0', '--workspace-mib', '0',
                 '--workspace-files', '0', '--socket', SOCKET, '--workspace', '/var/tmp/clanker-recovery-ram', '--reuse-workspace']
        launch = 'rm -f -- ' + SOCKET + '; exec ' + shlex.join(serve)
        if self.profile == 'ubuntu-bare':
            # Native bare CMD is synchronous vm_exec, unlike image-mode
            # detached workload launch. A guest setsid child survives the
            # short startup command and is not relaunched on RAM restoration.
            launch = ('rm -f -- ' + SOCKET + '; exec /usr/bin/setsid --fork ' + shlex.join(serve)
                      + ' </dev/null >/var/tmp/clanker-recovery-serve.log 2>&1')
        self.cli(key, 'machine', 'create', '--name', name, *image_args,
                 '--cpus', '2', '--mem', '2048', '--storage', '4', '--overlay', '2', '--',
                 '/bin/sh', '-c', launch)
        self.config_policy(key, name)
        self.cli(key, 'machine', 'start', '--name', name, '--branchable')
        ready = self.ready(key, name)
        self.network_proof(key, name)
        return ready

    def restore(self, key, name, artifact):
        need(len(self.helper('inventory')) < 5, 'five VMM/guardian limit reached')
        self.spaces[key]['names'].append(name)
        self.cli(key, 'machine', 'create', '--name', name, '--from', str(artifact), timeout=600)
        self.config_policy(key, name)
        self.cli(key, 'machine', 'start', '--name', name, timeout=180)
        ready = self.ready(key, name)
        self.network_proof(key, name)
        return ready

    def checkpoint(self, key, name, output):
        stage = scope(self.work / ('staging-' + output.stem))
        self.cli(key, 'machine', 'checkpoint', '--name', name, '--output', str(output),
                 '--staging-dir', str(stage), timeout=600)
        need(output.is_file() and output.stat().st_size > 64, 'checkpoint artifact missing')
        return {'path': str(output), 'sha256': sha(output), 'size_bytes': output.stat().st_size}

    def kill_space(self, key):
        prefix = str(self.spaces[key]['path']) + '/'
        identities = [p for p in self.helper('inventory') if p['argv'][2].startswith(prefix)]
        kills = [self.helper('kill', identity) for identity in identities]
        remaining = [p for p in self.helper('inventory') if p['argv'][2].startswith(prefix)]
        need(not remaining, 'origin VMM/guardian remains')
        return {'identities': identities, 'terminations': kills, 'remaining': remaining}

    def portable(self):
        source = self.space('origin')
        self.create(source, 'source')
        capture_ram = self.ram(source, 'source', 'mutate', branch=11)
        capture_disk = self.disk(source, 'source', 'initialize', 'A', 0)
        evidence = {'schema_version': 1, 'runtime': 'smolvm',
                    'provenance': {'guest_sha256': sha(ROOT / 'image/opt/recovery/latency-guest'),
                                   'probe_sha256': sha(ROOT / 'image/opt/recovery/disk_probe.py')},
                    'capture': {'ram': capture_ram, 'disk': capture_disk, 'vmm': self.observe(source, 'source')},
                    'restored': [], 'artifact_copies': []}
        self.save('portable-evidence.json', evidence)
        artifact = self.artifacts / 'saved-A.smolcheckpoint'
        self.report['stages']['capture'] = self.checkpoint(source, 'source', artifact)
        evidence['source_after_capture'] = {'ram': self.ram(source, 'source', 'mutate', branch=22),
                                           'disk': self.disk(source, 'source', 'write', 'B', 1, ('A', 0))}
        self.save('portable-evidence.json', evidence)
        for number in (1, 2):
            dest = self.artifacts / f'independent-{number}.smolcheckpoint'
            shutil.copyfile(artifact, dest)
            with dest.open('rb') as stream:
                os.fsync(stream.fileno())
            evidence['artifact_copies'].append({'source_sha256': sha(artifact), 'copied_sha256': sha(dest),
                'size_bytes': artifact.stat().st_size, 'copied_size_bytes': dest.stat().st_size})
        origin_proof = self.kill_space(source)
        old = self.spaces[source]['path']
        hidden = scope(self.work / 'hidden-origin')
        old.rename(hidden)
        self.spaces[source]['path'] = hidden
        need(not old.exists(), 'origin paths still available')
        evidence['independent_restore'] = {'origin_processes_absent': True, 'source_paths_unavailable': True}
        original_artifact = artifact
        artifact = self.artifacts / 'hidden-original-A.smolcheckpoint'
        original_artifact.rename(artifact)
        need(not original_artifact.exists(), 'original artifact path remains available')
        self.save('origin-removal.json', {'processes': origin_proof, 'old_path': str(old), 'hidden_path': str(hidden),
            'old_path_exists': old.exists(), 'original_artifact': str(original_artifact),
            'hidden_artifact': str(artifact), 'original_artifact_exists': original_artifact.exists()})
        self.save('portable-evidence.json', evidence)
        for number in (1, 2):
            key, name = self.space(f'restore-{number}'), f'restored-{number}'
            initial = self.restore(key, name, self.artifacts / f'independent-{number}.smolcheckpoint')
            row = {'name': name, 'space': key, 'branch_counter': 100 + number, 'ram_initial': initial,
                   'disk_initial': self.disk(key, name, 'read', 'A', 0), 'vmm': self.observe(key, name)}
            time.sleep(.15)
            row['ram_later'] = self.ram(key, name)
            self.ram(key, name, 'mutate', branch=row['branch_counter'])
            self.disk(key, name, 'write', 'branch', row['branch_counter'], ('A', 0))
            evidence['restored'].append(row)
            self.save('portable-evidence.json', evidence)
        evidence['all_mutations_completed_ns'] = time.monotonic_ns()
        for row in evidence['restored']:
            row['ram_final'] = self.ram(row['space'], row['name'])
            row['disk_final'] = self.disk(row['space'], row['name'], 'read', 'branch', row['branch_counter'])
            row['final_observed_ns'] = time.monotonic_ns()
        self.save('portable-evidence.json', evidence)
        evaluator = COMMON / 'shared/evaluate.py'
        result = self.command(['python3', str(evaluator), str(self.output / 'portable-evidence.json')], check=False)
        need(result.returncode == 0, 'shared portable evaluator rejected evidence: ' + result.stdout + result.stderr)
        self.report['stages']['portable'] = {'status': 'pass', 'evaluation': result.stdout}
        return artifact

    def invalid(self, artifact):
        key = self.space('negative')
        results = []
        for kind in ('corrupt', 'truncated', 'incompatible'):
            bad = self.artifacts / (kind + '.smolcheckpoint')
            mutation = make_bad(artifact, bad, kind)
            before = self.helper('inventory')
            result = self.cli(key, 'machine', 'create', '--name', 'retry', '--from', str(bad), timeout=300, check=False)
            after = self.helper('inventory')
            need(result.returncode != 0 and not self.records(key), 'bad artifact accepted or left a reserved VM')
            need(before == after, 'bad artifact changed live VMM set')
            results.append({**mutation, 'returncode': result.returncode, 'stderr': result.stderr,
                            'records_after': self.records(key), 'vmm_set_unchanged': True})
        initial = self.restore(key, 'retry', artifact)
        self.disk(key, 'retry', 'read', 'A', 0)
        self.report['stages']['invalid'] = {'status': 'pass', 'attempts': results, 'good_retry_ram': initial}
        self.kill_space(key)

    def lineage(self):
        key, ancestor = 'restore-1', 'restored-1'
        child = 'restored-child'
        self.spaces[key]['names'].append(child)
        self.cli(key, 'machine', 'branch', '--from', ancestor, '--name', child, '--branchable', timeout=300)
        initial = self.ready(key, child)
        self.disk(key, child, 'read', 'branch', 101)
        ancestor_id = self.observe(key, ancestor)
        killed = self.helper('kill', ancestor_id)
        self.ram(key, child, 'mutate', branch=201)
        self.disk(key, child, 'write', 'branch', 201, ('branch', 101))
        artifact = self.artifacts / 'grandchild.smolcheckpoint'
        checkpoint = self.checkpoint(key, child, artifact)
        self.kill_space(key)
        restore_key = self.space('grandchild')
        restored = self.restore(restore_key, 'grandchild', artifact)
        disk = self.disk(restore_key, 'grandchild', 'read', 'branch', 201)
        for field in ('pid', 'start_monotonic_ns', 'ram_marker'):
            need(restored[field] == initial[field], 'grandchild RAM identity changed')
        need(restored['branch'] == 201, 'grandchild RAM state lost')
        self.report['stages']['lineage'] = {'status': 'pass', 'ancestor_kill': killed,
            'checkpoint': checkpoint, 'restored_ram': restored, 'restored_disk': disk,
            'limitation': 'Ancestor process removed before capture; ancestor disk paths retained until descendants ended.'}
        self.kill_space(restore_key)

    def cold_restart_restored(self):
        key, name = 'restore-2', 'restored-2'
        before = self.ram(key, name)
        old_vmm = self.observe(key, name)
        source_removal = json.loads((self.output / 'origin-removal.json').read_text())
        need(not Path(source_removal['old_path']).exists(), 'old source path reappeared')
        self.disk(key, name, 'read', 'branch', 102)
        # Native stop is a separate lifecycle test from the explicit pidfd
        # source-death injection. Observe the exact owned identity first.
        self.cli(key, 'machine', 'stop', '--name', name, timeout=90)
        try:
            current_start, state = birth(old_vmm['pid'])
            need(current_start != old_vmm['start_ticks'] or state == 'Z', 'native stop left original VMM live')
        except FileNotFoundError:
            pass
        self.config_policy(key, name)
        self.cli(key, 'machine', 'start', '--name', name, timeout=180)
        after = self.ready(key, name)
        need(after['ram_marker'] != before['ram_marker'] and after['start_monotonic_ns'] != before['start_monotonic_ns'],
             'restored cold restart did not create fresh RAM identity')
        need(after['branch'] == before['branch'] == 102 and after['disk_branch'] == 102,
             'restored cold restart lost retained workload branch')
        disk = self.disk(key, name, 'read', 'branch', 102)
        network = self.network_proof(key, name)
        need(not Path(source_removal['old_path']).exists(), 'cold restart recreated old source path')
        self.report['stages']['restored_cold_restart'] = {'status': 'pass', 'ram_before': before,
            'ram_after': after, 'old_vmm': old_vmm, 'new_vmm': self.observe(key, name),
            'disk_after': disk, 'guest_network': network, 'old_source_path_still_absent': True}

    def volatile(self):
        key = self.space('volatile')
        baseline = self.create(key, 'volatile-source')
        self.disk(key, 'volatile-source', 'initialize', 'A', 0)
        children = []
        for number in (1, 2):
            child = f'volatile-child-{number}'
            self.spaces[key]['names'].append(child)
            self.cli(key, 'machine', 'branch', '--from', 'volatile-source', '--name', child, timeout=300)
            initial = self.ready(key, child)
            for field in ('pid', 'start_monotonic_ns', 'ram_marker'):
                need(initial[field] == baseline[field], 'volatile child RAM identity lost')
            children.append(child)
        source_id = self.observe(key, 'volatile-source')
        source_last = self.ram(key, 'volatile-source', 'mutate', branch=399)
        source_disk_last = self.disk(key, 'volatile-source', 'write', 'B', 1, ('A', 0))
        killed = self.helper('kill', source_id)
        failed = self.cli(key, 'machine', 'branch', '--from', 'volatile-source', '--name', 'must-not-exist', timeout=60, check=False)
        fresh = {'returncode': failed.returncode, 'stderr': failed.stderr, 'classification': 'rejected-dead-source'}
        if failed.returncode == 0:
            self.spaces[key]['names'].append('must-not-exist')
            revived = self.ready(key, 'must-not-exist')
            same_ram = all(revived[field] == baseline[field] for field in ('pid', 'start_monotonic_ns', 'ram_marker'))
            fresh.update(ram=revived, vmm=self.observe(key, 'must-not-exist'), source_record=self.records(key).get('volatile-source'))
            fresh['classification'] = ('new-RAM-generation-cold-restart' if not same_ram else
                'same-RAM-identity-latest-state' if revived['branch'] == 399 else 'same-RAM-identity-older-generation')
        proofs = []
        for number, child in enumerate(children, 1):
            ram = self.ram(key, child, 'mutate', branch=300 + number)
            disk = self.disk(key, child, 'write', 'branch', 300 + number, ('A', 0))
            proofs.append({'child': child, 'ram': ram, 'disk': disk, 'vmm': self.observe(key, child)})
        mutation_barrier = time.monotonic_ns()
        for number, proof in enumerate(proofs, 1):
            child = proof['child']
            final = self.ram(key, child)
            for field in ('pid', 'start_monotonic_ns', 'ram_marker'):
                need(final[field] == baseline[field], 'volatile final RAM identity lost')
            need(final['branch'] == 300 + number and final['disk_branch'] == 300 + number,
                 'volatile sibling mutation leaked into final RAM/workspace')
            need(final['heartbeat']['samples'] > proof['ram']['heartbeat']['samples'],
                 'volatile child heartbeat did not advance after mutation barrier')
            proof.update(ram_final=final, disk_final=self.disk(key, child, 'read', 'branch', 300 + number),
                         final_observed_ns=time.monotonic_ns())
            need(proof['final_observed_ns'] > mutation_barrier, 'volatile final observation precedes mutation barrier')
        self.report['stages']['volatile'] = {'status': 'pass', 'source_kill': killed,
            'source_ram_before_kill': source_last, 'source_disk_before_kill': source_disk_last,
            'fresh_branch': fresh, 'all_mutations_completed_ns': mutation_barrier, 'surviving_children': proofs}

    def control(self, key, name, verb, timeout=30):
        need(verb in ('STATUS', 'RESUME'), 'ungranted manual control command')
        directory = self.spaces[key]['path'] / 'c/smolvm/vms' / hashlib.sha256(name.encode()).hexdigest()[:16]
        path = scope(directory / 'control.sock')
        self.observe(key, name)
        started = time.monotonic_ns()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stream:
            stream.settimeout(timeout)
            stream.connect(str(path))
            stream.sendall((verb + '\n').encode())
            result = b''
            while b'\n' not in result:
                data = stream.recv(4096)
                need(data, 'native control closed without reply')
                result += data
                need(len(result) < 65536, 'oversized native reply')
        record = {'control': str(path), 'verb': verb, 'reply': result.decode().strip(),
                  'start_ns': started, 'end_ns': time.monotonic_ns()}
        self.journal.write(json.dumps(record) + '\n')
        self.journal.flush()
        return record

    def interrupted(self):
        key, name = self.space('interrupted'), 'interrupt-source'
        initial = self.create(key, name)
        disk = self.disk(key, name, 'initialize', 'A', 0)
        output, stage = self.artifacts / 'interrupted.smolcheckpoint', self.work / 'interrupt-stage'
        argv = [str(BINARY), 'machine', 'checkpoint', '--name', name, '--output', str(output), '--staging-dir', str(stage)]
        record = {'argv': argv, 'start_ns': time.monotonic_ns(), 'injection': 'kill checkpoint CLI while native memory.bin.partial exists'}
        with (self.output / 'interrupted-controller.stdout').open('w') as stdout, \
             (self.output / 'interrupted-controller.stderr').open('w') as stderr:
            process = subprocess.Popen(argv, env=self.spaces[key]['env'], stdout=stdout, stderr=stderr)
            identity = {'pid': process.pid, 'start_ticks': birth(process.pid)[0]}
            try:
                deadline = time.monotonic() + 120
                observed = None
                while process.poll() is None and time.monotonic() < deadline:
                    matches = list(stage.rglob('memory.bin.partial')) if stage.exists() else []
                    if matches:
                        observed = {'path': str(matches[0]), 'size_bytes': matches[0].stat().st_size,
                                    'observed_ns': time.monotonic_ns()}
                        break
                    time.sleep(.005)
                need(observed is not None, 'could not inject during native SAVE; no interruption claim')
                record['observed_partial'] = observed
                record['controller_kill'] = self.helper('kill-controller', identity)
                process.wait(timeout=15)
                record['returncode'] = process.returncode
                record['status_after_controller_death'] = self.control(key, name, 'STATUS', timeout=120)
                # Observe native behavior before any reconciliation. A paused
                # reply is a native interruption-recovery limitation, not pass.
                record['native_automatic_resume'] = record['status_after_controller_death']['reply'] == 'OK running'
                if not record['native_automatic_resume']:
                    need(record['status_after_controller_death']['reply'] == 'OK paused', 'unexpected native run state')
                    record['explicit_reconciliation'] = self.control(key, name, 'RESUME')
                    need(record['explicit_reconciliation']['reply'] == 'OK running', 'explicit RESUME failed')
                resumed = self.ready(key, name)
                for field in ('pid', 'start_monotonic_ns', 'ram_marker'):
                    need(resumed[field] == initial[field], 'manual resume lost live RAM identity')
                record['disk_after_resume'] = self.disk(key, name, 'read', 'A', 0)
                record['ram_before'], record['ram_after'] = initial, resumed
                record['disk_before'] = disk
                record['published_output_exists'] = output.exists()
                need(not output.exists(), 'interrupted capture published a final artifact')
                retry = self.artifacts / 'after-interruption.smolcheckpoint'
                record['good_retry'] = self.checkpoint(key, name, retry)
                record['status'] = 'pass-with-explicit-reconciliation' if not record['native_automatic_resume'] else 'pass'
            finally:
                if process.poll() is None:
                    record['controller_cleanup'] = self.helper('kill-controller', identity)
                    process.wait(timeout=15)
                record['end_ns'] = time.monotonic_ns()
                self.save('interrupted-evidence.json', record)
                self.journal.write(json.dumps(record) + '\n')
                self.journal.flush()
        self.report['stages']['interrupted'] = record

    def cleanup(self):
        for key in reversed(list(self.spaces)):
            try:
                proof = self.kill_space(key)
                self.report['cleanup'].append({'space': key, 'status': 'pass', 'proof': proof})
            except Exception as error:
                self.report['cleanup'].append({'space': key, 'status': 'fail', 'error': repr(error)})
        need(not self.helper('inventory'), 'owned VMMs remain after cleanup')
        need(all(v['status'] == 'pass' for v in self.report['cleanup']), 'cleanup had failures')
        # Retain exact private XDG trees and logs for audit; no broad deletion.

    def run(self, case):
        signal.signal(signal.SIGTERM, interrupted_signal)
        try:
            authorize()
            need(not self.helper('inventory'), 'owned VMMs already running')
            self.helper('join', {'pid': os.getpid(), 'start_ticks': birth(os.getpid())[0]})
            os.sched_setaffinity(0, set(range(4, 12)))
            self.report['resources_before'] = self.resources()
            self.report['cgroup_identity'] = json.loads((ROOT / 'cgroup-owned.json').read_text())
            self.report['cgroup_peak_scope'] = 'cumulative across attempts using this same owned cgroup inode'
            self.report['build'] = json.loads((ROOT / 'build.json').read_text())
            self.report['profile'] = self.profile
            if self.profile == 'ubuntu-bare':
                self.report['profile_inputs'] = profile_inputs.verify()
            for relative, expected in self.report['build']['hashes'].items():
                need(sha(scope(ROOT / relative)) == expected, 'runtime input hash changed: ' + relative)
            need(sha(ROOT / 'image/opt/recovery/latency-guest') ==
                 'c0db3a0cab9c3f039d45b9098b1e57746d37ac7ac16467885c34e9fe9281701e', 'shared RAM binary changed')
            need(sha(ROOT / 'image/opt/recovery/disk_probe.py') == sha(COMMON / 'shared/disk_probe.py'),
                 'staged direct-read probe differs from shared source')
            self.report['library_hashes'] = {str(p): sha(p) for p in (ROOT / 'runtime/lib').iterdir() if p.is_file()}
            self.report['provenance'] = json.loads((ROOT / 'provenance.json').read_text())
            if case == 'interrupted':
                self.interrupted()
                artifact = None
            elif case == 'volatile-only':
                self.volatile()
                artifact = None
            else:
                artifact = self.portable()
            if case == 'all':
                self.invalid(artifact)
                self.lineage()
                self.cold_restart_restored()
                self.kill_space('restore-2')
                self.volatile()
            self.report['status'] = 'pass'
        except BaseException as error:
            self.report['error'] = repr(error)
            with (ROOT / 'failed-attempts.jsonl').open('a') as stream:
                stream.write(json.dumps({'label': self.label, 'at_ns': time.monotonic_ns(), 'error': repr(error)}) + '\n')
        finally:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            for phase, action in (('resources_live', self.resources), ('cleanup_result', self.cleanup),
                                  ('resources_after', self.resources)):
                try:
                    self.report[phase] = action()
                except Exception as error:
                    self.report[phase + '_error'] = repr(error)
                    self.report['status'] = 'fail'
            self.save('report.json', self.report)
            self.journal.close()
        print(json.dumps({'status': self.report['status'], 'report': str(self.output / 'report.json')}))
        return 0 if self.report['status'] == 'pass' else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--grant')
    parser.add_argument('--label')
    parser.add_argument('--case', choices=('portable', 'all', 'interrupted', 'volatile-only'), default='portable')
    parser.add_argument('--profile', choices=('host-image', 'ubuntu-bare'))
    parser.add_argument('--helper', choices=('prepare-cgroup', 'close-cgroup', 'join', 'observe', 'inventory', 'kill', 'kill-controller'))
    parser.add_argument('--pid', type=int)
    parser.add_argument('--birth')
    args = parser.parse_args()
    if args.helper:
        print(json.dumps(privileged(args)))
    else:
        need(args.grant == GRANT and args.label and args.profile, 'explicit grant, profile and unique label required')
        authorize()
        with (COMMON / 'execute.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            raise SystemExit(Runner(args.label, args.profile).run(args.case))
