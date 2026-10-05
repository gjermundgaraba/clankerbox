#!/usr/bin/env python3
"""Runs the Tart live suite (tests/live) on this Mac: builds the darwin-arm64 SEA, runs it as a
Tart host from a private Tart home, and runs the suite with the same binary as the CLI.

  python3 tests/live/tart/driver.py --seed SEED --address TAILNET_ADDRESS [--suite-args 'VP TEST ARGS']

  python3 tests/live/tart/driver.py \
    --seed /Users/gg/ws/pers/clankerbox/.work/inputs/tart-cirrus-tahoe-base --address 100.122.69.11

SEED is the absolute path of the stock Cirrus seed (PROVENANCE, READY and its VM under home/vms),
in the main checkout's .work/inputs, and TAILNET_ADDRESS this Mac's tailnet address.

The run owns one WorkRun (scripts/WORK_RUNS.md). Its scratch holds the private TART_HOME, whose
base VM is an APFS clone (cp -c) of the seed's three files, never booted; the seed itself is only
read, and its checksums are compared with its PROVENANCE before and after. The host's ID carries
the run's ID, so every VM and launchd label the host makes starts with `cbx-<host ID>-`. The host
listens on the tailnet address, or on loopback when that address isn't assigned here (recorded in
evidence).

The host runs under a keeper process (`driver.py keep`), which records the host's pid and exit
status, so the suite's host-control program (`driver.py control`, tests/live/tests/live.ts) can
stop, kill and start it. Teardown, registered before anything it owns exists, works with the host
down: it stops the host, then stops and deletes every VM in the private home and boots out every
launchd job carrying the run's prefix, natively, and checks that none remains. The suite's key and
scripts stay in its temporary directory, under the run's scratch, which it removes; nothing here
prints a setup script.

It refuses a tree with uncommitted changes, so the commit it records (resources.json `commit`)
names the code it ran. The evidence also keeps a read-only snapshot of the application firewall's
settings.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from driver_common import REPO, Evidence, Failed, WorkRun, clean_commit, stop_on_signals  # noqa: E402

TART = REPO / '.work/inputs/tart-2.40.1/tart.app/Contents/MacOS/tart'
SEED_VM = 'home/vms/clankerbox-rewrite-seed-macos-tahoe-base'
SEED_FILES = ('config.json', 'disk.img', 'nvram.bin')
SOFTNET = Path('/usr/local/bin/softnet')
DIST = REPO / 'tools' / 'release' / 'dist'
VZ = 'com.apple.Virtualization.VirtualMachine'
DOMAIN = f'gui/{os.getuid()}'


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 22), b''):
            digest.update(chunk)
    return digest.hexdigest()


def provenance_sums(seed):
    """The seed files' checksums as its PROVENANCE records them."""
    text = (seed / 'PROVENANCE').read_text()
    sums = dict(re.findall(r'^\s+(config\.json|disk\.img|nvram\.bin)\s+([0-9a-f]{64})\s*$', text, re.M))
    if sorted(sums) != sorted(SEED_FILES):
        raise RuntimeError(f'PROVENANCE lists checksums for {sorted(sums)}, not {sorted(SEED_FILES)}')
    return sums


def vz_processes():
    out = subprocess.run(['ps', '-axo', 'pid,command'], capture_output=True, text=True).stdout
    return [line.strip() for line in out.splitlines() if VZ in line]


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


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def read_int(path):
    try:
        return int(path.read_text().strip())
    except (FileNotFoundError, ValueError):
        return None


def native_pattern(state, name):
    """A machine's or checkpoint's VM name, launchd label and job files, by its name on the host."""
    return re.compile(rf'^cbx-{re.escape(state["host_id"])}-[mc]-{re.escape(name)}-[0-9a-f]{{8}}(\.plist|\.log)?$')


# The host and its keeper.

