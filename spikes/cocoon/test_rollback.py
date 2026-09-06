#!/usr/bin/env python3
"""Local safety/unit checks only; actual O_DIRECT and RAM restore need Linux KVM."""
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import rollback_guest as guest
import rollback_host as host


class RollbackTests(unittest.TestCase):
    def test_payloads_are_distinct_complete_blocks(self):
        self.assertEqual(len(guest.payload('checkpoint')), 4096)
        self.assertEqual(len(guest.payload('after-capture')), 4096)
        self.assertNotEqual(guest.payload('checkpoint'), guest.payload('after-capture'))
        with self.assertRaises(ValueError):
            guest.payload('anything-else')

    def test_direct_io_failure_never_falls_back(self):
        with patch.object(os, 'O_DIRECT', 16384, create=True), patch.object(os, 'open', side_effect=OSError(errno.EINVAL, 'unsupported')) as opened:
            with self.assertRaises(OSError):
                guest.direct_read(guest.FILE)
            self.assertEqual(opened.call_count, 1)
            self.assertTrue(opened.call_args.args[1] & os.O_DIRECT)

    def test_flush_failure_propagates(self):
        with patch.object(os, 'open', return_value=7), patch.object(os, 'close') as closed, patch.object(os, 'fsync', side_effect=OSError('flush failed')):
            with self.assertRaises(OSError):
                guest.flush(guest.FILE)
            closed.assert_called_once_with(7)

    def test_cleanup_waits_for_exit_without_sending_signals(self):
        with patch.object(Path, 'read_text', side_effect=['123\n', '']), patch.object(host.time, 'sleep') as pause:
            host.wait_empty_group(Path('/unused/mock-group'))
            pause.assert_called_once_with(0.05)
        with patch.object(Path, 'read_text', return_value='123\n'), patch.object(host.time, 'monotonic', side_effect=[0, 6]):
            with self.assertRaisesRegex(ValueError, 'process remains'):
                host.wait_empty_group(Path('/unused/mock-group'))

    def test_optimized_execution_rejects_wrong_path_and_grant(self):
        for expression in ("h.validate_run(Path('/tmp/unowned'), 'cocoon-rollback-20260905')",
                           "h.validate_run(h.RUN, 'cocoon')"):
            result = subprocess.run([sys.executable, '-O', '-c',
                'from pathlib import Path; import rollback_host as h; ' + expression],
                cwd=Path(__file__).parent, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('ValueError', result.stderr)

    def test_setup_failure_cleans_or_reports_without_hiding_original_error(self):
        for cleanup_fails in (False, True):
            with self.subTest(cleanup_fails=cleanup_fails), tempfile.TemporaryDirectory(dir=Path(__file__).parent / '.work') as temporary:
                stage = Path(temporary).resolve()
                run, group = stage / 'rb01', stage / 'group'
                original_read, original_write = Path.read_text, Path.write_text
                def read(path, *args, **kwargs):
                    if str(path) == '/sys/fs/cgroup/cgroup.subtree_control':
                        return 'cpu cpuset memory'
                    if path == group / 'memory.peak':
                        return '0'
                    return original_read(path, *args, **kwargs)
                def write(path, *args, **kwargs):
                    if path == group / 'memory.max':
                        if cleanup_fails:
                            original_write(group / 'unexpected-residue', 'do not delete blindly')
                        raise OSError('injected memory.max failure')
                    return original_write(path, *args, **kwargs)
                with patch.object(host, 'STAGE', stage), patch.object(host, 'RUN', run), patch.object(host, 'GROUP', group), \
                     patch.object(host, 'digest', side_effect=lambda p: host.HASHES[str(p.relative_to(stage))]), \
                     patch.object(host, 'inventory', return_value={}), patch.object(os, 'geteuid', return_value=0), \
                     patch.object(sys, 'platform', 'linux'), patch.dict(os.environ, CLANKER_HOST_SLOT='cocoon-rollback-20260905'), \
                     patch.object(Path, 'read_text', read), patch.object(Path, 'write_text', write):
                    with self.assertRaisesRegex(OSError, 'injected memory.max failure'):
                        host.main()
                report = json.loads((run / 'rollback-evidence.json').read_text())
                self.assertEqual(report['cleanup'], 'fail' if cleanup_fails else 'pass')
                self.assertEqual(group.exists(), cleanup_fails)
                if cleanup_fails:
                    self.assertIn('cleanup_error', report)
                    self.assertIn('owned_leftovers', report)


if __name__ == '__main__':
    unittest.main()
