#!/usr/bin/env python3
"""Explicit live smoke test. Reads existing local Codex access token; never refreshes it.

Run only with authorization for one real model request. The disposable VM must
already contain probe.py and the pinned Codex package. Real credentials stay in
this laptop process; the guest receives only synthetic credentials.
"""
import base64
import http.client
import http.server
import json
from pathlib import Path
import subprocess
import threading
import time
import tomllib

MACHINE='auth-exp-codex'
observed=[]
token=''
account=''


class Broker(http.server.BaseHTTPRequestHandler):
    def log_message(self,*_):
        pass

    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type','application/json')
        self.end_headers(); self.wfile.write(b'{"models":[],"data":[]}')

    def do_CONNECT(self):
        self.send_error(403)

    def do_POST(self):
        body=self.rfile.read(int(self.headers.get('Content-Length','0')))
        if self.path!='/v1/responses':
            self.send_error(404); return
        headers={k:v for k,v in self.headers.items() if k.lower() not in
                 {'host','authorization','chatgpt-account-id','connection','content-length','accept-encoding','content-type'}}
        headers.update({'Authorization':'Bearer '+token,'ChatGPT-Account-Id':account,
                        'Content-Type':'application/json','Accept-Encoding':'identity','Connection':'close'})
        conn=http.client.HTTPSConnection('chatgpt.com',timeout=90)
        try:
            conn.request('POST','/backend-api/codex/responses',body,headers)
            response=conn.getresponse()
            observed.append({'path':'/backend-api/codex/responses','status':response.status})
            self.send_response(response.status)
            self.send_header('Content-Type',response.getheader('Content-Type','text/event-stream'))
            self.end_headers()
            if response.status!=200:
                raw=response.read()
                try:
                    detail=json.loads(raw)
                    message=detail.get('error',{}).get('message') if isinstance(detail.get('error'),dict) else detail.get('detail',detail.get('error'))
                    observed[-1]['error']=str(message).replace(token,'[redacted]').replace(account,'[account]')[:400]
                except (ValueError,AttributeError):pass
                self.wfile.write(b'{"error":{"message":"upstream auth probe failed"}}')
                return
            while chunk:=response.read1(16384):
                self.wfile.write(chunk); self.wfile.flush()
        finally:
            conn.close()


def main():
    global token,account
    path=Path.home()/'.codex/auth.json'
    original=path.read_bytes(); auth=json.loads(original)
    selected_model=tomllib.loads((Path.home()/'.codex/config.toml').read_text())['model']
    token=auth['tokens']['access_token']; account=auth['tokens']['account_id']
    claims=json.loads(base64.urlsafe_b64decode(token.split('.')[1]+'==='))
    assert claims['exp']-time.time()>300,'Access token expired or too near expiry; no refresh attempted'
    broker=http.server.ThreadingHTTPServer(('127.0.0.1',0),Broker)
    threading.Thread(target=broker.serve_forever,daemon=True).start()
    ssh=subprocess.Popen(['ssh','-F',str(Path.home()/'.local/state/clankerbox/ssh_config'),
                          '-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-N',
                          '-R',f'127.0.0.1:18080:127.0.0.1:{broker.server_port}','cb.'+MACHINE],
                         stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    try:
        for _ in range(15):
            probe=subprocess.run(['clankerbox','exec',MACHINE,'--','curl','--max-time','2','-sf','http://127.0.0.1:18080/'],capture_output=True)
            if probe.returncode==0:break
            assert ssh.poll() is None,'SSH reverse relay failed: '+ssh.stderr.read().decode()
            time.sleep(0.2)
        else:raise RuntimeError('relay not ready')
        setup='''import sys,json,datetime
from pathlib import Path
sys.path.insert(0,"/opt/auth-probe")
from probe import jwt
home=Path.home()/".codex"
c=(home/"config.toml").read_text()
import re
c=re.sub(r"http://127.0.0.1:[0-9]+", "http://127.0.0.1:18080", c)
c=re.sub(r'^model =.*$', 'model = '+json.dumps(MODEL_LITERAL),c,flags=re.M)
(home/"config.toml").write_text(c)
auth={"auth_mode":"chatgpt","OPENAI_API_KEY":None,"tokens":{"access_token":jwt(),"id_token":jwt(),"refresh_token":"probe-only-no-upstream-refresh","account_id":"probe-account"},"last_refresh":datetime.datetime.now(datetime.timezone.utc).isoformat()}
(home/"auth.json").write_text(json.dumps(auth)); (home/"auth.json").chmod(0o600)
'''
        subprocess.run(['clankerbox','exec',MACHINE,'--','runuser','-l','authprobe','-c','python3 -'],input=setup.replace('MODEL_LITERAL',repr(selected_model)),text=True,check=True,capture_output=True)
        command=('HTTPS_PROXY=http://127.0.0.1:18080 HTTP_PROXY=http://127.0.0.1:18080 '
                 'ALL_PROXY=http://127.0.0.1:18080 NO_PROXY=127.0.0.1,localhost '
                 '/opt/auth-probe/node_modules/.bin/codex exec --skip-git-repo-check '
                 '--ephemeral --json --dangerously-bypass-approvals-and-sandbox '
                 '"Reply only AUTH_PROBE_OK. Do not use tools."')
        result=subprocess.run(['clankerbox','exec',MACHINE,'--','runuser','-l','authprobe','-c',command],capture_output=True,text=True,timeout=110)
        output_events=[]
        for line in result.stdout.splitlines():
            try:
                event=json.loads(line)
                output_events.append(event.get('type'))
            except ValueError:pass
        print(json.dumps({'model':selected_model,'exit_code':result.returncode,'marker_received':'AUTH_PROBE_OK' in result.stdout,
                          'events':output_events,'requests':observed,
                          'local_auth_unchanged':path.read_bytes()==original,
                          'real_refresh_token_transferred':False,'real_access_token_in_guest':False},indent=2))
    finally:
        ssh.terminate()
        try:ssh.wait(timeout=5)
        except subprocess.TimeoutExpired:ssh.kill(); ssh.wait()
        broker.shutdown()


if __name__=='__main__':main()
