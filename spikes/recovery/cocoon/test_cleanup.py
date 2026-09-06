#!/usr/bin/env python3
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys

sys.path.insert(0,str(Path(__file__).parent))
import cleanup as c


class CleanupTests(unittest.TestCase):
    def fixture(self,root):
        (root/'results').mkdir()
        for name in c.BASE_TARGETS:
            path=root/name
            if path.name=='guest.tar':
                path.parent.mkdir(parents=True); path.write_bytes(b'disposable fixture')
            else:
                (path/'closure/snapshot').mkdir(parents=True)
                (path/'closure/closure.json').write_text('{"schema":1}')
                (path/'closure/snapshot/snapshot.json').write_text('{}')
                (path/'closure/snapshot/cocoon.json').write_text('{}')
                (path/'closure/snapshot/mem').write_bytes(b'RAM')

    def test_explicit_paths_and_isolated_id_refuse_expansion(self):
        with tempfile.TemporaryDirectory() as temporary,patch.object(c,'ROOT',Path(temporary).resolve()):
            for name in ('../s','isolated-deadbeef/../s','isolated-*','source','isolated-DEADBEEF'):
                with self.subTest(name=name),self.assertRaises(ValueError): c.target_names([name])
            with self.assertRaises(ValueError): c.inventory_target(c.ROOT.parent)
            self.assertEqual(c.target_names([]),list(c.BASE_TARGETS))

    def test_top_and_nested_symlinks_refused(self):
        with tempfile.TemporaryDirectory() as temporary,patch.object(c,'ROOT',Path(temporary).resolve()):
            root=c.ROOT; (root/'real').mkdir(); (root/'real/a').write_text('a')
            (root/'alias').symlink_to(root/'real')
            with self.assertRaises(ValueError): c.inventory_target(root/'alias')
            (root/'real/link').symlink_to(root/'real/a')
            with self.assertRaises(ValueError): c.inventory_target(root/'real')

    def test_slot_runtime_cgroup_and_mount_refusals(self):
        with tempfile.TemporaryDirectory() as temporary,patch.object(c,'ROOT',Path(temporary).resolve()),patch.object(c,'GROUP',Path(temporary)/'group'),patch.object(c.host,'inventory',return_value=[]),patch.object(c,'mount_points',return_value=[]):
            auth={'grant':'recovery-20260906','cocoon_root':str(c.ROOT),'execution_authorized_runtime':None,'mount_namespace_authorized':False}
            c.safety(auth)
            with self.assertRaisesRegex(ValueError,'slot'): c.safety(dict(auth,execution_authorized_runtime='smolvm'))
            with patch.object(c.host,'inventory',return_value=[{'pid':1}]),self.assertRaisesRegex(ValueError,'process'): c.safety(auth)
            c.GROUP.mkdir()
            with self.assertRaisesRegex(ValueError,'cgroup'): c.safety(auth)
            c.GROUP.rmdir()
            with patch.object(c,'mount_points',return_value=[c.ROOT/'s']),self.assertRaisesRegex(ValueError,'mount'): c.safety(auth)

    def test_metadata_archived_before_approved_deletion_and_preserved(self):
        with tempfile.TemporaryDirectory() as temporary,patch.object(c,'ROOT',Path(temporary).resolve()):
            self.fixture(c.ROOT)
            planned=c.make_plan([]); path=Path(planned['plan'])
            plan=c.validate_plan(path,planned['plan_sha256'])
            self.assertEqual(len(plan['metadata']),12)
            with self.assertRaisesRegex(ValueError,'not approved'): c.execute(path,planned['plan_sha256'],{})
            for target in plan['targets']: c.delete_target(target)
            self.assertTrue(all(not Path(row['path']).exists() for row in plan['targets']))
            self.assertTrue(all(Path(row['archive']).exists() for row in plan['metadata']))
            self.assertTrue(path.exists())

    def test_changed_inode_or_unlisted_target_rejected(self):
        with tempfile.TemporaryDirectory() as temporary,patch.object(c,'ROOT',Path(temporary).resolve()):
            self.fixture(c.ROOT); planned=c.make_plan([]); path=Path(planned['plan'])
            original=c.ROOT/c.BASE_TARGETS[0]/'closure/snapshot/mem'
            original.rename(original.with_name('old-mem')); original.write_bytes(b'RAM')
            with self.assertRaisesRegex(ValueError,'changed'): c.validate_plan(path,planned['plan_sha256'])
            plan=json.loads(path.read_text()); plan['targets'][0]['path']=str(c.ROOT/'s/bin')
            data=json.dumps(plan).encode(); path.write_bytes(data)
            with self.assertRaisesRegex(ValueError,'allowlist'): c.validate_plan(path,c.digest(data))


if __name__=='__main__': unittest.main()
