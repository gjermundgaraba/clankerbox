#!/usr/bin/env python3
"""Discoverable safety checks using fake proc files; no signals or VMs."""
import importlib.util
import os
from pathlib import Path
import socket
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("runner", Path(__file__).with_name("run-linux.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class SafetyTests(unittest.TestCase):
    def test_bad_stage(self):
        for path in (Path("/"), Path("/home/clanker"), Path("/home/clanker/clankerbox-smolvm.other"),
                     Path("/home/clanker/clankerbox-smolvm.Jf1bpB/../elsewhere")):
            with self.assertRaises(ValueError):
                runner.validate_stage(path)
        for name in ("../parent", "existing-user-vm", "cb-smol-20260905-110416-child-c"):
            with self.assertRaises(ValueError):
                runner.remove_owned_orphan(name)

    def test_foreign_pid_and_birth(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent / ".work") as tmp:
            root = Path(tmp)
            binary, foreign = root / "smolvm", root / "foreign"
            binary.touch()
            foreign.touch()
            proc = root / "123"
            proc.mkdir()
            (proc / "exe").symlink_to(foreign)
            with self.assertRaises(ValueError):
                runner.owned_process(123, binary, proc_root=root)
            (proc / "exe").unlink()
            (proc / "exe").symlink_to(binary)
            (proc / "stat").write_text("123 (a name) S " + "0 " * 18 + "456\n")
            (proc / "cmdline").write_bytes(b"smolvm\0_boot-vm\0")
            self.assertEqual(runner.owned_process(123, binary, "456", root)["start_time"], "456")
            with self.assertRaises(ValueError):
                runner.owned_process(123, binary, "wrong-birth", root)
            for invalid in (None, True, 0, 1, -10, "123"):
                with self.assertRaises(ValueError):
                    runner.owned_process(invalid, binary, proc_root=root)

    def test_active_and_unowned_socket_are_preserved(self):
        # macOS AF_UNIX paths are short; the fixture stays inside our owned tree.
        path = Path(__file__).parent / ".work/safety.sock"
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(str(path))
            try:
                server.listen()
                with self.assertRaises(ValueError):
                    runner.clear_dead_socket(path)
                with self.assertRaises(ValueError):
                    runner.clear_dead_socket(path, path.stat().st_ino)
                self.assertTrue(path.exists())
            finally:
                inode = path.stat().st_ino
        runner.clear_dead_socket(path, inode)
        self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
