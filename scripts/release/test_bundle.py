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
from types import SimpleNamespace

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
            root = pathlib.Path(directory) / 'bundle'
            root.mkdir()
            (root / 'file').write_text('value')
            (root / 'unicode-link').symlink_to('é' * 100)
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


class RuntimeInputTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        inputs = self.root / 'scripts/release/inputs'
        inputs.mkdir(parents=True)
        self.assets = self.root / 'assets'
        (self.assets / 'lib').mkdir(parents=True)
        (self.assets / 'lib/library').write_bytes(b'qualified library')
        (self.assets / 'lib/alias').symlink_to('library')
        for name in bundle.RUNTIME_TEMPLATES:
            (self.assets / name).write_bytes(name.encode())
        files = bundle.inventory(self.assets, include_root=False)
        for record in files:
            del record['mode']
        (inputs / 'runtime-artifacts.json').write_text(
            json.dumps(
                {
                    'platforms': {
                        'darwin-arm64': {'files': files},
                        'linux-amd64': {
                            'files': [
                                dict(record, sha256='0' * 64) if record['type'] == 'file' else record
                                for record in files
                            ]
                        },
                    }
                }
            )
        )
        self.args = SimpleNamespace(
            os='darwin',
            arch='arm64',
            engine=self.root / 'engine',
            image=self.root / 'image',
            runtime_assets=self.assets,
        )
        self.args.engine.write_bytes(b'engine')
        agent = self.args.image / 'usr/local/bin/smolvm-agent'
        agent.parent.mkdir(parents=True)
        agent.write_bytes(b'agent')
        self.args.image.chmod(0o755)
        (inputs / 'runtime.patch').write_bytes(b'patch')
        (inputs / 'pins.json').write_text(
            json.dumps(
                {
                    'hashes': {
                        'target/debug/smolvm': bundle.sha(self.args.engine),
                        'agent-target/aarch64-unknown-linux-musl/release/smolvm-agent': bundle.sha(agent),
                    },
                    'runtime_patch_sha256': bundle.sha(inputs / 'runtime.patch'),
                }
            )
        )
        patch = mock.patch.object(bundle, 'ROOT', self.root)
        patch.start()
        self.addCleanup(patch.stop)

    def verify(self):
        bundle.verify_inputs(self.args)

    def test_qualified_files_and_relative_library_link_pass(self):
        self.verify()
        # Unshipped upstream distribution files are not runtime payloads.
        (self.assets / 'README').write_text('upstream readme')
        (self.assets / 'lib/library').chmod(0o750)
        self.verify()

    def test_wrong_platform_fails(self):
        with self.assertRaisesRegex(ValueError, 'qualified platform inventory'):
            bundle.verify_runtime_assets(self.assets, 'linux', 'amd64')

    def test_missing_library_or_template_fails(self):
        for name in ['lib/library', *bundle.RUNTIME_TEMPLATES]:
            with self.subTest(name=name):
                path = self.assets / name
                contents = path.read_bytes()
                path.unlink()
                with self.assertRaisesRegex(ValueError, 'qualified'):
                    self.verify()
                path.write_bytes(contents)

    def test_changed_library_or_template_fails(self):
        for name in ['lib/library', *bundle.RUNTIME_TEMPLATES]:
            with self.subTest(name=name):
                path = self.assets / name
                contents = path.read_bytes()
                path.write_bytes(b'unqualified replacement')
                with self.assertRaisesRegex(ValueError, 'qualified platform inventory'):
                    self.verify()
                path.write_bytes(contents)

    def test_added_library_payload_fails(self):
        extra = self.assets / 'lib/.unqualified'
        extra.write_bytes(b'new loader payload')
        with self.assertRaisesRegex(ValueError, 'qualified platform inventory'):
            self.verify()
        extra.unlink()
        extra.mkdir()
        (extra / 'nested').write_bytes(b'new nested payload')
        with self.assertRaisesRegex(ValueError, 'qualified platform inventory'):
            self.verify()

    def test_changed_or_substituted_link_fails(self):
        link = self.assets / 'lib/alias'
        link.unlink()
        link.symlink_to('/outside/library')
        with self.assertRaisesRegex(ValueError, 'qualified platform inventory'):
            self.verify()
        link.unlink()
        # Identical hash to the pinned link text must not permit a regular file.
        link.write_bytes(b'library')
        with self.assertRaisesRegex(ValueError, 'qualified platform inventory'):
            self.verify()

    def test_library_directory_cannot_be_a_link(self):
        (self.assets / 'lib').rename(self.root / 'external-lib')
        (self.assets / 'lib').symlink_to(self.root / 'external-lib')
        with self.assertRaisesRegex(ValueError, 'qualified platform inventory'):
            self.verify()

    def test_fifo_and_privileged_library_modes_fail(self):
        os.mkfifo(self.assets / 'lib/fifo')
        with self.assertRaisesRegex(ValueError, 'unsupported payload type'):
            self.verify()
        (self.assets / 'lib/fifo').unlink()
        (self.assets / 'lib/library').chmod(0o4755)
        with self.assertRaisesRegex(ValueError, 'setuid/setgid'):
            self.verify()

    def test_invalid_runtime_fails_before_output_or_build(self):
        (self.assets / 'lib/library').write_bytes(b'unqualified')
        output = self.root / 'output'
        argv = [
            'bundle.py',
            '--os',
            'darwin',
            '--arch',
            'arm64',
            '--version',
            'test',
            '--engine',
            str(self.args.engine),
            '--image',
            str(self.args.image),
            '--runtime-assets',
            str(self.assets),
            '--engine-source',
            str(self.root),
            '--dependency-notices',
            str(self.root),
            '--output',
            str(output),
        ]
        with mock.patch('sys.argv', argv), mock.patch.object(bundle.subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'qualified platform inventory'):
                bundle.main()
            run.assert_not_called()
        self.assertFalse(output.exists())

    def test_changed_copy_fails_before_manifest(self):
        output = self.root / 'output'
        argv = [
            'bundle.py',
            '--os',
            'darwin',
            '--arch',
            'arm64',
            '--version',
            'test',
            '--engine',
            str(self.args.engine),
            '--image',
            str(self.args.image),
            '--runtime-assets',
            str(self.assets),
            '--engine-source',
            str(self.root),
            '--dependency-notices',
            str(self.root),
            '--output',
            str(output),
        ]
        copytree = shutil.copytree

        def changed_copy(source, target, **kwargs):
            result = copytree(source, target, **kwargs)
            (target / 'library').write_bytes(b'changed during copy')
            return result

        original_umask = os.umask(0o022)
        self.addCleanup(os.umask, original_umask)
        with (
            mock.patch('sys.argv', argv),
            mock.patch.object(bundle, 'verify_licenses', return_value={}),
            mock.patch.object(bundle.subprocess, 'run'),
            mock.patch.object(bundle.shutil, 'copytree', side_effect=changed_copy),
        ):
            with self.assertRaisesRegex(ValueError, 'qualified platform inventory'):
                bundle.main()
        self.assertFalse((output / 'bundle.json').exists())

    def test_bundle_carries_project_license(self):
        (self.root / 'LICENSE').write_text('project license')
        (self.root / 'scripts/release/README.md').write_text('release notes')
        (self.root / 'scripts/release/licenses').mkdir()
        engine_source = self.root / 'engine-source'
        engine_source.mkdir()
        (engine_source / 'LICENSE').write_text('engine license')
        notices = self.root / 'notices'
        notices.mkdir()
        output = self.root / 'output'
        argv = [
            'bundle.py',
            '--os',
            'darwin',
            '--arch',
            'arm64',
            '--version',
            'test',
            '--no-archive',
            '--engine',
            str(self.args.engine),
            '--image',
            str(self.args.image),
            '--runtime-assets',
            str(self.assets),
            '--engine-source',
            str(engine_source),
            '--dependency-notices',
            str(notices),
            '--output',
            str(output),
        ]
        with (
            mock.patch('sys.argv', argv),
            mock.patch('builtins.print'),
            mock.patch.object(bundle, 'verify_licenses', return_value={}),
            mock.patch.object(bundle, 'verify_release_licenses'),
            mock.patch.object(bundle.subprocess, 'run'),
        ):
            bundle.main()
        self.assertEqual((output / 'LICENSE').read_text(), 'project license')
        manifest = json.loads((output / 'bundle.json').read_text())
        self.assertIn('LICENSE', [item['path'] for item in manifest['files']])


class LicenseInputTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.engine = self.root / 'engine'
        self.notices = self.root / 'notices'
        inputs = self.root / 'scripts/release/inputs'
        native = self.root / 'scripts/release/licenses'
        for directory in [self.engine, self.notices, inputs, native]:
            directory.mkdir(parents=True)
        for name in ['LICENSE', 'Cargo.lock']:
            (self.engine / name).write_text(name)
        source = {'files': {name: bundle.sha(self.engine / name) for name in ['LICENSE', 'Cargo.lock']}}
        (inputs / 'source.json').write_text(json.dumps(source))
        (native / 'LICENSE').write_text('native license')
        (native / 'sources.json').write_text(
            json.dumps([{'file': 'LICENSE', 'sha256': bundle.sha(native / 'LICENSE')}])
        )
        for name in ['go.mod', 'go.sum']:
            (self.root / name).write_text(name)
        provenance = {
            'go_mod_sha256': bundle.sha(self.root / 'go.mod'),
            'go_sum_sha256': bundle.sha(self.root / 'go.sum'),
            'rust_lock_sha256': source['files']['Cargo.lock'],
        }
        (self.notices / 'provenance.json').write_text(json.dumps(provenance))
        rows = []
        for ecosystem, key in [('go', 'package@1.0'), ('rust', 'package-1.0')]:
            target = self.notices / ecosystem / key
            target.mkdir(parents=True)
            (target / 'LICENSE').write_text(ecosystem + ' license')
            rows.append({'ecosystem': ecosystem, 'name': 'package', 'version': '1.0', 'notices': ['LICENSE']})
        (self.notices / 'dependencies.json').write_text(json.dumps(rows))
        (self.notices / 'inventory.json').write_text(json.dumps(bundle.inventory(self.notices, include_root=False)))
        self.patch = mock.patch.object(bundle, 'ROOT', self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_complete_inputs_and_output_are_verified(self):
        source = bundle.verify_licenses(self.engine, self.notices)
        output = self.root / 'output'
        licenses = output / 'licenses'
        licenses.mkdir(parents=True)
        shutil.copy2(self.engine / 'LICENSE', licenses / 'smolvm-LICENSE')
        (licenses / 'source.json').write_text(json.dumps(source))
        shutil.copytree(self.notices, licenses / 'dependencies')
        shutil.copytree(self.root / 'scripts/release/licenses', licenses / 'native')
        bundle.verify_release_licenses(output)
        (licenses / 'dependencies/go/package@1.0/LICENSE').write_text('modified')
        with self.assertRaisesRegex(ValueError, 'release dependency notice inventory'):
            bundle.verify_release_licenses(output)

    def test_missing_source_license_fails(self):
        (self.engine / 'LICENSE').unlink()
        with self.assertRaisesRegex(ValueError, 'required regular nonempty file'):
            bundle.verify_licenses(self.engine, self.notices)

    def test_empty_notices_directory_fails(self):
        shutil.rmtree(self.notices)
        self.notices.mkdir()
        with self.assertRaisesRegex(ValueError, 'provenance.json'):
            bundle.verify_licenses(self.engine, self.notices)

    def test_changed_notice_or_lock_fails(self):
        (self.notices / 'go/package@1.0/LICENSE').write_text('modified')
        with self.assertRaisesRegex(ValueError, 'inventory mismatch'):
            bundle.verify_licenses(self.engine, self.notices)
        (self.root / 'go.mod').write_text('new dependency')
        with self.assertRaisesRegex(ValueError, 'provenance mismatch'):
            bundle.verify_licenses(self.engine, self.notices)

    def test_changed_engine_cargo_lock_fails(self):
        (self.engine / 'Cargo.lock').write_text('unqualified lock')
        with self.assertRaisesRegex(ValueError, 'engine source license/provenance mismatch: Cargo.lock'):
            bundle.verify_licenses(self.engine, self.notices)


if __name__ == '__main__':
    unittest.main()
