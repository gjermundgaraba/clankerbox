"""Image extraction preserves guest access even under a restrictive host umask."""

import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

IMAGES = Path(__file__).resolve().parents[1] / 'images'
spec = importlib.util.spec_from_file_location('stage_linux', IMAGES / 'stage-linux.py')
staging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(staging)


class ImageStagingTests(unittest.TestCase):
    def test_guest_root_and_executable_modes_survive_umask(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            archive = base / 'rootfs.tar'
            with tarfile.open(archive, 'w') as tar:
                root = tarfile.TarInfo('.')
                root.type, root.mode = tarfile.DIRTYPE, 0o755
                tar.addfile(root)
                for name, mode in [('tmp', 0o1777), ('shared', 0o2775)]:
                    item = tarfile.TarInfo(name)
                    item.type, item.mode = tarfile.DIRTYPE, mode
                    tar.addfile(item)
                executable = tarfile.TarInfo('shell')
                executable.mode, executable.size = 0o4755, 4
                tar.addfile(executable, io.BytesIO(b'test'))
            image = base / 'image'
            image.mkdir(mode=0o700)
            previous = os.umask(0o077)
            try:
                staging.extract(archive, image)
            finally:
                os.umask(previous)
            self.assertEqual(image.stat().st_mode & 0o7777, 0o755)
            self.assertEqual((image / 'tmp').stat().st_mode & 0o7777, 0o1777)
            self.assertEqual((image / 'shared').stat().st_mode & 0o7777, 0o2775)
            self.assertEqual((image / 'shell').stat().st_mode & 0o7777, 0o4755)

    def test_rejects_external_parent_before_creating_host_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            image, outside = base / 'image', base / 'outside'
            image.mkdir()
            outside.mkdir()
            (image / 'link').symlink_to(outside)
            archive = base / 'rootfs.tar'
            with tarfile.open(archive, 'w') as tar:
                item = tarfile.TarInfo('link/new/file')
                item.size = 4
                tar.addfile(item, io.BytesIO(b'test'))
            with self.assertRaisesRegex(ValueError, 'parent escapes'):
                staging.extract(archive, image)
            self.assertEqual(list(outside.iterdir()), [])

    def test_rejects_external_directory_before_changing_host_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            image, outside = base / 'image', base / 'outside'
            image.mkdir()
            outside.mkdir(mode=0o700)
            (image / 'link').symlink_to(outside)
            archive = base / 'rootfs.tar'
            with tarfile.open(archive, 'w') as tar:
                item = tarfile.TarInfo('link')
                item.type, item.mode = tarfile.DIRTYPE, 0o777
                tar.addfile(item)
            with self.assertRaisesRegex(ValueError, 'directory escapes'):
                staging.extract(archive, image)
            self.assertEqual(outside.stat().st_mode & 0o7777, 0o700)


class MacImageStagingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        self.tart = self.base / 'tools with spaces' / 'tart'
        self.tart.parent.mkdir()
        self.tart.write_text("""#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$TART_TEST_LOG"
case "$1" in
  --version) printf '%s\\n' "${TART_TEST_VERSION:-2.36.0}" ;;
  clone) mkdir -p "$TART_HOME/vms/$3" ;;
  list) test -d "$TART_HOME/vms/seed-e0721ddeae3c" ;;
  *) exit 99 ;;
esac
""")
        self.tart.chmod(0o755)
        self.log = self.base / 'calls'
        self.env = dict(os.environ, TART_BIN=str(self.tart), TART_TEST_LOG=str(self.log))
        self.env.pop('TART_TEST_VERSION', None)

    def run_script(self, name, home):
        args = ['/bin/bash', str(IMAGES / name), str(home)]
        if name == 'finalize-mac.sh':
            guest = self.base / 'guest'
            guest.write_bytes(b'guest')
            args.append(str(guest))
        return subprocess.run(
            args, env=self.env, capture_output=True, text=True
        )

    def test_stage_in_arbitrary_home_with_explicit_binary_or_path(self):
        for lookup in ('explicit', 'path'):
            with self.subTest(lookup=lookup):
                if lookup == 'path':
                    self.env.pop('TART_BIN')
                    self.env['PATH'] = str(self.tart.parent) + os.pathsep + os.environ['PATH']
                home = self.base / ('arbitrary home ' + lookup)
                result = self.run_script('stage-mac.sh', home)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((home / '.clankerbox-inputs').read_text(), 'clankerbox-mac-inputs-v1\n')
                self.assertTrue((home / 'vms/seed-e0721ddeae3c').is_dir())

    def test_stage_rejects_wrong_tart_version_before_creating_home(self):
        self.env['TART_TEST_VERSION'] = '0.0.0'
        home = self.base / 'new home'
        self.assertNotEqual(self.run_script('stage-mac.sh', home).returncode, 0)
        self.assertFalse(home.exists())

    def test_finalize_requires_staging_marker_and_source_before_native_commands(self):
        home = self.base / 'unrelated home'
        home.mkdir()
        for marker in (None, 'unrelated', 'clankerbox-mac-inputs-v1'):
            with self.subTest(marker=marker):
                if marker is not None:
                    (home / '.clankerbox-inputs').write_text(marker + '\n')
                self.assertNotEqual(self.run_script('finalize-mac.sh', home).returncode, 0)
                self.assertFalse(self.log.exists())

    def test_finalize_accepts_staged_home_and_checks_tart_version(self):
        home = self.base / 'staged home'
        self.assertEqual(self.run_script('stage-mac.sh', home).returncode, 0)
        self.log.unlink()
        self.env['TART_TEST_VERSION'] = '0.0.0'
        self.assertNotEqual(self.run_script('finalize-mac.sh', home).returncode, 0)
        self.assertEqual(self.log.read_text(), '--version\n')


if __name__ == '__main__':
    unittest.main()
