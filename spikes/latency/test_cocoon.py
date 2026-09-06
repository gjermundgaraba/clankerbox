#!/usr/bin/env python3
"""Offline tests for private ownership, image content, and latency interpretation."""
import argparse
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import threading
import unittest
from unittest.mock import MagicMock, patch

spec=importlib.util.spec_from_file_location('latency_cocoon',Path(__file__).with_name('cocoon.py'))
c=importlib.util.module_from_spec(spec); spec.loader.exec_module(c)


class AdapterTests(unittest.TestCase):
    def test_pause_is_bounded_and_absence_is_not_zero(self):
        samples=[dict(start_ns=i*10_000_000,end_ns=i*10_000_000+1_000_000,
                      body={'state':state}) for i,state in enumerate(['Running','Paused','Paused','Running'])]
        result=c.pause_bounds(samples)
        self.assertEqual(result['lower_ms'],9)
        self.assertEqual(result['upper_ms'],31)
        self.assertFalse(c.pause_bounds(samples[:1])['observed'])

    def test_ownership_and_closed_gate_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve()/'cocoon'; root.mkdir()
            lock=root.parent/'measure.lock'; lock.touch()
            manifest=dict(grant='test',cocoon_root=str(root),lock_path=str(lock),
                          cocoon_cgroup='/sys/fs/cgroup/test.slice',timing_authorized=False)
            (root.parent/'authorization.json').write_text(json.dumps(manifest))
            args=argparse.Namespace(root=str(root),grant='test',lock=str(lock),cpus='4-11')
            experiment=c.Experiment(args)
            self.assertFalse(experiment.manifest['timing_authorized'])
            args.grant='wrong'
            with self.assertRaisesRegex(RuntimeError,'grant mismatch'): c.Experiment(args)
            args.grant='test'; args.cpus='0-7'
            with self.assertRaisesRegex(RuntimeError,'CPU pool'): c.Experiment(args)

    def test_images_add_shared_binary_unit_and_guest_only_masks(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); guest=root/'guest'; guest.write_bytes(b'static-test-binary')
            with tarfile.open(root/'guest-rootfs.tar','w') as archive:
                info=tarfile.TarInfo('etc/original'); info.size=0; archive.addfile(info)
            with patch.object(c,'STAGE',root):
                c.make_image(root/'image.tar',guest,'workspace')
            with tarfile.open(root/'image.tar') as archive:
                self.assertIn('etc/original',archive.getnames())
                unit=archive.extractfile('etc/systemd/system/latency-guest.service').read().decode()
                self.assertIn('--memory-mib 1024',unit)
                self.assertIn('--workspace-mib 2048',unit)
                self.assertIn('--reuse-workspace',unit)
                self.assertEqual(archive.getmember('etc/systemd/system/docker.service').linkname,'/dev/null')
                self.assertEqual(archive.getmember('usr/local/bin/latency-guest').mode,0o755)
            with patch.object(c,'STAGE',root), self.assertRaisesRegex(RuntimeError,'existing image'):
                c.make_image(root/'image.tar',guest,'idle')

    def test_independence_rejects_source_changed_by_child(self):
        experiment=object.__new__(c.Experiment)
        baseline=dict(pid=10,start_monotonic_ns=1,ram_marker='abc',branch=0,disk_branch=0)
        child=dict(name='child',state=baseline.copy(),runtime={'config':{'name':'child'},'live_identity':{'pid':20,'starttime_ticks':2}},
                   prepare={'end_ns':100})
        experiment.inspect=lambda name:child['runtime']
        experiment.status=lambda name:dict(baseline,branch=1,disk_branch=1)
        with self.assertRaisesRegex(RuntimeError,'child changed source'):
            experiment.prove_children('source',baseline,[child])

    def test_request_fails_closed_on_ram_or_disk(self):
        experiment=object.__new__(c.Experiment)
        experiment.guest=lambda *args: json.dumps(dict(ok=True,ready=True,memory_ok=True,disk_ok=False))
        with self.assertRaisesRegex(RuntimeError,'verification failed'): experiment.status('source')

    def test_runtime_discriminator_survives_every_case(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); (root/'prepared.json').write_text(json.dumps({'artifacts':{'guest':'pin'}}))
            for case in c.CASES:
                with self.subTest(case=case):
                    experiment=object.__new__(c.Experiment)
                    experiment.root=root; experiment.manifest={'timing_authorized':True}
                    experiment.args=argparse.Namespace(guest='guest',run_case=case,repetitions=1,
                        variant='idle',block='test',trial_offset=0)
                    rows=[]
                    experiment.append=lambda filename,row:rows.append((filename,row))
                    experiment.resources=lambda:{'disk_allocated_bytes':1,'memory.peak':'1'}
                    experiment.run_vm=lambda name:None
                    experiment.command=lambda *args:''
                    experiment.status=lambda name:{}
                    experiment.wait=lambda op:op()
                    experiment.inspect=lambda name:{'id':'vm-id'}
                    experiment.ready=lambda *args:{'true_ms':1,'status_ms':2,
                        'state':{'branch':91,'disk_branch':91,'ram_marker':'new'}}
                    preparations=[]; first_prepared=threading.Event(); requests=[]
                    def request(name, operation):
                        requests.append((operation['op'],len(preparations)))
                        return {'branch':91,'disk_branch':91,'ram_marker':'old'}
                    experiment.request=request
                    experiment.guest_storage=lambda name:{}
                    experiment.cleanup_objects=lambda:None
                    experiment.capture=lambda *args,**kwargs:{'start_ns':0,'command_ms':1,'before':{}}
                    def clone(snapshot,name):
                        if case=='fanout4' and name=='cl-child2':
                            self.assertTrue(first_prepared.wait(.5),'child 1 was delayed by an all-ready barrier')
                        return {'name':name,'status_end_ns':c.time.monotonic_ns()}
                    experiment.clone=clone
                    def prepare(child,index):
                        child['prepare']={'end_ns':c.time.monotonic_ns()}
                        preparations.append(index)
                        if index==1: first_prepared.set()
                    experiment.prepare_child=prepare
                    experiment.finish_captures=lambda:None
                    experiment.prove_children=lambda *args:{}
                    with patch.object(c,'digest',return_value='pin'), patch.object(c,'HASHES',{}):
                        experiment.run_case()
                    sample=next(row for filename,row in rows if filename=='samples.jsonl')
                    self.assertEqual(sample['runtime'],'cocoon')
                    self.assertEqual(sample['status'],'pass')
                    if case in ('cold','warm'):
                        self.assertEqual(sample['runtime_identity'],{'id':'vm-id'})
                    if case=='warm':
                        self.assertEqual(sample['warm_restart_proof']['status'],'pass')
                    if case.startswith('fanout'):
                        self.assertIn(('resume_writes',len(sample['children'])),requests)
                        self.assertGreaterEqual(sample['source_resume_start_ns'],max(child['prepare']['end_ns'] for child in sample['children']))

    def test_capture_returns_while_postcapture_probe_is_pending(self):
        experiment=object.__new__(c.Experiment)
        experiment.snapshots=[]; experiment.capture_jobs=[]
        experiment.inspect=lambda name:{'socket_path':'unused'}
        experiment.request=lambda *args:{}
        experiment.command=lambda *args:None
        started=threading.Event(); release=threading.Event(); calls=[]
        def status(name):
            calls.append(name)
            if len(calls)==2:
                started.set(); release.wait(2)
            return {}
        experiment.status=status
        observer=MagicMock(); observer.samples=[]
        with patch.object(c,'PauseObserver',return_value=observer), patch.object(c.time,'sleep'):
            result=experiment.capture('source','snapshot')
            try:
                self.assertTrue(started.wait(.5))
                self.assertNotIn('capture_only_after',result)
            finally:
                release.set(); experiment.finish_captures()
        self.assertIn('capture_only_after',result)


if __name__=='__main__': unittest.main()
