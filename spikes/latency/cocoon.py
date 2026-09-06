#!/usr/bin/env python3
"""Private no-NIC Cocoon latency adapter. See COCOON_NOTES.md for boundaries."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import fcntl
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
import uuid

STAGE = Path('/home/clanker/clankerbox-cocoon.b0ngM6')
HASHES = {
    'bin/cocoon': 'db7ef5fbd609ac28f84f88042eb2ec75e107aea09d24cbbd824a5b049e92bebc',
    'bin/firecracker': '2fd0171309af7e24cf8dafc8a6f921c1434c49b5f9349bb996b7ed0a4deb8aa7',
    'guest-rootfs.tar': '0a64e8ef15c93ff146f10729750955a4b4a1938293260cbf983d99b5466c99ed',
}
VARIANTS = {'idle': (64, 0, 0), 'resident': (1024, 0, 0), 'dirty': (1024, 64, 0), 'workspace': (1024, 0, 2048)}
CASES = ('cold', 'warm', 'fresh', 'fanout1', 'fanout4')
POLL_SECONDS = .015


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def process_identity(pid):
    """PID reuse resistant identity; /proc comm may itself contain parentheses."""
    base = Path('/proc') / str(pid)
    stat = (base / 'stat').read_text()
    fields = stat[stat.rfind(')') + 2:].split()
    return {'pid': pid, 'starttime_ticks': int(fields[19]),
            'exe': str((base / 'exe').resolve()),
            'cmdline': (base / 'cmdline').read_bytes().decode(errors='replace').split('\0'),
            'cgroup': (base / 'cgroup').read_text(), 'stat': stat,
            'status': (base / 'status').read_text(), 'io': (base / 'io').read_text()}


def host_state():
    result = {'wall_ns': time.time_ns(), 'monotonic_ns': time.monotonic_ns()}
    for name in ('stat', 'meminfo', 'loadavg', 'pressure/cpu', 'pressure/memory', 'pressure/io'):
        path = Path('/proc') / name
        result[name] = path.read_text() if path.exists() else None
    return result


def networks():
    return {name: json.loads(subprocess.check_output(argv, text=True) or '[]') for name, argv in {
        'links': ['ip', '-j', 'link', 'show'], 'netns': ['ip', '-j', 'netns', 'list'],
        'routes': ['ip', '-j', '-4', 'route', 'show', 'table', 'all']}.items()}


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=.2)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class PauseObserver:
    """Observer only: never issues PATCH, PUT, or guest state mutations."""
    def __init__(self, path):
        self.path, self.samples = path, []
        self.stop = threading.Event()

    def poll(self):
        while not self.stop.is_set():
            start = time.monotonic_ns()
            connection = UnixHTTP(self.path)
            try:
                connection.request('GET', '/')
                response = connection.getresponse()
                body = response.read()
                self.samples.append({'start_ns': start, 'end_ns': time.monotonic_ns(),
                                     'http_status': response.status, 'body': json.loads(body)})
            except Exception as error:
                self.samples.append({'start_ns': start, 'end_ns': time.monotonic_ns(), 'error': repr(error)})
            finally:
                connection.close()
            self.stop.wait(.01)

    def __enter__(self):
        self.thread = threading.Thread(target=self.poll, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *unused):
        self.stop.set()
        self.thread.join(2)


def pause_bounds(samples):
    paused = [i for i, s in enumerate(samples) if s.get('body', {}).get('state') == 'Paused']
    if not paused:
        return {'observed': False, 'reason': 'No Paused sample; not evidence of zero pause.'}
    first, last = paused[0], paused[-1]
    lower = max(0, samples[last]['start_ns'] - samples[first]['end_ns'])
    upper = None
    if first > 0 and last + 1 < len(samples):
        if all(samples[i].get('body', {}).get('state') == 'Running' for i in (first-1, last+1)):
            upper = samples[last+1]['end_ns'] - samples[first-1]['start_ns']
    return {'observed': True, 'lower_ms': lower/1e6,
            'upper_ms': None if upper is None else upper/1e6, 'paused_samples': len(paused)}


class Experiment:
    def __init__(self, args):
        self.args = args
        self.root = Path(args.root)
        require(self.root.is_absolute() and self.root.resolve() == self.root, 'exact nonsymlink root required')
        self.manifest = json.loads((self.root.parent / 'authorization.json').read_text())
        require(self.manifest['grant'] == args.grant, 'coordinator execution grant mismatch')
        require(self.manifest['cocoon_root'] == str(self.root), 'root differs from coordinator exact grant')
        require(self.manifest['lock_path'] == args.lock, 'shared lock differs from coordinator grant')
        require(args.cpus == '4-11', 'authorized CPU pool is exactly 4-11')
        self.group = Path(self.manifest['cocoon_cgroup'])
        require(self.group.parent == Path('/sys/fs/cgroup') and self.group.name.endswith('.slice'), 'invalid cgroup')
        self.cli = [str(STAGE/'bin/cocoon'), '--config', str(self.root/'config.json')]
        self.env = dict(os.environ, PATH=str(self.root/'tools/usr/bin')+':'+str(STAGE/'bin')+':'+os.environ['PATH'],
                        LD_LIBRARY_PATH=str(self.root/'tools/usr/lib/x86_64-linux-gnu'), GOMAXPROCS='4', GOMEMLIMIT='512MiB')
        self.log_lock = threading.Lock()
        self.children, self.sources, self.snapshots = [], [], []
        self.capture_jobs = []
        self.trial = None

    def append(self, filename, row):
        with self.log_lock, (self.root/filename).open('a') as stream:
            stream.write(json.dumps(row, sort_keys=True)+'\n')

    def command(self, *args, timeout=600, allow_failure=False):
        # exec wrapper is safe when this method is called by four threads.
        wrapper = ('import os,sys,pathlib;pathlib.Path(sys.argv[1]).write_text(str(os.getpid()));'
                   'os.sched_setaffinity(0,range(4,12));os.execvpe(sys.argv[2],sys.argv[2:],os.environ)')
        row = {'trial': self.trial, 'argv': list(args), 'start_ns': time.monotonic_ns(), 'wall_start_ns': time.time_ns()}
        try:
            result = subprocess.run([sys.executable, '-c', wrapper, str(self.group/'control/cgroup.procs'),
                                     *self.cli, *args], capture_output=True, text=True, env=self.env, timeout=timeout)
            row.update(returncode=result.returncode, stdout=result.stdout, stderr=result.stderr)
        except BaseException as error:
            row['error'] = repr(error)
            raise
        finally:
            row.update(end_ns=time.monotonic_ns(), wall_end_ns=time.time_ns())
            self.append('commands.jsonl', row)
        require(allow_failure or result.returncode == 0, 'Cocoon command failed: '+repr(args)+': '+result.stderr)
        return result.stdout

    def guest(self, name, *args):
        return self.command('vm', 'exec', name, '--', *args, timeout=20)

    def status(self, name):
        return self.request(name, {'op':'status'})

    def request(self, name, request):
        result = json.loads(self.guest(name, '/usr/local/bin/latency-guest', 'call', json.dumps(request)))
        require(result.get('ok') and result.get('ready'), 'guest workload not ready: '+repr(result))
        require(result.get('memory_ok') and result.get('disk_ok'), 'guest RAM/disk verification failed')
        return result

    def wait(self, operation, timeout=90):
        deadline = time.monotonic()+timeout
        attempts = 0
        while True:
            attempts += 1
            try:
                return operation(), time.monotonic_ns(), attempts
            except (RuntimeError, json.JSONDecodeError, subprocess.TimeoutExpired):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(POLL_SECONDS)

    def inspect(self, name):
        vm = json.loads(self.command('vm', 'inspect', name))
        require(vm['config']['name'] == name and name in self.sources+self.children, 'unowned VM record')
        require(vm['config']['cpu'] == 2 and vm['config']['memory'] == 4*1024**3, 'VM resource budget differs')
        require(not vm.get('network_configs') and not vm.get('netns_path'), 'unexpected VM networking')
        require(all(Path(d['path']).resolve().is_relative_to(self.root) for d in vm['storage_configs']), 'disk escapes private root')
        if vm.get('pid') and Path('/proc', str(vm['pid'])).exists():
            identity = process_identity(vm['pid'])
            require(identity['exe'] == str(STAGE/'bin/firecracker'), 'VMM executable mismatch')
            require(vm['socket_path'] in identity['cmdline'], 'VMM socket/PID mismatch')
            require(Path(vm['socket_path']).resolve().is_relative_to(self.root/'r'), 'VMM socket outside run')
            require((self.group/('vm-'+vm['id']+'.scope')/'cgroup.procs').read_text().split() == [str(vm['pid'])], 'VMM cgroup mismatch')
            require(set(os.sched_getaffinity(vm['pid'])) <= set(range(4,12)), 'VMM outside CPU fence')
            vm['live_identity'] = identity
            scope=self.group/('vm-'+vm['id']+'.scope')
            vm['cgroup_controls'] = {key:(scope/key).read_text() for key in
                ('cpu.max','cpu.max.burst','cpu.stat','cpuset.cpus.effective','memory.max','memory.swap.max','pids.max') if (scope/key).exists()}
        return vm

    def resources(self):
        allocated = int(subprocess.check_output(['du', '-s', '-B1', str(self.root.parent)], text=True).split()[0])
        require(allocated <= 96*1024**3, 'combined benchmark disk allocation exceeds 96 GiB')
        result = {'disk_allocated_bytes': allocated, 'host': host_state()}
        for name in ('memory.current', 'memory.peak', 'memory.events', 'cpu.stat', 'io.stat', 'memory.pressure', 'cpu.pressure', 'io.pressure'):
            path = self.group/name
            result[name] = path.read_text() if path.exists() else None
        return result

    def guest_storage(self, name):
        code = ('import os,json,pathlib; p="/var/tmp/clanker-latency-workspace"; '
                'rows=[l.split() for l in pathlib.Path("/proc/self/mountinfo").read_text().splitlines()]; '
                'matches=[r for r in rows if p==r[4] or p.startswith(r[4].rstrip("/")+"/")]; '
                'r=max(matches,key=lambda r:len(r[4])); sep=r.index("-"); s=os.statvfs(p); '
                'print(json.dumps(dict(workspace=p,mountpoint=r[4],filesystem=r[sep+1],'
                'mountinfo=" ".join(r),block_size=s.f_frsize,blocks=s.f_blocks,'
                'interfaces=sorted(x.name for x in pathlib.Path("/sys/class/net").iterdir()))))')
        result = json.loads(self.guest(name,'python3','-c',code))
        require(result['filesystem'] not in ('tmpfs','ramfs'), 'workspace is on volatile RAM filesystem')
        require(result['interfaces'] == ['lo'], 'guest has unexpected network interfaces')
        return result

    def initialize_group(self):
        require(not self.group.exists(), 'refuse preexisting cgroup')
        require({'cpu','cpuset','memory','pids'} <= set(Path('/sys/fs/cgroup/cgroup.subtree_control').read_text().split()), 'required controllers unavailable; no global changes allowed')
        self.group.mkdir()
        self.group_inode = self.group.stat().st_ino
        (self.group/'memory.max').write_text(str(32*1024**3))
        (self.group/'memory.swap.max').write_text('0')
        (self.group/'pids.max').write_text('2048')
        (self.group/'cpu.max').write_text('max 100000')
        (self.group/'cpuset.cpus').write_text('4-11')
        (self.group/'cpuset.mems').write_text(Path('/sys/fs/cgroup/cpuset.mems.effective').read_text())
        (self.group/'cgroup.subtree_control').write_text('+cpu +cpuset +memory +pids')
        (self.group/'control').mkdir()

    def close_group(self):
        require(self.group.stat().st_ino == self.group_inode, 'cgroup ownership changed')
        for child in self.group.iterdir():
            if child.is_dir():
                deadline = time.monotonic()+10
                while (child/'cgroup.procs').read_text().strip():
                    require(time.monotonic() < deadline, 'owned cgroup still populated: '+str(child))
                    time.sleep(.05)
                child.rmdir()
        self.group.rmdir()

    def run_vm(self, name):
        self.sources.append(name)
        return self.command('vm','run','--fc','--name',name,'--cpu','2','--memory','4G','--storage','10G',
                            '--nics','0','--cpuset-cpus','4-11','--cpu-quota-us','800000','--cpu-burst-us=-1','cl-'+self.args.variant)

    def ready(self, name, start, command_end):
        # Both probes start after command return; report that observational limitation.
        with ThreadPoolExecutor(max_workers=2) as executor:
            true_future = executor.submit(self.wait, lambda: self.guest(name, 'true'))
            state_future = executor.submit(self.wait, lambda: self.status(name))
            _, true_end, true_attempts = true_future.result()
            state, status_end, status_attempts = state_future.result()
        return {'start_ns': start, 'command_end_ns': command_end, 'true_end_ns': true_end,
                'status_end_ns': status_end, 'command_ms': (command_end-start)/1e6,
                'true_ms': (true_end-start)/1e6, 'status_ms': (status_end-start)/1e6,
                'true_attempts': true_attempts, 'status_attempts': status_attempts, 'state': state}

    def capture(self, source, name, cooperative=False):
        vm = self.inspect(source)
        self.snapshots.append(name)
        self.request(source, {'op':'reset_metrics'})
        time.sleep(1)  # Fixed baseline; excluded from capture command and end-to-end clocks.
        baseline = self.status(source)
        prerequisite = {'start_ns':time.monotonic_ns(),'cooperative':cooperative}
        if cooperative:
            prerequisite['paused_state'] = self.request(source, {'op':'pause_writes'})
        before = self.request(source, {'op':'reset_metrics'})
        prerequisite['end_ns'] = time.monotonic_ns()
        observer = PauseObserver(vm['socket_path'])
        observer.__enter__()
        try:
            start = time.monotonic_ns()
            self.command('snapshot','save','--name',name,source)
            end = time.monotonic_ns()
        except BaseException:
            observer.__exit__()
            raise
        observer.stop.set()
        result = {'start_ns': start, 'end_ns': end, 'command_ms': (end-start)/1e6,
                  'baseline':baseline,'prerequisite':prerequisite,'before':before}
        def post_capture():
            try:
                # This probe is submitted immediately and overlaps clone/readiness.
                result['capture_only_probe_start_ns'] = time.monotonic_ns()
                result['capture_only_after'] = self.status(source)
                result['capture_only_probe_end_ns'] = time.monotonic_ns()
            except BaseException as error:
                result['capture_probe_error'] = repr(error)
            finally:
                observer.__exit__()
                result['fc_state_samples'] = observer.samples
                result['observed_pause'] = pause_bounds(observer.samples)
        worker = threading.Thread(target=post_capture,name='capture-probe')
        self.capture_jobs.append((worker,result))
        worker.start()
        return result

    def finish_captures(self, raise_errors=True):
        errors = []
        while self.capture_jobs:
            worker,result = self.capture_jobs.pop(0)
            worker.join()  # Bound by the guest command's 20-second timeout.
            if result.get('capture_probe_error'):
                errors.append(result['capture_probe_error'])
        if raise_errors:
            require(not errors, 'post-capture probe failed: '+repr(errors))
        return errors

    def clone(self, snapshot, name):
        with self.log_lock:
            self.children.append(name)
        start = time.monotonic_ns()
        # Firecracker inherits the validated zero-NIC snapshot; the CLI only
        # accepts --nics overrides for Cloud Hypervisor, even when unchanged.
        self.command('vm','clone','--name',name,'--cpuset-cpus','4-11',
                     '--cpu-quota-us','800000','--cpu-burst-us=-1',snapshot)
        command_end = time.monotonic_ns()
        result = self.ready(name, start, command_end)
        result['name'] = name
        return result

    def prove_children(self, source, baseline, children):
        """Check continuing RAM and independently mutate every child's RAM/disk."""
        states = []
        for index, child in enumerate(children, 1):
            inherited = child['state']
            for field in ('pid','start_monotonic_ns','ram_marker','branch','disk_branch'):
                require(inherited[field] == baseline[field], 'child did not inherit '+field)
            if 'prepare' not in child:
                self.prepare_child(child,index)
            name = child['name']
            child['runtime'] = self.inspect(name)
            states.append((name,index))
        source_state = self.status(source)
        for field in ('pid','start_monotonic_ns','ram_marker','branch','disk_branch'):
            require(source_state[field] == baseline[field], 'child changed source RAM/disk identity: '+field)
        for name,index in states:
            state = self.status(name)
            require(state['branch'] == index and state['disk_branch'] == index, 'siblings share mutable RAM/disk')
            child = next(c for c in children if c['runtime']['config']['name'] == name)
            child['independent_state'] = state
            child['independence'] = 'pass'
        identities = [c['runtime']['live_identity'] for c in children]
        require(len({(i['pid'],i['starttime_ticks']) for i in identities}) == len(identities), 'children share VMM process')
        return source_state

    def prepare_child(self, child, branch):
        start = time.monotonic_ns()
        prepared = self.request(child['name'], {'op':'mutate','branch':branch})
        if prepared.get('writes_paused'):
            prepared = self.request(child['name'], {'op':'resume_writes'})
        end = time.monotonic_ns()
        require(prepared['branch'] == branch and prepared['disk_branch'] == branch, 'child mutation failed')
        child['prepare'] = {'start_ns':start,'end_ns':end,'duration_ms':(end-start)/1e6,
                            'scope':'shared workload branch identity; no network identity','state':prepared}

    def cleanup_objects(self, children_only=False):
        probe_errors = self.finish_captures(raise_errors=False)
        if probe_errors:
            self.append('cleanup.jsonl',{'trial':self.trial,'capture_probe_errors':probe_errors})
        errors = []
        def rows(kind):
            output = self.command(kind,'ls','--format','json')
            return [] if output.strip().startswith('No ') else json.loads(output)
        owned = list(reversed(self.children)) + ([] if children_only else list(reversed(self.sources)))
        actual = rows('vm')
        require(all(v['config']['name'] in self.sources+self.children for v in actual), 'unexpected private VM record')
        for name in owned:
            if not any(v['config']['name'] == name for v in actual):
                continue
            try:
                vm = self.inspect(name)
                self.command('vm','rm','--force',vm['id'])
            except Exception as error:
                errors.append({'name': name, 'error': repr(error)})
        if not children_only and not errors:
            for row in rows('snapshot'):
                require(row['name'] in self.snapshots, 'unowned snapshot record')
                try:
                    self.command('snapshot','rm',row['id'])
                except Exception as error:
                    errors.append({'snapshot': row['name'], 'error': repr(error)})
        remaining = rows('vm')
        self.append('cleanup.jsonl', {'trial': self.trial, 'errors': errors, 'remaining_vms': remaining})
        require(not errors, 'cleanup errors: '+repr(errors))
        if children_only:
            require(all(v['config']['name'] in self.sources for v in remaining), 'child VM remains')
            self.children.clear()
        else:
            require(not remaining and not rows('snapshot'), 'runtime records remain')
            self.sources.clear(); self.children.clear(); self.snapshots.clear()

    def prepare(self):
        require(not (self.root/'prepared.json').exists(), 'refuse duplicate prepare')
        for relative, expected in HASHES.items():
            require(digest(STAGE/relative) == expected, 'retained artifact hash mismatch: '+relative)
        require(Path(self.args.guest).is_file(), 'shared guest binary is missing')
        for name in ('d','r','l','empty-cni','tools','downloads'):
            (self.root/name).mkdir()
        config = dict(root_dir=str(self.root/'d'), run_dir=str(self.root/'r'), log_dir=str(self.root/'l'),
                      fc_binary=str(STAGE/'bin/firecracker'), use_firecracker=True,
                      cni_conf_dir=str(self.root/'empty-cni'), cni_bin_dir=str(STAGE/'cni-bin'),
                      net_scope='lt', cgroup_parent=self.group.name, cgroup_cpus='4-11', dns='',
                      pool_size=1, meta_backend='json', stop_timeout_seconds=30,
                      socket_wait_timeout_seconds=20, metering={'backend':'file'})
        (self.root/'config.json').write_text(json.dumps(config, indent=2)+'\n')
        pins = json.loads((STAGE/'pins.json').read_text())
        for name in ('erofs','libdeflate'):
            archive = self.root/'downloads'/(name+'.deb')
            urllib.request.urlretrieve(pins[name+'_deb'], archive)
            require(digest(archive) == pins[name+'_deb_sha256'], 'private package hash mismatch')
            subprocess.run(['dpkg-deb','-x',str(archive),str(self.root/'tools')], check=True)
        artifacts = dict(HASHES, guest=digest(self.args.guest))
        self.import_images(artifacts,pins)

    def import_images(self, artifacts, pins):
        for variant in VARIANTS:
            archive = self.root/(variant+'.tar')
            make_image(archive, Path(self.args.guest), variant)
            artifacts[variant+'_tar'] = digest(archive)
            self.command('image','import','cl-'+variant,str(archive),timeout=900)
            archive.unlink()  # exact newly-created staging archive, cached image remains.
        (self.root/'prepared.json').write_text(json.dumps({'artifacts':artifacts,'pins':pins}, indent=2)+'\n')

    def refresh_images(self):
        require(self.manifest.get('timing_authorized') is False, 'image refresh only before timing gate')
        previous = json.loads((self.root/'prepared.json').read_text())
        require(json.loads(self.command('vm','ls','--format','json')) == [], 'cannot refresh with existing VMs')
        snaps = self.command('snapshot','ls','--format','json').strip()
        require(snaps in ('[]','No snapshots found.'), 'cannot refresh with existing snapshots')
        for relative, expected in HASHES.items():
            require(digest(STAGE/relative) == expected, 'retained input changed')
        (self.root/('prepared-before-refresh-'+uuid.uuid4().hex[:8]+'.json')).write_text(json.dumps(previous,indent=2)+'\n')
        for variant in VARIANTS:
            if variant+'_tar' in previous['artifacts']:
                record=json.loads(self.command('image','inspect','cl-'+variant))
                require(record['name']=='cl-'+variant, 'unexpected image ownership')
                self.command('image','rm',record['id'])
        self.import_images(dict(HASHES,guest=digest(self.args.guest)),previous['pins'])

    def run_case(self):
        prepared = json.loads((self.root/'prepared.json').read_text())
        require(prepared['artifacts']['guest'] == digest(self.args.guest), 'guest changed after prepare')
        for relative, expected in HASHES.items():
            require(digest(STAGE/relative) == expected, 'retained artifact changed')
        require(self.manifest.get('timing_authorized') is True, 'coordinator timing gate is closed')
        case = self.args.run_case
        source, snapshot = 'cl-source', 'cl-snapshot'
        primary = None
        try:
            if case == 'warm':
                self.run_vm(source); self.wait(lambda:self.status(source))
            for index in range(self.args.repetitions):
                self.trial = f'{case}-{self.args.variant}-{self.args.block}-{index+self.args.trial_offset:03d}-{uuid.uuid4().hex[:8]}'
                sample = {'schema_version':1, 'runtime':'cocoon','trial':self.trial,'case':case,
                          'variant':self.args.variant,'repetition':index+self.args.trial_offset,'block':self.args.block,
                          'metrics':{},'resources_before':self.resources(),'adapter_sha256':digest(__file__),
                          'start_ns':time.monotonic_ns(),'status':'running'}
                try:
                    if case == 'cold':
                        start = time.monotonic_ns(); self.run_vm(source); end = time.monotonic_ns()
                        sample['boot'] = self.ready(source,start,end)
                        sample['runtime_identity'] = self.inspect(source)
                        sample['metrics'].update(cold_request_to_exec_ms=sample['boot']['true_ms'],cold_request_to_workload_ms=sample['boot']['status_ms'])
                    elif case == 'warm':
                        self.inspect(source)
                        warm_before = self.request(source,{'op':'mutate','branch':91})
                        require(warm_before['branch']==91 and warm_before['disk_branch']==91, 'warm fixture mutation failed')
                        self.command('vm','stop',source)
                        start = time.monotonic_ns(); self.command('vm','start',source); end = time.monotonic_ns()
                        sample['boot'] = self.ready(source,start,end)
                        sample['runtime_identity'] = self.inspect(source)
                        sample['metrics'].update(warm_request_to_exec_ms=sample['boot']['true_ms'],warm_request_to_workload_ms=sample['boot']['status_ms'])
                        warm_after = sample['boot']['state']
                        require(warm_after['disk_branch']==91 and warm_after['branch']==91, 'warm restart lost retained disk branch')
                        require(warm_after['ram_marker']!=warm_before['ram_marker'], 'warm restart did not create fresh RAM workload')
                        sample['warm_restart_proof'] = {'before':warm_before,'after':warm_after,
                            'retained_disk_branch':91,'new_ram_marker':True,'status':'pass'}
                    elif case == 'fresh':
                        self.run_vm(source); self.wait(lambda:self.status(source))
                        sample['capture'] = self.capture(source,snapshot)
                        sample['children'] = [self.clone(snapshot,'cl-child1')]
                        self.prepare_child(sample['children'][0],1)
                        self.finish_captures()
                        sample['capture']['after'] = self.status(source)
                        sample['second_capture'] = self.capture(source,snapshot+'2')
                        sample['children'].append(self.clone(snapshot+'2','cl-child2'))
                        self.prepare_child(sample['children'][1],2)
                        self.finish_captures()
                        sample['second_capture']['after'] = self.status(source)
                        sample['metrics'].update(fresh_first_total_ms=(sample['children'][0]['prepare']['end_ns']-sample['capture']['start_ns'])/1e6,
                            fresh_second_total_ms=(sample['children'][1]['prepare']['end_ns']-sample['second_capture']['start_ns'])/1e6,
                            capture_command_ms=sample['capture']['command_ms'],second_capture_command_ms=sample['second_capture']['command_ms'])
                        sample['source_after_proof'] = self.prove_children(source,sample['capture']['before'],sample['children'])
                    else:
                        self.run_vm(source); self.wait(lambda:self.status(source))
                        sample['capture'] = self.capture(source,snapshot,cooperative=True)
                        count = 1 if case == 'fanout1' else 4
                        start = time.monotonic_ns()
                        def clone_and_prepare(index):
                            child=self.clone(snapshot,'cl-child'+str(index))
                            self.prepare_child(child,index)
                            return child
                        with ThreadPoolExecutor(max_workers=count) as pool:
                            sample['children'] = list(pool.map(clone_and_prepare,range(1,count+1)))
                        sample['fanout_status_ms'] = (max(c['status_end_ns'] for c in sample['children'])-start)/1e6
                        sample['source_resume_start_ns'] = time.monotonic_ns()
                        sample['source_resumed'] = self.request(source,{'op':'resume_writes'})
                        sample['source_resume_end_ns'] = time.monotonic_ns()
                        self.finish_captures()
                        sample['capture']['after'] = self.status(source)
                        sample['source_after_proof'] = self.prove_children(source,sample['capture']['before'],sample['children'])
                        sample['metrics'].update(fanout_total_ms=(max(c['prepare']['end_ns'] for c in sample['children'])-sample['capture']['start_ns'])/1e6,
                            capture_command_ms=sample['capture']['command_ms'],clone_only_all_ready_ms=sample['fanout_status_ms'])
                    sample['guest_storage'] = self.guest_storage(source)
                    sample['status'] = 'pass'
                except BaseException as error:
                    sample.update(status='fail',error=repr(error)); primary = error
                    raise
                finally:
                    sample['end_ns'] = time.monotonic_ns()
                    try:
                        sample['resources_after'] = self.resources()
                        sample['metrics'].update(disk_allocated_before_bytes=sample['resources_before']['disk_allocated_bytes'],
                            disk_allocated_after_bytes=sample['resources_after']['disk_allocated_bytes'],
                            cgroup_memory_peak_bytes=int(sample['resources_after']['memory.peak']))
                        if 'capture' in sample:
                            for phase,key in [('baseline','baseline'),('capture_only_after','capture'),('after','source_postfork')]:
                                state=sample['capture'].get(phase,{})
                                for clock in ('monotonic','raw'):
                                    value=state.get('heartbeat',{}).get('max_gap_'+clock+'_ns')
                                    if value is not None:
                                        sample['metrics'][key+'_observed_heartbeat_'+clock+'_stall_ms']=value/1e6
                        if case != 'warm' or index == self.args.repetitions-1:
                            self.cleanup_objects()
                        sample['cleanup'] = 'pass'
                    except BaseException as error:
                        sample.update(status='fail',cleanup='fail',cleanup_error=repr(error))
                        if primary is None:
                            raise
                    finally:
                        self.append('samples.jsonl',sample)
        except BaseException as error:
            primary = error
            raise
        finally:
            try:
                self.cleanup_objects()
            except BaseException as error:
                self.append('cleanup.jsonl',{'error':repr(error),'primary_error':repr(primary)})
                if primary is None:
                    raise


