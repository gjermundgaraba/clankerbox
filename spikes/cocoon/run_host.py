#!/usr/bin/env python3
"""KVM acceptance runner. Requires an explicit coordinator execution-slot token."""
import argparse
import hashlib
import ipaddress
from http.server import HTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import urllib.request

import gate
from measure import PauseObserver, resources


def main(base):
    if base != gate.REMOTE_BASE:
        raise ValueError('run must use the explicitly authorized directory')
    if not (os.geteuid() == 0 and sys.platform == 'linux'): raise ValueError("validation failed: os.geteuid() == 0 and sys.platform == 'linux'")
    if not (os.environ.get('CLANKER_HOST_SLOT') == 'cocoon'): raise ValueError('coordinator execution slot required')
    if not (base.name.startswith('clankerbox-cocoon.') and (base / 'config.json').is_file()): raise ValueError("validation failed: base.name.startswith('clankerbox-cocoon.') and (base / 'config.json').is_file()")
    if not ({'cpu', 'cpuset'} <= set(Path('/sys/fs/cgroup/cgroup.subtree_control').read_text().split())): raise ValueError('refuse host-wide controller changes')
    sys.path.insert(0, str(base / 'src'))
    from evaluate import evaluate
    from fake_endpoint import Handler
    config = json.loads((base / 'config.json').read_text())
    scope = config['net_scope']
    if scope != 'q7' or config['cgroup_parent'] != 'cqq7.slice':
        raise ValueError('configuration is outside the granted host slot')
    for key in ('root_dir', 'run_dir', 'log_dir', 'cni_conf_dir', 'cni_bin_dir', 'fc_binary'):
        if not Path(config[key]).resolve().is_relative_to(base):
            raise ValueError('configuration path outside owned directory: ' + key)
    results = base / 'results'; results.mkdir(exist_ok=True)
    evidence = dict(execution_scope='vm', concurrently_running=False, inherited={}, after={}, metrics={})
    evidence['timing_context'] = 'Concurrent host activity: coordinator permits disjoint smolvm execution (up to 3 GiB guest RAM, 8 GiB total budget).'
    env = dict(os.environ, PATH=str(base / 'bin') + ':' + str(base / 'erofs/usr/bin') + ':' + os.environ['PATH'],
               LD_LIBRARY_PATH=str(base / 'erofs/usr/lib/x86_64-linux-gnu'))
    cli = [str(base / 'bin/cocoon'), '--config', str(base / 'config.json')]
    log = (results / 'commands.jsonl').open('a')

    def cc(*args, timeout=180):
        start = time.monotonic_ns()
        p = subprocess.run([*cli, *args], env=env, text=True, capture_output=True, timeout=timeout)
        log.write(json.dumps(dict(argv=args, start_ns=start, end_ns=time.monotonic_ns(),
                                  code=p.returncode, stdout=p.stdout, stderr=p.stderr)) + '\n'); log.flush()
        if p.returncode:
            raise RuntimeError(f'cocoon {args}: {p.stderr}')
        return p.stdout

    def execvm(name, *args):
        return cc('vm', 'exec', name, '--', *args)

    def status(name, request=None):
        return json.loads(execvm(name, 'python3', '/opt/clanker/guest.py', 'call',
                                 json.dumps(request or {'op': 'status'})))

    def wait_agent(name):
        deadline = time.monotonic() + 90
        while True:
            try:
                execvm(name, 'true'); return
            except RuntimeError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.5)

    def inspect(name):
        return json.loads(cc('vm', 'inspect', name))

    def gate_record(vm):
        matches = [(p, json.loads(p.read_text())) for p in (base / 'gates').glob('*.json')]
        matches = [(p, d) for p, d in matches if d['vm_id'] == vm['id']]
        if not (len(matches) == 1): raise ValueError('exactly one gated NIC required')
        return matches[0]

    def tc_stats(record, direction):
        return json.loads(subprocess.check_output(
            ['tc', '-s', '-j', 'filter', 'show', 'dev', record['dev'], direction], text=True))

    def drop_packets(rules, pref):
        counts = []
        def visit(item):
            if isinstance(item, dict):
                if 'packets' in item and isinstance(item['packets'], int):
                    counts.append(item['packets'])
                for child in item.values():
                    visit(child)
            elif isinstance(item, list):
                for child in item:
                    visit(child)
        visit([r for r in rules if r.get('pref') == pref])
        return sum(counts)

    def raw_probe(name):
        return execvm(name, 'python3', '-c',
            "import socket,pathlib; "
            "dev=next(p.name for p in pathlib.Path('/sys/class/net').iterdir() if p.name!='lo'); "
            "src=bytes.fromhex(pathlib.Path('/sys/class/net/'+dev+'/address').read_text().strip().replace(':','')); "
            "s=socket.socket(socket.AF_PACKET,socket.SOCK_RAW); s.bind((dev,0)); "
            "s.send(bytes.fromhex('ffffffffffff')+src+bytes.fromhex('88b5')+bytes(46)); "
            "s.send(bytes.fromhex('333300000001')+src+bytes.fromhex('86dd6000000000003b01')"
            "+socket.inet_pton(socket.AF_INET6,'fe80::123')+socket.inet_pton(socket.AF_INET6,'ff02::1')); s.close()")

    names = {name: f'cq-{scope}-{name}' for name in ('parent', 'child-a', 'child-b')}
    # Refuse an existing run: never adopt or delete someone else's machines.
    for suffix in ('p', 'a', 'b'):
        if not (subprocess.run(['ip', 'link', 'show', 'cq' + scope + suffix], capture_output=True).returncode != 0): raise ValueError("validation failed: subprocess.run(['ip', 'link', 'show', 'cq' + scope + suffix], capture_output=True).returncode != 0")
    if not (not (base / 'run-started').exists()): raise ValueError('one-shot runner; retain failed evidence and reconcile explicitly')
    inventory = {kind: json.loads(subprocess.check_output(command, text=True) or '[]') for kind, command in {
        'links': ['ip', '-j', 'link', 'show'], 'routes': ['ip', '-j', '-4', 'route', 'show', 'table', 'all'],
        'netns': ['ip', '-j', 'netns', 'list']}.items()}
    (results / 'host-before.json').write_text(json.dumps(inventory, indent=2))
    if any(n['name'].startswith('q7-') for n in inventory['netns']):
        raise ValueError('pre-existing q7 namespace; refusing to adopt')
    if Path('/sys/fs/cgroup/cqq7.slice').exists():
        raise ValueError('pre-existing cqq7.slice; refusing to adopt')
    networks = [ipaddress.ip_network(f'172.30.{n}.0/24') for n in (216, 217, 218)]
    for route in inventory['routes']:
        dst = route.get('dst', 'default')
        if dst == 'default':
            continue
        network = ipaddress.ip_network(dst, strict=False)
        if any(network.overlaps(n) for n in networks):
            raise ValueError('live route overlaps the requested private subnet: ' + dst)
    artifact = base / 'guest-rootfs.tar'
    expected = (base / 'guest-rootfs.sha256').read_text().split()[0]
    with artifact.open('rb') as f:
        if not (hashlib.file_digest(f, 'sha256').hexdigest() == expected): raise ValueError("validation failed: hashlib.file_digest(f, 'sha256').hexdigest() == expected")
    (base / 'run-started').write_text(str(time.time()))
    daemon = None; servers = []; claims = {}
    try:
        # Servers must listen BEFORE first resumed execution, not after cloning.
        for i, suffix in enumerate(('p', 'a', 'b')):
            bridge = 'cq' + scope + suffix
            subprocess.run(['ip', 'link', 'add', bridge, 'type', 'bridge'], check=True)
            subprocess.run(['ip', 'addr', 'add', f'172.30.{216+i}.1/24', 'dev', bridge], check=True)
            subprocess.run(['ip', 'link', 'set', bridge, 'up'], check=True)
            server = HTTPServer((f'172.30.{216+i}.1', 8080), Handler); server.claims = claims
            threading.Thread(target=server.serve_forever, daemon=True).start(); servers.append(server)
        cc('image', 'import', 'cq-acceptance', str(artifact), timeout=600)
        cc('vm', 'run', '--fc', '--name', names['parent'], '--cpu', '2', '--memory', '2G',
           '--storage', '10G', '--nics', '1', '--network', names['parent'], 'cq-acceptance')
        wait_agent(names['parent'])
        kernel = execvm(names['parent'], 'sh', '-ec',
            'modprobe vmgenid; uname -r; '
            'grep "CONFIG_VMGENID=" /boot/config-$(uname -r); '
            'ls /sys/bus/acpi/drivers/vmgenid/; '
            'find /sys/bus/acpi/drivers/vmgenid -maxdepth 1 -name "VMGENCTR:*" | grep .')
        (results / 'guest-vmgenid.txt').write_text(kernel)
        execvm(names['parent'], 'sh', '-ec',
               'systemd-run --unit=clanker-sentinel --property=LimitMEMLOCK=infinity '
               'python3 /opt/clanker/guest.py serve --socket /tmp/clanker-acceptance.sock '
               '--disk /var/tmp/clanker-acceptance-disk.json')
        for _ in range(40):
            try:
                evidence['baseline'] = status(names['parent']); break
            except RuntimeError:
                time.sleep(0.1)
        if not ('baseline' in evidence): raise ValueError("validation failed: 'baseline' in evidence")
        # Continuous pre-resume canary is captured in RAM with the source.
        execvm(names['parent'], 'sh', '-ec',
               'systemd-run --unit=clanker-probe python3 /opt/clanker/probe.py '
               'http://172.30.216.1:8080 parent loop')
        observer = PauseObserver(inspect(names['parent'])['socket_path'])
        observer.thread.start()
        t = time.monotonic_ns()
        cc('snapshot', 'save', '--name', 'cq-' + scope + '-ram', names['parent'], timeout=600)
        evidence['metrics']['snapshot_command_ms'] = (time.monotonic_ns() - t) / 1e6
        # Snapshot command includes disk copy+bookkeeping. Do NOT call it pause time.
        evidence['metrics'].update(observer.finish())
        (results / 'source-pause-samples.json').write_text(json.dumps(observer.samples))
        evidence['inherited']['parent'] = status(names['parent'])
        for name in ('child-a', 'child-b'):
            t = time.monotonic_ns()
            cc('vm', 'clone', '--name', names[name], '--network', names[name], 'cq-' + scope + '-ram', timeout=600)
            wait_agent(names[name])
            evidence['metrics'][name + '_fork_to_exec_ms'] = (time.monotonic_ns() - t) / 1e6
            evidence['inherited'][name] = status(names[name])
        vms = {name: inspect(vmname) for name, vmname in names.items()}
        evidence['runtime'] = vms
        if not (len({v['pid'] for v in vms.values()}) == 3): raise ValueError("validation failed: len({v['pid'] for v in vms.values()}) == 3")
        if not (len({v['id'] for v in vms.values()}) == 3): raise ValueError("validation failed: len({v['id'] for v in vms.values()}) == 3")
        if not (len({v['vsock_socket'] for v in vms.values()}) == 3): raise ValueError("validation failed: len({v['vsock_socket'] for v in vms.values()}) == 3")
        cow_paths = [{d['path'] for d in v['storage_configs'] if d['role'] == 'cow'} for v in vms.values()]
        if not (all(len(paths) == 1 for paths in cow_paths) and len(set.union(*cow_paths)) == 3): raise ValueError('validation failed: all(len(paths) == 1 for paths in cow_paths) and len(set.union(*cow_paths)) == 3')
        for vm in vms.values():
            if not (vm['state'] == 'running'): raise ValueError("validation failed: vm['state'] == 'running'")
            os.kill(vm['pid'], 0)
        evidence['concurrently_running'] = True
        (results / 'resources-inherited.json').write_text(json.dumps(resources(vms, base), indent=2))
        for name, delta in [('parent', 10), ('child-a', 100), ('child-b', 1000)]:
            status(names[name], {'op': 'mutate', 'delta': delta, 'label': name})
        evidence['after'] = {name: status(vmname) for name, vmname in names.items()}
        (results / 'resources-mutated.json').write_text(json.dumps(resources(vms, base), indent=2))
        result = evaluate(evidence)
        (results / 'ram-result.json').write_text(json.dumps(result, indent=2))
        if not (result['status'] == 'pass'): raise ValueError('RAM/disk/process acceptance failed')
        if not (claims == {}): raise ValueError('pre-preparation side effect escaped quarantine')
        proofs = {}
        for name, vm in vms.items():
            path, record = gate_record(vm)
            if not (record['state'] == 'quarantined'): raise ValueError("validation failed: record['state'] == 'quarantined'")
            # Capture actual TC packet/drop counters before altering the guest.
            for direction in ('ingress', 'egress'):
                (results / f'{name}-quarantine-{direction}.json').write_text(
                    json.dumps(tc_stats(record, direction), indent=2))
            if drop_packets(tc_stats(record, 'ingress'), 1) <= 0:
                raise ValueError('no actual packet-drop evidence from the captured canary')
            # Cocoon detaches a best-effort machine-ID reseed after clone.
            # Wait for those scoped children to exit before setting final identity.
            deadline = time.monotonic() + 25
            while True:
                reseeding = []
                for proc in Path('/proc').glob('[0-9]*/cmdline'):
                    try:
                        argv = proc.read_bytes().split(b'\0')
                    except OSError:
                        continue
                    if (str(base / 'bin/cocoon').encode() in argv and b'reseed' in argv
                            and vm['id'].encode() in argv):
                        reseeding.append(proc)
                if not reseeding:
                    break
                if not (time.monotonic() < deadline): raise ValueError('detached reseed still running')
                time.sleep(0.1)
            # Guest network repair and identity hooks happen entirely behind gate.
            cc('vm', 'reseed', vm['id'])
            nic = vm['network_configs'][0]; net = nic['network']
            proof = json.loads(execvm(names[name], 'python3', '/opt/clanker/guest_prepare.py', vm['id'], record['nonce'],
                                     f"{net['ip']}/{net['prefix']}", net['gateway'], nic['mac']))
            proofs[name] = proof
            # Failure here must leave the initial all-protocol drop installed.
            bad = dict(proof, prepared=False)
            rejected = False
            try:
                gate.release(record, bad)
            except ValueError:
                rejected = True
            if not (rejected): raise ValueError('invalid preparation opened gate')
            previous_claims = dict(claims)
            blocked_before = drop_packets(tc_stats(record, 'ingress'), 1)
            blocked = False
            try:
                execvm(names[name], 'python3', '/opt/clanker/probe.py', 'http://' + record['endpoint'] + ':8080', name)
            except RuntimeError:
                blocked = True
            if not (blocked and claims == previous_claims): raise ValueError('side effect escaped quarantine')
            raw_probe(names[name])
            time.sleep(0.1)
            blocked_after = drop_packets(tc_stats(record, 'ingress'), 1)
            if blocked_after <= blocked_before:
                raise ValueError('blocked probes did not increase TC packet-drop counters')
            execvm(names[name], 'systemctl', 'stop', 'clanker-probe.service')
            (results / (name + '-proof.json')).write_text(json.dumps(proof, indent=2))
            gate.release(record, proof)
            record['state'] = 'fake-endpoint-only'
            gate.atomic(path, record)
            execvm(names[name], 'python3', '/opt/clanker/probe.py', 'http://' + record['endpoint'] + ':8080', name)
            if not (claims == dict(previous_claims, **{proof['session']: name})): raise ValueError("validation failed: claims == dict(previous_claims, **{proof['session']: name})")
            restricted_before = drop_packets(tc_stats(record, 'ingress'), 100)
            raw_probe(names[name]); time.sleep(0.1)
            restricted_after = drop_packets(tc_stats(record, 'ingress'), 100)
            if restricted_after < restricted_before + 2:
                raise ValueError('IPv6/custom-EtherType frames were not both blocked after release')
            (results / (name + '-packet-proof.json')).write_text(json.dumps(dict(
                quarantine_before=blocked_before, quarantine_after=blocked_after,
                restricted_before=restricted_before, restricted_after=restricted_after,
                ingress=tc_stats(record, 'ingress'), egress=tc_stats(record, 'egress')), indent=2))
            (results / (name + '-claims.json')).write_text(json.dumps(claims))
        if not (len({p['machine_id'] for p in proofs.values()}) == 3): raise ValueError("validation failed: len({p['machine_id'] for p in proofs.values()}) == 3")
        if not (len({p['session'] for p in proofs.values()}) == 3): raise ValueError("validation failed: len({p['session'] for p in proofs.values()}) == 3")
        if not (len({p['ssh_public_key_sha256']['ssh_host_ed25519_key.pub'] for p in proofs.values()}) == 3): raise ValueError("validation failed: len({p['ssh_public_key_sha256']['ssh_host_ed25519_key.pub'] for p in proofs.values()}) == 3")
        # Start/restart only this private supervisor; VMM PIDs must survive both.
        daemon_log = (results / 'daemon.log').open('a')
        def start_daemon():
            return subprocess.Popen([*cli, 'daemon', '--reconcile-interval', '500ms'], env=env,
                                    stdout=daemon_log, stderr=daemon_log)
        daemon = start_daemon(); time.sleep(2)
        if not (daemon.poll() is None): raise ValueError('validation failed: daemon.poll() is None')
        daemon.terminate(); daemon.wait(timeout=15)
        daemon = start_daemon(); time.sleep(2)
        if not (daemon.poll() is None): raise ValueError('validation failed: daemon.poll() is None')
        for name, vm in vms.items():
            if not (inspect(names[name])['pid'] == vm['pid']): raise ValueError("validation failed: inspect(names[name])['pid'] == vm['pid']")
            if not (status(names[name])['marker_sha256'] == evidence['baseline']['marker_sha256']): raise ValueError("validation failed: status(names[name])['marker_sha256'] == evidence['baseline']['marker_sha256']")
        # Workspace stop/start is a cold boot; do not restart sentinel and pretend continuity.
        before = inspect(names['child-a'])['storage_configs']
        cc('vm', 'stop', names['child-a']); cc('vm', 'start', names['child-a']); wait_agent(names['child-a'])
        if not (inspect(names['child-a'])['storage_configs'] == before): raise ValueError("validation failed: inspect(names['child-a'])['storage_configs'] == before")
        disk = json.loads(execvm(names['child-a'], 'cat', '/var/tmp/clanker-acceptance-disk.json'))
        if not (disk == evidence['after']['child-a']['disk']): raise ValueError("validation failed: disk == evidence['after']['child-a']['disk']")
        for name in names.values():
            output = execvm(name, 'sh', '-ec', (base / 'guest_workload.sh').read_text())
            (results / (name + '-build.txt')).write_text(output)
        (results / 'lifecycle.json').write_text(json.dumps(dict(status='pass', execution_scope='vm',
            checks=['quarantine_and_identity', 'daemon_reattachment', 'same_disk_stop_start', 'guest_gcc_and_docker_build'])))
    except Exception as error:
        (results / 'failure.json').write_text(json.dumps(dict(status='fail', execution_scope='vm', error=str(error))))
        raise
    finally:
        for server in servers:
            server.shutdown(); server.server_close()
        if daemon is not None and daemon.poll() is None:
            daemon.terminate(); daemon.wait(timeout=15)
        # Preserve VMs/disks/checkpoints and gate state on every failure. Explicit cleanup only.
        log.close()


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('base', type=Path); a=p.parse_args()
    main(a.base.resolve())
