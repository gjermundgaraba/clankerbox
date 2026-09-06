import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

SHARED = Path(__file__).parent
sys.path.insert(0, str(SHARED))
import disk_probe as probe
import evaluate as evaluator


def ram(branch=0, samples=10):
    return dict(ok=True, ready=True, memory_ok=True, disk_ok=True, pid=42,
                start_monotonic_ns=1234, ram_marker='0123456789abcdef', branch=branch,
                disk_branch=branch, heartbeat={'samples': samples})


def disk(phase, counter):
    digest = hashlib.sha256(probe.payload('test', phase, counter)).hexdigest()
    return dict(schema_version=1, ok=True, namespace='test', phase=phase, counter=counter,
                path=str(probe.BASE / 'test/payload.bin'), size=4096, sha256=digest,
                expected_sha256=digest, method=probe.METHOD,
                probe_sha256=hashlib.sha256((SHARED / 'disk_probe.py').read_bytes()).hexdigest())


def evidence():
    return dict(schema_version=1, runtime='cocoon', provenance={'guest_sha256': evaluator.GUEST_SHA256,
                'probe_sha256': disk('A', 0)['probe_sha256']},
                capture={'ram': ram(), 'disk': disk('A', 0), 'vmm': {'pid': 100, 'start_ticks': 1000, 'owned': True}},
                source_after_capture={'ram': ram(), 'disk': disk('B', 1)},
                independent_restore={'origin_processes_absent': True, 'source_paths_unavailable': True},
                artifact_copies=[{'source_sha256': 'a' * 64, 'copied_sha256': 'a' * 64, 'size_bytes': 4096, 'copied_size_bytes': 4096}],
                all_mutations_completed_ns=100,
                restored=[dict(name=f'child{i}', branch_counter=i, ram_initial=ram(), ram_later=ram(samples=20),
                               ram_final=ram(i, 30), disk_initial=disk('A', 0), disk_final=disk('branch', i),
                               vmm={'pid': 100 + i, 'start_ticks': 2000, 'owned': True}, final_observed_ns=101 + i)
                          for i in (1, 2)])


class SharedRecoveryTests(unittest.TestCase):
    def test_payloads_are_fixed_distinct_and_namespace_scoped(self):
        values = [probe.payload('test', 'A', 0), probe.payload('test', 'B', 1), probe.payload('test', 'branch', 2)]
        self.assertTrue(all(len(value) == 4096 for value in values))
        self.assertEqual(len(set(values)), 3)
        self.assertNotEqual(values[0], probe.payload('other', 'A', 0))
        for namespace in ('../outside', '/tmp/target', 'x/y', '', 'a' * 65):
            with self.assertRaises(ValueError):
                probe.payload(namespace, 'A', 0)

    def test_lifecycle_is_in_place_and_rejects_wrong_expected_payload(self):
        # On macOS, emulate only the open flag to exercise portable state/file
        # logic. This test does not claim a successful Linux O_DIRECT operation.
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(os, 'O_DIRECT', 0, create=True):
            fd = os.open(tmp, os.O_RDONLY)
            try:
                with mock.patch.object(probe, 'namespace_fd', side_effect=lambda *unused: os.dup(fd)):
                    a = probe.perform('initialize', 'test', 'A', 0)
                    b = probe.perform('write', 'test', 'B', 1, 'A', 0)
                    self.assertEqual(a['inode'], b['inode'])
                    self.assertEqual((Path(tmp) / 'payload.bin').stat().st_size, 4096)
                    with self.assertRaises(ValueError):
                        probe.perform('write', 'test', 'branch', 2, 'A', 0)
                    self.assertEqual(probe.perform('read', 'test', 'B', 1)['sha256'], b['sha256'])
                    with mock.patch.object(os, 'readv', side_effect=OSError('direct I/O rejected')):
                        with self.assertRaises(OSError):
                            probe.perform('read', 'test', 'B', 1)
            finally:
                os.close(fd)

    def test_evaluator_accepts_complete_proof_and_rejects_missing_independence(self):
        good = evidence()
        self.assertEqual(evaluator.evaluate(good)['status'], 'pass')
        self.assertTrue(evaluator.evaluate(good)['sibling_isolation_proven'])
        mutations = [lambda e: e['independent_restore'].update(origin_processes_absent=False),
                     lambda e: e['independent_restore'].update(source_paths_unavailable=False),
                     lambda e: e['artifact_copies'][0].update(copied_sha256='b' * 64),
                     lambda e: e['restored'][0].update(disk_initial=disk('B', 1)),
                     lambda e: e['restored'][0].update(ram_later=ram(samples=10)),
                     lambda e: e['restored'][0].update(ram_initial=dict(ram(), ram_marker='restarted')),
                     lambda e: e['restored'][0].update(final_observed_ns=99),
                     lambda e: e['restored'][0]['vmm'].update(owned=False),
                     lambda e: e['restored'][1].update(ram_final=ram(1))]
        for mutate in mutations:
            value = copy.deepcopy(good)
            mutate(value)
            self.assertEqual(evaluator.evaluate(value)['status'], 'fail')


if __name__ == '__main__':
    unittest.main()
