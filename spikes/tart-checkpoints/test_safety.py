"""Local, non-VM checks for the remote runner's safety boundary."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import checkpoints as c


class SafetyTests(unittest.TestCase):
    def test_reject_unowned_paths(self):
        for path in ("/Users/example/.tart", "/tmp/clankerbox-tart-checkpoints.abcdef",
                     "/Users/example/clankerbox-tart-checkpoints.abcdef/../.tart",
                     "/Users/example/clankerbox-tart-checkpoints.*", "/Users/example/clankerbox-tart-checkpoints.abcdef/"):
            if path.endswith("/"):
                continue  # Path normalizes an innocuous trailing slash.
            with self.assertRaises(ValueError):
                c.owned(path)

    def test_reject_marker_and_symlink(self):
        path = Path("/Users/example/clankerbox-tart-checkpoints.abcdef")
        with patch.object(Path, "is_symlink", return_value=False), patch.object(Path, "resolve", return_value=path):
            with patch.object(Path, "read_text", return_value="wrong\n"):
                with self.assertRaises(ValueError):
                    c.owned(path)
        with patch.object(Path, "is_symlink", return_value=True):
            with self.assertRaises(ValueError):
                c.owned(path)

    def test_every_tart_command_overrides_unsafe_environment(self):
        home = Path("/Users/example/clankerbox-tart-checkpoints.abcdef")
        with patch.object(c, "owned", return_value=home), patch.dict(os.environ, TART_HOME="/Users/example/.tart", TART_NO_AUTO_PRUNE="0"):
            for args in (("--version",), ("clone", "source", "branch"), ("delete", "branch")):
                cmd, env = c.tart_command(home, *args)
                self.assertEqual(cmd, [c.TART, *args])
                self.assertEqual(env["TART_HOME"], str(home))
                self.assertEqual(env["TART_NO_AUTO_PRUNE"], "1")
                self.assertEqual(env["HOME"], os.environ["HOME"])

    def test_only_exact_vm_names(self):
        for name in ("*", "../source", "codex-macos-tahoe-xcodegen-base", c.IMAGE, ""):
            with self.assertRaises(ValueError):
                c.vm_name(name)
        for name in c.NAMES:
            self.assertEqual(c.vm_name(name), name)

    def test_apfs_copy_is_independent(self):
        Path(".work").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".work") as directory:
            source, target = Path(directory) / "source", Path(directory) / "target"
            source.mkdir()
            (source / "disk.img").write_bytes(b"original" * 512)
            c.apfs_copy(source, target)
            (target / "disk.img").write_bytes(b"changed")
            self.assertEqual((source / "disk.img").read_bytes(), b"original" * 512)

    def test_apfs_copy_rejects_symlink(self):
        Path(".work").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=".work") as directory:
            source, target = Path(directory) / "source", Path(directory) / "target"
            source.mkdir()
            (source / "disk.img").symlink_to("/dev/null")
            with self.assertRaises(ValueError):
                c.apfs_copy(source, target)


if __name__ == "__main__":
    unittest.main()
