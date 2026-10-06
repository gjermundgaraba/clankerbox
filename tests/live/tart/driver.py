#!/usr/bin/env python3
"""Runs the Tart live suite (tests/live) on this Mac: builds the darwin-arm64 SEA, runs it as a
Tart host from a private Tart home, and runs the suite with the same binary as the CLI.

  python3 tests/live/tart/driver.py --tart TART --seed SEED --address TAILNET_ADDRESS \\
    [--suite-args 'VP TEST ARGS']

  python3 tests/live/tart/driver.py --tart "$PWD/.work/inputs/tart-2.40.1/tart.app/Contents/MacOS/tart" \\
    --seed /path/to/main-checkout/.work/inputs/tart-cirrus-tahoe-base --address TAILNET_ADDRESS

TART is the absolute path of the tart binary the host runs (inside its tart.app), SEED that of
the stock Cirrus seed (PROVENANCE, READY and its one VM under home/vms), in the main checkout's
.work/inputs, and TAILNET_ADDRESS this Mac's tailnet address.

The run owns one WorkRun (scripts/WORK_RUNS.md). Its scratch holds the private TART_HOME, whose
base VM is an APFS clone (cp -c) of the seed's three files, never booted; the seed itself is only
read, and its checksums are compared with its PROVENANCE before and after. The host's ID carries
the run's ID, so every VM and launchd label the host makes starts with `cbx-<host ID>-`. The host
listens on the tailnet address, or on loopback when that address isn't assigned here (recorded in
evidence).

A second Tart host of the run, `<host ID>-b`, which only the suite's placement test uses, shares
the private home and the address, offers the base as `macos` and `macos-b`, and keeps its own
state, pid, exit status and log under scratch/second and evidence/second. Its ID starts with the
first host's, so the teardown below covers its VMs and launchd jobs too. The suite finds it in
`CLANKERBOX_LIVE_PLACEMENT_CONFIG`, a client config listing it alone; the placement test writes
its own configs with both hosts, in each order.

The host runs under a keeper process (`driver.py keep`), which records the host's pid and exit
status, so the suite's host-control program (`driver.py control`, tests/live/tests/live.ts) can
stop, kill and start it. Teardown, registered before anything it owns exists, works with the host
down: it stops both hosts, then stops and deletes every VM in the private home and boots out every
launchd job carrying the run's prefix, natively, and checks that none remains. The suite's key and
scripts stay in its temporary directory, under the run's scratch, which it removes; nothing here
prints a setup script.

It refuses a tree with uncommitted changes, so the commit it records (resources.json `commit`)
names the code it ran. The evidence also keeps a read-only snapshot of the application firewall's
settings.
"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from driver_common import (Evidence, Steps, WorkRun, choose_address, clean_commit, free_port,  # noqa: E402
                           host_start, processes, run_driver, sha256, stop_host, stop_on_signals,
                           write_client_config, write_control_stub)

SEED_FILES = ('config.json', 'disk.img', 'nvram.bin')
SOFTNET = Path('/usr/local/bin/softnet')
VZ = 'com.apple.Virtualization.VirtualMachine'
DOMAIN = f'gui/{os.getuid()}'


def seed_vm(seed):
    """The seed's one VM, under home/vms, whatever its name."""
    vms = [entry for entry in (seed / 'home' / 'vms').iterdir() if entry.is_dir()]
    if len(vms) != 1:
        sys.exit(f'the seed at {seed} holds {len(vms)} VMs under home/vms, not one')
    return vms[0]


def provenance_sums(seed):
    """The seed files' checksums as its PROVENANCE records them."""
    text = (seed / 'PROVENANCE').read_text()
    sums = dict(re.findall(r'^\s+(config\.json|disk\.img|nvram\.bin)\s+([0-9a-f]{64})\s*$', text, re.M))
    if sorted(sums) != sorted(SEED_FILES):
        raise RuntimeError(f'PROVENANCE lists checksums for {sorted(sums)}, not {sorted(SEED_FILES)}')
    return sums


def vz_processes():
    return processes(VZ)


def softnet_ready():
    """Softnet as the owner installs it: SUID root, group wheel, mode 4755."""
    try:
        st = SOFTNET.stat()
    except FileNotFoundError:
        return False
    return st.st_uid == 0 and st.st_gid == 0 and (st.st_mode & 0o7777) == 0o4755


def tart(state, *args, timeout=120):
    return subprocess.run([state['tart'], *args], env=dict(os.environ, TART_HOME=state['tart_home']),
                          capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)


def tart_list(state):
    ran = tart(state, 'list', '--source', 'local', '--format', 'json')
    if ran.returncode != 0:
        raise RuntimeError(f'tart list exited {ran.returncode}: {ran.stderr.strip()}')
    return json.loads(ran.stdout or '[]')


