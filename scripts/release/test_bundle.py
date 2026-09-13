"""Release metadata tests: modes and types are part of checkpoint identity."""
import importlib.util
import pathlib
import os
import subprocess
import json
import hashlib
import shutil
from unittest import mock
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('bundle', pathlib.Path(__file__).with_name('bundle.py'))
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)

class InventoryTests(unittest.TestCase):
    def test_canonical_json_golden(self):
        value = [{'path': 'é<&\u2028\u2029', 'type': 'file', 'mode': 493, 'sha256': 'abc'}]
        expected = '[{"mode":493,"path":"é<&\\u2028\\u2029","sha256":"abc","type":"file"}]'
        self.assertEqual(bundle.canonical_json(value), expected)
        self.assertEqual(bundle.content_digest(value), hashlib.sha256(expected.encode()).hexdigest())

    def test_archive_headers_have_no_pax_charset_on_every_platform(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)/'bundle'
            root.mkdir()
            (root/'file').write_text('value')
            (root/'unicode-link').symlink_to('é'*100)
            archive, _ = bundle.package_archive(root)
            with tarfile.open(archive) as contents:
                for member in contents:
                    self.assertFalse(member.pax_headers)
                    self.assertEqual(member.uid, 0)
                    self.assertEqual(member.gid, 0)
                    self.assertEqual(member.mtime, 0)

    def test_system_tar_preserves_unicode_symlink_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory) / 'bundle'
            root.mkdir()
            target = 'Főtanúsítvány.pem'
            (root / target).write_text('certificate')
            (root / 'link').symlink_to(target)
            (root / 'tmp').mkdir(mode=0o1777)
            (root / 'tmp').chmod(0o1777)
            (root / 'run').write_text('executable')
            (root / 'run').chmod(0o755)
            archive, _ = bundle.package_archive(root)
            extracted = pathlib.Path(directory) / 'extracted'
            extracted.mkdir()
            subprocess.run(['tar', '-xzpf', str(archive), '-C', str(extracted)], check=True)
            with tarfile.open(archive) as contents:
                self.assertFalse(any('hdrcharset' in item.pax_headers for item in contents))
            self.assertEqual(os.readlink(extracted / 'link'), target)
            self.assertEqual((extracted / 'link').read_text(), 'certificate')
            self.assertEqual((extracted / 'tmp').stat().st_mode & 0o7777, 0o1777)
            self.assertEqual((extracted / 'run').stat().st_mode & 0o7777, 0o755)

    def test_platform_archive_names_preserve_dotted_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            archives = []
            for platform in ['darwin-arm64', 'linux-amd64']:
                root = pathlib.Path(directory) / ('clankerbox-0.2.0-rc5-' + platform)
                root.mkdir()
                (root / 'payload').write_text(platform)
                archive, checksum = bundle.package_archive(root)
                self.assertEqual(archive.name, root.name + '.tar.gz')
                self.assertEqual(checksum, bundle.sha(archive))
                archives.append(archive)
                with self.assertRaises(FileExistsError):
                    bundle.package_archive(root)
            self.assertNotEqual(*archives)

    def test_metadata_changes_identity_but_location_does_not(self):
        with tempfile.TemporaryDirectory() as directory:
            first = pathlib.Path(directory) / 'one'
            first.mkdir(mode=0o755)
            first.chmod(0o755)
            binary = first / 'shell'
            binary.write_bytes(b'executable')
            binary.chmod(0o755)
            before = bundle.content_digest(bundle.inventory(first))
            binary.chmod(0o700)
            self.assertNotEqual(before, bundle.content_digest(bundle.inventory(first)))
            binary.chmod(0o755)
            first.chmod(0o750)
            self.assertNotEqual(before, bundle.content_digest(bundle.inventory(first)))
            first.chmod(0o755)
            second = first.with_name('two')
            first.rename(second)
            self.assertEqual(before, bundle.content_digest(bundle.inventory(second)))

    def test_directories_and_literal_links_are_inventoried(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'empty').mkdir(mode=0o755)
            (root / 'empty').chmod(0o755)
            (root / 'link').symlink_to('empty')
            records = {row['path']: row for row in bundle.inventory(root)}
            self.assertEqual(records['empty'], {'path': 'empty', 'type': 'directory', 'mode': 0o755})
            self.assertEqual(records['link']['type'], 'symlink')
            self.assertEqual(records['link']['mode'], 0o777)
            self.assertEqual(len(records['link']['sha256']), 64)
            self.assertIn('.', records)
            self.assertNotIn('.', {row['path'] for row in bundle.inventory(root, include_root=False)})

    def test_rejects_special_files_and_privileged_modes(self):
        import os
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            payload = root / 'payload'
            payload.touch()
            payload.chmod(0o4755)
            with self.assertRaisesRegex(ValueError, 'setuid'):
                bundle.inventory(root)
            payload.unlink()
            os.mkfifo(payload)
            with self.assertRaisesRegex(ValueError, 'unsupported'):
                bundle.inventory(root)

class LicenseInputTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.engine = self.root/'engine'
        self.notices = self.root/'notices'
        inputs = self.root/'scripts/release/inputs'
        native = self.root/'scripts/release/licenses'
        for directory in [self.engine, self.notices, inputs, native]:
            directory.mkdir(parents=True)
        for name in ['LICENSE', 'Cargo.lock']:
            (self.engine/name).write_text(name)
        source = {'files': {name: bundle.sha(self.engine/name) for name in ['LICENSE', 'Cargo.lock']}}
        (inputs/'source.json').write_text(json.dumps(source))
        (native/'LICENSE').write_text('native license')
        (native/'sources.json').write_text(json.dumps([{'file': 'LICENSE', 'sha256': bundle.sha(native/'LICENSE')}]))
        for name in ['go.mod', 'go.sum']:
            (self.root/name).write_text(name)
        provenance = {'go_mod_sha256': bundle.sha(self.root/'go.mod'), 'go_sum_sha256': bundle.sha(self.root/'go.sum'),
                      'rust_lock_sha256': source['files']['Cargo.lock']}
        (self.notices/'provenance.json').write_text(json.dumps(provenance))
        rows = []
        for ecosystem, key in [('go', 'package@1.0'), ('rust', 'package-1.0')]:
            target = self.notices/ecosystem/key
            target.mkdir(parents=True)
            (target/'LICENSE').write_text(ecosystem + ' license')
            rows.append({'ecosystem': ecosystem, 'name': 'package', 'version': '1.0', 'notices': ['LICENSE']})
        (self.notices/'dependencies.json').write_text(json.dumps(rows))
        (self.notices/'inventory.json').write_text(json.dumps(bundle.inventory(self.notices, include_root=False)))
        self.patch = mock.patch.object(bundle, 'ROOT', self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_complete_inputs_and_output_are_verified(self):
        source = bundle.verify_licenses(self.engine, self.notices)
        output = self.root/'output'
        licenses = output/'licenses'
        licenses.mkdir(parents=True)
        shutil.copy2(self.engine/'LICENSE', licenses/'smolvm-LICENSE')
        (licenses/'source.json').write_text(json.dumps(source))
        shutil.copytree(self.notices, licenses/'dependencies')
        shutil.copytree(self.root/'scripts/release/licenses', licenses/'native')
        bundle.verify_release_licenses(output)
        (licenses/'dependencies/go/package@1.0/LICENSE').write_text('modified')
        with self.assertRaisesRegex(ValueError, 'release dependency notice inventory'):
            bundle.verify_release_licenses(output)

    def test_missing_source_license_fails(self):
        (self.engine/'LICENSE').unlink()
        with self.assertRaisesRegex(ValueError, 'required regular nonempty file'):
            bundle.verify_licenses(self.engine, self.notices)

    def test_empty_notices_directory_fails(self):
        shutil.rmtree(self.notices)
        self.notices.mkdir()
        with self.assertRaisesRegex(ValueError, 'provenance.json'):
            bundle.verify_licenses(self.engine, self.notices)

    def test_changed_notice_or_lock_fails(self):
        (self.notices/'go/package@1.0/LICENSE').write_text('modified')
        with self.assertRaisesRegex(ValueError, 'inventory mismatch'):
            bundle.verify_licenses(self.engine, self.notices)
        (self.root/'go.mod').write_text('new dependency')
        with self.assertRaisesRegex(ValueError, 'provenance mismatch'):
            bundle.verify_licenses(self.engine, self.notices)

if __name__ == '__main__':
    unittest.main()
