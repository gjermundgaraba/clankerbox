import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from control import Controller, fixture_host, handler


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="cb-control-test-")
        self.root = Path(self.scratch.name)
        self.host_db = self.root / "host.sqlite"
        self.command = [sys.executable, str(Path(__file__).with_name("control.py")),
                        "fixture-host", "--db", str(self.host_db)]

    def tearDown(self):
        self.scratch.cleanup()

    def request(self, action, key=None):
        return {"id": key or action, "request": {"action": action, "machine": "one"}}

    def test_fixture_stop_retains_disk_and_delete_is_explicit(self):
        created = fixture_host(self.host_db, self.request("create"))
        started = fixture_host(self.host_db, self.request("start"))
        stopped = fixture_host(self.host_db, self.request("stop"))
        self.assertEqual(created["machine"]["disk_marker"], stopped["machine"]["disk_marker"])
        self.assertEqual(started["machine"]["power"], "running")
        self.assertEqual(stopped["machine"]["power"], "stopped")
        self.assertEqual(fixture_host(self.host_db, self.request("start")), started)
        with self.assertRaises(ValueError):
            fixture_host(self.host_db, self.request("delete", "start"))
        self.assertIsNone(fixture_host(self.host_db, self.request("delete"))["machine"])
        fixture_host(self.host_db, self.request("create"))  # Cached result, not recreation.
        with sqlite3.connect(self.host_db) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM machines").fetchone()[0], 0)

    def test_lost_reply_restart_and_ordering(self):
        path = self.root / "controller.sqlite"
        controller = Controller(path, self.command + ["--lose-reply-once"])
        controller.submit("op-create", {"action": "create", "machine": "one"})
        controller.submit("op-start", {"action": "start", "machine": "one"})
        controller.reconcile()
        self.assertEqual(controller.get("op-create")["status"], "pending")
        with sqlite3.connect(self.host_db) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM ops").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT power FROM machines").fetchone()[0], "stopped")
        recovered = Controller(path, self.command + ["--lose-reply-once"])
        recovered.reconcile()  # Create replay completes; start commits but loses reply.
        recovered.reconcile()
        self.assertEqual(recovered.get("op-create")["status"], "complete")
        self.assertEqual(recovered.get("op-start")["status"], "complete")
        with sqlite3.connect(self.host_db) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM ops").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT count(*) FROM machines").fetchone()[0], 1)

    def test_unavailable_host_preserves_intent_without_replacement(self):
        path = self.root / "controller.sqlite"
        controller = Controller(path, [str(self.root / "missing-command")])
        controller.submit("retry", {"action": "create", "machine": "one"})
        controller.reconcile()
        self.assertEqual(controller.get("retry")["status"], "pending")
        recovered = Controller(path, self.command)
        recovered.reconcile()
        self.assertEqual(recovered.get("retry")["status"], "complete")
        self.assertEqual(recovered.submit("retry", {"action": "create", "machine": "one"})["status"], "complete")
        with self.assertRaises(ValueError):
            recovered.submit("retry", {"action": "delete", "machine": "one"})

    def test_http_auth_validation_and_persist_before_dispatch(self):
        controller = Controller(self.root / "controller.sqlite", self.command)
        token = "disposable-local-fixture-token"
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler(controller, token))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}"

        def request(method, path, value=None, auth=token, key="http-op"):
            headers = {"Authorization": "Bearer " + auth, "Idempotency-Key": key}
            data = json.dumps(value).encode() if value is not None else None
            req = urllib.request.Request(url + path, data, headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=3) as response:
                    return response.status, json.load(response)
            except urllib.error.HTTPError as error:
                with error:
                    return error.code, json.load(error)
        try:
            body = {"action": "create", "machine": "one"}
            self.assertEqual(request("POST", "/operations", body, auth="wrong")[0], 401)
            self.assertIsNone(controller.get("http-op"))
            status, result = request("POST", "/operations", body)
            self.assertEqual((status, result["status"]), (202, "pending"))
            self.assertFalse(self.host_db.exists())
            self.assertEqual(request("POST", "/operations", {"action": "delete", "machine": "one"})[0], 400)
            self.assertEqual(request("POST", "/operations", {"action": "create", "machine": "../escape"})[0], 400)
            controller.reconcile()
            status, result = request("GET", "/operations/http-op")
            self.assertEqual((status, result["status"]), (200, "complete"))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
