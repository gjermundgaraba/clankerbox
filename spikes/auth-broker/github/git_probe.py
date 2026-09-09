#!/usr/bin/env python3
"""Exercise real Git smart HTTP through loopback URL rewrites; no GitHub access."""
import http.server,json,os,subprocess,tempfile,threading
from pathlib import Path
from urllib.parse import urlsplit

def run(args, cwd=None):
    return subprocess.run(args,cwd=cwd,env=env,check=True,capture_output=True,text=True).stdout.strip()

with tempfile.TemporaryDirectory(prefix='clankerbox-git-routing-') as tmp:
    root=Path(tmp)
    env={'PATH':os.environ['PATH'],'HOME':tmp,'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':str(root/'gitconfig'),'GIT_TERMINAL_PROMPT':'0'}
    backend=Path(run(['git','--exec-path']))/'git-http-backend'
    repo=root/'repos'/'owner'/'private.git';repo.parent.mkdir(parents=True)
    run(['git','init','--bare',str(repo)])
    run(['git','--git-dir',str(repo),'config','http.receivepack','true'])
    seed=root/'seed';run(['git','init',str(seed)])
    run(['git','config','user.email','probe@example.invalid'],seed);run(['git','config','user.name','Routing Probe'],seed)
    (seed/'hello').write_text('first\n');run(['git','add','.'],seed);run(['git','commit','-m','fixture'],seed)
    run(['git','push',str(repo),'HEAD:refs/heads/main'],seed);run(['git','--git-dir',str(repo),'symbolic-ref','HEAD','refs/heads/main'])
    records=[]
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):self.handle_git()
        def do_POST(self):self.handle_git()
        def handle_git(self):
            u=urlsplit(self.path)
            if not u.path.startswith('/github/git/'):
                self.send_error(404);return
            body=self.rfile.read(int(self.headers.get('Content-Length','0')))
            records.append({'method':self.command,'path':u.path,'query':u.query,'guest_authorization_present':bool(self.headers.get('Authorization'))})
            cgienv=dict(env,GIT_PROJECT_ROOT=str(root/'repos'),GIT_HTTP_EXPORT_ALL='1',PATH_INFO=u.path.removeprefix('/github/git'),QUERY_STRING=u.query,REQUEST_METHOD=self.command,CONTENT_TYPE=self.headers.get('Content-Type',''),CONTENT_LENGTH=str(len(body)),REMOTE_USER='probe',SERVER_PROTOCOL='HTTP/1.1',HTTP_GIT_PROTOCOL=self.headers.get('Git-Protocol',''))
            raw=subprocess.run([str(backend)],input=body,env=cgienv,check=True,capture_output=True).stdout
            head,data=raw.split(b'\r\n\r\n',1); headers=[line.decode().split(': ',1) for line in head.split(b'\r\n')]
            status=next((int(v.split()[0]) for k,v in headers if k.lower()=='status'),200)
            self.send_response(status)
            for k,v in headers:
                if k.lower()!='status': self.send_header(k,v)
            self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    srv=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=srv.serve_forever,daemon=True).start()
    base=f'http://127.0.0.1:{srv.server_port}/github/git/'
    for prefix in ['https://github.com/','git@github.com:','ssh://git@github.com/']:
        run(['git','config','--global','--add',f'url.{base}.insteadOf',prefix])
    for i,url in enumerate(['https://github.com/owner/private.git','git@github.com:owner/private.git','ssh://git@github.com/owner/private.git']):
        clone=root/f'clone{i}';run(['git','clone',url,str(clone)])
        assert run(['git','config','--get','remote.origin.url'],clone)==url
        run(['git','config','user.email','probe@example.invalid'],clone);run(['git','config','user.name','Routing Probe'],clone)
        (clone/'hello').write_text(f'change{i}\n');run(['git','commit','-am','update'],clone);run(['git','push','origin','main'],clone);run(['git','fetch','origin'],clone)
    srv.shutdown();srv.server_close()
    result={'git_version':run(['git','--version']),'clone_fetch_push_all_three_url_forms':True,'canonical_remote_preserved':True,'real_credentials_used':False,'requests':records}
    Path(__file__).with_name('git-results.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k!='requests'}))
