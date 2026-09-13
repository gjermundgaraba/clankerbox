"""Image extraction preserves guest access even under a restrictive host umask."""
import importlib.util
import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('stage_linux', Path(__file__).resolve().parents[1] / 'images/stage-linux.py')
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
            self.assertEqual((image / 'shell').stat().st_mode & 0o7777, 0o755)

if __name__ == '__main__':
    unittest.main()
