import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('smol_cleanup', Path(__file__).with_name('cleanup.py'))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class CleanupSafety(unittest.TestCase):
    def test_broad_and_parent_targets_rejected(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(cleanup, 'ROOT', Path(temp).resolve()):
            for value in ('', '..', '/'):
                with self.assertRaisesRegex(RuntimeError, 'redirected/broad'):
                    cleanup.target(value)

    def test_symlink_top_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            (root / 'actual').mkdir()
            (root / 'link').symlink_to(root / 'actual')
            with patch.object(cleanup, 'ROOT', root):
                with self.assertRaisesRegex(RuntimeError, 'redirected/broad'):
                    cleanup.target('link')

    def test_wrong_plan_hash_cannot_reach_deletion(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            plan = root / 'results/cleanup-123abcde/plan.json'
            plan.parent.mkdir(parents=True)
            plan.write_text('{}\n')
            expected = 'a' * 64
            with patch.object(cleanup, 'ROOT', root), \
                 patch.object(cleanup, 'safety', return_value={'smolvm_cleanup_plan_sha256': expected}), \
                 patch.object(cleanup.shutil, 'rmtree') as remove:
                with self.assertRaisesRegex(RuntimeError, 'plan bytes changed'):
                    cleanup.execute(plan, expected)
                remove.assert_not_called()


if __name__ == '__main__':
    unittest.main()
