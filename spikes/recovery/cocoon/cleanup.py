#!/usr/bin/env python3
"""Plan-hash-authorized cleanup of explicitly named disposable recovery copies.

Neither planning nor execution is permitted while any runtime slot is open.
Execution additionally requires the coordinator to publish the exact plan hash
as authorization.json:cocoon_cleanup_plan_sha256. No wildcard target sweep.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid

import host

ROOT=host.ROOT
GROUP=Path('/sys/fs/cgroup/cqrec20260906.slice')
BASE_TARGETS=(
    'artifacts/process-2ba83a05',
    'artifacts/process-7051f6cc',
    'artifacts/native-ac5f590b',
    'artifacts/corruption-b672d3de',
    'failed-prepare-14646703/guest.tar',
)
SMALL_NAMES={'closure.json','snapshot.json','cocoon.json'}
MAX_METADATA=8*1024**2


def require(value,message):
    if not value: raise ValueError(message)


def digest(data): return hashlib.sha256(data).hexdigest()


def fact(value):
    require(stat.S_ISREG(value.st_mode) or stat.S_ISDIR(value.st_mode),'only regular files/directories allowed')
    require(not stat.S_ISREG(value.st_mode) or value.st_nlink==1,'hard-linked file refused')
    return {'device':value.st_dev,'inode':value.st_ino,'mode':value.st_mode,
            'size':value.st_size,'mtime_ns':value.st_mtime_ns,'allocated_bytes':value.st_blocks*512}


def same_identity(actual,expected):
    return actual.st_dev==expected['device'] and actual.st_ino==expected['inode'] and actual.st_mode==expected['mode']


def target_names(isolated_runs):
    names=list(BASE_TARGETS)
    require(len(isolated_runs)<=2 and len(set(isolated_runs))==len(isolated_runs),'at most two explicit isolated runs')
    for run in isolated_runs:
        require(re.fullmatch(r'isolated-[0-9a-f]{8}',run),'invalid isolated run ID')
        result_path=ROOT/'results'/run/'result.json'
        require(result_path.resolve()==result_path,'redirected isolated result')
        result=json.loads(result_path.read_text())
        require(result.get('run_id')==run and result.get('case')=='isolated' and result.get('status')=='pass'
                and result.get('cleanup')=='pass' and result.get('namespace_cleanup',{}).get('mounts_removed') is True,
                'isolated run must have passed with normal unmount cleanup')
        names.extend(['artifacts/'+run,'restores/'+run])
    return names


def inventory_target(path):
    require(path.is_absolute() and path.resolve()==path and path.is_relative_to(ROOT) and path!=ROOT,'redirected or out-of-root target')
    require(path.exists() and not path.is_symlink(),'target absent or symlinked')
    nodes={}
    def walk(current,relative):
        item=current.lstat(); nodes[relative]=fact(item)
        if stat.S_ISDIR(item.st_mode):
            for child in sorted(current.iterdir()):
                walk(child,child.name if not relative else relative+'/'+child.name)
    walk(path,'')
    return {'path':str(path),'nodes':nodes,'allocated_bytes':sum(row['allocated_bytes'] for row in nodes.values())}


def mount_points():
    def decode(text):
        return re.sub(r'\\([0-7]{3})',lambda m:chr(int(m[1],8)),text)
    return [Path(decode(line.split()[4])) for line in Path('/proc/self/mountinfo').read_text().splitlines()]


def safety(auth):
    require(ROOT.resolve()==ROOT and ROOT.is_dir(),'exact root required')
    require(auth.get('grant')=='recovery-20260906' and auth.get('cocoon_root')==str(ROOT),'grant/root mismatch')
    require(auth.get('execution_authorized_runtime') is None,'global execution slot must be closed')
    require(auth.get('mount_namespace_authorized') is False,'namespace grant must be closed')
    require(not host.inventory(),'owned runtime process remains')
    require(not GROUP.exists(),'owned cgroup remains, even if empty')
    require(not any(path.is_relative_to(ROOT) for path in mount_points()),'owned mount remains')


def publish(path,value):
    data=json.dumps(value,sort_keys=True,indent=2).encode()+b'\n'
    with path.open('xb') as stream:
        stream.write(data); stream.flush(); os.fsync(stream.fileno())
    descriptor=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)
    return digest(data)


def archive_metadata(targets,output):
    archived=[]
    for target in targets:
        for member,expected in target['nodes'].items():
            source=Path(target['path'])/member
            if source.name not in SMALL_NAMES or not stat.S_ISREG(expected['mode']): continue
            require(expected['size']<=MAX_METADATA,'metadata unexpectedly large')
            fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW)
            try:
                require(fact(os.fstat(fd))==expected,'metadata changed before archive')
                with os.fdopen(os.dup(fd),'rb') as stream: data=stream.read(MAX_METADATA+1)
                require(len(data)==expected['size'] and fact(os.fstat(fd))==expected,'metadata changed during archive')
            finally: os.close(fd)
            destination=output/'evidence'/source.relative_to(ROOT)
            destination.parent.mkdir(parents=True,exist_ok=True)
            with destination.open('xb') as stream:
                stream.write(data); stream.flush(); os.fsync(stream.fileno())
            archived.append({'source':str(source),'archive':str(destination),'size_bytes':len(data),'sha256':digest(data)})
    # Persist every newly created evidence-directory entry, bottom up.
    for directory,_,_ in os.walk(output,topdown=False):
        fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try: os.fsync(fd)
        finally: os.close(fd)
    return archived


def make_plan(isolated_runs):
    names=target_names(isolated_runs)
    targets=[inventory_target(ROOT/name) for name in names]
    output=ROOT/'results'/('cleanup-'+uuid.uuid4().hex[:8]); output.mkdir(mode=0o700)
    metadata=archive_metadata(targets,output)  # All small evidence published before any deletion is possible.
    plan={'schema_version':1,'kind':'cocoon-explicit-cleanup-v1','root':str(ROOT),'created_ns':time.time_ns(),
          'isolated_runs':isolated_runs,'targets':targets,'metadata':metadata,
          'target_allocated_bytes':sum(item['allocated_bytes'] for item in targets),
          'preserved':['results','prepared.json','scripts/tests','s/bin','s/tools','s/downloads','s/d','s/l']}
    sha=publish(output/'plan.json',plan)
    return {'plan':str(output/'plan.json'),'plan_sha256':sha,'target_allocated_bytes':plan['target_allocated_bytes']}


def validate_plan(path,expected_sha):
    require(path.resolve()==path and path.parent.parent==ROOT/'results' and re.fullmatch(r'cleanup-[0-9a-f]{8}',path.parent.name)
            and path.name=='plan.json','exact private plan path required')
    data=path.read_bytes(); require(digest(data)==expected_sha,'plan hash mismatch')
    plan=json.loads(data)
    require(plan.get('schema_version')==1 and plan.get('kind')=='cocoon-explicit-cleanup-v1' and plan.get('root')==str(ROOT),'plan schema/root mismatch')
    allowed=[str(ROOT/name) for name in target_names(plan['isolated_runs'])]
    require([row['path'] for row in plan['targets']]==allowed,'plan targets differ from explicit allowlist')
    expected_metadata=set()
    for target in plan['targets']:
        require(inventory_target(Path(target['path']))==target,'target identity or contents changed since plan')
        for member,entry in target['nodes'].items():
            source=Path(target['path'])/member
            if source.name in SMALL_NAMES and stat.S_ISREG(entry['mode']): expected_metadata.add(str(source))
    require({row['source'] for row in plan['metadata']}==expected_metadata,'metadata archive is incomplete')
    for row in plan['metadata']:
        archived=Path(row['archive'])
        require(archived.resolve()==archived and archived.is_relative_to(path.parent/'evidence'),'redirected metadata archive')
        data=archived.read_bytes()
        require(len(data)==row['size_bytes'] and digest(data)==row['sha256'],'archived evidence changed')
    return plan


def delete_target(target):
    """Descriptor-relative deletion; each directory/file identity is rechecked."""
    path=Path(target['path']); require(inventory_target(path)==target,'target changed before deletion')
    nodes=target['nodes']
    def contents(fd,prefix):
        children={member[len(prefix)+1:] if prefix else member:entry for member,entry in nodes.items()
                  if member and str(Path(member).parent)==(prefix or '.')}
        require(set(os.listdir(fd))==set(children),'directory inventory changed')
        for name,entry in children.items():
            current=os.stat(name,dir_fd=fd,follow_symlinks=False)
            require(fact(current)==entry,'entry changed before deletion')
            member=prefix+'/'+name if prefix else name
            if stat.S_ISDIR(current.st_mode):
                child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                try:
                    require(same_identity(os.fstat(child),entry),'directory inode changed during open')
                    contents(child,member)
                finally: os.close(child)
                require(same_identity(os.stat(name,dir_fd=fd,follow_symlinks=False),entry),'directory replaced during deletion')
                os.rmdir(name,dir_fd=fd)
            else: os.unlink(name,dir_fd=fd)
    parent=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        require(same_identity(os.stat(path.name,dir_fd=parent,follow_symlinks=False),nodes['']),'top inode changed')
        if stat.S_ISDIR(nodes['']['mode']):
            fd=os.open(path.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
            try:
                require(same_identity(os.fstat(fd),nodes['']),'top inode changed during open'); contents(fd,'')
            finally: os.close(fd)
            require(same_identity(os.stat(path.name,dir_fd=parent,follow_symlinks=False),nodes['']),'top inode replaced')
            os.rmdir(path.name,dir_fd=parent)
        else: os.unlink(path.name,dir_fd=parent)
        os.fsync(parent)
    finally: os.close(parent)


def execute(path,expected_sha,auth):
    require(auth.get('cocoon_cleanup_plan_sha256')==expected_sha,'coordinator has not approved this exact plan hash')
    plan=validate_plan(path,expected_sha)
    journal=path.parent/'deletion.jsonl'; require(not journal.exists(),'execution already attempted; refuse implicit retry')
    def event(**data):
        with journal.open('a') as stream:
            stream.write(json.dumps(dict(monotonic_ns=time.monotonic_ns(),wall_ns=time.time_ns(),**data))+'\n'); stream.flush(); os.fsync(stream.fileno())
    removed=[]
    try:
        event(event='approved-target-list',plan_sha256=expected_sha,targets=[row['path'] for row in plan['targets']],bytes_before=plan['target_allocated_bytes'])
        for target in plan['targets']:
            safety(auth)
            event(event='before-delete',target=target['path'],identity=target['nodes'][''])
            delete_target(target); removed.append(target['path'])
            event(event='deleted',target=target['path'],allocated_bytes=target['allocated_bytes'])
        safety(auth)
        result={'status':'pass','removed':removed,'bytes_before':plan['target_allocated_bytes'],'bytes_after':0,
                'retained_metadata':plan['metadata'],'plan_sha256':expected_sha}
    except BaseException as error:
        event(event='failure',error=repr(error),removed=removed)
        publish(path.parent/'cleanup-result.json',{'status':'fail','error':repr(error),'removed':removed,'plan_sha256':expected_sha})
        raise
    publish(path.parent/'cleanup-result.json',result)
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    actions=parser.add_mutually_exclusive_group(required=True)
    actions.add_argument('--plan',action='store_true'); actions.add_argument('--execute',type=Path)
    parser.add_argument('--isolated-run',action='append',default=[]); parser.add_argument('--plan-sha256')
    args=parser.parse_args()
    require(os.geteuid()==0,'Linux root required')
    auth=json.loads((ROOT.parent/'authorization.json').read_text())
    lock=ROOT.parent/'execute.lock'
    require(auth.get('lock_path')==str(lock) and lock.resolve()==lock and lock.is_file(),'exact lock required')
    with lock.open('r+') as descriptor:
        fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB); safety(auth)
        if args.plan: result=make_plan(args.isolated_run)
        else:
            require(not args.isolated_run and re.fullmatch(r'[0-9a-f]{64}',args.plan_sha256 or ''),'execution requires plan hash only')
            result=execute(args.execute,args.plan_sha256,auth)
        print(json.dumps(result,sort_keys=True))


if __name__=='__main__': main()
