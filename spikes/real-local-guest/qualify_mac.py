#!/usr/bin/env python3
"""Owned real-VM PTY/VT identity gate; invoke only on the handed-off gate root."""
import argparse,json,os,pathlib,plistlib,subprocess,time,uuid

p=argparse.ArgumentParser();p.add_argument('--config',required=True);p.add_argument('--resume-copy',action='store_true');a=p.parse_args()
c=json.loads(pathlib.Path(a.config).read_text());root=pathlib.Path(c['root'])
if not str(root).startswith('/private/tmp/cbre-guest-'):raise RuntimeError('requires explicitly handed-off guest gate root')
repo=pathlib.Path(__file__).resolve().parents[2];local=repo/'spikes/real-local-guest/.tools/guest-gate'
env=os.environ.copy();env.update(c['env']);evidence={};commands=[]
def execute(argv,**kwargs):
    r=subprocess.run(argv,capture_output=True,timeout=180,**kwargs)
    # Never record stdin or credential contents.
    commands.append({'argv':[str(v) for v in argv],'returncode':r.returncode})
    if r.returncode:raise RuntimeError(f'{argv[:4]}: {r.stderr.decode(errors="replace")[-4000:]}')
    return r.stdout.decode()
def engine(*args):return execute([c['binary'],*args],env=env)
def guest(name,script):return engine('machine','exec','--name',name,'--','sh','-c',script)
def cli(machine,port,action,*extra):
    out=execute([str(local),'client','--credentials',str(root/'credentials/host.json'),'--machine',machine,'--address',f'127.0.0.1:{port}','--action',action,*extra]);return json.loads(out)
def save():
    (root/'guest-acceptance.json').write_text(json.dumps(evidence,indent=2)+'\n')
    (root/'guest-commands.json').write_text(json.dumps(commands,indent=2)+'\n')
def require(v,msg):
    if not v:raise RuntimeError(msg)
def launch(name,args):
    label='org.clankerbox.guest-gate.'+root.name+'.'+name
    out=root/(name+'.log');plist=root/(name+'.plist')
    plist.write_bytes(plistlib.dumps({'Label':label,'ProgramArguments':[c['binary'],*args],'EnvironmentVariables':c['env'],'RunAtLoad':False,'KeepAlive':False,'AbandonProcessGroup':True,'StandardOutPath':str(out),'StandardErrorPath':str(out)}))
    execute(['launchctl','bootstrap',c.get('domain','gui/'+str(os.getuid())),str(plist)])
    execute(['launchctl','kickstart',c.get('domain','gui/'+str(os.getuid()))+'/'+label])
    for _ in range(240):
        try: result=engine('machine','status','--name',name)
        except RuntimeError: result=''
        if ': running ' in result:return
        time.sleep(.25)
    raise RuntimeError('launch did not report running')
def rebind(name,identity):
    engine('machine','cp',str(root/'credentials'/f'{identity}.json'),name+':/root/rebind.json','--mode','600')
    guest(name,'/root/guest-gate rebind --state /root/ggate < /root/rebind.json && rm /root/rebind.json')
def verify(identity,port,session,expected,word,cursor):
    inventory=cli(identity,port,'list')['sessions'];require(len(inventory)==1,'session missing after copy')
    record=inventory[0];require(record['pid']==expected['pid'],'PTY PID changed');require(record['incarnation']==expected['incarnation'],'manager incarnation changed')
    result=cli(identity,port,'send','--session',session,'--input',word+'\n','--marker',':'+word,'--cursor',str(cursor))
    line=next(v for v in result['output'].splitlines() if v.endswith(':'+word))
    require(line.split(':')[0]==evidence['ram_value'],'shell RAM changed')
    return result

try:
    if a.resume_copy:
        evidence=json.loads((root/'guest-acceptance.json').read_text());record=evidence['session'];session=record['id'];before=evidence['parent'];parent='guest-parent';parent_port=48191;child='guest-child';child_port=48192
    else:
        if not (root/'credentials').exists(): execute([str(local),'credentials','--state',str(root/'credentials')])
        parent=c.get('machine','guest-parent');parent_port=c.get('port',48191)
        guest(parent,'chown 0:0 /root /tmp; chmod 700 /root; chmod 1777 /tmp; chmod 755 /home /etc; chmod -R a+rX /bin /sbin /usr /lib; mkdir -p /home/gate-workload; chown 1001:1001 /home/gate-workload; chmod 700 /home/gate-workload')
        engine('machine','cp',str(repo/'spikes/real-local-guest/.tools/guest-gate-linux-arm64'),parent+':/root/guest-gate','--mode','700')
        engine('machine','cp',str(root/'credentials/parent.json'),parent+':/root/parent.json','--mode','600')
        engine('machine','exec','--name',parent,'--detach','--','env','CLANKERBOX_GATE_WORKLOAD_UID=1001','CLANKERBOX_GATE_WORKLOAD_GID=1001','CLANKERBOX_GATE_WORKLOAD_HOME=/home/gate-workload','CLANKERBOX_GATE_WORKLOAD_USER=gate-workload','/root/guest-gate','serve','--state','/root/ggate','--binding','/root/parent.json','--address','0.0.0.0:7443')
        for attempt in range(60):
            try:cli('parent',parent_port,'describe');break
            except RuntimeError:
                if attempt==59:raise
                time.sleep(.25)
        session=str(uuid.uuid4());record=cli('parent',parent_port,'create','--session',session)
        before=cli('parent',parent_port,'send','--session',session,'--input','before\n','--marker',':before')
        evidence['parent']=before;evidence['session']=record
        evidence['ram_value']=next(v.split(':')[0] for v in before['output'].splitlines() if v.endswith(':before'))
        save()
        child='guest-child';child_port=parent_port+1
        launch(child,['machine','fork','--from',parent,'--name',child,'--branchable','--port',f'{child_port}:7443'])
    if not a.resume_copy:
        try:cli('child',child_port,'describe');raise AssertionError('unbound child identity accepted')
        except RuntimeError:pass
    rebind(child,'child')
    evidence['child']=verify('child',child_port,session,record,'child',before['cursor'])
    evidence['source_after_branch']=verify('parent',parent_port,session,record,'source',before['cursor']);save()
    checkpoint=root/'guest.smolcheckpoint';engine('machine','checkpoint','--name',parent,'--output',str(checkpoint))
    evidence['source_after_capture']=verify('parent',parent_port,session,record,'capture',evidence['source_after_branch']['cursor']);save()
    # Child must be removed before parent; no cascade or unrelated state deletion.
    for name in [child,parent]:
        engine('machine','stop','--name',name);engine('machine','delete','--force','--name',name)
        if name != parent: execute(['launchctl','bootout',c.get('domain','gui/'+str(os.getuid()))+'/org.clankerbox.guest-gate.'+root.name+'.'+name])
    restored='guest-restore';restore_port=parent_port+2
    engine('machine','create','--name',restored,'--from',str(checkpoint))
    engine('machine','update','--name',restored,'--remove-port',f'{parent_port}:7443','--port',f'{restore_port}:7443')
    launch(restored,['machine','start','--name',restored,'--branchable'])
    rebind(restored,'restore')
    evidence['restore']=verify('restore',restore_port,session,record,'restored',evidence['source_after_branch']['cursor'])
    evidence['complete']=True;save()
    print(json.dumps(evidence,indent=2))
finally:save()
