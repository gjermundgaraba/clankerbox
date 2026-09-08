#!/usr/bin/env python3
"""Run as an isolated Linux user. Uses fake credentials and loopback HTTP only."""
import base64
import datetime
import http.server
import json
import os
from pathlib import Path
import subprocess
import ssl
import threading
import time

CODEX = '/opt/auth-probe/node_modules/.bin/codex'
events = []
mode = 'success'
refreshed = False
tls_context = None


class Refresh(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        global refreshed
        self.rfile.read(int(self.headers.get('Content-Length', '0')))
        events.append({'method':'POST','path':'https://auth.openai.com'+self.path,
                       'mock_refresh':True})
        refreshed = True
        body=json.dumps({'access_token':jwt(),'id_token':jwt(),
                         'refresh_token':'probe-rotated-placeholder','expires_in':3600}).encode()
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(body)))
        self.end_headers(); self.wfile.write(body)


class Mock(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def record(self):
        events.append({'method': self.command, 'path': self.path,
                       'authorization_present': bool(self.headers.get('Authorization')),
                       'account_header': self.headers.get('ChatGPT-Account-Id'),
                       'upgrade': self.headers.get('Upgrade')})

    def do_CONNECT(self):
        self.record()
        if self.path != 'auth.openai.com:443' or mode != 'refresh':
            self.send_error(403)
            return
        self.send_response(200); self.end_headers()
        self.wfile.flush()
        with tls_context.wrap_socket(self.connection,server_side=True) as conn:
            Refresh(conn,self.client_address,self.server)
        self.close_connection=True

    def do_GET(self):
        self.record()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"models":[],"data":[]}')

    def do_POST(self):
        self.record()
        self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if mode == 'unauthorized' or (mode == 'refresh' and not refreshed and self.path.endswith('/responses')):
            self.send_response(401)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"probe authorization revoked","type":"invalid_request_error","code":"invalid_api_key"}}')
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        message = {'id':'msg_probe','type':'message','role':'assistant','status':'completed',
                   'content':[{'type':'output_text','text':'AUTH_PROBE_OK','annotations':[]}]}
        response = {'id':'resp_probe','object':'response','created_at':int(time.time()),
                    'status':'completed','model':'gpt-5.4','output':[message],
                    'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}
        stream = [
            {'type':'response.created','response':dict(response,status='in_progress',output=[])},
            {'type':'response.output_item.added','output_index':0,'item':dict(message,status='in_progress',content=[])},
            {'type':'response.content_part.added','item_id':'msg_probe','output_index':0,'content_index':0,'part':{'type':'output_text','text':'','annotations':[]}},
            {'type':'response.output_text.delta','item_id':'msg_probe','output_index':0,'content_index':0,'delta':'AUTH_PROBE_OK'},
            {'type':'response.output_text.done','item_id':'msg_probe','output_index':0,'content_index':0,'text':'AUTH_PROBE_OK'},
            {'type':'response.output_item.done','output_index':0,'item':message},
            {'type':'response.completed','response':response},
        ]
        for event in stream:
            self.wfile.write(('event: '+event['type']+'\ndata: '+json.dumps(event)+'\n\n').encode())
        self.wfile.flush()


def jwt():
    payload={'email':'auth-probe@example.invalid','exp':int(time.time())+3600,
             'https://api.openai.com/auth':{'chatgpt_account_id':'probe-account','chatgpt_plan_type':'plus'}}
    enc=lambda d:base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip('=')
    return enc({'alg':'none','typ':'JWT'})+'.'+enc(payload)+'.probe'


def main():
    global mode, refreshed, tls_context
    assert Path.home() == Path('/home/authprobe')
    assert os.readlink('/proc/self/ns/net') != os.readlink('/proc/1/ns/net'), 'Run in isolated network namespace'
    home=Path.home()/'.codex'
    home.mkdir(mode=0o700,exist_ok=True)
    cert=Path.home()/'mock-auth-cert.pem'; key=Path.home()/'mock-auth-key.pem'
    ca=Path.home()/'mock-ca.pem'; cakey=Path.home()/'mock-ca-key.pem'
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1',
                    '-subj','/CN=Clankerbox disposable probe CA','-addext','basicConstraints=critical,CA:TRUE',
                    '-keyout',str(cakey),'-out',str(ca)],check=True,capture_output=True)
    csr=Path.home()/'mock-auth.csr'; ext=Path.home()/'mock-auth.ext'
    ext.write_text('subjectAltName=DNS:auth.openai.com\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n')
    subprocess.run(['openssl','req','-new','-newkey','rsa:2048','-nodes','-subj','/CN=auth.openai.com',
                    '-keyout',str(key),'-out',str(csr)],check=True,capture_output=True)
    subprocess.run(['openssl','x509','-req','-in',str(csr),'-CA',str(ca),'-CAkey',str(cakey),
                    '-CAcreateserial','-days','1','-extfile',str(ext),'-out',str(cert)],check=True,capture_output=True)
    key.chmod(0o600)
    tls_context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); tls_context.load_cert_chain(cert,key)
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Mock)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    base=f'http://127.0.0.1:{server.server_port}'
    config=f'''model = "gpt-5.4"
model_provider = "probe"
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
chatgpt_base_url = "{base}"
[analytics]
enabled = false
[model_providers.probe]
name = "Loopback auth experiment"
base_url = "{base}/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
'''
    (home/'config.toml').write_text(config)
    env=dict(os.environ,HTTPS_PROXY=base,HTTP_PROXY=base,ALL_PROXY=base,
             NO_PROXY='127.0.0.1,localhost',CODEX_CA_CERTIFICATE=str(ca),SSL_CERT_FILE=str(ca))
    results=[]
    for auth_mode in ['apikey','chatgpt']:
        auth={'auth_mode':auth_mode,'OPENAI_API_KEY':'probe-not-a-real-key'}
        if auth_mode=='chatgpt':
            auth={'auth_mode':'chatgpt','OPENAI_API_KEY':None,
                  'tokens':{'access_token':jwt(),'id_token':jwt(),
                            'refresh_token':'probe-not-a-real-refresh-token','account_id':'probe-account'},
                  'last_refresh':datetime.datetime.now(datetime.timezone.utc).isoformat()}
        for mode in (['success','unauthorized','refresh'] if auth_mode=='chatgpt' else ['success','unauthorized']):
            refreshed=False
            (home/'auth.json').write_text(json.dumps(auth)); (home/'auth.json').chmod(0o600)
            events.clear()
            args=[CODEX,'exec','--skip-git-repo-check','--ephemeral','--json',
                  '--dangerously-bypass-approvals-and-sandbox','Reply only AUTH_PROBE_OK. Do not use tools.']
            started=time.monotonic()
            try:
                p=subprocess.run(args,env=env,cwd=Path.home(),capture_output=True,text=True,timeout=45)
                result={'auth_mode':auth_mode,'mock':mode,'exit_code':p.returncode,
                        'completed_text':'AUTH_PROBE_OK' in p.stdout,
                        'stdout':p.stdout[-3500:],'stderr':p.stderr[-2500:]}
            except subprocess.TimeoutExpired:
                result={'auth_mode':auth_mode,'mock':mode,'timeout':True}
            result.update(elapsed_seconds=round(time.monotonic()-started,2),requests=list(events))
            results.append(result)
    server.shutdown()
    print(json.dumps({'version':subprocess.check_output([CODEX,'--version'],text=True).strip(),
                      'results':results},indent=2))


if __name__=='__main__':
    main()
