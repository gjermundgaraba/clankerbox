#!/usr/bin/env python3
"""Single-VM, no-NIC rollback test for grant cocoon-rollback-20260905 only."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request

STAGE = Path('/home/clanker/clankerbox-cocoon.b0ngM6')
RUN = STAGE / 'rb01'  # Short enough for Firecracker's UNIX socket paths.
GROUP = Path('/sys/fs/cgroup/cqrb20260905.slice')
NAME = 'cq-rollback-20260905'
HASHES = {
    'bin/cocoon': 'db7ef5fbd609ac28f84f88042eb2ec75e107aea09d24cbbd824a5b049e92bebc',
    'bin/firecracker': '2fd0171309af7e24cf8dafc8a6f921c1434c49b5f9349bb996b7ed0a4deb8aa7',
    'guest-rootfs.tar': '0a64e8ef15c93ff146f10729750955a4b4a1938293260cbf983d99b5466c99ed',
}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def validate_run(path, token):
    require(path == RUN and path.resolve() == RUN, 'outside exact rollback run path')
    require(token == 'cocoon-rollback-20260905', 'fresh rollback execution grant required')
    require(not path.exists() and not GROUP.exists(), 'refuse preexisting run/cgroup')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def wait_empty_group(path):
    deadline = time.monotonic() + 5
    while (path / 'cgroup.procs').read_text().strip():
        require(time.monotonic() < deadline, 'process remains in ' + str(path))
        time.sleep(0.05)


def inventory():
    return {key: json.loads(subprocess.check_output(cmd, text=True) or '[]') for key, cmd in {
        'links': ['ip', '-j', 'link', 'show'], 'netns': ['ip', '-j', 'netns', 'list'],
        'routes': ['ip', '-j', '-4', 'route', 'show', 'table', 'all']}.items()}


def main():
    validate_run(RUN, os.environ.get('CLANKER_HOST_SLOT'))
    require(os.geteuid() == 0 and sys.platform == 'linux', 'authorized Linux root runner required')
    require({'cpu', 'cpuset', 'memory'} <= set(Path('/sys/fs/cgroup/cgroup.subtree_control').read_text().split()),
            'refuse global controller changes')
    require(STAGE.resolve() == STAGE, 'stage symlink refused')
    for relative, expected in HASHES.items():
        require(digest(STAGE / relative) == expected, 'retained artifact hash mismatch: ' + relative)
    before = inventory()
    RUN.mkdir(mode=0o700)
    evidence = dict(schema_version=1, execution_scope='vm', status='running', checks={},
                    grant='cocoon-rollback-20260905', run_dir=str(RUN), artifact_sha256=HASHES,
                    timing_context='contended / concurrent-host activity: Cube isolated outer VM may run alongside',
                    metrics={}, phases={}, host_before=before,
                    limitations=['One quiesced 4-KiB regular file and separately flushed sentinel JSON; no concurrent application transactions.',
                                 'O_DIRECT bypasses guest file page cache, not host cache or storage-device cache; host power-loss durability NOT RUN.',
                                 'Atomic RAM/disk coherence with in-flight I/O, multi-file transactions, databases or multiple disks NOT RUN.',
                                 'No network, Docker workload, cross-host migration or host reboot in this follow-up.'])
    def save():
        (RUN / 'rollback-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    save()
    for name in ('d', 'r', 'l', 'empty-cni', 'tools', 'downloads'):
        (RUN / name).mkdir()
    config = dict(root_dir=str(RUN / 'd'), run_dir=str(RUN / 'r'), log_dir=str(RUN / 'l'),
                  fc_binary=str(STAGE / 'bin/firecracker'), use_firecracker=True,
                  cni_conf_dir=str(RUN / 'empty-cni'), cni_bin_dir=str(STAGE / 'cni-bin'),
                  net_scope='q7', cgroup_parent=GROUP.name, dns='', pool_size=1,
                  meta_backend='json', stop_timeout_seconds=30, socket_wait_timeout_seconds=20,
                  metering={'backend': 'file'})
    (RUN / 'config.json').write_text(json.dumps(config, indent=2))
    env = dict(os.environ, PATH=str(RUN / 'tools/usr/bin') + ':' + str(STAGE / 'bin') + ':' + os.environ['PATH'],
               LD_LIBRARY_PATH=str(RUN / 'tools/usr/lib/x86_64-linux-gnu'), GOMAXPROCS='4', GOMEMLIMIT='512MiB')
    cli = [str(STAGE / 'bin/cocoon'), '--config', str(RUN / 'config.json')]
    log = (RUN / 'commands.jsonl').open('x')
    group_inode = None
    def confined():
        (GROUP / 'control/cgroup.procs').write_text(str(os.getpid()))
        os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:4])
    def cc(*args, timeout=180):
        start = time.monotonic_ns()
        p = subprocess.run([*cli, *args], text=True, capture_output=True, timeout=timeout,
                           env=env, preexec_fn=confined)
        log.write(json.dumps(dict(argv=args, start_ns=start, end_ns=time.monotonic_ns(),
                                  code=p.returncode, stdout=p.stdout, stderr=p.stderr)) + '\n'); log.flush()
        require(p.returncode == 0, 'cocoon ' + repr(args) + ': ' + p.stderr)
        return p.stdout
    def listing(kind):
        output = cc(kind, 'ls', '--format', 'json')
        return [] if output.strip() == 'No snapshots found.' else json.loads(output)
    def inspect():
        vm = json.loads(cc('vm', 'inspect', NAME))
        require(vm['config']['name'] == NAME, 'VM name ownership mismatch')
        require(vm['config']['cpu'] == 2 and vm['config']['memory'] == 2 * 1024**3, 'unexpected VM budget')
        require(not vm.get('network_configs') and not vm.get('netns_path'), 'unexpected guest network')
        if vm.get('socket_path'):
            require(Path(vm['socket_path']).resolve().is_relative_to(RUN / 'r'), 'unowned socket')
        require(all(Path(d['path']).resolve().is_relative_to(RUN) for d in vm['storage_configs']), 'unowned disk')
        pid = vm.get('pid', 0)
        if pid and Path(f'/proc/{pid}').exists():
            require(Path(f'/proc/{pid}/exe').resolve() == STAGE / 'bin/firecracker', 'unowned executable')
            require(vm['socket_path'].encode() in Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0'), 'unowned process socket')
            scope = GROUP / ('vm-' + vm['id'] + '.scope')
            require((scope / 'cgroup.procs').read_text().split() == [str(pid)], 'unexpected VM cgroup processes')
        return vm
    def guest(*args):
        return cc('vm', 'exec', NAME, '--', *args)
    def status(request=None):
        return json.loads(guest('python3', '/opt/clanker/guest.py', 'call', json.dumps(request or {'op': 'status'})))
    def wait(call):
        deadline = time.monotonic() + 90
        while True:
            try:
                return call()
            except ValueError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.5)
    helper = (Path(__file__).resolve().parent / 'rollback_guest.py').read_text()
    def probe(action, phase):
        return json.loads(guest('python3', '-c', helper, action, phase))
    def allocation(label):
        size = int(subprocess.check_output(['du', '-s', '-B1', str(RUN)], text=True).split()[0])
        evidence['metrics'][label + '_allocated_bytes'] = size
        require(size <= 12 * 1024**3, 'additional actual disk budget exceeded')
        save()
    snapshot = None
    runtime_started = False
    primary_error = None
    try:
        GROUP.mkdir()  # Never adopt an existing cgroup; setup is inside cleanup scope.
        group_inode = GROUP.stat().st_ino
        (GROUP / 'memory.max').write_text(str(5 * 1024**3))  # leaves 1 GiB for this small runner
        (GROUP / 'cpu.max').write_text('400000 100000')
        (GROUP / 'cgroup.subtree_control').write_text('+cpu +memory')
        (GROUP / 'control').mkdir()
        pins = json.loads((STAGE / 'pins.json').read_text())
        for name in ('erofs', 'libdeflate'):
            target = RUN / 'downloads' / (name + '.deb')
            urllib.request.urlretrieve(pins[name + '_deb'], target)
            require(digest(target) == pins[name + '_deb_sha256'], 'private dependency hash mismatch')
            subprocess.run(['dpkg-deb', '-x', str(target), str(RUN / 'tools')], check=True)
        runtime_started = True
        cc('image', 'import', NAME, str(STAGE / 'guest-rootfs.tar'), timeout=600)
        cc('vm', 'run', '--fc', '--name', NAME, '--cpu', '2', '--memory', '2G',
           '--storage', '10G', '--nics', '0', NAME)
        wait(lambda: guest('true'))
        evidence['runtime_before'] = inspect()
        guest('systemd-run', '--unit=clanker-rollback-sentinel', '--property=LimitMEMLOCK=infinity',
              'python3', '/opt/clanker/guest.py', 'serve', '--socket', '/tmp/clanker-acceptance.sock',
              '--disk', '/var/tmp/clanker-acceptance-disk.json')
        wait(status)
        checkpoint = status({'op': 'mutate', 'delta': 10, 'label': 'checkpoint'})
        direct = probe('write', 'checkpoint')
        require(direct['guest_interfaces'] == ['lo'], 'guest has unexpected NIC')
        require(json.loads(direct['sentinel_disk']['text']) == checkpoint['disk'], 'checkpoint direct JSON mismatch')
        evidence['phases']['checkpoint'] = dict(sentinel=checkpoint, direct=direct)
        allocation('before_capture')
        start = time.monotonic_ns()
        cc('snapshot', 'save', '--name', NAME + '-snapshot', NAME, timeout=600)
        evidence['metrics']['snapshot_command_ms'] = (time.monotonic_ns() - start) / 1e6
        snapshot = json.loads(cc('snapshot', 'inspect', NAME + '-snapshot'))
        evidence['snapshot'] = snapshot
        changed = status({'op': 'mutate', 'delta': 100, 'label': 'after-capture'})
        changed_direct = probe('write', 'after-capture')
        require(changed['counter'] == 110 and changed['pid'] == checkpoint['pid'] and
                changed['marker_sha256'] == checkpoint['marker_sha256'], 'post-capture sentinel mutation failed')
        require(json.loads(changed_direct['sentinel_disk']['text']) == changed['disk'], 'post-capture direct JSON mismatch')
        require(changed_direct['inode'] == direct['inode'], 'fixture unexpectedly replaced inode')
        evidence['phases']['after_capture'] = dict(sentinel=changed, direct=changed_direct)
        evidence['checks']['flushed_post_capture_backing_bytes_differ'] = 'pass'
        allocation('after_mutation')
        inspect()  # Validate exact process ownership immediately before restore kills it.
        start = time.monotonic_ns()
        cc('vm', 'restore', NAME, NAME + '-snapshot', timeout=600)
        restored = wait(status)
        evidence['metrics']['restore_to_sentinel_ms'] = (time.monotonic_ns() - start) / 1e6
        # NO flush or buffered file read before this direct file read. status above
        # only reads the separate sentinel JSON; neither file is written on restore.
        restored_direct = probe('read', 'checkpoint')
        evidence['phases']['restored'] = dict(sentinel=restored, direct=restored_direct)
        evidence['runtime_after'] = inspect()
        for key in ('pid', 'marker_sha256', 'counter', 'ram_label', 'disk', 'session'):
            require(restored[key] == checkpoint[key], 'restored sentinel mismatch: ' + key)
        require(json.loads(restored_direct['sentinel_disk']['text']) == checkpoint['disk'], 'restored direct JSON mismatch')
        evidence['checks'].update(continuing_ram_sentinel='pass', point_in_time_backing_file_rollback='pass',
                                  flushed_sentinel_json_rollback='pass', quiesced_fixture_ram_disk_agreement='pass',
                                  guest_page_cache_bypass='pass', no_guest_network='pass')
        allocation('after_restore')
        evidence['status'] = 'pass'
    except Exception as error:
        primary_error = error
        evidence['status'] = 'fail'
        evidence['error'] = repr(error)
        raise
    finally:
        save()
        try:
            if group_inode is not None:
                require(GROUP.stat().st_ino == group_inode, 'cgroup ownership changed')
            if runtime_started:
                # Failed create can roll back its metadata completely. List first;
                # absent records are not a reason to abandon the residue audit.
                rows = listing('vm')
                evidence['cleanup_initial_vms'] = rows
                require(len(rows) <= 1, 'unexpected VM records in the private run')
                if rows:
                    vm = inspect()
                    require(rows[0]['id'] == vm['id'], 'VM listing ownership mismatch')
                    evidence['cleanup_vm'] = vm
                    cc('vm', 'rm', '--force', vm['id'])
                snapshots = listing('snapshot')
                evidence['cleanup_initial_snapshots'] = snapshots
                for current in snapshots:
                    require(current['name'] == NAME + '-snapshot', 'unowned snapshot name')
                    if snapshot is not None:
                        require(current['id'] == snapshot['id'], 'snapshot ownership changed')
                    cc('snapshot', 'rm', current['id'])
                evidence['cleanup_vms'] = listing('vm')
                evidence['cleanup_snapshots'] = listing('snapshot')
                require(not evidence['cleanup_vms'] and not evidence['cleanup_snapshots'], 'runtime objects remain')
            if group_inode is not None:
                evidence['metrics']['cgroup_memory_peak_bytes'] = int((GROUP / 'memory.peak').read_text())
                # Every descendant belongs to this newly created parent. Only
                # remove empty scopes; never kill a process missing VM ownership.
                for child in GROUP.iterdir():
                    if child.is_dir():
                        wait_empty_group(child)
                        child.rmdir()
                GROUP.rmdir()
            evidence['host_after'] = inventory()
            require(before == evidence['host_after'], 'host network inventory changed; inspect without mutating')
            for name in ('d', 'r', 'l', 'empty-cni', 'tools', 'downloads'):
                target = RUN / name
                require(target.resolve().parent == RUN and not target.is_symlink(), 'cleanup path ownership changed')
                shutil.rmtree(target)
            evidence['cleanup'] = 'pass'
            evidence['retained_files'] = {p.name: p.stat().st_size for p in RUN.iterdir() if p.is_file()}
        except Exception as error:
            evidence['cleanup'] = 'fail'
            evidence['cleanup_error'] = repr(error)
            evidence['owned_leftovers'] = {'run': str(RUN), 'cgroup_created_inode': group_inode,
                                         'cgroup_exists': GROUP.exists(),
                                         'run_entries': sorted(p.name for p in RUN.iterdir())}
            if primary_error is None:
                raise
        finally:
            save()
            log.close()
            print(json.dumps({'status': evidence['status'], 'cleanup': evidence.get('cleanup'), 'path': str(RUN)}), flush=True)


if __name__ == '__main__':
    main()
