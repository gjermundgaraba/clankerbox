import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zlib

spec = importlib.util.spec_from_file_location('smol_recovery', Path(__file__).with_name('run.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SafetyTests(unittest.TestCase):
    def test_observer_uses_persisted_config_after_transient_unlink(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / 'agent.config.json').write_text('{"resources":{"network":false}}')
            self.assertFalse((directory / 'boot-config.json').exists())
            self.assertIs(module.persisted_launch_config(directory / 'boot-config.json')['resources']['network'], False)

    def test_unaddressed_dummy_is_not_external_nic(self):
        value = {'interfaces': ['dummy0', 'lo'], 'addresses': [
            {'ifname': 'lo'}, {'ifname': 'dummy0', 'linkinfo': {'info_kind': 'dummy'}, 'addr_info': []}],
            'route': 'header\n', 'ipv6_route': 'loopback-route lo\n'}
        module.validate_network(value)
        value['addresses'][1]['linkinfo']['info_kind'] = 'veth'
        with self.assertRaises(RuntimeError):
            module.validate_network(value)
        value['interfaces'].append('eth0')
        with self.assertRaises(RuntimeError):
            module.validate_network(value)

    def test_owned_socket_paths_fit_linux(self):
        path = module.ROOT / 'x/abcdef/s4/c/smolvm/vms' / ('0' * 16) / 'control.sock'
        self.assertLess(len(str(path).encode()), 108)

    def test_integrity_failure_is_not_retryable(self):
        runner = object.__new__(module.Runner)
        runner.guest = lambda *a, **kw: subprocess.CompletedProcess([], 0, stdout=json.dumps(
            {'ok': True, 'ready': True, 'memory_ok': False, 'disk_ok': True}))
        with self.assertRaises(module.IntegrityError):
            runner.ready('space', 'name')

    def test_nonzero_integrity_failure_is_not_masked(self):
        runner = object.__new__(module.Runner)
        runner.guest = lambda *a, **kw: subprocess.CompletedProcess([], 1, stdout=json.dumps(
            {'ok': False, 'ready': True, 'memory_ok': False, 'disk_ok': True}))
        with self.assertRaises(module.IntegrityError):
            runner.ready('space', 'name')

    def test_termination_raises_into_finally(self):
        with self.assertRaisesRegex(RuntimeError, 'signal 15'):
            module.interrupted_signal(15, None)

    def test_scope_rejects_broad_paths(self):
        for path in ('/', '/home/clanker', str(module.ROOT), str(module.ROOT.parent / 'cocoon')):
            with self.assertRaises(RuntimeError):
                module.scope(path)

    def test_scope_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            (root / 'real').mkdir()
            (root / 'link').symlink_to(root / 'real')
            with patch.object(module, 'ROOT', root):
                self.assertEqual(module.scope(root / 'real'), root / 'real')
                with self.assertRaises(RuntimeError):
                    module.scope(root / 'link')

    def artifact(self, path):
        assets = b'compressed-assets-fixture'
        manifest = json.dumps({'checkpoint': {'runtime_abi': 'libkrun-portable-snapshot-v1'}}).encode()
        footer = bytearray(64)
        footer[:8] = b'SMOLPACK'
        struct.pack_into('<I', footer, 8, 1)
        struct.pack_into('<QQQQQ', footer, 12, 0, 0, len(assets), len(assets), len(manifest))
        struct.pack_into('<I', footer, 52, zlib.crc32(assets + manifest))
        path.write_bytes(assets + manifest + footer)

    def test_incompatible_changes_abi_not_checksum_validity(self):
        with tempfile.TemporaryDirectory() as temp:
            source, bad = Path(temp) / 'source', Path(temp) / 'bad'
            self.artifact(source)
            module.make_bad(source, bad, 'incompatible')
            data = bad.read_bytes()
            self.assertIn(b'libkrun-portable-snapshot-v9', data)
            self.assertEqual(zlib.crc32(data[:-64]), struct.unpack_from('<I', data[-64:], 52)[0])
            self.assertEqual(source.stat().st_size, bad.stat().st_size)

    def test_corrupt_keeps_stale_checksum_and_source_unchanged(self):
        with tempfile.TemporaryDirectory() as temp:
            source, bad = Path(temp) / 'source', Path(temp) / 'bad'
            self.artifact(source)
            digest = module.sha(source)
            module.make_bad(source, bad, 'corrupt')
            data = bad.read_bytes()
            self.assertNotEqual(zlib.crc32(data[:-64]), struct.unpack_from('<I', data[-64:], 52)[0])
            self.assertEqual(module.sha(source), digest)

    def test_truncation_removes_footer_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            source, bad = Path(temp) / 'source', Path(temp) / 'bad'
            self.artifact(source)
            module.make_bad(source, bad, 'truncated')
            self.assertEqual(bad.stat().st_size, source.stat().st_size - 37)

    def test_publication_patch_orders_directory_sync_after_publish(self):
        patch_text = Path(__file__).with_name('publication-fsync.patch').read_text()
        self.assertLess(patch_text.index('persist_noclobber(output)'), patch_text.index('File::open(parent)?.sync_all()?'))
        self.assertIn('#[cfg(unix)]', patch_text)


if __name__ == '__main__':
    unittest.main()
