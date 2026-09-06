import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('latency_cleanup', Path(__file__).with_name('cleanup.py'))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class CleanupGateTests(unittest.TestCase):
    def audit(self):
        return dict(status='pass', scope=dict(detailed_guest_proofs='required',
                    pins='recorded hashes and exported bytes',
                    command_status_responses='all measured trials required'), driver=dict(starts=320, ends=320),
                    samples=dict(non_smoke=320, groups=28), finding_count=0)

    def test_strict_completed_audit_passes(self):
        cleanup.validate_final_audit(self.audit())

    def test_summary_only_or_unverified_inputs_refused(self):
        for field, value in [('detailed_guest_proofs', 'skipped_explicitly'), ('pins', 'recorded hashes'),
                             ('command_status_responses', 'skipped_explicitly')]:
            audit = self.audit()
            audit['scope'][field] = value
            with self.assertRaisesRegex(RuntimeError, 'strict detailed proof'):
                cleanup.validate_final_audit(audit)

    def test_incomplete_or_failed_audit_refused(self):
        for section, key, value in [('driver', 'ends', 319), ('samples', 'non_smoke', 319), ('samples', 'groups', 27)]:
            audit = self.audit()
            audit[section][key] = value
            with self.assertRaisesRegex(RuntimeError, 'complete matched'):
                cleanup.validate_final_audit(audit)
        audit = self.audit()
        audit['status'] = 'fail'
        with self.assertRaisesRegex(RuntimeError, 'not passed'):
            cleanup.validate_final_audit(audit)

    def test_targets_are_explicit_narrow_descendants(self):
        for relative in cleanup.TARGETS:
            path = Path(relative)
            self.assertFalse(path.is_absolute())
            self.assertEqual(len(path.parts), 2)
            self.assertNotIn('..', path.parts)
            self.assertIn(path.parts[0], ('cocoon', 'smolvm', 'shared'))
        self.assertNotIn('smolvm/bin', cleanup.TARGETS)
        self.assertNotIn('cocoon/l', cleanup.TARGETS)


if __name__ == '__main__':
    unittest.main()
