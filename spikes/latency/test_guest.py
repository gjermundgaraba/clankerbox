"""Portable guest integration checks; no VM, credentials, or network required."""
import contextlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import unittest


SOURCE = Path(__file__).with_name("guest.c")


class GuestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory(prefix="latency-build-")
        cls.binaries = []
        for optimization in ("-O0", "-O2"):
            binary = Path(cls.build.name) / optimization[1:]
            subprocess.run([os.environ.get("CC", "cc"), "-std=c11", optimization,
                            "-Wall", "-Wextra", "-Werror", "-pthread",
                            str(SOURCE), "-o", str(binary)], check=True)
            cls.binaries.append(binary)

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    @contextlib.contextmanager
    def server(self, binary, root, suffix="", reuse=False):
        sock = Path(root) / ("s" + suffix)
        args = [str(binary), "serve", "--memory-mib", "4", "--dirty-mib-s", "4",
                "--workspace-mib", "1", "--workspace-files", "4",
                "--socket", str(sock), "--workspace", str(Path(root) / ("w" + suffix))]
        if reuse:
            args.append("--reuse-workspace")
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 10
            while not sock.exists():
                if proc.poll() is not None:
                    self.fail(f"guest exited before ready: {proc.communicate()}")
                if time.monotonic() >= deadline:
                    self.fail("guest ready timed out")
                time.sleep(.005)
            yield proc, sock
        finally:
            if proc.poll() is None:
                proc.terminate()
            proc.communicate(timeout=5)
            sock.unlink(missing_ok=True)

    def request(self, sock, request):
        data = request if isinstance(request, bytes) else json.dumps(request).encode() + b"\n"
        with socket.socket(socket.AF_UNIX) as conn:
            conn.settimeout(5)
            conn.connect(str(sock))
            conn.sendall(data)
            received = b""
            while b"\n" not in received:
                chunk = conn.recv(8192)
                if not chunk:
                    break
                received += chunk
        return json.loads(received)

    def test_workload_metrics_pause_mutation_and_restart(self):
        for binary in self.binaries:
            with self.subTest(binary=binary.name), tempfile.TemporaryDirectory(prefix="lt-", dir="/tmp") as root:
                with self.server(binary, root) as (proc, sock):
                    initial = self.request(sock, {"op": "status"})
                    self.assertTrue(initial["ready"] and initial["memory_ok"] and initial["disk_ok"])
                    self.assertEqual(initial["pid"], proc.pid)
                    files = sorted((Path(root) / "w").glob("payload-*"))
                    self.assertEqual(len(files), 4)
                    self.assertEqual(sum(p.stat().st_size for p in files), 1024 * 1024)
                    self.assertGreater(len(set(files[0].read_bytes())), 250)
                    original_payload = files[0].read_bytes()
                    marker = Path(root) / "w" / "branch-marker"
                    original_marker_inode = marker.stat().st_ino
                    self.assertEqual(marker.stat().st_size, 128)
                    time.sleep(.12)
                    paused = self.request(sock, {"op": "pause_writes"})
                    self.assertTrue(paused["writes_paused"])
                    self.assertGreater(paused["dirty_bytes"], 0)
                    time.sleep(.05)
                    after = self.request(sock, {"op": "status"})
                    self.assertEqual(after["dirty_bytes"], paused["dirty_bytes"])
                    reset = self.request(sock, {"op": "reset_metrics"})
                    self.assertEqual(reset["dirty_bytes"], 0)
                    self.assertEqual(reset["ram_marker"], initial["ram_marker"])
                    self.assertEqual(reset["start_monotonic_ns"], initial["start_monotonic_ns"])
                    self.assertTrue(reset["writes_paused"])
                    time.sleep(.03)
                    baseline = self.request(sock, {"op": "status"})
                    self.assertGreater(baseline["heartbeat"]["samples"], 5)
                    os.kill(proc.pid, signal.SIGSTOP)
                    try:
                        time.sleep(.08)
                    finally:
                        os.kill(proc.pid, signal.SIGCONT)
                    time.sleep(.02)
                    resumed = self.request(sock, {"op": "resume_writes"})
                    self.assertFalse(resumed["writes_paused"])
                    self.assertGreater(resumed["heartbeat"]["max_gap_monotonic_ns"], 60_000_000)
                    self.assertLessEqual(len(resumed["heartbeat"]["recent_gap_raw_ns"]), 64)
                    changed = self.request(sock, {"op": "mutate", "branch": 17})
                    self.assertEqual(changed["branch"], 17)
                    self.assertEqual(changed["disk_branch"], 17)
                    self.assertTrue(changed["memory_ok"] and changed["disk_ok"])
                    self.assertEqual(marker.stat().st_ino, original_marker_inode)
                    self.assertEqual(marker.stat().st_size, 128)
                    self.assertEqual(marker.read_bytes()[-1:], b"\n")
                    changed_again = self.request(sock, {"op": "mutate", "branch": 2147483647})
                    self.assertEqual(changed_again["disk_branch"], 2147483647)
                    self.request(sock, {"op": "mutate", "branch": 17})
                    self.assertEqual(marker.stat().st_ino, original_marker_inode)
                    self.assertEqual(marker.stat().st_size, 128)
                    cli = subprocess.run([str(binary), "call", "--socket", str(sock), '{"op":"status"}'],
                                         capture_output=True, check=True, text=True)
                    self.assertEqual(json.loads(cli.stdout)["branch"], 17)
                with self.server(binary, root, reuse=True) as (_, sock):
                    fresh = self.request(sock, {"op": "status"})
                    self.assertEqual(fresh["branch"], 17)
                    self.assertNotEqual(fresh["ram_marker"], initial["ram_marker"])
                    self.assertNotEqual(fresh["start_monotonic_ns"], initial["start_monotonic_ns"])
                    self.assertEqual(files[0].read_bytes(), original_payload)
                    self.assertEqual(marker.stat().st_ino, original_marker_inode)
                    self.assertEqual(marker.stat().st_size, 128)

    def test_rejects_invalid_requests_and_options(self):
        for binary in self.binaries:
            with self.subTest(binary=binary.name), tempfile.TemporaryDirectory(prefix="lt-", dir="/tmp") as root:
                with self.server(binary, root) as (_, sock):
                    invalid = [b'{}\n', b'{"op":"exec"}\n', b'{"op":"status","op":"status"}\n',
                               b'{"op":"status","extra":1}\n', b'{"op":"mutate"}\n',
                               b'{"op":"mutate","branch":0}\n', b'{"op":"mutate","branch":-1}\n',
                               b'{"op":"mutate","branch":2147483648}\n', b'{"op":"status"}\x00\n',
                               b'{"op":"sta\\tus"}\n', b'{"op":"status",}\n', b'{' + b' ' * 300 + b'}\n']
                    for payload in invalid:
                        self.assertFalse(self.request(sock, payload)["ok"], payload)
                    self.assertTrue(self.request(sock, {"op": "status"})["ok"])
                for args in (["--memory-mib", "0"], ["--memory-mib", "8193"],
                             ["--dirty-mib-s", "-1"], ["--workspace-files", "nan"],
                             ["--workspace-mib", "1", "--workspace-files", "0"]):
                    result = subprocess.run([str(binary), "serve", *args], capture_output=True, timeout=5)
                    self.assertEqual(result.returncode, 2, args)

    def test_distinct_workspaces_and_corruption_detection(self):
        binary = self.binaries[-1]
        with tempfile.TemporaryDirectory(prefix="lt-", dir="/tmp") as root:
            with self.server(binary, root, "a") as (_, a), self.server(binary, root, "b") as (_, b):
                self.request(a, {"op": "mutate", "branch": 99})
                self.assertEqual(self.request(b, {"op": "status"})["branch"], 0)
                (Path(root) / "wa" / "branch-marker").write_text("corrupt\n")
                self.assertFalse(self.request(a, {"op": "status"})["disk_ok"])

    def test_reuse_rejects_wrong_size_and_symlink_marker(self):
        binary = self.binaries[-1]
        with tempfile.TemporaryDirectory(prefix="lt-", dir="/tmp") as root:
            with self.server(binary, root) as (proc, _):
                restart = [*proc.args, "--reuse-workspace"]
            marker = Path(root) / "w" / "branch-marker"
            original = marker.read_bytes()
            marker.write_bytes(original[:64])
            result = subprocess.run(restart, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 2)
            target = Path(root) / "saved-marker"
            target.write_bytes(original)
            marker.unlink()
            marker.symlink_to(target)
            result = subprocess.run(restart, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
