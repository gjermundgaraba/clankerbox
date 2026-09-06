#!/usr/bin/env python3
"""Local tests only. Forked OS processes do not prove VM snapshot semantics."""
import argparse
import copy
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from evaluate import evaluate
from fake_endpoint import make_server
from guest import State, call


def local_forks(directory):
    state = State(directory / "parent.json")
    baseline = state.status()
    children = []
    try:
        for name in ("child-a", "child-b"):
            disk = directory / (name + ".json")
            disk.write_text(state.disk.read_text())
            parent, child = socket.socketpair()
            pid = os.fork()
            if pid == 0:
                parent.close()
                for _, other, _ in children:
                    other.close()
                state.disk = disk
                try:
                    with child, child.makefile("rb") as reader:
                        for line in reader:
                            reply = state.command(json.loads(line))
                            child.sendall(json.dumps(reply).encode() + b"\n")
                finally:
                    os._exit(0)
            child.close()
            parent.settimeout(5)
            children.append((pid, parent, parent.makefile("rb")))

        def child_call(index, request):
            _, connection, reader = children[index]
            connection.sendall(json.dumps(request).encode() + b"\n")
            return json.loads(reader.readline())

        inherited = {"parent": state.status(), "child-a": child_call(0, {"op": "status"}),
                     "child-b": child_call(1, {"op": "status"})}
        # Do every write before every final read: shared-disk bugs cannot hide.
        for index, (name, delta) in enumerate((("parent", 10), ("child-a", 100), ("child-b", 1000))):
            request = {"op": "mutate", "label": name, "delta": delta}
            state.command(request) if index == 0 else child_call(index - 1, request)
        after = {"parent": state.status(), "child-a": child_call(0, {"op": "status"}),
                 "child-b": child_call(1, {"op": "status"})}
        return evaluate({"execution_scope": "local_process", "baseline": baseline,
                         "inherited": inherited, "after": after, "concurrently_running": True,
                         "metrics": {}})
    finally:
        for pid, connection, reader in children:
            reader.close()
            connection.close()
        for pid, _, _ in children:
            os.waitpid(pid, 0)
        state.marker.close()


class AcceptanceTests(unittest.TestCase):
    report = None

    def test_local_inheritance_and_reject_shared_disk(self):
        with tempfile.TemporaryDirectory(prefix="acceptance-") as path:
            # Fork from a fresh interpreter, before any HTTP server threads.
            report = json.loads(subprocess.check_output(
                [sys.executable, __file__, "--local-forks", path], text=True, timeout=10))
        self.assertEqual(report["status"], "pass")
        self.assertEqual(next(c for c in report["checks"] if c["name"] == "same_guest_pid")["status"], "not-run")
        self.assertEqual(len({s["pid"] for s in report["evidence"]["inherited"].values()}), 3)
        bad = copy.deepcopy(report["evidence"])
        bad["after"]["child-a"]["disk"] = bad["after"]["child-b"]["disk"]
        self.assertEqual(evaluate(bad)["status"], "fail")
        bad = copy.deepcopy(report["evidence"])
        bad["execution_scope"] = "vm"
        self.assertEqual(evaluate(bad)["status"], "fail")
        bad = copy.deepcopy(report["evidence"])
        bad["concurrently_running"] = False
        self.assertEqual(evaluate(bad)["status"], "fail")
        AcceptanceTests.report = report

    def test_cli_persistent_process_and_bad_request(self):
        # /tmp keeps the Unix socket name below macOS's short path limit.
        with tempfile.TemporaryDirectory(prefix="acceptance-", dir="/tmp") as path:
            sock, disk = Path(path) / "s", Path(path) / "disk.json"
            process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("guest.py")),
                                        "serve", "--socket", str(sock), "--disk", str(disk)],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.assertTrue(select.select([process.stdout], [], [], 5)[0], "server readiness timed out")
                ready = process.stdout.readline()
                if not ready:
                    self.fail(process.stderr.read())
                self.assertTrue(json.loads(ready)["ready"])
                before = call(sock, {"op": "status"})
                with self.assertRaises(ValueError):
                    call(sock, {"op": "mutate", "delta": True, "label": "bad"})
                after = call(sock, {"op": "mutate", "delta": 7, "label": "child-a"})
                self.assertEqual(before["pid"], after["pid"])
                self.assertEqual(before["marker_sha256"], after["marker_sha256"])
                self.assertEqual(after["counter"], 7)
                self.assertEqual(json.loads(disk.read_text()), {"counter": 7, "label": "child-a"})
                self.assertNotIn("marker", disk.read_text())
                self.assertIsNone(call(sock, {"op": "prepare"})["session"])
                self.assertNotEqual(before["session"], call(sock, {"op": "new-session"})["session"])
            finally:
                process.terminate()
                process.communicate(timeout=5)

    def test_duplicate_session_and_preparation(self):
        with make_server() as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                def claim(session, owner):
                    request = Request(f"http://127.0.0.1:{server.server_port}/",
                                      data=json.dumps({"session": session, "owner": owner}).encode(),
                                      headers={"Content-Type": "application/json"})
                    try:
                        with urlopen(request, timeout=5) as response:
                            return response.status
                    except HTTPError as error:
                        error.close()
                        return error.code
                with tempfile.TemporaryDirectory(prefix="acceptance-") as path:
                    state = State(Path(path) / "disk.json")
                    try:
                        inherited = state.session
                        self.assertEqual(claim(inherited, "parent"), 200)
                        self.assertEqual(claim(inherited, "child-a"), 409)
                        state.command({"op": "prepare"})
                        self.assertIsNone(state.session)
                        state.command({"op": "new-session"})
                        self.assertEqual(claim(state.session, "child-a"), 200)
                        with self.assertRaises(ValueError):
                            state.command({"op": "new-session"})
                    finally:
                        state.marker.close()
            finally:
                server.shutdown()
                thread.join(timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, help="write a local_process result artifact")
    parser.add_argument("--local-forks", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.local_forks:
        print(json.dumps(local_forks(args.local_forks)))
        sys.exit(0)
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(AcceptanceTests))
    if args.report and AcceptanceTests.report:
        args.report.write_text(json.dumps(AcceptanceTests.report, indent=2, sort_keys=True) + "\n")
    sys.exit(not result.wasSuccessful())
