import tempfile
import unittest
from pathlib import Path
from retained_model import FakeRuntime, Worker


class RetainedLifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "ledger.db"
        self.rt = FakeRuntime()
        self.worker = self.open_worker()

    def open_worker(self, owner="host-a"):
        worker = Worker(self.path, owner, self.rt)
        self.addCleanup(worker.db.close)
        return worker

    def add(self, uid="a", resources=(2, 4096, 1)):
        self.rt.disks[uid] = dict(owner="host-a", running=False, contents="uncommitted work")
        self.worker.register(uid, resources)
        return self.rt.disks[uid]

    def start(self, uid="a"):
        self.worker.request(uid, "running")
        self.worker.reconcile()

    def test_stop_resume_reconstruct_and_host_reboot_keep_same_disk(self):
        disk = self.add()
        self.start()
        self.worker.request("a", "stopped")
        self.worker.reconcile()
        self.assertFalse(disk["running"])
        self.start()
        self.worker.shutdown()
        self.assertFalse(disk["running"])
        self.worker.db.close()
        self.worker = self.open_worker()
        self.worker.reconcile()
        self.assertTrue(disk["running"])
        # Abrupt worker restart while the runtime process survives.
        self.worker.db.close()
        self.worker = self.open_worker()
        self.worker.reconcile()
        self.assertIs(disk, self.rt.disks["a"])
        self.assertEqual(disk["contents"], "uncommitted work")
        self.assertTrue(disk["running"])

    def test_outage_and_empty_controller_ledger_never_delete(self):
        disk = self.add()
        self.start()
        before = list(self.rt.commands)
        for _ in range(1000):
            self.worker.reconcile(controller_online=False)
        self.assertEqual(self.rt.commands, before)
        self.assertTrue(disk["running"])
        empty = Worker(Path(self.tmp.name) / "empty.db", "host-a", self.rt)
        self.addCleanup(empty.db.close)
        empty.reconcile()
        self.assertEqual(self.rt.commands, before)
        self.assertIs(disk, self.rt.disks["a"])

    def test_resume_requires_capacity_and_stop_failure_keeps_reservation(self):
        self.add("a"); self.add("b"); self.add("c")
        self.start("a"); self.start("b")
        self.worker.request("c", "running")
        with self.assertRaisesRegex(RuntimeError, "capacity"):
            self.worker.reconcile()
        self.worker.request("a", "stopped")
        self.rt.stop_error = True
        with self.assertRaisesRegex(RuntimeError, "stop failure"):
            self.worker.reconcile()
        self.assertEqual(self.worker.rows()[0]["reserved"], 1)
        self.assertFalse(self.rt.disks["c"]["running"])
        self.rt.stop_error = False
        self.worker.reconcile()
        self.assertTrue(self.rt.disks["c"]["running"])
        self.worker.request("a", "running")
        with self.assertRaisesRegex(RuntimeError, "capacity"):
            self.worker.reconcile()

    def test_explicit_delete_tombstone_survives_error_and_restart(self):
        self.add(); self.start()
        self.worker.request("a", "delete")
        self.rt.delete_error = True
        with self.assertRaisesRegex(RuntimeError, "delete failure"):
            self.worker.reconcile()
        self.assertEqual(self.worker.rows()[0]["desired"], "delete")
        self.worker.db.close()
        self.worker = self.open_worker()
        self.rt.delete_error = False
        self.worker.reconcile()
        self.assertEqual(self.worker.rows(), [])
        self.assertNotIn("a", self.rt.disks)
        self.worker.reconcile()  # Repeating cleanup is safe.

    def test_ownership_mismatch_and_missing_disk_are_errors(self):
        self.add()
        wrong = self.open_worker("host-b")
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            wrong.reconcile()
        self.assertEqual(self.rt.commands, [])
        self.rt.disks.clear()
        with self.assertRaisesRegex(RuntimeError, "missing"):
            self.worker.reconcile()
        self.assertEqual(self.rt.commands, [])

    def test_unknown_running_vm_blocks_start_without_cleanup(self):
        self.add()
        self.rt.disks["foreign"] = dict(owner="someone-else", running=True)
        self.worker.request("a", "running")
        with self.assertRaisesRegex(RuntimeError, "unaccounted"):
            self.worker.reconcile()
        self.assertTrue(self.rt.disks["foreign"]["running"])
        self.assertFalse(self.rt.disks["a"]["running"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