def labels(prefix):
    listed = subprocess.run(['launchctl', 'list'], capture_output=True, text=True).stdout
    return sorted(line.split('\t')[-1] for line in listed.splitlines() if line.split('\t')[-1].startswith(prefix))


def native_pattern(host_id, name):
    """A machine's or checkpoint's VM name, launchd label and job files, by its name on host
    `host_id`."""
    return re.compile(rf'^cbx-{re.escape(host_id)}-[mc]-{re.escape(name)}-[0-9a-f]{{8}}(\.plist|\.log)?$')


# The suite's host-control program's own ops on Tart (tests/live/tests/live.ts).

def natives(state, args):
    # The second host's, when its ID follows the name.
    name, host_id = args if len(args) == 2 else (*args, state['host_id'])
    if host_id not in (state['host_id'], f'{state["host_id"]}-b'):
        print(f'{host_id} is no host of the run', file=sys.stderr)
        return 2
    pattern = native_pattern(host_id, name)
    jobs = Path(state['state_dir']) / 'launchd'
    if host_id != state['host_id']:
        jobs = Path(state['scratch']) / 'second' / 'state' / 'launchd'
    files = [entry.name for entry in jobs.iterdir()] if jobs.exists() else []
    print(json.dumps({
        'machines': [{'name': vm['Name'], 'state': vm['State']} for vm in tart_list(state)
                     if pattern.match(vm['Name'])],
        'jobs': [label for label in labels(f'cbx-{host_id}-') if pattern.match(label)],
        'files': sorted(name for name in files if pattern.match(name)),
    }))


def guest(state, args):
    name, command = args
    pattern = re.compile(rf'^cbx-{re.escape(state["host_id"])}-m-{re.escape(name)}-[0-9a-f]{{8}}$')
    vms = [vm['Name'] for vm in tart_list(state) if pattern.match(vm['Name'])]
    if len(vms) != 1:
        print(f'{len(vms)} VMs for machine {name}', file=sys.stderr)
        return 3
    ran = tart(state, 'exec', vms[0], 'sudo', '-n', '/bin/sh', '-c', command, timeout=300)
    sys.stdout.write(ran.stdout)
    sys.stderr.write(ran.stderr)
    return ran.returncode


def addresses(state, args):
    out = subprocess.run(['ifconfig'], capture_output=True, text=True, check=True).stdout
    # A subnet's network or broadcast address, which a bridge of OrbStack's can carry
    # (192.168.215.0/24), takes no connection, from the Mac either (EADDRNOTAVAIL); a /31's or
    # /32's, such as the tailnet's, does.
    found = set()
    for address, mask in re.findall(r'^\tinet (\S+) (?:--> \S+ )?netmask (0x[0-9a-f]+)', out, re.M):
        network = ipaddress.ip_interface(f'{address}/{ipaddress.ip_address(int(mask, 16))}').network
        ip = ipaddress.ip_address(address)
        if ip.is_loopback or network.prefixlen <= 30 and ip in (network.network_address,
                                                                network.broadcast_address):
            continue
        found.add(address)
    print(json.dumps(sorted(found)))


def listener(state, args):
    # A TCP port some process of the Mac listens on at every IPv4 address.
    out = subprocess.run(['lsof', '-nP', '-i4TCP', '-sTCP:LISTEN'], capture_output=True, text=True).stdout
    listening = sorted({(int(port), command) for command, port in
                        re.findall(r'^(\S+)\s.*\s\*:(\d+) \(LISTEN\)', out, re.M)})
    if not listening:
        print('no process listens on every address', file=sys.stderr)
        return 1
    port, command = listening[0]
    with open(Path(state['evidence']) / 'control.log', 'a') as log:
        log.write(f'  listener: {command} on *:{port}\n')
    print(port)


OPS = {'natives': natives, 'guest': guest, 'addresses': addresses, 'listener': listener}


# Teardown, natively, by the run's own names.

def keep_job_logs(state):
    """The jobs' logs hold tart run's and Softnet's output, the only record of a failed boot."""
    scratch = Path(state['scratch'])
    for jobs, kept in ((Path(state['state_dir']) / 'launchd', Path(state['evidence']) / 'launchd'),
                       (scratch / 'second' / 'state' / 'launchd', Path(state['evidence']) / 'second' / 'launchd')):
        if jobs.exists():
            kept.mkdir(parents=True, exist_ok=True)
            for job_log in jobs.glob('*.log'):
                shutil.copy2(job_log, kept / job_log.name)


