#!/usr/bin/env python3
"""One narrowly scoped cleanup retry for the preserved first process attempt."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import host


def main():
    adapter=host.Recovery(argparse.Namespace(case=None,prepare=False))
    failure=host.ROOT/'results/process-2ba83a05/result.json'
    prior=json.loads(failure.read_text())
    host.require(prior['cleanup']=='fail' and prior['run_id']=='process-2ba83a05','unexpected failure record')
    host.require(adapter.auth['execution_authorized_runtime']=='cocoon','slot closed')
    lock=host.ROOT.parent/'execute.lock'
    host.require(lock.resolve()==lock and adapter.auth['lock_path']==str(lock),'lock redirected')
    with lock.open('r+') as descriptor:
        fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
        host.require(not host.inventory(),'process remains; empty-only repair refused')
        adapter.group_inode=adapter.group.stat().st_ino
        before={str(path):path.read_text() for path in adapter.group.rglob('cgroup.procs')}
        host.require(before and not any(value.strip() for value in before.values()),'cgroup not empty')
        adapter.event('cleanup-retry-before',prior_result=str(failure),group_inode=adapter.group_inode,cgroups=before,processes=[])
        adapter.cleanup()  # All CLI inventories first; unexpected records are refused, never deleted.
        adapter.close_group()
        adapter.result.update(status='pass',case='cleanup-retry',prior_result=str(failure),group_absent=not adapter.group.exists())
        adapter.save()
        print(json.dumps({'result':str(adapter.out/'result.json'),'status':'pass'}))


if __name__=='__main__': main()
