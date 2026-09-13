#!/usr/bin/env python3
import json,pathlib,subprocess,urllib.request,time,sys,os
C=pathlib.Path(os.environ.get('ENGINE_GATE_CONFIG',str(pathlib.Path(__file__).resolve().parents[2]/'.work/real-local-engine/mac.json')));cfg=json.loads(C.read_text());root=pathlib.Path(cfg['root']);driver=pathlib.Path(__file__).with_name('control.py')
def run(*a,ok=True):
 p=subprocess.run([sys.executable,str(driver),*a],capture_output=True,text=True)
 if ok and p.returncode:raise RuntimeError(p.stderr+p.stdout)
 return p

def http(port,post=False):
 req=urllib.request.Request(f'http://127.0.0.1:{port}/',method='POST' if post else 'GET')
 for attempt in range(10):
  try:return json.load(urllib.request.urlopen(req,timeout=5))
  except OSError:
   if attempt==9:raise
   time.sleep(.3)

def guest(name,script):return run('machine','exec','--name',name,'--','sh','-c',script).stdout.strip()
def require(condition,message):
 if not condition:raise RuntimeError(message)
report={}
a=http(48181);b=http(48182);require(a==b,'branch RAM differs');report['inherited']=a
http(48181,True);http(48182,True);http(48182,True)
a=http(48181);b=http(48182);require(a['count']==2 and b['count']==3 and a['token']==b['token'],'RAM independence');report['diverged']=[a,b]
guest('gate-parent','echo parent-B > /root/gate-disk; sync');guest('gate-child','echo child-C > /root/gate-disk; sync')
require(guest('gate-parent','cat /root/gate-disk')=='parent-B','parent disk');require(guest('gate-child','cat /root/gate-disk')=='child-C','child disk');report['disk_independent']=True
(root/'acceptance.json').write_text(json.dumps(report,indent=2))
p=run('machine','checkpoint','--name','gate-parent','--output',str(root/'portable.smolcheckpoint'))
report['capture']=p.stdout;report['after_capture']=http(48181);require(report['after_capture']==a,'source continuity')
(root/'acceptance.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
