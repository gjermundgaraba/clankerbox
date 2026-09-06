#!/usr/bin/env python3
"""Granted no-NIC Cocoon process/lineage/closure recovery adapter."""
import argparse
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import urllib.request
import uuid

import closure

ROOT=Path('/home/clanker/clankerbox-recovery.AsnzhP/cocoon')
STAGE=Path('/home/clanker/clankerbox-cocoon.b0ngM6')
GUEST_SOURCE=Path('/home/clanker/clankerbox-latency.RPxPe6/shared/latency-guest')
GUEST_SHA='c0db3a0cab9c3f039d45b9098b1e57746d37ac7ac16467885c34e9fe9281701e'
PINS={'bin/cocoon':'db7ef5fbd609ac28f84f88042eb2ec75e107aea09d24cbbd824a5b049e92bebc',
      'bin/firecracker':'2fd0171309af7e24cf8dafc8a6f921c1434c49b5f9349bb996b7ed0a4deb8aa7',
      'guest-rootfs.tar':'0a64e8ef15c93ff146f10729750955a4b4a1938293260cbf983d99b5466c99ed'}
GUEST='/opt/recovery/latency-guest'
PROBE='/opt/recovery/disk_probe.py'
FIELDS=('pid','start_monotonic_ns','ram_marker','branch','disk_branch')


def require(value,message):
    if not value: raise RuntimeError(message)


class IntegrityError(Exception):
    """A valid guest reply disproved integrity; never retry it away."""


def list_rows(text,kind):
    text=text.strip()
    if text==('No VMs found.' if kind=='vm' else 'No snapshots found.'): return []
    rows=json.loads(text)
    require(isinstance(rows,list) and all(isinstance(row,dict) for row in rows),'invalid '+kind+' inventory')
    return rows


def terminate(signum,frame):
    raise KeyboardInterrupt('received signal '+str(signum))


def namespace_proof(auth):
    require(auth.get('execution_authorized_runtime')=='cocoon' and auth.get('mount_namespace_authorized') is True,'isolated mount grant closed')
    current=os.readlink('/proc/self/ns/mnt'); host=os.readlink('/proc/1/ns/mnt')
    require(current!=host,'refuse mounts in host mount namespace')
    mountinfo=Path('/proc/self/mountinfo').read_text()
    require(not any(field.startswith(('shared:','master:','propagate_from:')) for line in mountinfo.splitlines() for field in line.split()[6:line.split().index('-')]),'mount propagation is not recursively private')
    return {'namespace':current,'host_namespace':host,'mountinfo':mountinfo}


