#!/usr/bin/env python3
"""Synthetic broker outside VMs; actual CLI + live fork + checkpoint restore.

Requires the prepared auth-exp-codex VM from the Codex probe, with temporary
loopback-only SSH remote forwarding enabled. Does not read real credentials.
"""
import argparse
import concurrent.futures
import http.server
import json
from pathlib import Path
import subprocess
import threading
import time

import probe

parent='auth-exp-codex'
children=[]
checkpoint=None
generation=1
calls=[]
revoked=set()
tunnels=[]
servers=[]


def cb(*args):
    return subprocess.check_output(['clankerbox','--json',*args],text=True)


def bind(name):
    class Gateway(probe.Mock):
        def do_POST(self):
            if self.path.endswith('/responses'):
                calls.append({'machine':name,'generation':generation,'revoked':name in revoked})
                if name in revoked:
                    self.rfile.read(int(self.headers.get('Content-Length','0')))
                    self.send_response(403); self.end_headers()
                    self.wfile.write(b'{"error":{"message":"machine binding revoked"}}')
                    return
            super().do_POST()
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Gateway)
    servers.append(server)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    cb('exec',name,'--','sh','-c',
       "sed -i 's/^AllowTcpForwarding .*/AllowTcpForwarding yes/; s/^PermitListen .*/PermitListen 127.0.0.1:18080/' /etc/ssh/sshd_config && sshd -t && pkill -HUP -x sshd")
    tunnel=subprocess.Popen(['ssh','-F',str(Path.home()/'.local/state/clankerbox/ssh_config'),
                             '-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-N',
                             '-R',f'127.0.0.1:18080:127.0.0.1:{server.server_port}','cb.'+name],
                            stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    tunnels.append(tunnel)
    for _ in range(15):
        p=subprocess.run(['clankerbox','exec',name,'--','curl','-sf','--max-time','2','http://127.0.0.1:18080/'],capture_output=True)
        if p.returncode==0:return
        if tunnel.poll() is not None:raise RuntimeError(tunnel.stderr.read().decode())
        time.sleep(0.2)
    raise RuntimeError('relay not ready')


def turn(name):
    command=('HTTPS_PROXY=http://127.0.0.1:18080 HTTP_PROXY=http://127.0.0.1:18080 '
             'ALL_PROXY=http://127.0.0.1:18080 NO_PROXY=127.0.0.1,localhost '
             '/opt/auth-probe/node_modules/.bin/codex exec --skip-git-repo-check '
             '--ephemeral --json --dangerously-bypass-approvals-and-sandbox '
             '"Reply only AUTH_PROBE_OK. Do not use tools."')
    p=subprocess.run(['clankerbox','exec',name,'--','runuser','-l','authprobe','-c',command],capture_output=True,text=True,timeout=40)
    return {'machine':name,'exit_code':p.returncode,'marker_received':'AUTH_PROBE_OK' in p.stdout}


def main():
    global checkpoint,generation
    parser=argparse.ArgumentParser()
    parser.add_argument('--source-id',required=True,help='Expected ID of disposable auth-exp-codex VM')
    args=parser.parse_args()
    results=[]
    try:
        assert json.loads(cb('inspect',parent))['id']==args.source_id,'unexpected source machine'
        child='auth-exp-codex-fork'
        cb('fork',parent,child); children.append(child)
        cp=json.loads(cb('checkpoint','create',parent)); checkpoint=cp['id']
        for name in [parent,child]:bind(name)
        results.append({'phase':'before-rotation','turn':turn(parent)})
        generation=2
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results.append({'phase':'after-rotation-concurrent','turns':list(pool.map(turn,[parent,child]))})
        restored='auth-exp-codex-restored'
        cb('restore',checkpoint,restored); children.append(restored); bind(restored)
        results.append({'phase':'restore-old-checkpoint','turn':turn(restored)})
        revoked.add(child)
        results.append({'phase':'revoke-child','turn':turn(child)})
        results.append({'phase':'parent-still-authorized','turn':turn(parent)})
        print(json.dumps({'results':results,'broker_requests':calls,
                          'real_provider_credentials_used':False,
                          'broker_state_location':'laptop process, outside guest snapshots',
                          'agent_process_continuity_tested':False},indent=2),flush=True)
    finally:
        for p in tunnels:
            p.terminate()
            try:p.wait(timeout=5)
            except subprocess.TimeoutExpired:p.kill(); p.wait()
        for server in servers:server.shutdown()
        for name in reversed(children):
            subprocess.run(['clankerbox','stop',name],check=True,stdout=subprocess.DEVNULL)
            subprocess.run(['clankerbox','delete',name],check=True,stdout=subprocess.DEVNULL)
        if checkpoint:subprocess.run(['clankerbox','checkpoint','delete',checkpoint],check=True,stdout=subprocess.DEVNULL)


if __name__=='__main__':main()
