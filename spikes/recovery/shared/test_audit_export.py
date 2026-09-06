import json
import hashlib
from pathlib import Path
import tempfile
import unittest

from audit_export import GUEST_SHA256, REMOTE, UBUNTU_SHA256, audit, profile_errors


class AuditTests(unittest.TestCase):
    def fixture(self, root, bad=False, status='pass'):
        path = Path(root) / 'cocoon/results/native-test'
        path.mkdir(parents=True)
        pins = {}
        for name in ('cocoon', 'firecracker'):
            binary = Path(root) / 'cocoon/s/bin' / name
            binary.parent.mkdir(parents=True, exist_ok=True)
            binary.write_bytes(name.encode())
            pins['/home/clanker/clankerbox-recovery.AsnzhP/cocoon/s/bin/' + name] = hashlib.sha256(name.encode()).hexdigest()
        (Path(root) / 'cocoon/prepared.json').write_text(json.dumps(dict(runtime_pins=pins)))
        report = dict(runtime='cocoon', case='native', status=status, cleanup='pass', remaining_processes=[],
                      events=[dict(event='native-import', code=0)],
                      capabilities={'native_arbitrary_path_portability': 'fail'},
                      native_failure_classification=dict(stage='clone-prevalidation', stderr='untrusted storage path'))
        (path / 'result.json').write_text(json.dumps(report))
        good = dict(ok=True, ready=True, memory_ok=True, disk_ok=True)
        states = [dict(good, memory_ok=False), good] if bad else [good]
        (path / 'commands.jsonl').write_text(''.join(json.dumps(dict(stdout=json.dumps(s))) + '\n' for s in states))
        return path

    def test_expected_negative_not_capability_success(self):
        with tempfile.TemporaryDirectory() as root:
            self.fixture(root)
            result = audit(root, ['cocoon/native'])
            self.assertEqual(result['status'], 'pass')
            self.assertEqual(result['attempts'][0]['classification'], 'expected-negative-confirmed')
            self.assertFalse(result['attempts'][0]['strict_independent_restore'])

    def test_transient_bad_then_valid_is_fatal(self):
        with tempfile.TemporaryDirectory() as root:
            self.fixture(root, bad=True)
            result = audit(root, ['cocoon/native'])
            self.assertEqual(result['status'], 'fail')
            self.assertEqual(result['attempts'][0]['integrity_responses'], 2)

    def test_incomplete_export_not_full_matrix(self):
        with tempfile.TemporaryDirectory() as root:
            self.fixture(root)
            result = audit(root)
            self.assertEqual(result['status'], 'incomplete')
            self.assertFalse(result['core_matrix_complete'])
            self.assertIn('cocoon/isolated', result['missing_cases'])

    def test_failed_attempt_retained_not_completed(self):
        with tempfile.TemporaryDirectory() as root:
            self.fixture(root, status='fail')
            result = audit(root, ['cocoon/native'])
            self.assertEqual(result['status'], 'incomplete')
            self.assertEqual(result['attempts'][0]['classification'], 'failed-attempt-retained')
            self.assertEqual(result['completed_cases'], [])

    def test_isolated_requires_deep_evidence(self):
        with tempfile.TemporaryDirectory() as root:
            path = self.fixture(root)
            report = json.loads((path / 'result.json').read_text())
            report['case'] = 'isolated'
            (path / 'result.json').write_text(json.dumps(report))
            result = audit(root, ['cocoon/isolated'])
            self.assertEqual(result['status'], 'fail')
            self.assertFalse(result['attempts'][0]['strict_independent_restore'])

    def test_binary_tamper_fails(self):
        with tempfile.TemporaryDirectory() as root:
            self.fixture(root)
            (Path(root) / 'cocoon/s/bin/cocoon').write_bytes(b'changed')
            self.assertEqual(audit(root, ['cocoon/native'])['status'], 'fail')

    def test_profile_manifest_crosscheck_not_rootfs_byte_claim(self):
        build = {'hashes': {'runtime/agent-rootfs/usr/local/bin/smolvm-agent': 'a' * 64}}
        entries = [{'path': 'file', 'type': 'file', 'sha256': 'b' * 64, 'size_bytes': 1}]
        manifest = dict(schema_version=1, id='ubuntu-bare-v1', ubuntu_source_sha256=UBUNTU_SHA256,
                        guest_sha256=GUEST_SHA256,
                        probe_sha256=hashlib.sha256(Path(__file__).with_name('disk_probe.py').read_bytes()).hexdigest(),
                        matching_build=build, agent_sha256='a' * 64, entries=entries,
                        tree_sha256=hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(',', ':')).encode()).hexdigest())
        recorded = {k: v for k, v in manifest.items() if k != 'entries'}
        recorded.update(manifest_path=str(REMOTE / 'smolvm/profiles/ubuntu-bare/profile.json'),
                        manifest_sha256='c' * 64, entry_count=1)
        self.assertEqual(profile_errors(manifest, recorded, build, 'c' * 64), [])
        recorded['manifest_sha256'] = 'd' * 64
        self.assertTrue(profile_errors(manifest, recorded, build, 'c' * 64))


if __name__ == '__main__':
    unittest.main()