def remove_vm(state, vm, log):
    name = vm['Name']
    if vm['State'] == 'running':
        ran = tart(state, 'stop', '--timeout', '0', name)
        log(f'teardown: tart stop {name} rc={ran.returncode}')
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and any(
                other['Name'] == name and other['State'] == 'running' for other in tart_list(state)):
            time.sleep(0.5)
    ran = tart(state, 'delete', name)
    log(f'teardown: tart delete {name} rc={ran.returncode} {ran.stderr.strip()}')


def bootout(label, log):
    subprocess.run(['launchctl', 'bootout', f'{DOMAIN}/{label}'], capture_output=True)
    rc = subprocess.run(['launchctl', 'print', f'{DOMAIN}/{label}'], capture_output=True).returncode
    log(f'teardown: bootout {label}, then launchctl print rc={rc}')
    if rc != 113:
        raise RuntimeError(f'launchd still holds {label}')


def processes_end(state, prefix):
    """Waits 10 s for the run's processes to end: the host's keeper records its exit just after
    the host ends."""
    deadline = time.monotonic() + 10
    while (mine := processes(state['scratch']) + processes(prefix)) and time.monotonic() < deadline:
        time.sleep(0.5)
    if mine:
        raise RuntimeError(f'processes left: {mine}')


def teardown(state, log, fail):
    step = Steps(log)
    scratch = Path(state['scratch'])
    pid = step('stop the host', stop_host, scratch, log, fail)
    second_pid = step('stop the second host', stop_host, scratch / 'second', log, fail)
    step("keep the launchd jobs' logs", keep_job_logs, state)
    home = Path(state['tart_home'])
    if (home / 'vms').exists():
        for vm in step('list the VMs', tart_list, state) or []:
            step(f'remove VM {vm["Name"]}', remove_vm, state, vm, log)
        left = step('list the VMs again', tart_list, state)
        if left:
            step.fail(f'VMs left in {home}: {[vm["Name"] for vm in left]}')
    prefix = f'cbx-{state["host_id"]}-'
    for label in step('list the launchd jobs', labels, prefix) or []:
        step(f'boot out {label}', bootout, label, log)
    if labels(prefix):
        step.fail(f'launchctl list still shows {labels(prefix)}')
    step("wait for the run's processes to end", processes_end, state, prefix)
    record = {'errors': step.errors, 'vz_processes': vz_processes(), 'softnet_processes': processes(str(SOFTNET)),
              'launchd_labels': labels(prefix), 'host_pid': pid, 'second_host_pid': second_pid}
    (Path(state['evidence']) / 'teardown.json').write_text(json.dumps(record, indent=2) + '\n')
    log(f'teardown: {record}')
    step.done()


FIREWALL = '/usr/libexec/ApplicationFirewall/socketfilterfw'


