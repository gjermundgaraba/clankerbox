"""Release metadata tests: modes and types are part of checkpoint identity."""
import importlib.util
import pathlib
import os
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('bundle', pathlib.Path(__file__).with_name('bundle.py'))
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)

class InventoryTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'darwin', 'Apple archive extraction regression')
    def test_system_tar_preserves_unicode_symlink_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory) / 'bundle'
            root.mkdir()
            target = 'Főtanúsítvány.pem'
            (root / target).write_text('certificate')
            (root / 'link').symlink_to(target)
            archive, _ = bundle.package_archive(root)
            extracted = pathlib.Path(directory) / 'extracted'
            extracted.mkdir()
            subprocess.run(['tar', '-xzpf', str(archive), '-C', str(extracted)], check=True)
            self.assertEqual(os.readlink(extracted / 'link'), target)
            self.assertEqual((extracted / 'link').read_text(), 'certificate')

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

if __name__ == '__main__':
    unittest.main()
