#!/usr/bin/env python3
"""Granted Cocoon real-agent fork run. Never reads credentials or application logs."""
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
import agent_gate
import agent_proxy
from rollback_host import HASHES, digest, inventory, require, wait_empty_group

STAGE = Path('/home/clanker/clankerbox-cocoon.b0ngM6')
RUN = STAGE / 'ca04'
GROUP = Path('/sys/fs/cgroup/cqagent420260905.slice')
NAMES = {'parent': 'cq-agent4-p', 'child-a': 'cq-agent4-a', 'child-b': 'cq-agent4-b'}
SOURCE = Path(__file__).resolve().parent

class Experiment:
    def __init__(self):
        self.evidence = dict(schema_version=1, status='running', checks={}, phases={}, metrics={},
                             run_dir=str(RUN), grant='cocoon-codex4-20260905', artifact_sha256=HASHES,
                             codex_binary_sha256='56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da',
                             timing_context='contended / concurrent smolvm host activity', limitations=[])
        self.servers = []; self.bridges = []; self.group_inode = None; self.runtime = False
        self.save_lock=threading.Lock()
        self.env = dict(os.environ, PATH=str(RUN/'tools/usr/bin')+':'+str(STAGE/'bin')+':'+os.environ['PATH'],
                        LD_LIBRARY_PATH=str(RUN/'tools/usr/lib/x86_64-linux-gnu'), GOMAXPROCS='4', GOMEMLIMIT='512MiB')
        self.cli = [str(STAGE/'bin/cocoon'), '--config', str(RUN/'config.json')]

    def save(self):
        with self.save_lock:
            temp=RUN/'agent-evidence.tmp';temp.write_text(json.dumps(self.evidence, indent=2)+'\n');temp.replace(RUN/'agent-evidence.json')
    def confined(self):
        (GROUP/'control/cgroup.procs').write_text(str(os.getpid()))
        os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:4])
    def cc(self, *args, timeout=240, data=None, allow_failure=False):
        start = time.monotonic()
        wrapper='import os,sys,pathlib;pathlib.Path(sys.argv[1]).write_text(str(os.getpid()));os.sched_setaffinity(0,sorted(os.sched_getaffinity(0))[:4]);os.execvpe(sys.argv[2],sys.argv[2:],os.environ)'
        p = subprocess.run([sys.executable,'-c',wrapper,str(GROUP/'control/cgroup.procs'),*self.cli,*args],
                           input=data,capture_output=True,timeout=timeout,env=self.env)
        # Neither stdout nor stderr are logged: guest tool/model streams may contain secrets.
        with (RUN/'commands.jsonl').open('a') as log:
            log.write(json.dumps(dict(command=args[:3], returncode=p.returncode, duration_ms=(time.monotonic()-start)*1000))+'\n')
        if p.returncode and not allow_failure:
            raise RuntimeError('Cocoon command failed: '+repr(args[:3])+' exit '+str(p.returncode))
        return p.stdout.decode()
    def guest(self, name, *args, timeout=240): return self.cc('vm','exec',name,'--',*args,timeout=timeout)
    def put(self, name, path, content, mode=0o644):
        code = 'import pathlib,sys,os;p=pathlib.Path(sys.argv[1]);p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(sys.stdin.buffer.read());p.chmod(int(sys.argv[2]))'
        self.cc('vm','exec','-i',name,'--','python3','-c',code,path,str(mode),data=content)
    def wait(self, operation, timeout=90):
        deadline=time.monotonic()+timeout
        while True:
            try: return operation()
            except (RuntimeError, json.JSONDecodeError):
                if time.monotonic()>deadline: raise
                time.sleep(.5)
    def inspect(self, name):
        vm=json.loads(self.cc('vm','inspect',name))
        require(vm['config']['name'] in NAMES.values(), 'unowned VM name')
        require(vm['config']['memory']==2*1024**3 and vm['config']['cpu']==2, 'VM budget mismatch')
        require(all(Path(d['path']).resolve().is_relative_to(RUN) for d in vm['storage_configs']), 'unowned disk')
        if vm.get('pid') and Path('/proc/'+str(vm['pid'])).exists():
            require(Path('/proc/'+str(vm['pid'])+'/exe').resolve()==STAGE/'bin/firecracker','unowned VMM')
            require(vm['socket_path'].encode() in Path('/proc/'+str(vm['pid'])+'/cmdline').read_bytes().split(b'\0'),'unowned socket')
            require((GROUP/('vm-'+vm['id']+'.scope')/'cgroup.procs').read_text().split()==[str(vm['pid'])],'unowned cgroup process')
        return vm
    def request(self, name, *args):
        result=json.loads(self.cc('vm','exec',name,'--','python3','/opt/real-agent/client.py','--socket',
                                   '/tmp/real-agent.sock',*args,timeout=360,allow_failure=True))
        if not result.get('ok'):
            self.evidence['last_request_failure']=result; self.save()
            raise RuntimeError('harness '+name+' '+str(args)+': '+result.get('error','UnknownError'))
        return result['state']
    def gate_record(self, vm):
        rows=[(p,json.loads(p.read_text())) for p in (RUN/'gates').glob('*.json')]
        rows=[(p,v) for p,v in rows if v['vm_id']==vm['id']]
        require(len(rows)==1,'one gated NIC required'); return rows[0]
    def prepare(self, name):
        vm=self.inspect(name); path,record=self.gate_record(vm)
        agent_gate.gate.verify_block(record['dev'])
        self.evidence.setdefault('quarantine',{})[name]=dict(record=record,tc={direction:json.loads(subprocess.check_output(
            ['tc','-s','-j','filter','show','dev',record['dev'],direction],text=True)) for direction in ('ingress','egress')})
        deadline=time.monotonic()+30
        while True:
            reseeding=[]
            for proc in Path('/proc').glob('[0-9]*/cmdline'):
                try: argv=proc.read_bytes().split(b'\0')
                except OSError: continue
                if str(STAGE/'bin/cocoon').encode() in argv and b'reseed' in argv and vm['id'].encode() in argv: reseeding.append(proc)
            if not reseeding: break
            require(time.monotonic()<deadline,'detached reseed did not finish'); time.sleep(.1)
        nic=vm['network_configs'][0]; net=nic['network']
        proof=json.loads(self.guest(name,'python3','/opt/real-agent/agent_prepare.py',vm['id'],record['nonce'],
                          f"{net['ip']}/{net['prefix']}",net['gateway'],nic['mac']))
        self.evidence.setdefault('identities',{})[name]=proof
        if name!=NAMES['parent']:
            reset=json.loads(self.guest(name,'python3','/opt/real-agent/relay.py','reset'))
            require(reset['ok'] and reset['oldTunnelsRemaining']==0,'captured relay tunnels remain')
            self.evidence.setdefault('relay_resets',{})[name]=reset; self.save()
        agent_gate.release(record,proof); record['state']='private-connect-only'; agent_gate.gate.atomic(path,record)
    def allocation(self, label):
        value=int(subprocess.check_output(['du','-s','-B1',str(RUN)],text=True).split()[0])
        self.evidence['metrics'][label+'_allocated_bytes']=value
        require(value<=40*1024**3,'disk budget exceeded'); self.save()

    def setup(self):
        require(os.environ.get('CLANKER_HOST_SLOT')=='cocoon-codex4-20260905','new agent grant required')
        require(os.geteuid()==0 and sys.platform=='linux','root Linux required')
        require(not RUN.exists() and not GROUP.exists(),'refuse existing run/cgroup')
        require(STAGE.resolve()==STAGE,'stage symlink refused')
        require({'cpu','cpuset','memory'}<=set(Path('/sys/fs/cgroup/cgroup.subtree_control').read_text().split()),'no global controller changes')
        for path,sha in HASHES.items(): require(digest(STAGE/path)==sha,'retained hash mismatch '+path)
        before=inventory()
        require(not any(row['ifname'] in agent_gate.NETWORKS for row in before['links']),'bridge exists')
        require(not any(row['name'].startswith('ag-') for row in before['netns']),'namespace exists')
        for route in before['routes']:
            if route.get('dst','default')!='default':
                require(not any(ipaddress.ip_network(route['dst'],strict=False).overlaps(ipaddress.ip_network(ip+'/24',strict=False))
                                for ip in agent_gate.NETWORKS.values()),'subnet overlaps')
        RUN.mkdir(mode=0o700); self.evidence['host_before']=before; self.save()
        for name in ('d','r','l','cni-conf','cni-bin','gates','ipam','tools','downloads'): (RUN/name).mkdir()
        config=dict(root_dir=str(RUN/'d'),run_dir=str(RUN/'r'),log_dir=str(RUN/'l'),fc_binary=str(STAGE/'bin/firecracker'),
                    use_firecracker=True,cni_conf_dir=str(RUN/'cni-conf'),cni_bin_dir=str(RUN/'cni-bin'),net_scope='ag',
                    cgroup_parent=GROUP.name,dns='',pool_size=3,meta_backend='json',stop_timeout_seconds=30,
                    socket_wait_timeout_seconds=20,metering={'backend':'file'})
        (RUN/'config.json').write_text(json.dumps(config,indent=2))
        for name in ('bridge','host-local'): (RUN/'cni-bin'/name).symlink_to(STAGE/'cni-bin'/name)
        shutil.copyfile(SOURCE/'agent_gate.py',RUN/'cni-bin/clanker-agent-gate'); (RUN/'cni-bin/clanker-agent-gate').chmod(0o755)
        shutil.copyfile(SOURCE/'gate.py',RUN/'cni-bin/gate.py')
        for (label,name),(bridge,endpoint) in zip(NAMES.items(),agent_gate.NETWORKS.items()):
            subnet=endpoint.rsplit('.',1)[0]
            config=dict(cniVersion='1.0.0',name=name,plugins=[dict(type='bridge',bridge=bridge,isGateway=False,
                        isDefaultGateway=False,ipMasq=False,hairpinMode=False,ipam=dict(type='host-local',dataDir=str(RUN/'ipam'),
                        ranges=[[dict(subnet=subnet+'.0/24',rangeStart=subnet+'.2',rangeEnd=subnet+'.2',gateway=endpoint)]])),
                        dict(type='clanker-agent-gate',bridge=bridge,endpoint=endpoint,stateDir=str(RUN/'gates'))])
            (RUN/'cni-conf'/(label+'.conflist')).write_text(json.dumps(config))
        GROUP.mkdir(); self.group_inode=GROUP.stat().st_ino
        (GROUP/'memory.max').write_text(str(11*1024**3)); (GROUP/'cpu.max').write_text('400000 100000')
        (GROUP/'cgroup.subtree_control').write_text('+cpu +memory'); (GROUP/'control').mkdir()
        pins=json.loads((STAGE/'pins.json').read_text())
        for name in ('erofs','libdeflate'):
            target=RUN/'downloads'/(name+'.deb'); urllib.request.urlretrieve(pins[name+'_deb'],target)
            require(digest(target)==pins[name+'_deb_sha256'],'dependency checksum mismatch')
            subprocess.run(['dpkg-deb','-x',str(target),str(RUN/'tools')],check=True)
        for bridge,endpoint in agent_gate.NETWORKS.items():
            subprocess.run(['ip','link','add',bridge,'type','bridge'],check=True); self.bridges.append(bridge)
            subprocess.run(['ip','addr','add',endpoint+'/24','dev',bridge],check=True)
            subprocess.run(['ip','link','set',bridge,'up'],check=True)
            server=agent_proxy.Server((endpoint,8443),agent_proxy.Connect); server.counts={}; server.lock=threading.Lock(); server.active=set()
            threading.Thread(target=server.serve_forever,daemon=True).start(); self.servers.append(server)
        self.runtime=True
        self.cc('image','import','cq-agent-image',str(STAGE/'guest-rootfs.tar'),timeout=600)
        self.cc('vm','run','--fc','--name',NAMES['parent'],'--cpu','2','--memory','2G','--storage','10G','--nics','1',
                '--network',NAMES['parent'],'cq-agent-image')
        self.wait(lambda:self.guest(NAMES['parent'],'true'))
        parent=NAMES['parent']
        self.guest(parent,'sh','-ec','useradd --create-home --shell /bin/bash agent; chmod 700 /home/agent; install -d -m 700 -o agent -g agent /home/agent/.codex; install -d /opt/real-agent')
        for file in ('agent_prepare.py','agent_proxy.py'): self.put(parent,'/opt/real-agent/'+file,(SOURCE/file).read_bytes())
        harness=SOURCE/'real-agent'
        for path in harness.rglob('*'):
            if path.is_file() and '__pycache__' not in path.parts and path.suffix!='.pyc':
                self.put(parent,'/opt/real-agent/'+str(path.relative_to(harness)),path.read_bytes())
        self.guest(parent,'chown','-R','agent:agent','/opt/real-agent')
        self.prepare(parent)
        (RUN/'awaiting-binary').touch(mode=0o600)
        print('AWAITING_ROOT_BINARY '+str(RUN),flush=True)
        deadline=time.monotonic()+900
        while not (RUN/'binary-ready').exists():
            require(time.monotonic()<deadline,'root binary deadline'); time.sleep(1)
        self.evidence['codex_version']=self.guest(parent,'/opt/real-agent/codex','--version').strip()
        require(self.evidence['codex_version']=='codex-cli 0.153.4','CLI version mismatch')
        self.evidence['features']=self.guest(parent,'runuser','-u','agent','--','/opt/real-agent/codex','features','list').splitlines()
        self.evidence['guest_tool_paths']=json.loads(self.guest(parent,'python3','-c',
            'import shutil,json;print(json.dumps({name:shutil.which(name) for name in ("node","bash","rg","python3")}))'))
        self.save()
        (RUN/'awaiting-injection').touch(mode=0o600)
        print('AWAITING_ROOT_INJECTION '+str(RUN),flush=True)
        deadline=time.monotonic()+900
        while not (RUN/'injection-ready').exists():
            require(time.monotonic()<deadline,'root injection deadline'); time.sleep(1)
        self.guest(parent,'systemd-run','--unit=real-agent-relay','--property=User=agent','python3','/opt/real-agent/relay.py','serve')
        self.evidence['relay_baseline']=self.wait(lambda:json.loads(self.guest(parent,'python3','/opt/real-agent/relay.py','status')))
        self.guest(parent,'systemd-run','--unit=real-agent','--property=User=agent','--property=SetLoginEnvironment=yes',
                   '--setenv=HTTPS_PROXY=http://127.0.0.1:8888','--setenv=HTTP_PROXY=http://127.0.0.1:8888',
                   '--setenv=ALL_PROXY=http://127.0.0.1:8888','--setenv=NO_PROXY=localhost,127.0.0.1',
                   'python3','/opt/real-agent/guest.py','serve','--socket','/tmp/real-agent.sock',
                   '--workdir','/opt/real-agent/fixture','--codex','/opt/real-agent/codex','--isolated-user','agent')
        self.wait(lambda:self.request(parent,'status'))

    def execute(self):
        parent=NAMES['parent']
        try:
            self.evidence['phases']['baseline']=self.request(parent,'baseline'); self.save()
        except RuntimeError:
            self.evidence.setdefault('baseline_diagnostics',[]).append(self.request(parent,'report'))
            self.evidence['diagnostic_pause']=True;self.save()
            (RUN/'diagnostic-pause').touch(mode=0o600)
            print('BASELINE_DIAGNOSTIC_PAUSE '+str(RUN),flush=True)
            deadline=time.monotonic()+1200
            while not (RUN/'resume-baseline').exists() and not (RUN/'cleanup-diagnostic').exists():
                require(time.monotonic()<deadline,'baseline diagnostic deadline');time.sleep(1)
            require((RUN/'resume-baseline').exists(),'diagnostic cleanup requested')
            self.evidence['diagnostic_pause']=False;self.save()
            self.evidence['phases']['baseline']=self.request(parent,'baseline');self.save()
        start=time.monotonic(); self.cc('snapshot','save','--name','cq-agent-ram',parent,timeout=600)
        self.evidence.setdefault('snapshots',{})['idle_capture_only']=json.loads(self.cc('snapshot','inspect','cq-agent-ram'))
        self.evidence['metrics']['snapshot_command_ms']=(time.monotonic()-start)*1000
        self.evidence['phases']['barrier_start']=self.request(parent,'barrier-start'); self.save()
        deadline=time.monotonic()+120
        while True:
            checkpoint=self.request(parent,'status')
            if checkpoint.get('barrierWaiting'): break
            require(time.monotonic()<deadline,'active tool did not reach barrier'); time.sleep(.5)
        self.evidence['phases']['active_checkpoint']=checkpoint; self.save()
        start=time.monotonic(); self.cc('snapshot','save','--name','cq-agent-active',parent,timeout=600)
        self.evidence['snapshots']['active']=json.loads(self.cc('snapshot','inspect','cq-agent-active'))
        self.evidence['metrics']['active_snapshot_command_ms']=(time.monotonic()-start)*1000
        self.evidence['phases']['inherited']={'parent':self.request(parent,'status')}
        for label in ('child-a','child-b'):
            start=time.monotonic(); name=NAMES[label]
            self.cc('vm','clone','--name',name,'--network',name,'cq-agent-active',timeout=600)
            self.wait(lambda:self.guest(name,'true'))
            self.evidence['metrics'][label+'_fork_to_exec_ms']=(time.monotonic()-start)*1000
            self.evidence['phases']['inherited'][label]=self.request(name,'status'); self.save()
            self.prepare(name)
        self.evidence['runtime']={label:self.inspect(name) for label,name in NAMES.items()}
        require(len({v['pid'] for v in self.evidence['runtime'].values()})==3,'not three VMM processes')
        self.allocation('after_fork')
        self.evidence['phases']['barrier_release']={label:self.request(name,'barrier-release','--name',label) for label,name in NAMES.items()}
        self.parallel('barrier_complete','barrier-wait')
        self.evidence['ordering']=dict(clock='host-monotonic',ramSnapshotVerified=True,writesCompleted={},readsStarted={})
        self.parallel('branches','branch',named=True)
        self.parallel('followups','followup')
        self.evidence['phases']['reports']={label:self.request(name,'report') for label,name in NAMES.items()}
        sys.path.insert(0,str(SOURCE/'real-agent'))
        from evaluate import evaluate
        self.evidence['evaluation']=evaluate(list(self.evidence['phases']['reports'].values()),self.evidence['ordering'],True)
        self.save()
        self.evidence['network_fault']={ip:dict(disconnected_active_tunnels=server.disconnect(),
            tunnel_count_before=sum(server.counts.values())) for ip,server in zip(agent_gate.NETWORKS.values(),self.servers)}
        self.parallel('recovery_followups','recovery-followup')
        self.evidence['phases']['recovery_reports']={label:self.request(name,'report') for label,name in NAMES.items()}
        self.evidence['recovery_evaluation']=evaluate(list(self.evidence['phases']['recovery_reports'].values()),self.evidence['ordering'],True,True)
        self.evidence['proxy_tunnels']={ip:dict(server.counts) for ip,server in zip(agent_gate.NETWORKS.values(),self.servers)}
        self.evidence['status']='pass' if self.evidence['evaluation']['pass'] else 'fail'; self.save()

    def parallel(self, phase, operation, named=False):
        self.evidence['phases'][phase]={}
        self.evidence.setdefault('concurrent_calls',{})[phase]={}
        def call(label,name):
            start=time.monotonic_ns()
            result=self.request(name,operation,*(['--name',label] if named else []))
            return result,start,time.monotonic_ns()
        with ThreadPoolExecutor(max_workers=3) as pool:
            pending={pool.submit(call,label,name):label for label,name in NAMES.items()}
            for future in as_completed(pending):
                label=pending[future];result,start,end=future.result()
                self.evidence['phases'][phase][label]=result
                self.evidence['concurrent_calls'][phase][label]=dict(start_ns=start,end_ns=end)
                if operation=='branch':self.evidence['ordering']['writesCompleted'][label]=end
                if operation=='followup':self.evidence['ordering']['readsStarted'][label]=start
                self.save()

    def cleanup(self):
        if not RUN.exists(): return
        try:
            self.evidence['proxy_tunnels']={ip:dict(server.counts) for ip,server in zip(agent_gate.NETWORKS.values(),self.servers)}
            if self.runtime:
                rows=json.loads(self.cc('vm','ls','--format','json'))
                require(len(rows)<=3,'unexpected VM inventory')
                for row in rows:
                    vm=self.inspect(row['id']); self.cc('vm','rm','--force',vm['id'])
                out=self.cc('snapshot','ls','--format','json')
                rows=[] if out.strip()=='No snapshots found.' else json.loads(out)
                for row in rows:
                    require(row['name'] in ('cq-agent-ram','cq-agent-active'),'unowned snapshot'); self.cc('snapshot','rm',row['id'])
                self.evidence['cleanup_vms']=json.loads(self.cc('vm','ls','--format','json'))
                out=self.cc('snapshot','ls','--format','json')
                self.evidence['cleanup_snapshots']=[] if out.strip()=='No snapshots found.' else json.loads(out)
                require(not self.evidence['cleanup_vms'] and not self.evidence['cleanup_snapshots'],'VM objects remain')
            for server in self.servers: server.shutdown(); server.server_close()
            for bridge in self.bridges:
                link=json.loads(subprocess.check_output(['ip','-j','link','show','dev',bridge],text=True))[0]
                require(link['ifname'] in agent_gate.NETWORKS,'unowned bridge')
                subprocess.run(['ip','link','del',bridge],check=True)
            if self.group_inode:
                require(GROUP.stat().st_ino==self.group_inode,'cgroup ownership changed')
                self.evidence['metrics']['cgroup_memory_peak_bytes']=int((GROUP/'memory.peak').read_text())
                for child in GROUP.iterdir():
                    if child.is_dir(): wait_empty_group(child); child.rmdir()
                GROUP.rmdir()
            self.evidence['host_after']=inventory()
            require(not any(v['ifname'] in agent_gate.NETWORKS for v in self.evidence['host_after']['links']),'owned network remains')
            require(not any(v['name'].startswith('ag-') for v in self.evidence['host_after']['netns']),'owned namespace remains')
            for name in ('d','r','l','cni-conf','cni-bin','gates','ipam','tools','downloads'):
                path=RUN/name
                if path.exists(): require(path.resolve().parent==RUN and not path.is_symlink(),'cleanup path ownership'); shutil.rmtree(path)
            self.evidence['cleanup']='pass'
        except Exception as error:
            self.evidence['cleanup']='fail'; self.evidence['cleanup_error']=str(error); raise
        finally: self.save()

if __name__=='__main__':
    test=Experiment()
    try: test.setup(); test.execute()
    except Exception as error:
        test.evidence['status']='fail'; test.evidence['error']=str(error)
        if RUN.exists():
            test.evidence['failure_reports']={}
            if test.runtime:
                for label,name in NAMES.items():
                    try:
                        test.inspect(name)
                        test.evidence['failure_reports'][label]=test.request(name,'report')
                    except Exception as report_error:
                        test.evidence['failure_reports'][label]={'unavailable':str(report_error)}
            test.save()
            (RUN/'failure-diagnostic-pause').touch(mode=0o600)
            print('FAILURE_DIAGNOSTIC_PAUSE '+str(RUN),flush=True)
            deadline=time.monotonic()+1200
            while not (RUN/'cleanup-diagnostic').exists():
                if time.monotonic()>deadline:break
                time.sleep(1)
        raise
    finally: test.cleanup()
