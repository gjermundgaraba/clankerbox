#!/usr/bin/env python3
"""Start/stop only the granted loopback proxy and its owned SSH tunnel handles."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time
from agent_network import call

ROOT = Path(__file__).resolve().parent
WORK = ROOT / '.work'
RECORD = WORK / 'agent-network-owner.json'
HOST_CONTROL = str(WORK / 'host-agent-proxy.sock')
OUTER_CONTROL = '/opt/clanker-spikes/cube/.work/outer-agent-proxy.sock'
SSH = ['ssh', '-i', str(WORK / 'target/id_ed25519'), '-p', '22070',
       '-o', 'UserKnownHostsFile=' + str(WORK / 'target/known_hosts'),
       '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5',
       '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2']


def identity(pid):
    stat = Path('/proc/%s/stat' % pid).read_text().rsplit(')', 1)[1].split()
    return {'pid': pid, 'startTicks': int(stat[19])}


def spawn(argv, name):
    with (WORK / (name + '.log')).open('x') as stream:
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=stream,
                                 stderr=stream, start_new_session=True)
    return identity(child.pid)


def stop_pid(record):
    try:
        if identity(record['pid']) != record:
            raise RuntimeError('RefusingToSignalReusedPID')
    except FileNotFoundError:
        return
    os.kill(record['pid'], signal.SIGTERM)


def start():
    if RECORD.exists():
        raise RuntimeError('NetworkOwnerRecordExists')
    for port in ('18444',):
        if subprocess.check_output(['ss', '-H', '-ltn', 'sport = :' + port], text=True).strip():
            raise RuntimeError('HostListenerOccupied')
    subprocess.run(SSH + ['cube@127.0.0.1',
        "test -z \"$(ss -H -ltn 'sport = :18443 or sport = :18445')\""], check=True)
    record = {'grant': 'cube-codex-20260905'}
    record['proxy'] = spawn(['python3', str(ROOT / 'agent_network.py'), 'host',
                             '--control', HOST_CONTROL], 'host-agent-proxy')
    RECORD.write_text(json.dumps(record)); RECORD.chmod(0o600)
    record['tunnel'] = spawn(SSH + ['-N', '-o', 'ExitOnForwardFailure=yes',
         '-R', '127.0.0.1:18443:127.0.0.1:18444', 'cube@127.0.0.1'], 'agent-reverse-ssh')
    RECORD.write_text(json.dumps(record))
    record['relaySSH'] = spawn(SSH + ['cube@127.0.0.1',
        'sudo -n python3 /opt/clanker-spikes/cube/agent_network.py outer --control ' +
        OUTER_CONTROL], 'outer-agent-relay')
    RECORD.write_text(json.dumps(record))
    deadline = time.monotonic() + 30
    while True:
        try:
            record['proxyIdentity'] = call(HOST_CONTROL, 'status')['identity']
            response = subprocess.run(SSH + ['cube@127.0.0.1',
                'sudo -n python3 /opt/clanker-spikes/cube/agent_network.py call --control ' +
                OUTER_CONTROL], capture_output=True, text=True)
            if response.returncode:
                raise RuntimeError('RelayNotReady')
            record['relayIdentity'] = json.loads(response.stdout)['identity']
            break
        except (OSError, ValueError, RuntimeError):
            if time.monotonic() > deadline:
                raise RuntimeError('NetworkStartupDeadline')
            time.sleep(.5)
    RECORD.write_text(json.dumps(record))
    print(json.dumps({'networkReady': True, 'ownership': record}))


def stop():
    record = json.loads(RECORD.read_text())
    if record['grant'] != 'cube-codex-20260905':
        raise RuntimeError('WrongNetworkOwner')
    response = subprocess.run(SSH + ['cube@127.0.0.1',
        'sudo -n python3 /opt/clanker-spikes/cube/agent_network.py call --control ' +
        OUTER_CONTROL], capture_output=True, text=True)
    if response.returncode == 0:
        if json.loads(response.stdout)['identity'] != record.get('relayIdentity'):
            raise RuntimeError('OuterRelayIdentityMismatch')
        subprocess.run(SSH + ['cube@127.0.0.1',
            'sudo -n python3 /opt/clanker-spikes/cube/agent_network.py call --control ' +
            OUTER_CONTROL + ' --operation stop'], capture_output=True, text=True, check=True)
    else:
        raise RuntimeError('CannotVerifyOuterRelayBeforeStop')
    status = call(HOST_CONTROL, 'status')
    if status['identity'] != record.get('proxyIdentity'):
        raise RuntimeError('HostProxyIdentityMismatch')
    summary = call(HOST_CONTROL, 'stop')
    for key in ('relaySSH', 'tunnel'):
        if key in record:
            stop_pid(record[key])
    (WORK / 'agent-network-cleanup.json').write_text(json.dumps({'stopped': True, 'proxy': summary}))
    print(json.dumps({'stopped': True, 'proxy': summary}))


def resume():
    record = json.loads(RECORD.read_text())
    for key in ('proxy', 'tunnel'):
        if identity(record[key]['pid']) != record[key]:
            raise RuntimeError('PartialNetworkIdentityMismatch')
    record['proxyIdentity'] = call(HOST_CONTROL, 'status')['identity']
    record.setdefault('previousRelayAttempts', []).append(record['relaySSH'])
    record['relaySSH'] = spawn(SSH + ['cube@127.0.0.1',
        'sudo -n python3 /opt/clanker-spikes/cube/agent_network.py outer --control ' +
        OUTER_CONTROL], 'outer-agent-relay-retry' + str(len(record['previousRelayAttempts'])))
    RECORD.write_text(json.dumps(record))
    time.sleep(1)
    response = subprocess.run(SSH + ['cube@127.0.0.1',
        'sudo -n python3 /opt/clanker-spikes/cube/agent_network.py call --control ' +
        OUTER_CONTROL], capture_output=True, text=True, check=True)
    record['relayIdentity'] = json.loads(response.stdout)['identity']
    RECORD.write_text(json.dumps(record))
    print(json.dumps({'networkReady': True, 'ownership': record}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'stop', 'resume'])
    args = parser.parse_args()
    scope = json.loads((WORK / 'scope.json').read_text())
    if scope['grant'] != 'cube-codex-20260905' or str(ROOT) != scope['root'] + '/cube':
        raise RuntimeError('WrongHostScope')
    {'start': start, 'stop': stop, 'resume': resume}[args.action]()
