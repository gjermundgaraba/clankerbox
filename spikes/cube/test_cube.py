#!/usr/bin/env python3
"""Local HTTP/SDK contract fixtures, explicitly not RAM-fork evidence."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import argparse

from cubesandbox import Config, Sandbox
from cube_spike import Run, NAMES, REV, isolated, mutate_and_observe, runtime_mapping, require_same_runtimes, observe


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def handle_request(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        s = self.server
        s.calls.append((self.command, self.path, body))
        status, response = 200, {}
        if self.command == "POST" and self.path == "/sandboxes":
            if s.fail_create:
                status = 503
            else:
                sid = "fixture-" + str(len(s.instances))
                response = {"sandboxID": sid, "templateID": body["templateID"], "state": "running",
                            "metadata": body["metadata"], "envdAccessToken": "fixture-only"}
                s.instances[sid] = response
        elif self.command == "POST" and self.path.endswith("/snapshots"):
            if s.fail_snapshot:
                status = 503
            else:
                response = {"snapshotID": "fixture-snapshot", "names": [body["name"]]}
        elif self.command == "GET":
            response = s.instances.get(self.path.split("/")[-1])
            if response is None:
                status, response = 404, {}
        elif self.command == "DELETE":
            if s.fail_delete:
                status = 503
            elif self.path.startswith("/sandboxes/"):
                s.instances.pop(self.path.split("/")[-1], None)
            status = status if status != 200 else 204
        raw = json.dumps(response).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw) if status != 204 else 0))
        self.end_headers()
        if status != 204:
            self.wfile.write(raw)

    do_GET = do_POST = do_DELETE = handle_request


class ProcedureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        self.server.instances, self.server.calls = {}, []
        self.server.fail_create = self.server.fail_snapshot = self.server.fail_delete = False
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        config = Config(api_url=f"http://127.0.0.1:{self.server.server_port}", api_key=None)
        self.run = Run(Path(self.temp.name) / "run", Sandbox, config, create=True)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def populate(self):
        parent = self.run.create("parent", "base-template")
        snap = self.run.snapshot(parent)
        for name in NAMES[1:]:
            self.run.create(name, snap)

    def test_sdk_wire_pin_no_ttl_explicit_snapshot_and_cleanup_order(self):
        self.populate()
        for method, path, body in self.server.calls:
            if method == "POST" and path == "/sandboxes":
                self.assertEqual(body["timeout"], -1)
                self.assertFalse(body["allow_internet_access"])
        self.assertEqual(self.run.attach("parent")._data["envdAccessToken"], "fixture-only")
        reloaded = Run(self.run.directory, Sandbox, self.run.config)
        reloaded.cleanup()
        deletes = [path for method, path, _ in self.server.calls if method == "DELETE"]
        self.assertEqual(deletes, ["/sandboxes/fixture-2", "/sandboxes/fixture-1",
                                  "/sandboxes/fixture-0", "/templates/fixture-snapshot"])
        reloaded.cleanup()
        self.assertEqual(len([1 for m, _, _ in self.server.calls if m == "DELETE"]), 4)

    def test_failed_child_creation_preserves_parent_and_checkpoint(self):
        parent = self.run.create("parent", "base")
        self.run.snapshot(parent)
        self.server.fail_create = True
        with self.assertRaises(Exception):
            self.run.create("child-a", "fixture-snapshot")
        with self.assertRaisesRegex(RuntimeError, "Ambiguous"):
            self.run.cleanup()
        self.assertEqual(self.run.data["snapshot"], "fixture-snapshot")
        self.assertFalse(any(m == "DELETE" for m, _, _ in self.server.calls))

    def test_ambiguous_snapshot_blocks_cleanup(self):
        parent = self.run.create("parent", "base")
        self.server.fail_snapshot = True
        with self.assertRaises(Exception):
            self.run.snapshot(parent)
        with self.assertRaisesRegex(RuntimeError, "Ambiguous"):
            self.run.cleanup()
        self.assertEqual(self.run.data["pending"]["kind"], "snapshot")

    def test_failed_kill_never_deletes_snapshot(self):
        self.populate()
        self.server.fail_delete = True
        with self.assertRaises(Exception):
            self.run.cleanup()
        self.assertFalse(any(p.startswith("/templates/") for m, p, _ in self.server.calls if m == "DELETE"))
        self.assertEqual(self.run.data["deleted"], [])

    def test_unowned_object_rejected(self):
        self.populate()
        self.server.instances["fixture-2"]["metadata"] = {"clanker_run": "other-worker"}
        with self.assertRaisesRegex(RuntimeError, "unowned"):
            self.run.cleanup()
        self.assertFalse(any(m == "DELETE" for m, _, _ in self.server.calls))

    def test_already_absent_child_can_finish_cleanup(self):
        self.populate()
        del self.server.instances["fixture-2"]
        self.run.cleanup()
        self.assertIsNone(self.run.data["snapshot"])

    def test_all_final_reads_follow_all_independent_mutations(self):
        mutated, disks = set(), set()
        def state(name, request=None):
            if request:
                mutated.add(name)
                return {"synthetic": True}
            self.assertEqual(mutated, set(NAMES))
            self.assertEqual(disks, set(NAMES))
            return {"synthetic": True}
        with patch.object(self.run, "state", side_effect=state), patch.object(
                self.run, "command", side_effect=lambda name, cmd: disks.add(name)):
            self.assertEqual(set(mutate_and_observe(self.run)), set(NAMES))

    def test_bare_metal_and_wrong_target_identity_rejected(self):
        with patch('cube_spike.Path.read_text', return_value='wrong'):
            with self.assertRaisesRegex(RuntimeError, 'identity'):
                isolated()
        with patch('cube_spike.Path.read_text', return_value=REV), patch(
                'cube_spike.subprocess.check_output', return_value='none\n'):
            with self.assertRaisesRegex(RuntimeError, 'bare-metal'):
                isolated()

    def runtime_fixture(self):
        root = Path(self.temp.name)
        proc, bundles = root / 'proc', root / 'bundles'
        boot = proc / 'sys/kernel/random/boot_id'
        boot.parent.mkdir(parents=True)
        boot.write_text('fixture-boot')
        exe = root / 'containerd-shim-cube-rs'
        exe.touch()
        ids = {name: 'sandbox-' + name for name in NAMES}
        for index, sid in enumerate(ids.values(), 100):
            bundle = bundles / sid
            bundle.mkdir(parents=True)
            for filename in ('vmm.pid', 'shim.pid'):
                (bundle / filename).write_text(str(index))
            p = proc / str(index)
            (p / 'fd').mkdir(parents=True)
            (p / 'exe').symlink_to(exe)
            (p / 'cwd').symlink_to(bundle)
            (p / 'stat').write_text(f'{index} (shim) S ' + '0 ' * 18 + str(index * 10))
            (p / 'cmdline').write_bytes(f'shim\0-namespace\0default\0-id\0{sid}\0'.encode())
            (p / 'cgroup').write_text('0::/cube_sandbox/sandbox/0\n')
            (p / 'fd/20').symlink_to('anon_inode:kvm-vm')
            (p / 'fd/21').symlink_to('anon_inode:kvm-vcpu:0')
        return ids, proc, bundles

    def test_mapping_requires_exact_sandbox_runtime_and_kvm_ownership(self):
        ids, proc, bundles = self.runtime_fixture()
        mapped = runtime_mapping(ids, proc, bundles)
        self.assertEqual([mapped[n]['pid'] for n in NAMES], [100, 101, 102])
        (proc / '102/cmdline').write_bytes(b'shim\0-namespace\0default\0-id\0template-build\0')
        with self.assertRaisesRegex(RuntimeError, 'identifying this sandbox'):
            runtime_mapping(ids, proc, bundles)
        (proc / '102/cmdline').write_bytes(b'shim\0-namespace\0default\0-id\0sandbox-child-b\0')
        (proc / '102/fd/20').unlink()
        with self.assertRaisesRegex(RuntimeError, 'live KVM'):
            runtime_mapping(ids, proc, bundles)

    def test_mapping_rejects_missing_duplicate_dead_and_reused_pids(self):
        ids, proc, bundles = self.runtime_fixture()
        before = runtime_mapping(ids, proc, bundles)
        after = json.loads(json.dumps(before))
        after['child-b']['start_ticks'] += 1
        with self.assertRaisesRegex(RuntimeError, 'start_ticks'):
            require_same_runtimes(before, after)
        with self.assertRaisesRegex(RuntimeError, 'distinct runtimes'):
            runtime_mapping(dict.fromkeys(NAMES, ids['parent']), proc, bundles)
        (proc / '102/stat').write_text('102 (shim) Z ' + '0 ' * 18 + '1020')
        with self.assertRaisesRegex(RuntimeError, 'not live'):
            runtime_mapping(ids, proc, bundles)
        (bundles / ids['child-b'] / 'vmm.pid').unlink()
        with self.assertRaises(FileNotFoundError):
            runtime_mapping(ids, proc, bundles)

    def test_observation_resume_cannot_repeat_mutations(self):
        with self.assertRaisesRegex(RuntimeError, 'already started'):
            observe(self.run, {'after': {}})
        (self.run.directory / 'observations-started').touch()
        with self.assertRaisesRegex(RuntimeError, 'already started'):
            observe(self.run, {})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ProcedureTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if args.report:
        args.report.write_text(json.dumps({
            'schema_version': 1, 'execution_scope': 'local_process',
            'status': 'pass' if result.wasSuccessful() else 'fail',
            'checks': [{'name': 'HTTP SDK and lifecycle fixture tests',
                        'status': 'pass' if result.wasSuccessful() else 'fail',
                        'detail': f'{result.testsRun} tests, {len(result.failures)} failures, {len(result.errors)} errors'}],
            'metrics': {}, 'evidence': {},
            'limitations': ['Loopback HTTP fixtures and mocked states; not VM or RAM-fork evidence.']
        }, indent=2) + '\n')
    raise SystemExit(not result.wasSuccessful())