def firewall_state():
    """The application firewall's settings, read only: the owner's, and never changed here."""
    def read(flag):
        return subprocess.run([FIREWALL, flag], capture_output=True, text=True).stdout.strip()

    return {flag: read(flag) for flag in ('--getglobalstate', '--getblockall', '--getstealthmode',
                                          '--getallowsigned')}


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--tart', required=True, help='the tart binary, inside its tart.app')
    parser.add_argument('--seed', required=True, help='the Cirrus seed, with its PROVENANCE and READY')
    parser.add_argument('--address', required=True, help="this Mac's tailnet address")
    parser.add_argument('--suite-args', default='', help='arguments for the suite run, such as -t PATTERN')
    options = parser.parse_args()
    if not (options.tart.startswith('/') and options.seed.startswith('/')):
        parser.error('--tart and --seed must be absolute')
    tart_bin = Path(options.tart)
    seed = Path(options.seed)

    if not os.access(tart_bin, os.X_OK):
        sys.exit(f'{tart_bin} is not an executable')
    if not softnet_ready():
        sys.exit(f'{SOFTNET} is not installed SUID root (4755, root:wheel)')
    if not (seed / 'READY').exists():
        sys.exit(f'the seed at {seed} is not READY')
    seed_files = seed_vm(seed)
    if vz_processes():
        sys.exit(f'macOS VMs already run on this Mac, and Apple allows two: {vz_processes()}')
    commit = clean_commit()
    stop_on_signals()

    with WorkRun('live-tart') as run:
        rid = run.path.name.rsplit('-', 1)[1][:5]
        host_id = f'clankerbox-live-t{rid}'
        base = f'clankerbox-live-t{rid}-base'
        home = run.scratch / 'tart-home'
        config = run.scratch / 'host.json'
        client_config = run.scratch / 'client.json'
        control_bin = run.scratch / 'host-control'
        binary = run.scratch / 'clankerbox'
        state_file = run.scratch / 'state.json'

        evidence = Evidence(run)
        log, record = evidence.log, evidence.record

        sums = provenance_sums(seed)

        def seed_check(when):
            started = time.monotonic()
            found = {name: sha256(seed_files / name) for name in SEED_FILES}
            matches = found == sums
            log(f'seed checksums {when}: {"match" if matches else "DIFFER from"} PROVENANCE '
                f'({time.monotonic() - started:.1f}s)')
            record(**{f'seed_{when}': {'matches': matches, 'sha256': found}})
            if not matches:
                raise RuntimeError(f'seed checksums {when} differ from PROVENANCE: {found}')

        # Runs last, after the VMs are gone.
        run.on_cleanup(lambda: seed_check('after'))

        address, why = choose_address(options.address)
        api_port = free_port(address)
        state = {
            'scratch': str(run.scratch), 'evidence': str(run.evidence), 'state_file': str(state_file),
            'tart': str(tart_bin), 'tart_home': str(home), 'binary': str(binary), 'config': str(config),
            'host_id': host_id, 'state_dir': str(run.scratch / 'state'), 'address': address, 'api_port': api_port,
        }
        state_file.write_text(json.dumps(state, indent=2) + '\n')
        record(seed=str(seed), seed_vm=seed_files.name, tart_home=str(home), base_vm=base, host_id=host_id,
               vm_and_label_prefix=f'cbx-{host_id}-', domain=DOMAIN, state_dir=state['state_dir'],
               config=str(config), address=address,
               address_reason=why, api_port=api_port, host_pid_file=str(run.scratch / 'host.pid'),
               softnet=str(SOFTNET), tart=str(tart_bin),
               softnet_ls=subprocess.run(['ls', '-l', str(SOFTNET)], capture_output=True, text=True).stdout.strip(),
               softnet_version=subprocess.run([str(SOFTNET), '--version'], capture_output=True,
                                              text=True).stdout.strip())
        log(f'run {run.path.name}: host {host_id} on {address}:{api_port} ({why}); home {home}')

        run.on_cleanup(lambda: teardown(state, log, run.fail))

        record(commit=commit, firewall=firewall_state())
        seed_check('before')
        evidence.build_binary(binary)

        (home / 'vms' / base).mkdir(parents=True)
        for name in SEED_FILES:
            subprocess.run(['cp', '-c', str(seed_files / name), str(home / 'vms' / base / name)], check=True)
        log(f'base {base}: an APFS clone of the seed')

        config.write_text(json.dumps({
            'id': host_id,
            'runtime': 'tart',
            'listen': {'address': address, 'port': api_port},
            'stateDir': 'state',
            'bases': {'macos': base},
            'tart': {'binary': str(tart_bin)},
        }, indent=2) + '\n')
        write_client_config(client_config, [(host_id, address, api_port)])
        write_control_stub(control_bin, __file__, state_file)

        log(f'host pid {host_start(state, __file__)}')

        # Picked once the first host listens, so the two never share a port.
        second = dict(state, scratch=str(run.scratch / 'second'), evidence=str(run.evidence / 'second'),
                      state_file=str(run.scratch / 'second' / 'state.json'),
                      config=str(run.scratch / 'second' / 'host.json'), host_id=f'{host_id}-b',
                      state_dir=str(run.scratch / 'second' / 'state'), api_port=free_port(address))
        for directory in (second['scratch'], second['evidence']):
            Path(directory).mkdir()
        Path(second['state_file']).write_text(json.dumps(second, indent=2) + '\n')
        Path(second['config']).write_text(json.dumps({
            'id': second['host_id'],
            'runtime': 'tart',
            'listen': {'address': address, 'port': second['api_port']},
            'stateDir': 'state',
            'bases': {'macos': base, 'macos-b': base},
            'tart': {'binary': str(tart_bin)},
        }, indent=2) + '\n')
        placement_config = run.scratch / 'placement.json'
        write_client_config(placement_config, [(second['host_id'], address, second['api_port'])])
        record(second_host={'host_id': second['host_id'], 'api_port': second['api_port'],
                            'state_dir': second['state_dir'], 'config': second['config'],
                            'host_pid_file': str(run.scratch / 'second' / 'host.pid')})
        log(f'second host pid {host_start(second, __file__)}')

        evidence.suite('tart', binary, client_config, control_bin, f'r{rid[:3]}-', options.suite_args,
                       {'CLANKERBOX_LIVE_PLACEMENT_CONFIG': str(placement_config)})


if __name__ == '__main__':
    run_driver(__file__, main, OPS, lambda state: dict(os.environ, TART_HOME=state['tart_home']))
