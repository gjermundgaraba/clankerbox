#!/usr/bin/env python3
import json,pathlib,subprocess,urllib.request,time,sys,plistlib,os
C=pathlib.Path(__file__).resolve().parents[2]/'.work/real-local-engine/mac.json';cfg=json.loads(C.read_text());root=pathlib.Path(cfg['root']);driver=pathlib.Path(__file__).with_name('control.py');report=json.loads((root/'mac-acceptance.json').read_text())
def run(*a,ok=True):
 p=subprocess.run([sys.executable,str(driver),*a],capture_output=True,text=True)
 if ok and p.returncode:raise RuntimeError(p.stderr+p.stdout)
 return p

def guest(n,s):return run('machine','exec','--name',n,'--','sh','-c',s).stdout.strip()
def require(c,m):
 if not c:raise RuntimeError(m)
def http(port):return json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/',timeout=10))
def save(): (root/'mac-acceptance.json').write_text(json.dumps(report,indent=2))
def kick(name,argv):
 p=plistlib.loads((root/'parent.plist').read_bytes());p['Label']=cfg['label'].removesuffix('parent')+name;p['ProgramArguments']=[cfg['binary'],*argv];p['StandardOutPath']=p['StandardErrorPath']=str(root/('launch-'+name+'.log'));path=root/(name+'.plist');path.write_bytes(plistlib.dumps(p));subprocess.run(['launchctl','bootstrap',cfg['domain'],str(path)],check=True);subprocess.run(['launchctl','kickstart',cfg['domain']+'/'+p['Label']],check=True)
 for _ in range(120):
  p=run('machine','status','--name',argv[argv.index('--name')+1],ok=False)
  if ': running ' in p.stdout:return
  time.sleep(.25)
 raise RuntimeError('launch did not become running')
if os.environ.get('GATE_RESUME_AFTER_STOP') != '1':
 run('machine','stop','--name','gate-parent')
 p=run('machine','delete','--force','--name','gate-parent',ok=False);require(p.returncode!=0,'source deletion with child accepted');report['dependent_source_delete_rejected']=p.stderr+p.stdout;save()
 subprocess.run(['launchctl','kickstart',cfg['domain']+'/'+cfg['label']],check=True)
 for _ in range(80):
  p=run('machine','status','--name','gate-parent')
  if ': running ' in p.stdout:break
  time.sleep(.25)
 require(guest('gate-parent','cat /root/gate-disk')=='parent-B','source cold disk retention');report['cold_parent_with_descendant']=True
 require(http(48182)['count']==3,'child lost RAM with source restart');run('machine','stop','--name','gate-parent');run('machine','stop','--name','gate-child');run('machine','delete','--force','--name','gate-child');run('machine','delete','--force','--name','gate-parent')
else:
 report['cold_parent_with_descendant']=True
 run('machine','delete','--force','--name','gate-child');run('machine','delete','--force','--name','gate-parent')
for name in ['parent','child']:subprocess.run(['launchctl','bootout',cfg['domain']+'/'+cfg['label'].removesuffix('parent')+name],check=True)
report['source_and_child_deleted']=True;save()
for ix in [1,2]:
 name='gate-restore'+str(ix);port=48182+ix
 run('machine','create','--name',name,'--from',str(root/'portable.smolcheckpoint'))
 run('machine','update','--name',name,'--remove-port','48181:18080','--port',str(port)+':18080')
 kick('restore'+str(ix),['machine','start','--name',name,'--branchable'])
 a=http(port);require(a==report['after_capture'],'portable RAM differed');require(guest(name,'cat /root/gate-disk')=='parent-B','portable disk differed')
 guest(name,'echo restore-'+str(ix)+' > /root/gate-disk; sync');report['restore'+str(ix)]={'ram':a,'disk':guest(name,'cat /root/gate-disk')};save()
 # Sequential restore keeps a two-VM maximum and proves retained cold disk after RAM restoration.
 run('machine','stop','--name',name);subprocess.run(['launchctl','kickstart',cfg['domain']+'/'+cfg['label'].removesuffix('parent')+'restore'+str(ix)],check=True)
 for _ in range(80):
  p=run('machine','status','--name',name)
  if ': running ' in p.stdout:break
  time.sleep(.25)
 require(guest(name,'cat /root/gate-disk')=='restore-'+str(ix),'restored cold disk retention');report['restore'+str(ix)]['cold_retained']=True;save()
 run('machine','stop','--name',name);run('machine','delete','--force','--name',name);subprocess.run(['launchctl','bootout',cfg['domain']+'/'+cfg['label'].removesuffix('parent')+'restore'+str(ix)],check=True)
report['complete']=True;save();print(json.dumps(report,indent=2))
