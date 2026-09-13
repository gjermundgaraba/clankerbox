#!/usr/bin/env python3
import json,pathlib,subprocess,urllib.request,time,sys,os
root=pathlib.Path(os.environ['ENGINE_GATE_CONFIG']).parent;cfg=json.loads((root/'config.json').read_text());driver=root/'control.py';report=json.loads((root/'acceptance.json').read_text())
def run(*a,ok=True):
 p=subprocess.run([sys.executable,str(driver),*a],capture_output=True,text=True)
 if ok and p.returncode:raise RuntimeError(p.stderr+p.stdout)
 return p

def guest(n,s):return run('machine','exec','--name',n,'--','sh','-c',s).stdout.strip()
def require(c,m):
 if not c:raise RuntimeError(m)
def http(port):return json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/',timeout=10))
def save(): (root/'acceptance.json').write_text(json.dumps(report,indent=2))
def unit(n):return 'clankerbox-engine-'+root.name+'-'+n+'.service'
def ctl(*a):subprocess.run(['systemctl','--user',*a],check=True)
def stop(n):run('machine','stop','--name','gate-'+n);ctl('stop',unit(n))
def remove_unit(n):ctl('disable',unit(n));ctl('daemon-reload')
stop('parent');p=run('machine','delete','--force','--name','gate-parent',ok=False);require(p.returncode!=0,'dependent source deletion accepted');report['dependent_source_delete_rejected']=p.stderr+p.stdout;save()
ctl('start',unit('parent'));require(guest('gate-parent','cat /root/gate-disk')=='parent-B','source cold disk');require(http(48182)['count']==3,'child RAM after source restart');report['cold_parent_with_descendant']=True;save()
stop('parent');stop('child');run('machine','delete','--force','--name','gate-child');run('machine','delete','--force','--name','gate-parent');remove_unit('parent');remove_unit('child');report['source_and_child_deleted']=True;save()
for ix in [1,2]:
 name='gate-restore';port=48183
 run('machine','create','--name',name,'--from',str(root/'portable.smolcheckpoint'));run('machine','update','--name',name,'--remove-port','48181:18080','--port',str(port)+':18080')
 subprocess.run([sys.executable,str(root/'supervise_linux.py'),str(root),'restore','machine','start','--name',name,'--branchable'],check=True)
 a=http(port);require(a==report['after_capture'],'portable RAM differs');require(guest(name,'cat /root/gate-disk')=='parent-B','portable disk differs')
 guest(name,'echo restore-'+str(ix)+' > /root/gate-disk; sync');report['restore'+str(ix)]={'ram':a,'disk':guest(name,'cat /root/gate-disk')};save()
 stop('restore');ctl('start',unit('restore'));require(guest(name,'cat /root/gate-disk')=='restore-'+str(ix),'restored cold disk retention');report['restore'+str(ix)]['cold_retained']=True;save()
 stop('restore');run('machine','delete','--force','--name',name);remove_unit('restore')
report['complete']=True;save();print(json.dumps(report,indent=2))