def inventory():
    found=[]
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit(): continue
        try:
            exe=(entry/'exe').resolve(strict=True)
            argv=(entry/'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
            if exe.name in ('cocoon','firecracker') and (str(ROOT).encode() in b'\0'.join(argv) or exe.is_relative_to(ROOT)):
                fields=(entry/'stat').read_text().rsplit(')',1)[1].split()
                found.append({'pid':int(entry.name),'start_ticks':int(fields[19]),'exe':str(exe),
                              'argv':[os.fsdecode(a) for a in argv], 'uid':entry.stat().st_uid,
                              'state':fields[0], 'cgroup':(entry/'cgroup').read_text()})
        except (FileNotFoundError,ProcessLookupError): pass
    return found


def networks():
    return {key:json.loads(subprocess.check_output(cmd,text=True) or '[]') for key,cmd in {
        'links':['ip','-j','link','show'],'netns':['ip','-j','netns','list'],
        'routes':['ip','-j','-4','route','show','table','all']}.items()}


class Recovery:
    def __init__(self,args):
        require(ROOT.resolve()==ROOT and ROOT.is_dir(),'exact granted root required')
        self.args=args
        self.auth=json.loads((ROOT.parent/'authorization.json').read_text())
        require(self.auth.get('grant')=='recovery-20260906' and self.auth.get('cocoon_root')==str(ROOT),'authorization mismatch')
        self.source=ROOT/'s'; self.fresh=ROOT/'f'
        self.group=Path(self.auth['cocoon_cgroup'])
        require(self.group==Path('/sys/fs/cgroup/cqrec20260906.slice'),'cgroup grant mismatch')
        self.names={}; self.snapshots={}; self.group_inode=None; self.mounts=[]
        self.run_id=(args.case or 'prepare')+'-'+uuid.uuid4().hex[:8]
        self.out=ROOT/'results'/self.run_id; self.out.mkdir(parents=True)
        self.artifacts=ROOT/'artifacts'/self.run_id; self.artifacts.mkdir(parents=True)
        self.result={'schema_version':1,'runtime':'cocoon','run_id':self.run_id,'case':args.case,
                     'status':'running','events':[],'capabilities':{},'artifact_copies':[]}
        self.env=dict(os.environ,PATH=str(self.source/'tools/usr/bin')+':'+os.environ['PATH'],
                      LD_LIBRARY_PATH=str(self.source/'tools/usr/lib/x86_64-linux-gnu'),GOMAXPROCS='4',GOMEMLIMIT='512MiB')

    def save(self):
        path=self.out/'result.tmp'; path.write_text(json.dumps(self.result,indent=2)+'\n'); path.replace(self.out/'result.json')

    def event(self,kind,**value):
        row=dict(event=kind,monotonic_ns=time.monotonic_ns(),wall_ns=time.time_ns(),**value)
        self.result['events'].append(row); self.save()
        return row

    def cc(self,*args,store=None,check=True,timeout=600):
        store=store or self.source
        argv=[str(self.source/'bin/cocoon'),'--config',str(store/'config.json'),*args]
        wrapper=('import os,sys,pathlib;os.sched_setaffinity(0,range(4,12) if sys.argv[1]!="-" else range(0,4));'
                 'g=sys.argv[1];g!="-" and pathlib.Path(g).write_text(str(os.getpid()));os.execvpe(sys.argv[2],sys.argv[2:],os.environ)')
        row={'argv':argv,'start_ns':time.monotonic_ns(),'wall_start_ns':time.time_ns()}
        try:
            done=subprocess.run([sys.executable,'-c',wrapper,str(self.group/'control/cgroup.procs') if self.group_inode else '-',*argv],
                capture_output=True,text=True,env=self.env,timeout=timeout)
            row.update(returncode=done.returncode,stdout=done.stdout,stderr=done.stderr)
        except BaseException as error:
            row['error']=repr(error); raise
        finally:
            row.update(end_ns=time.monotonic_ns(),wall_end_ns=time.time_ns())
            with (self.out/'commands.jsonl').open('a') as stream: stream.write(json.dumps(row)+'\n')
        require(not check or done.returncode==0,'Cocoon command failed '+repr(args)+': '+done.stderr)
        return done

    def guest(self,name,*args):
        return self.cc('vm','exec',name,'--',*args,store=self.names[name],timeout=30).stdout

    def ram(self,name,op='status',**kwargs):
        done=self.cc('vm','exec',name,'--',GUEST,'call',json.dumps(dict(op=op,**kwargs)),store=self.names[name],check=False,timeout=30)
        state=json.loads(done.stdout)
        if any(state.get(k) is False for k in ('memory_ok','disk_ok')):
            self.event('fatal-integrity-reply',name=name,reply=state)
            raise IntegrityError('shared RAM/disk marker corruption')
        if not all(state.get(k) is True for k in ('ok','ready','memory_ok','disk_ok')):
            self.event('not-ready-reply',name=name,reply=state)
            raise RuntimeError('shared workload not ready')
        require(done.returncode==0,'guest transport failed after status response')
        return state

    def disk(self,name,action,phase,counter,expect=None):
        argv=['python3',PROBE,action,'--namespace','recovery','--phase',phase,'--counter',str(counter)]
        if expect is not None: argv+=['--expect-phase',expect[0],'--expect-counter',str(expect[1])]
        state=json.loads(self.guest(name,*argv))
        if state.get('ok') is not True or state.get('method')!='O_DIRECT+mmap+readv':
            self.event('fatal-direct-disk-reply',name=name,reply=state)
            raise IntegrityError('direct disk proof failed')
        return state

    def wait(self,operation,timeout=90):
        deadline=time.monotonic()+timeout
        while True:
            try: return operation()
            except (RuntimeError,json.JSONDecodeError,subprocess.TimeoutExpired):
                if time.monotonic()>=deadline: raise
                time.sleep(.02)

    def inspect(self,name):
        vm=json.loads(self.cc('vm','inspect',name,store=self.names[name]).stdout)
        require(vm['config']['name']==name and vm['config']['memory']==2*1024**3 and vm['config']['cpu']==2,'VM ownership/budget mismatch')
        require(not vm.get('network_configs') and not vm.get('netns_path'),'guest network forbidden')
        require(all(Path(d['path']).resolve().is_relative_to(ROOT) for d in vm['storage_configs']),'disk ownership mismatch')
        require(not vm.get('socket_path') or Path(vm['socket_path']).resolve().is_relative_to(ROOT),'socket ownership mismatch')
        matches=[p for p in inventory() if p['pid']==vm.get('pid')]
        if matches:
            require(len(matches)==1 and matches[0]['exe']==str(self.source/'bin/firecracker') and matches[0]['uid']==0,'VMM identity mismatch')
            require(vm['socket_path'] in matches[0]['argv'],'VMM socket identity mismatch')
            scope=self.group/('vm-'+vm['id']+'.scope')
            require((scope/'cgroup.procs').read_text().split()==[str(vm['pid'])],'VMM cgroup mismatch')
            require(set(os.sched_getaffinity(vm['pid']))<=set(range(4,12)),'VMM outside CPU pool')
            vm['identity']=dict(matches[0],owned=True)
        return vm

    def run_vm(self,name):
        require(len(self.names)<3,'adapter limits itself to three VM records')
        self.names[name]=self.source
        self.cc('vm','run','--fc','--name',name,'--cpu','2','--memory','2G','--storage','10G','--nics','0',
                '--cpuset-cpus','4-11','--cpu-quota-us','800000','--cpu-burst-us=-1','recovery-image')
        state=self.wait(lambda:self.ram(name))
        vm=self.inspect(name)
        self.event('vm-ready',name=name,ram=state,vmm=vm)
        return state

    def capture(self,name,snapshot):
        before=self.ram(name); vm=self.inspect(name)
        self.snapshots[snapshot]=self.names[name]
        self.cc('snapshot','save','--name',snapshot,name)
        self.event('snapshot-created',name=snapshot,source=name,ram=before,vmm=vm)
        return before,vm

    def clone(self,snapshot,name,store=None,from_dir=None,check=True):
        require(len(self.names)<3,'adapter limits itself to three VM records')
        self.names[name]=store or self.source
        argv=['vm','clone','--name',name,'--cpuset-cpus','4-11','--cpu-quota-us','800000','--cpu-burst-us=-1']
        argv+=['--from-dir',str(from_dir)] if from_dir else [snapshot]
        done=self.cc(*argv,store=self.names[name],check=check)
        if done.returncode:
            self.event('clone-rejected',name=name,code=done.returncode,stdout=done.stdout,stderr=done.stderr)
            return done
        state=self.wait(lambda:self.ram(name))
        vm=self.inspect(name)
        require('identity' in vm,'restored child has no live identity')
        self.event('clone-ready',name=name,ram=state,vmm=vm)
        return state,vm

    def remove_vm(self,name):
        vm=self.inspect(name)
        self.cc('vm','rm','--force',vm['id'],store=self.names[name])
        del self.names[name]
        self.event('vm-removed',name=name,id=vm['id'])

    def kill_source(self,name):
        vm=self.inspect(name); identity=vm['identity']
        self.event('origin-process-inventory',processes=inventory())
        pid=identity['pid']; fd=os.pidfd_open(pid)
        try:
            again=self.inspect(name)['identity']
            require((again['pid'],again['start_ticks'])==(pid,identity['start_ticks']),'PID birth changed before kill')
            signal.pidfd_send_signal(fd,signal.SIGKILL)
        finally: os.close(fd)
        deadline=time.monotonic()+10
        while any(p['pid']==pid and p['start_ticks']==identity['start_ticks'] for p in inventory()):
            require(time.monotonic()<deadline,'killed VMM still exists'); time.sleep(.05)
        self.wait_process_exit()
        self.event('source-crash',identity=identity,method='pidfd SIGKILL after ownership and birth checks',remaining=inventory())
        return identity

    def wait_process_exit(self):
        # Native detached console relays poll VMM exit once per second.
        deadline=time.monotonic()+10
        while inventory():
            require(time.monotonic()<deadline,'owned VMM/control process remains after bounded exit wait')
            time.sleep(.05)
        self.event('owned-processes-absent',processes=[])

    def branch(self,name,number,initial_phase='A',initial_counter=0):
        ram=self.ram(name,'mutate',branch=number)
        disk=self.disk(name,'write','branch',number,(initial_phase,initial_counter))
        return {'ram':ram,'disk':disk}

    def check_continuity(self,before,after):
        require(all(before[k]==after[k] for k in FIELDS),'RAM identity or checkpoint branch did not continue')

    def collect_restores(self,names,capture,initial_phase='A',initial_counter=0):
        restored=[]
        for number,name in enumerate(names,1):
            ram=self.ram(name); self.check_continuity(capture['ram'],ram)
            disk=self.disk(name,'read',initial_phase,initial_counter)
            vm=self.inspect(name)
            later=self.wait(lambda:self.progress(name,ram['heartbeat']['samples']))
            self.check_continuity(ram,later)
            identity=(vm['identity']['pid'],vm['identity']['start_ticks'])
            require(identity!=(capture['vmm']['pid'],capture['vmm']['start_ticks']),'restored VMM is originating VMM')
            require(identity not in {(item['vmm']['pid'],item['vmm']['start_ticks']) for item in restored},'restored children share VMM identity')
            restored.append({'name':name,'branch_counter':number,'ram_initial':ram,'ram_later':later,
                             'disk_initial':disk,'vmm':vm['identity']})
        for item in restored: self.branch(item['name'],item['branch_counter'],initial_phase,initial_counter)
        barrier=time.monotonic_ns()
        for item in restored:
            item['ram_final']=self.ram(item['name'])
            item['disk_final']=self.disk(item['name'],'read','branch',item['branch_counter'])
            require(item['ram_final']['branch']==item['branch_counter'],'siblings share RAM branch')
            require(all(item['ram_final'][field]==item['ram_initial'][field] for field in FIELDS[:3]),'restored workload restarted during proof')
            item['final_observed_ns']=time.monotonic_ns()
        return restored,barrier

    def progress(self,name,prior):
        value=self.ram(name); require(value['heartbeat']['samples']>prior,'heartbeat not advancing'); return value

    def checkpoint_fixture(self,label):
        name='rc-source'; snapshot='rc-'+label
        ram=self.run_vm(name)
        disk=self.disk(name,'initialize','A',0)
        ram,vm=self.capture(name,snapshot)
        capture={'ram':ram,'disk':disk,'vmm':vm['identity']}
        export=self.artifacts/'native'; self.cc('snapshot','export',snapshot,'--to-dir',str(export))
        runtime_pins={str(self.source/p):closure.digest(self.source/p) for p in ('bin/cocoon','bin/firecracker','config.json')}
        created=closure.create(export,self.source,self.artifacts/'closure',runtime_pins)
        self.result.update(capture=capture,closure=created,closure_path=str(self.artifacts/'closure'))
        self.result['artifact_copies']=created['manifest']['files']
        self.result['source_after_capture']={'ram':self.ram(name,'mutate',branch=100),
            'disk':self.disk(name,'write','B',1,('A',0))}
        self.save()
        return name,snapshot,export,capture

    def process_case(self):
        name,snapshot,export,capture=self.checkpoint_fixture('process')
        self.kill_source(name)
        self.result['origin_processes_absent']=True
        self.clone(snapshot,'rc-child1')
        self.remove_vm(name)
        self.clone(snapshot,'rc-child2')
        restored,barrier=self.collect_restores(['rc-child1','rc-child2'],capture)
        self.result.update(restored=restored,all_mutations_completed_ns=barrier,
            independent_restore={'origin_processes_absent':True,'source_paths_unavailable':False})
        self.result['capabilities'].update(process_independent_ram_disk='pass',snapshot_after_source_deletion='pass',two_independent_restores='pass')

    def native_case(self):
        name,snapshot,export,capture=self.checkpoint_fixture('native')
        self.remove_vm(name); self.wait_process_exit()
        archive=self.artifacts/'native.tar'; self.cc('snapshot','export',snapshot,'--output',str(archive))
        self.config(self.fresh,initialize=True)
        self.snapshots['rc-imported']=self.fresh
        imported=self.cc('snapshot','import','--name','rc-imported',str(archive),store=self.fresh,check=False)
        self.event('native-import',code=imported.returncode,stdout=imported.stdout,stderr=imported.stderr)
        require(imported.returncode==0,'native import failed before the dependency/path portability check; not classified as portability failure')
        if imported.returncode==0:
            result=self.clone('rc-imported','rc-native-child',store=self.fresh,check=False)
            require(isinstance(result,subprocess.CompletedProcess) and result.returncode!=0,'native fresh-store unexpectedly succeeded; inspect before claiming failure')
            require('untrusted' in result.stderr or 'outside' in result.stderr,'native failure is not an established dependency/path limitation')
            self.result['native_failure_classification']={'stage':'clone-prevalidation','cause':'absolute dependency paths outside fresh configured store','stderr':result.stderr}
        require(not inventory(),'native rejection left a VMM')
        self.result['capabilities']['native_arbitrary_path_portability']='fail'
        self.result['capabilities']['native_failure_recorded_without_runtime_residue']='pass'

    def lineage_case(self):
        source='rc-source'; self.run_vm(source); self.disk(source,'initialize','A',0)
        baseline,_=self.capture(source,'rc-generation0')
        child,_=self.clone('rc-generation0','rc-child')
        self.check_continuity(baseline,child); self.disk('rc-child','read','A',0)
        self.branch('rc-child',1)
        require(self.ram(source)['branch']==0,'child mutation reached source')
        self.disk(source,'read','A',0)
        child_capture,_=self.capture('rc-child','rc-generation1')
        grandchild,_=self.clone('rc-generation1','rc-grandchild')
        self.check_continuity(child_capture,grandchild); self.disk('rc-grandchild','read','branch',1)
        self.remove_vm(source); self.remove_vm('rc-child')
        self.progress('rc-grandchild',grandchild['heartbeat']['samples'])
        self.branch('rc-grandchild',3,'branch',1)
        restored,_=self.clone('rc-generation1','rc-recovered')
        self.check_continuity(child_capture,restored); self.disk('rc-recovered','read','branch',1)
        self.branch('rc-recovered',4,'branch',1)
        require(self.ram('rc-grandchild')['branch']==3 and self.ram('rc-recovered')['branch']==4,'lineage branches share RAM')
        self.disk('rc-grandchild','read','branch',3); self.disk('rc-recovered','read','branch',4)
        self.capture('rc-grandchild','rc-generation2')
        self.event('lineage-final',grandchild_ram=self.ram('rc-grandchild'),recovered_ram=self.ram('rc-recovered'))
        self.result['capabilities'].update(child_can_checkpoint='pass',grandchild_can_checkpoint='pass',descendant_survives_ancestor_deletion='pass',recovery_from_deleted_ancestor_checkpoint='pass')

    def corruption_case(self):
        name,snapshot,export,capture=self.checkpoint_fixture('corruption')
        self.remove_vm(name); self.wait_process_exit()
        good=self.artifacts/'closure'; expected=self.result['closure']['manifest_sha256']
        layer=next(row['member'] for row in self.result['closure']['manifest']['files'] if row['role']=='readonly-layer')
        defects={'missing-memory':'snapshot/mem','truncated-vmstate':'snapshot/vmstate',
                 'bad-sidecar':'snapshot/cocoon.json','missing-cow':'snapshot/cow.raw','missing-base':layer}
        outcomes=[]
        for kind,member in defects.items():
            damaged=self.artifacts/('fault-'+kind)
            copies=closure.materialize(good,expected,damaged)
            target=damaged/member
            if kind.startswith('missing-'): target.unlink()
            elif kind=='truncated-vmstate':
                with target.open('r+b') as stream: stream.truncate(8)
            else: target.write_text('{broken-sidecar')
            rejected=False
            try: closure.verify(damaged,expected)
            except (ValueError,OSError) as error:
                rejected=True; outcomes.append({'kind':kind,'stage':'closure-preflight','error':repr(error),'vmm_started':False})
            require(rejected,'corrupt closure was accepted')
            require(not inventory(),'preflight started a runtime')
            closure.verify(good,expected)
            shutil.rmtree(damaged)  # Exact newly created corruption copy; good closure is retained.
        archive=self.artifacts/'native.tar.gz'; self.cc('snapshot','export',snapshot,'--output',str(archive),'--gzip')
        closure.verify_gzip(archive)
        damaged=self.artifacts/'bad-crc.tar.gz'; closure.copy_file(archive,damaged)
        with damaged.open('r+b') as stream:
            stream.seek(-8,2); byte=stream.read(1); stream.seek(-1,1); stream.write(bytes([byte[0]^1]))
        failed=self.cc('snapshot','import','--name','rc-crc-reject',str(damaged),check=False)
        require(failed.returncode!=0 and 'gzip integrity check' in failed.stderr,'native gzip CRC was not rejected as expected')
        outcomes.append({'kind':'gzip-crc','stage':'native-import','stderr':failed.stderr,'vmm_started':False})
        self.snapshots['rc-valid-retry']=self.source
        self.cc('snapshot','import','--name','rc-valid-retry',str(archive))
        restored,_=self.clone('rc-valid-retry','rc-valid-child')
        self.check_continuity(capture['ram'],restored); self.disk('rc-valid-child','read','A',0)
        self.result['corruptions']=outcomes
        self.result['capabilities'].update(malformed_closure_fail_closed='pass',native_gzip_crc_fail_closed='pass',valid_retry_after_corruption='pass')

    def isolated_case(self):
        self.event('namespace-before-fixture',**namespace_proof(self.auth))
        name,snapshot,export,capture=self.checkpoint_fixture('isolated')
        original_marker=self.source/'source-origin-only'
        original_marker.write_text(self.run_id)
        restore_parent=ROOT/'restores'; restore_parent.mkdir(exist_ok=True)
        destination=restore_parent/self.run_id
        copies=closure.materialize(self.artifacts/'closure',self.result['closure']['manifest_sha256'],destination)
        self.event('materialized-independent-closure',destination=str(destination),copies=copies)
        self.kill_source(name); self.remove_vm(name)
        self.cc('snapshot','rm',snapshot); del self.snapshots[snapshot]
        self.wait_process_exit()
        require(not list_rows(self.cc('vm','ls','--format','json').stdout,'vm'),'original VM store not empty')
        require(not list_rows(self.cc('snapshot','ls','--format','json').stdout,'snapshot'),'original snapshot store not empty')
        self.wait_process_exit()
        empty=destination/'hidden-original-artifacts'; empty.mkdir(mode=0o700)
        bind_pairs=[(destination/'tree',self.source),(empty,ROOT/'artifacts')]
        for source,target in bind_pairs:
            require(source.is_dir() and source.resolve()==source and source.is_relative_to(destination),'unsafe namespace bind source')
            require(target in (ROOT/'s',ROOT/'artifacts') and target.is_dir() and target.resolve()==target and target.stat().st_uid==0,'unsafe namespace bind target')
        self.result['original_paths']={'store':str(self.source),'artifact_root':str(ROOT/'artifacts'),
            'marker':str(original_marker),'native_export':str(export),'closure':str(self.artifacts/'closure')}
        for source,target in bind_pairs:
            self.event('before-private-bind',source=str(source),target=str(target),source_inode=source.stat().st_ino,target_inode=target.stat().st_ino,**namespace_proof(self.auth))
            subprocess.run(['mount','--bind',str(source),str(target)],check=True)
            self.mounts.append(target)
            require(source.stat().st_ino==target.stat().st_ino and source.stat().st_dev==target.stat().st_dev,'bind does not expose copied inode')
        require(not original_marker.exists() and not export.exists() and not (self.artifacts/'closure').exists(),'original source or artifacts remain visible at canonical paths')
        self.event('source-paths-unavailable',marker_absent=True,export_absent=True,original_closure_absent=True,
            scope='canonical original paths hidden in private mount namespace; not a hostile-root security sandbox',**namespace_proof(self.auth))
        # Fresh metadata store: the closure intentionally contains no VM/image/snapshot records.
        for directory in ('d','r','l','empty-cni'): (self.source/directory).mkdir(exist_ok=True)
        require(not list_rows(self.cc('vm','ls','--format','json').stdout,'vm'),'copied store has VM records')
        require(not list_rows(self.cc('snapshot','ls','--format','json').stdout,'snapshot'),'copied store has snapshot records')
        for row in copies:
            if row['member'].startswith('tree/'):
                exposed=self.source/row['member'][5:]
                require(exposed.stat().st_ino==row['copied_inode'] and closure.digest(exposed)==row['copied_sha256'],'exposed dependency differs from independent copy')
        self.clone(None,'rc-independent1',from_dir=destination/'snapshot')
        self.clone(None,'rc-independent2',from_dir=destination/'snapshot')
        restored,barrier=self.collect_restores(['rc-independent1','rc-independent2'],capture)
        self.result.update(restored=restored,all_mutations_completed_ns=barrier,artifact_copies=copies,
            independent_restore={'origin_processes_absent':True,'source_paths_unavailable':True})
        evidence=self.out/'evidence.json'; evidence.write_text(json.dumps(self.result,indent=2)+'\n')
        evaluated=subprocess.run([sys.executable,str(ROOT.parent/'shared/evaluate.py'),str(evidence)],capture_output=True,text=True)
        self.result['evaluation']={'returncode':evaluated.returncode,'stdout':evaluated.stdout,'stderr':evaluated.stderr}
        require(evaluated.returncode==0,'shared independent recovery evaluator rejected evidence')
        self.result['capabilities'].update(fixed_layout_copied_closure_ram_disk_recovery='pass',two_independent_copied_closure_restores='pass')

    def unmount_owned(self):
        if not self.mounts: return
        require(not inventory(),'refuse unmount while any owned VMM/control process remains')
        for target in reversed(self.mounts):
            self.event('before-normal-unmount',target=str(target),**namespace_proof(self.auth))
            subprocess.run(['umount',str(target)],check=True)  # Never lazy/force unmount.
            self.event('normal-unmount-complete',target=str(target))
        self.mounts=[]
        self.result['namespace_cleanup']={'mounts_removed':True,'owned_processes':[],**namespace_proof(self.auth)}

    def config(self,store,initialize=False):
        if initialize:
            require(not store.exists(),'fresh store already exists'); store.mkdir()
        for name in ('d','r','l','empty-cni'):
            (store/name).mkdir(exist_ok=True)
        config=dict(root_dir=str(store/'d'),run_dir=str(store/'r'),log_dir=str(store/'l'),
            fc_binary=str(self.source/'bin/firecracker'),use_firecracker=True,cni_conf_dir=str(store/'empty-cni'),
            cni_bin_dir=str(store/'empty-cni'),net_scope='r1',cgroup_parent=self.group.name,cgroup_cpus='4-11',
            dns='',pool_size=1,meta_backend='json',stop_timeout_seconds=30,socket_wait_timeout_seconds=20,metering={'backend':'file'})
        (store/'config.json').write_text(json.dumps(config,indent=2)+'\n')

    def prepare(self):
        require(not (ROOT/'prepared.json').exists() and not self.source.exists(),'preparation already exists')
        for path,expected in PINS.items(): require(closure.digest(STAGE/path)==expected,'retained artifact pin mismatch')
        require(closure.digest(GUEST_SOURCE)==GUEST_SHA,'shared guest pin mismatch')
        probe=ROOT.parent/'shared/disk_probe.py'; require(probe.is_file(),'shared direct disk probe missing')
        self.source.mkdir(); (self.source/'bin').mkdir(); (self.source/'tools').mkdir(); (self.source/'downloads').mkdir()
        for name in ('cocoon','firecracker'):
            shutil.copyfile(STAGE/'bin'/name,self.source/'bin'/name); (self.source/'bin'/name).chmod(0o755)
        self.config(self.source)
        pins=json.loads((STAGE/'pins.json').read_text())
        for name in ('erofs','libdeflate'):
            archive=self.source/'downloads'/(name+'.deb'); urllib.request.urlretrieve(pins[name+'_deb'],archive)
            require(closure.digest(archive)==pins[name+'_deb_sha256'],'private dependency hash mismatch')
            subprocess.run(['dpkg-deb','-x',str(archive),str(self.source/'tools')],check=True)
        archive=self.source/'guest.tar'; shutil.copyfile(STAGE/'guest-rootfs.tar',archive)
        unit=('[Unit]\nDescription=Recovery RAM sentinel\nAfter=local-fs.target\n[Service]\nType=simple\n'
              'ExecStartPre=/usr/bin/rm -f /tmp/clanker-latency.sock\nExecStart='+GUEST+' serve --memory-mib 64 '
              '--workspace /var/tmp/clanker-latency-workspace --reuse-workspace\n[Install]\nWantedBy=multi-user.target\n')
        with tarfile.open(archive,'a') as tar:
            for name,content,mode in [(GUEST.lstrip('/'),GUEST_SOURCE.read_bytes(),0o755),(PROBE.lstrip('/'),probe.read_bytes(),0o644),
                ('etc/systemd/system/recovery-sentinel.service',unit.encode(),0o644)]:
                info=tarfile.TarInfo(name); info.size=len(content); info.mode=mode; tar.addfile(info,io.BytesIO(content))
            for name,target in [('etc/systemd/system/multi-user.target.wants/recovery-sentinel.service','../recovery-sentinel.service')]+[
                ('etc/systemd/system/'+service,'/dev/null') for service in ('docker.service','docker.socket','containerd.service',
                 'systemd-networkd-wait-online.service','NetworkManager-wait-online.service')]:
                info=tarfile.TarInfo(name); info.type=tarfile.SYMTYPE; info.linkname=target; info.mode=0o777; tar.addfile(info)
        archive_hash=closure.digest(archive)
        self.cc('image','import','recovery-image',str(archive),timeout=900)
        archive.unlink()
        prepared={'pins':PINS,'guest_sha256':GUEST_SHA,'probe_sha256':closure.digest(probe),'derived_rootfs_sha256':archive_hash,
                  'runtime_pins':{str(self.source/'bin'/name):closure.digest(self.source/'bin'/name) for name in ('cocoon','firecracker')}}
        (ROOT/'prepared.json').write_text(json.dumps(prepared,indent=2)+'\n')
        self.result['prepared']=prepared

    def start_group(self):
        require(self.auth.get('execution_authorized_runtime')=='cocoon','coordinator runtime slot is closed')
        require(not self.group.exists(),'private cgroup already exists')
        require({'cpu','cpuset','memory','pids'}<=set(Path('/sys/fs/cgroup/cgroup.subtree_control').read_text().split()),'controllers unavailable; no global changes permitted')
        self.group.mkdir(); self.group_inode=self.group.stat().st_ino
        for key,value in {'memory.max':str(32*1024**3),'memory.swap.max':'0','pids.max':'2048','cpu.max':'max 100000',
            'cpuset.cpus':'4-11','cpuset.mems':Path('/sys/fs/cgroup/cpuset.mems.effective').read_text()}.items():
            (self.group/key).write_text(value)
        (self.group/'cgroup.subtree_control').write_text('+cpu +cpuset +memory +pids'); (self.group/'control').mkdir()

    def cleanup(self):
        errors=[]
        for store in {self.source,self.fresh}:
            if not (store/'config.json').exists(): continue
            rows=list_rows(self.cc('vm','ls','--format','json',store=store).stdout,'vm')
            found={row['config']['name'] for row in rows}
            require(found<={name for name,owned_store in self.names.items() if owned_store==store},'unowned VM in private store')
            for name in reversed(list(self.names)):
                if name not in found: continue
                try:
                    require(name in self.names and self.names[name]==store,'unowned VM in private store')
                    self.remove_vm(name)
                except Exception as error: errors.append(repr(error))
            if not errors:
                text=self.cc('snapshot','ls','--format','json',store=store).stdout.strip()
                for row in list_rows(text,'snapshot'):
                    require(row['name'] in self.snapshots and self.snapshots[row['name']]==store,'unowned snapshot')
                    self.cc('snapshot','rm',row['id'],store=store)
        if not errors: self.wait_process_exit()
        self.result['remaining_processes']=inventory()
        require(not errors and not self.result['remaining_processes'],'cleanup did not remove owned runtimes: '+repr(errors))
        self.result['cleanup']='pass'

    def close_group(self):
        if self.group_inode is None: return
        require(self.group.stat().st_ino==self.group_inode,'cgroup ownership changed')
        self.result['resources']={key:(self.group/key).read_text() for key in ('memory.peak','memory.events','cpu.stat','io.stat')}
        for child in self.group.iterdir():
            if child.is_dir():
                deadline=time.monotonic()+10
                while (child/'cgroup.procs').read_text().strip():
                    require(time.monotonic()<deadline,'private cgroup not empty'); time.sleep(.05)
                child.rmdir()
        self.group.rmdir()

    def execute(self):
        before=networks(); primary=None
        try:
            if self.args.prepare: self.prepare()
            else:
                prepared=json.loads((ROOT/'prepared.json').read_text())
                self.result['provenance']={key:prepared[key] for key in ('guest_sha256','probe_sha256')}
                for path,expected in prepared['runtime_pins'].items(): require(closure.digest(path)==expected,'private runtime binary changed')
                self.start_group()
                {'process':self.process_case,'lineage':self.lineage_case,'native':self.native_case,
                 'corruption':self.corruption_case,'isolated':self.isolated_case}[self.args.case]()
            self.result['status']='pass'
        except BaseException as error:
            primary=error; self.result.update(status='fail',error=repr(error)); raise
        finally:
            try:
                if self.group_inode is not None: self.cleanup()
                self.close_group()
                self.unmount_owned()
                after=networks(); require(before==after,'network inventory changed')
                self.result['network_audit']={'before':before,'after':after,'status':'pass'}
                allocated=int(subprocess.check_output(['du','-s','-B1',str(ROOT.parent)],text=True).split()[0])
                self.result['allocated_root_bytes']=allocated
                require(allocated<=self.auth['allocated_disk_limit_bytes'],'whole-root disk budget exceeded')
            except BaseException as error:
                self.result.update(status='fail',cleanup='fail',cleanup_error=repr(error))
                if primary is None: raise
            finally:
                self.save(); print(json.dumps({'result':str(self.out/'result.json'),'status':self.result['status']}),flush=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    action=parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--prepare',action='store_true')
    action.add_argument('--case',choices=('process','lineage','native','corruption','isolated'))
    args=parser.parse_args()
    signal.signal(signal.SIGTERM,terminate)
    require(sys.platform=='linux' and os.geteuid()==0,'Linux root required')
    recovery=Recovery(args)
    path=Path(recovery.auth['lock_path']); require(path==ROOT.parent/'execute.lock' and path.is_file() and not path.is_symlink(),'exact coordinator lock required')
    with path.open('r+') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        recovery.execute()


if __name__=='__main__': main()