def make_image(target, guest, variant):
    """Append deterministic overrides to a copy of the exact retained rootfs."""
    require(not target.exists(), 'refuse existing image staging file')
    shutil.copyfile(STAGE/'guest-rootfs.tar', target)
    memory, dirty, workspace = VARIANTS[variant]
    unit = ('[Unit]\nDescription=Shared latency workload\nAfter=local-fs.target\n'
            '[Service]\nType=simple\nExecStartPre=/usr/bin/rm -f /tmp/clanker-latency.sock\nExecStart=/usr/local/bin/latency-guest serve '
            f'--memory-mib {memory} --dirty-mib-s {dirty} --workspace-mib {workspace} '
            '--workspace-files 1024 --workspace /var/tmp/clanker-latency-workspace --reuse-workspace\nRestart=no\n[Install]\nWantedBy=multi-user.target\n')
    with tarfile.open(target, 'a') as archive:
        for path, content, mode in [('usr/local/bin/latency-guest',guest.read_bytes(),0o755),
                                    ('etc/systemd/system/latency-guest.service',unit.encode(),0o644)]:
            info=tarfile.TarInfo(path); info.size=len(content); info.mode=mode; info.mtime=0
            archive.addfile(info,io.BytesIO(content))
        link=tarfile.TarInfo('etc/systemd/system/multi-user.target.wants/latency-guest.service')
        link.type=tarfile.SYMTYPE; link.linkname='../latency-guest.service'; link.mode=0o777; link.mtime=0
        archive.addfile(link)
        for service in ('docker.service','docker.socket','containerd.service',
                        'systemd-networkd-wait-online.service','NetworkManager-wait-online.service'):
            mask=tarfile.TarInfo('etc/systemd/system/'+service)
            mask.type=tarfile.SYMTYPE; mask.linkname='/dev/null'; mask.mode=0o777; mask.mtime=0
            archive.addfile(mask)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',required=True); parser.add_argument('--grant',required=True)
    parser.add_argument('--lock',required=True); parser.add_argument('--guest',required=True)
    parser.add_argument('--cpus',default='4-11'); parser.add_argument('--variant',choices=VARIANTS,default='idle')
    parser.add_argument('--repetitions',type=int,default=20)
    parser.add_argument('--trial-offset',type=int,default=0); parser.add_argument('--block',default='0')
    actions=parser.add_mutually_exclusive_group(required=True)
    actions.add_argument('--prepare',action='store_true'); actions.add_argument('--run-case',choices=CASES)
    actions.add_argument('--refresh-images',action='store_true')
    args=parser.parse_args()
    def terminate(signum, frame):
        raise KeyboardInterrupt('signal '+str(signum))
    signal.signal(signal.SIGTERM,terminate)
    require(sys.platform=='linux' and os.geteuid()==0,'Linux root required')
    require(1 <= args.repetitions <= 100,'repetition range is 1..100')
    experiment=Experiment(args)
    os.sched_setaffinity(0,range(4,12))
    require(Path(args.lock).is_file() and not Path(args.lock).is_symlink(),'coordinator must create shared lock')
    with open(args.lock,'r+') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        before=networks()
        audit_context={'runtime':'cocoon','case':args.run_case,'variant':args.variant,
                       'block':args.block,'trial_offset':args.trial_offset,'repetitions':args.repetitions}
        primary=None
        try:
            experiment.initialize_group()
            if args.prepare:
                experiment.prepare()
            elif args.refresh_images:
                experiment.refresh_images()
            else:
                experiment.run_case()
        except BaseException as error:
            primary=error
            raise
        finally:
            try:
                if hasattr(experiment,'group_inode'):
                    experiment.close_group()
                after=networks()
                require(before==after,'host network inventory changed; no corrective global mutation allowed')
                experiment.append('case-audits.jsonl',dict(audit_context,before=before,after=after,cleanup='pass'))
            except BaseException as error:
                experiment.append('case-audits.jsonl',dict(audit_context,cleanup='fail',error=repr(error),primary_error=repr(primary)))
                if primary is None:
                    raise


if __name__=='__main__':
    main()
