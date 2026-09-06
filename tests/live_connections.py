#!/usr/bin/env python3
"""Connection acceptance on a retained disposable machine from live_lifecycle."""
import argparse
import json
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--config', required=True)
    parser.add_argument('--lifecycle-result', required=True)
    args = parser.parse_args()
    evidence = json.loads(Path(args.lifecycle_result).read_text())
    assert evidence['name'].startswith('accept-') and evidence['status'] == 'passed'
    machine = evidence['machine_id']
    base = [str(Path(args.binary).resolve()), '--config', str(Path(args.config).resolve())]

    def run(*command, data=None):
        return subprocess.check_output(base + list(command), input=data, text=True, timeout=45)

    def mapping(available):
        deadline = time.monotonic() + 30
        rows = []
        while time.monotonic() < deadline:
            query = subprocess.run(base + ['ports', machine], capture_output=True, text=True, timeout=15)
            if query.returncode:
                time.sleep(1)
                continue
            rows = json.loads(query.stdout)
            for row in rows or []:
                if row['guest'] == {'host': '127.0.0.1', 'port': 18347} and row['available'] == available:
                    return row['local']
            time.sleep(1)
        raise AssertionError(f'expected availability {available}: {rows}')

    directory = '/tmp/' + evidence['name'] + '-connections'
    start = f'nohup python3 -m http.server 18347 --bind 127.0.0.1 --directory {directory} >{directory}/server.log 2>&1 </dev/null & echo $! >{directory}/server.pid\n'
    start += f'''i=0
until curl -fsS http://127.0.0.1:18347/ >/dev/null 2>&1; do
  kill -0 "$(cat {directory}/server.pid)"
  i=$((i+1)); test "$i" -lt 30
  sleep 1
done
'''
    stop = f'kill "$(cat {directory}/server.pid)"\n'
    consumers = []
    try:
        run('ssh', machine, 'sh -se', data=f'mkdir -p {directory}\nprintf connection-ok >{directory}/index.html\n' + start)
        for _ in range(2):
            consumers.append(subprocess.Popen(base + ['connect', machine], stdout=subprocess.DEVNULL))
        address = mapping(True)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open('http://' + address, timeout=10) as response:
            assert response.read() == b'connection-ok'
        url = json.loads(run('url', machine, 'http://localhost:18347/a%20b?q=x%26y#z'))['url']
        assert url == 'http://' + address + '/a%20b?q=x%26y#z', url
        consumers[0].send_signal(signal.SIGINT)
        consumers[0].wait(timeout=15)
        assert mapping(True) == address
        run('ssh', machine, 'sh -se', data=stop)
        assert mapping(False) == address
        run('ssh', machine, 'sh -se', data=start)
        assert mapping(True) == address
        print(json.dumps({'machine_id': machine, 'http': True, 'url_preserved': True,
                          'independent_consumers': True, 'stable_listener_churn': True}))
    except Exception:
        # Keep guest startup errors visible before removing the disposable files.
        try:
            print(run('ssh', machine, 'cat ' + directory + '/server.log'), file=sys.stderr)
        except subprocess.SubprocessError as error:
            print('Could not read guest startup log:', error, file=sys.stderr)
        raise
    finally:
        already_failed = sys.exception() is not None
        for consumer in consumers:
            if consumer.poll() is None:
                consumer.send_signal(signal.SIGINT)
                consumer.wait(timeout=15)
        try:
            run('ssh', machine, 'sh -se', data=f'''if test -s {directory}/server.pid; then
  pid=$(cat {directory}/server.pid)
  if kill -0 "$pid" 2>/dev/null; then kill "$pid"; fi
fi
rm -rf {directory}
''')
        except subprocess.SubprocessError as error:
            if not already_failed:
                raise
            print('Guest cleanup failed after acceptance error:', error, file=sys.stderr)


if __name__ == '__main__':
    main()
