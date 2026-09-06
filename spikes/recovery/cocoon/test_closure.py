#!/usr/bin/env python3
import gzip
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('closure',Path(__file__).with_name('closure.py'))
c=importlib.util.module_from_spec(spec); spec.loader.exec_module(c)


def local_cp(argv, check):
    shutil.copyfile(argv[-2],argv[-1])


class ClosureTests(unittest.TestCase):
    def fixture(self, root):
        original=root/'s'; original.mkdir()
        for name in ('d/layer.erofs','d/vmlinuz','d/vmlinux','d/initrd','bin/cocoon','bin/firecracker'):
            path=original/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(name.encode())
        snapshot=root/'export'; snapshot.mkdir()
        (snapshot/'snapshot.json').write_text(json.dumps({'version':1,'config':{'hypervisor':'firecracker','memory':8192,'cpu':2,'nics':0}}))
        (snapshot/'cocoon.json').write_text(json.dumps({'storage_configs':[
            {'path':str(original/'d/layer.erofs'),'role':'layer','ro':True},
            {'path':str(original/'r/source/cow.raw'),'role':'cow','ro':False}],
            'boot_config':{'kernel_path':str(original/'d/vmlinuz'),'initrd_path':str(original/'d/initrd')}}))
        (snapshot/'mem').write_bytes(b'R'*8192); (snapshot/'vmstate').write_bytes(b'valid-versioned-state')
        (snapshot/'cow.raw').write_bytes(b'D'*4096)
        pins={str(original/'bin'/name):c.digest(original/'bin'/name) for name in ('cocoon','firecracker')}
        return original,snapshot,pins

    def test_closure_is_complete_and_copy_survives_original_removal(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(c,'MEMORY_BYTES',8192), patch.object(c.subprocess,'run',side_effect=local_cp):
            root=Path(temp).resolve(); original,snapshot,pins=self.fixture(root)
            result=c.create(snapshot,original,root/'good',pins)
            manifest=result['manifest']; expected=result['manifest_sha256']
            self.assertEqual(len(manifest['files']),11)
            copies=c.materialize(root/'good',expected,root/'copy')
            self.assertTrue(all(r['source_inode']!=r['copied_inode'] for r in copies))
            shutil.rmtree(original); shutil.rmtree(snapshot); shutil.rmtree(root/'good')
            c.verify(root/'copy',expected)

    def test_corrupted_members_fail_before_destination_creation(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(c,'MEMORY_BYTES',8192), patch.object(c.subprocess,'run',side_effect=local_cp):
            root=Path(temp).resolve(); original,snapshot,pins=self.fixture(root)
            result=c.create(snapshot,original,root/'good',pins); expected=result['manifest_sha256']
            for member in ('snapshot/mem','snapshot/vmstate','snapshot/cocoon.json','snapshot/cow.raw','tree/d/layer.erofs'):
                with self.subTest(member=member):
                    bad=root/'bad'; shutil.copytree(root/'good',bad)
                    path=bad/member; path.write_bytes(b'corrupt')
                    with self.assertRaisesRegex(ValueError,'size mismatch|hash mismatch'):
                        c.materialize(bad,expected,root/'destination')
                    self.assertFalse((root/'destination').exists())
                    shutil.rmtree(bad)
            c.verify(root/'good',expected)

    def test_manifest_tampering_and_unlisted_files_rejected(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(c,'MEMORY_BYTES',8192), patch.object(c.subprocess,'run',side_effect=local_cp):
            root=Path(temp).resolve(); original,snapshot,pins=self.fixture(root)
            result=c.create(snapshot,original,root/'good',pins); expected=result['manifest_sha256']
            (root/'good/unlisted').write_text('x')
            with self.assertRaisesRegex(ValueError,'unlisted'): c.verify(root/'good',expected)
            (root/'good/unlisted').unlink()
            with (root/'good/closure.json').open('a') as stream: stream.write(' ')
            with self.assertRaisesRegex(ValueError,'manifest hash'): c.verify(root/'good',expected)

    def test_symlink_and_path_escape_rejected(self):
        for name in ('../escape','/absolute','a/../b','a//b','a/./b','a\\b'):
            with self.subTest(name=name), self.assertRaises(ValueError): c.relative(name)
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve(); (root/'target').write_text('a'); (root/'link').symlink_to(root/'target')
            with self.assertRaises(ValueError): c.regular(root/'link')
            (root/'actual').mkdir(); (root/'redirect').symlink_to(root/'actual',target_is_directory=True)
            with self.assertRaisesRegex(ValueError,'redirected parent'):
                c.copy_file(root/'target',root/'redirect/new')
            self.assertFalse((root/'actual/new').exists())

    def test_gzip_crc_is_checked_through_trailer(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'snapshot.tar.gz'; data=bytearray(gzip.compress(b'payload'+b'\0'*1024))
            path.write_bytes(data); self.assertEqual(c.verify_gzip(path)['gzip_crc'],'pass')
            data[-8]^=1; path.write_bytes(data)
            with self.assertRaises((gzip.BadGzipFile,EOFError,OSError)): c.verify_gzip(path)


if __name__=='__main__': unittest.main()
