from pathlib import Path
import tempfile
import unittest

from storage import clone, exercise


class StorageTests(unittest.TestCase):
    def test_copy_lineage_and_cleanup(self):
        with tempfile.TemporaryDirectory(prefix="cb-storage-local-") as name:
            root = Path(name)
            report = exercise(root, "copy", 1)
            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["execution_scope"], "filesystem")
            self.assertEqual(list(root.iterdir()), [])

    def test_refuse_overwrite_symlink_and_invalid_size(self):
        with tempfile.TemporaryDirectory(prefix="cb-storage-guard-") as name:
            root = Path(name)
            source, dest = root / "source", root / "destination"
            source.write_bytes(b"source")
            dest.write_bytes(b"keep")
            with self.assertRaises(FileExistsError):
                clone(source, dest, "copy")
            self.assertEqual(dest.read_bytes(), b"keep")
            linked = root / "linked"
            linked.symlink_to(source)
            with self.assertRaises(ValueError):
                clone(linked, root / "new", "copy")
            with self.assertRaises(ValueError):
                exercise(root, "copy", 1025)


if __name__ == "__main__":
    unittest.main(verbosity=2)
