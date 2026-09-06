import tempfile
import unittest

from audit_full import audit


class FullAuditTests(unittest.TestCase):
    def test_missing_export_is_failure_not_completed_stages(self):
        with tempfile.TemporaryDirectory() as root:
            result = audit(root)
            self.assertEqual(result['status'], 'fail')
            self.assertNotIn('completed_stages', result)
            self.assertTrue(result['findings'])


if __name__ == '__main__':
    unittest.main()