def keep(state_file):
    """Runs the host to its end, recording its pid and exit status (negative: the signal)."""
    state = json.loads(Path(state_file).read_text())
    scratch = Path(state['scratch'])
    with open(Path(state['evidence']) / 'host.log', 'a') as log:
        log.write(f'--- host start {time.strftime("%Y-%m-%dT%H:%M:%S")}\n')
        log.flush()
        host = subprocess.Popen([state['binary'], 'host', '--config', state['config']], stdout=log,
                                stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                env=dict(os.environ, TART_HOME=state['tart_home']))
        (scratch / 'host.pid.new').write_text(f'{host.pid}\n')
        (scratch / 'host.pid.new').replace(scratch / 'host.pid')
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        code = host.wait()
        (scratch / 'host.exit.new').write_text(f'{code}\n')
        (scratch / 'host.exit.new').replace(scratch / 'host.exit')


def host_start(state):
    scratch = Path(state['scratch'])
    pid = read_int(scratch / 'host.pid')
    if pid is not None and alive(pid) and not (scratch / 'host.exit').exists():
        raise RuntimeError(f'the host already runs as pid {pid}')
    for name in ('host.pid', 'host.exit'):
        (scratch / name).unlink(missing_ok=True)
    subprocess.Popen([sys.executable, __file__, 'keep', state['state_file']], start_new_session=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if (scratch / 'host.exit').exists():
            log = (Path(state['evidence']) / 'host.log').read_text()[-2000:]
            raise RuntimeError(f'the host exited {(scratch / "host.exit").read_text().strip()} at startup:\n{log}')
        try:
            with socket.create_connection((state['address'], state['api_port']), timeout=2):
                return read_int(scratch / 'host.pid')
        except OSError:
            time.sleep(0.25)
    raise RuntimeError('the host did not listen within 60 s')


def host_end(state, sig, expected, wait=60):
    """Signals the host and waits for its keeper to record how it ended."""
    scratch = Path(state['scratch'])
    pid = read_int(scratch / 'host.pid')
    if pid is None or (scratch / 'host.exit').exists():
        raise RuntimeError('the host does not run')
    os.kill(pid, sig)
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        code = read_int(scratch / 'host.exit')
        if code is not None:
            if code != expected:
                raise RuntimeError(f'the host ended with {code}, not {expected}')
            return
        time.sleep(0.1)
    raise RuntimeError(f'the host did not end within {wait} s of signal {sig}')


# The suite's host-control program (tests/live/tests/live.ts).

def control(state_file, op, args):
    state = json.loads(Path(state_file).read_text())
    with open(Path(state['evidence']) / 'control.log', 'a') as log:
        log.write(f'{time.strftime("%H:%M:%S")} {shlex.join([op, *args])}\n')
    if op == 'host-start':
        host_start(state)
    elif op == 'host-stop':
        host_end(state, signal.SIGTERM, 0)
    elif op == 'host-kill':
        host_end(state, signal.SIGKILL, -signal.SIGKILL)
    elif op == 'natives':
        [name] = args
        pattern = native_pattern(state, name)
        jobs = Path(state['state_dir']) / 'launchd'
        files = [entry.name for entry in jobs.iterdir()] if jobs.exists() else []
        print(json.dumps({
            'machines': [{'name': vm['Name'], 'state': vm['State']} for vm in tart_list(state)
                         if pattern.match(vm['Name'])],
            'jobs': [label for label in labels(f'cbx-{state["host_id"]}-') if pattern.match(label)],
            'files': sorted(name for name in files if pattern.match(name)),
        }))
    elif op == 'guest':
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
    elif op == 'addresses':
        out = subprocess.run(['ifconfig'], capture_output=True, text=True, check=True).stdout
        print(json.dumps(sorted({address for address in re.findall(r'^\tinet (\S+)', out, re.M)
                                 if not address.startswith('127.')})))
    elif op == 'listener':
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
    elif op == 'probe':
        address, port = args
        try:
            with socket.create_connection((address, int(port)), timeout=5):
                print('reached')
        except OSError:
            print('unreachable')
    else:
        print(f'unknown op {op}', file=sys.stderr)
        return 2
    return 0


# Teardown, natively, by the run's own names.

def teardown(state, log):
    errors = []
    scratch = Path(state['scratch'])
    pid = read_int(scratch / 'host.pid')
    if pid is not None and alive(pid) and not (scratch / 'host.exit').exists():
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 30
        while alive(pid) and time.monotonic() < deadline:
            time.sleep(0.2)
        if alive(pid):
            os.kill(pid, signal.SIGKILL)
        log(f'teardown: stopped the host (pid {pid})')
    # The jobs' logs hold tart run's and Softnet's output, the only record of a failed boot.
    jobs = Path(state['state_dir']) / 'launchd'
    if jobs.exists():
        kept = Path(state['evidence']) / 'launchd'
        kept.mkdir(exist_ok=True)
        for job_log in jobs.glob('*.log'):
            shutil.copy2(job_log, kept / job_log.name)
    home = Path(state['tart_home'])
    if (home / 'vms').exists():
        for vm in tart_list(state):
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
        left = [vm['Name'] for vm in tart_list(state)]
        if left:
            errors.append(f'VMs left in {home}: {left}')
    prefix = f'cbx-{state["host_id"]}-'
    for label in labels(prefix):
        subprocess.run(['launchctl', 'bootout', f'{DOMAIN}/{label}'], capture_output=True)
        rc = subprocess.run(['launchctl', 'print', f'{DOMAIN}/{label}'], capture_output=True).returncode
        log(f'teardown: bootout {label}, then launchctl print rc={rc}')
        if rc != 113:
            errors.append(f'launchd still holds {label}')
    if labels(prefix):
        errors.append(f'launchctl list still shows {labels(prefix)}')
    # The host's keeper records its exit just after the host ends.
    deadline = time.monotonic() + 10
    while True:
        procs = subprocess.run(['ps', '-axo', 'pid,command'], capture_output=True, text=True).stdout
        mine = [line.strip() for line in procs.splitlines() if state['scratch'] in line or prefix in line]
        if not mine or time.monotonic() > deadline:
            break
        time.sleep(0.5)
    if mine:
        errors.append(f'processes left: {mine}')
    softnets = [line.strip() for line in procs.splitlines() if str(SOFTNET) in line]
    record = {'errors': errors, 'vz_processes': vz_processes(), 'softnet_processes': softnets,
              'launchd_labels': labels(prefix), 'host_pid': pid}
    (Path(state['evidence']) / 'teardown.json').write_text(json.dumps(record, indent=2) + '\n')
    log(f'teardown: {record}')
    if errors:
        raise RuntimeError('; '.join(errors))


FIREWALL = '/usr/libexec/ApplicationFirewall/socketfilterfw'


def firewall_state():
    """The application firewall's settings, read only: the owner's, and never changed here."""
    def read(flag):
        return subprocess.run([FIREWALL, flag], capture_output=True, text=True).stdout.strip()

    return {flag: read(flag) for flag in ('--getglobalstate', '--getblockall', '--getstealthmode',
                                          '--getallowsigned')}


def free_port(address):
    """A port outside the machines' range (10000-19999) that binds on `address`."""
    for port in range(47000, 48000):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind((address, port))
            except OSError:
                continue
            return port
    raise RuntimeError(f'no free port in 47000-47999 on {address}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--seed', required=True, help='the Cirrus seed, with its PROVENANCE and READY')
    parser.add_argument('--address', required=True, help="this Mac's tailnet address")
    parser.add_argument('--suite-args', default='', help='arguments for the suite run, such as -t PATTERN')
    options = parser.parse_args()
    if not options.seed.startswith('/'):
        parser.error('--seed must be absolute')
    seed = Path(options.seed)

    if not softnet_ready():
        sys.exit(f'{SOFTNET} is not installed SUID root (4755, root:wheel)')
    if not (seed / 'READY').exists():
        sys.exit(f'the seed at {seed} is not READY')
    if vz_processes():
        sys.exit(f'macOS VMs already run on this Mac, and Apple allows two: {vz_processes()}')
    commit = clean_commit()
    stop_on_signals()

    with WorkRun('live-tart') as run:
        rid = run.path.name.rsplit('-', 1)[1][:5]
        host_id = f'clankerbox-rewrite-t{rid}'
        base = f'clankerbox-rewrite-t{rid}-base'
        home = run.scratch / 'tart-home'
        config = run.scratch / 'host.json'
        client_config = run.scratch / 'client.json'
        control_bin = run.scratch / 'host-control'
        binary = run.scratch / 'clankerbox'
        state_file = run.scratch / 'state.json'

        evidence = Evidence(run)
        log, record, sh = evidence.log, evidence.record, evidence.sh

        sums = provenance_sums(seed)

        def seed_check(when):
            started = time.monotonic()
            found = {name: sha256(seed / SEED_VM / name) for name in SEED_FILES}
            matches = found == sums
            log(f'seed checksums {when}: {"match" if matches else "DIFFER from"} PROVENANCE '
                f'({time.monotonic() - started:.1f}s)')
            record(**{f'seed_{when}': {'matches': matches, 'sha256': found}})
            if not matches:
                raise RuntimeError(f'seed checksums {when} differ from PROVENANCE: {found}')

        # Runs last, after the VMs are gone.
        run.on_cleanup(lambda: seed_check('after'))

        if not re.search(rf'^\tinet {re.escape(options.address)} ',
                         subprocess.run(['ifconfig'], capture_output=True, text=True).stdout, re.M):
            address, why = '127.0.0.1', f'{options.address} is not assigned on this Mac'
        else:
            address, why = options.address, 'the tailnet address, as production listens'
        api_port = free_port(address)
        state = {
            'scratch': str(run.scratch), 'evidence': str(run.evidence), 'state_file': str(state_file),
            'tart': str(TART), 'tart_home': str(home), 'binary': str(binary), 'config': str(config),
            'host_id': host_id, 'state_dir': str(run.scratch / 'state'), 'address': address, 'api_port': api_port,
        }
        state_file.write_text(json.dumps(state, indent=2) + '\n')
        record(seed=str(seed), tart_home=str(home), base_vm=base, host_id=host_id,
               vm_and_label_prefix=f'cbx-{host_id}-', domain=DOMAIN, state_dir=state['state_dir'],
               config=str(config), address=address,
               address_reason=why, api_port=api_port, host_pid_file=str(run.scratch / 'host.pid'),
               softnet=str(SOFTNET), tart=str(TART),
               softnet_ls=subprocess.run(['ls', '-l', str(SOFTNET)], capture_output=True, text=True).stdout.strip(),
               softnet_version=subprocess.run([str(SOFTNET), '--version'], capture_output=True,
                                              text=True).stdout.strip())
        log(f'run {run.path.name}: host {host_id} on {address}:{api_port} ({why}); home {home}')

        run.on_cleanup(lambda: teardown(state, log))

        record(commit=commit, firewall=firewall_state())
        seed_check('before')
        sh(['vp', 'run', '-r', 'build'], 'build', cwd=REPO)
        sh(['sh', 'tools/release/build-sea.sh', 'darwin-arm64'], 'build-sea', cwd=REPO)
        shutil.copy2(DIST / 'darwin-arm64' / 'clankerbox', binary)
        shutil.rmtree(DIST)
        record(sea={'bytes': binary.stat().st_size, 'sha256': sha256(binary)})
        log(f'SEA from {commit}: {binary.stat().st_size / 2**20:.1f} MiB, sha256 {sha256(binary)}')

        (home / 'vms' / base).mkdir(parents=True)
        for name in SEED_FILES:
            subprocess.run(['cp', '-c', str(seed / SEED_VM / name), str(home / 'vms' / base / name)], check=True)
        log(f'base {base}: an APFS clone of the seed')

        config.write_text(json.dumps({
            'id': host_id,
            'runtime': 'tart',
            'listen': {'address': address, 'port': api_port},
            'stateDir': 'state',
            'bases': {'macos': base},
            'tart': {'binary': str(TART)},
        }, indent=2) + '\n')
        client_config.write_text(json.dumps({'hosts': [{'id': host_id, 'url': f'http://{address}:{api_port}'}]},
                                            indent=2) + '\n')
        control_bin.write_text(f'#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(__file__)} control '
                               f'{shlex.quote(str(state_file))} "$@"\n')
        control_bin.chmod(0o755)

        log(f'host pid {host_start(state)}')
        evidence.suite('tart', binary, client_config, control_bin, f'r{rid[:3]}-', options.suite_args)


if __name__ == '__main__':
    if sys.argv[1:2] == ['keep']:
        keep(sys.argv[2])
    elif sys.argv[1:2] == ['control']:
        try:
            sys.exit(control(sys.argv[2], sys.argv[3], sys.argv[4:]))
        except RuntimeError as error:
            print(error, file=sys.stderr)
            sys.exit(1)
    else:
        try:
            main()
        except Failed as failure:
            sys.exit(failure.code)
