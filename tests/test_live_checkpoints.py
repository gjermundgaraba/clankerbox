import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import live_checkpoints


class CheckpointEvidenceTests(unittest.TestCase):
    def test_ram_continues_manager_but_disk_copies_start_new_managers(self):
        source = {'machine_id': 'source', 'incarnation': 'original'}
        for ram in (True, False):
            valid = {'machine_id': 'child', 'incarnation': 'original' if ram else 'new'}
            live_checkpoints.require_copy_identity(source, valid, ram=ram)
            with self.assertRaisesRegex(RuntimeError, 'machine identity'):
                live_checkpoints.require_copy_identity(source, dict(valid, machine_id='source'), ram=ram)
            with self.assertRaisesRegex(RuntimeError, 'manager'):
                live_checkpoints.require_copy_identity(source, valid, ram=not ram)

    def test_trim_checks_the_machine_engine_disk_lengths(self):
        # Observed live: machine 7a11...1766 used vms/4e8e94780d8c0c47.
        self.assertEqual(
            live_checkpoints.engine_disk_dir('/vms', '7a1138497ac7eb576f7d268cf7b81766'),
            Path('/vms/4e8e94780d8c0c47'),
        )
        with tempfile.TemporaryDirectory() as directory:
            for name, size in (('storage.raw', 1 << 30), ('overlay.raw', 8 << 30)):
                with (Path(directory) / name).open('wb') as disk:
                    disk.truncate(size)
            before = live_checkpoints.disk_lengths(directory)
            self.assertEqual(before, {'storage.raw': 1 << 30, 'overlay.raw': 8 << 30})
            live_checkpoints.require_unchanged_lengths(before, live_checkpoints.disk_lengths(directory))
            with (Path(directory) / 'storage.raw').open('r+b') as disk:
                disk.truncate(939790336)
            with self.assertRaisesRegex(RuntimeError, 'disk lengths'):
                live_checkpoints.require_unchanged_lengths(before, live_checkpoints.disk_lengths(directory))
            (Path(directory) / 'overlay.raw').unlink()
            with self.assertRaises(FileNotFoundError):
                live_checkpoints.disk_lengths(directory)

    def test_engine_disks_require_trim_before_requests(self):
        argv = [
            'live_checkpoints.py',
            '--binary',
            'cli',
            '--config',
            'config',
            '--lifecycle-result',
            'missing.json',
            '--result',
            'result.json',
            '--engine-vms',
            '/vms',
        ]
        with patch('sys.argv', argv), patch('subprocess.run') as run:
            with self.assertRaisesRegex(ValueError, 'trim-before-fork'):
                live_checkpoints.main()
            run.assert_not_called()

    def test_source_ambiguity_and_result_overwrite_fail_before_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / 'source.json'
            result = Path(directory) / 'result.json'
            source = {'name': 'accept-source', 'status': 'passed', 'machine_id': 'machine'}
            argv = [
                'live_checkpoints.py',
                '--binary',
                'cli',
                '--config',
                'config',
                '--lifecycle-result',
                str(source_path),
                '--result',
                str(result),
            ]
            for extra in (
                {'cleaned': True},
                {'pending': {'command': ['delete', 'machine']}},
                {'cleanup_error': 'unresolved'},
            ):
                with self.subTest(extra=extra):
                    source_path.write_text(json.dumps(dict(source, **extra)))
                    with patch('sys.argv', argv), patch('subprocess.run') as run:
                        with self.assertRaises(ValueError):
                            live_checkpoints.main()
                        run.assert_not_called()
                    self.assertFalse(result.exists())
            source_path.write_text(json.dumps(source))
            result.write_text('existing evidence')
            with patch('sys.argv', argv), patch('subprocess.run') as run:
                with self.assertRaises(FileExistsError):
                    live_checkpoints.main()
                run.assert_not_called()
            self.assertEqual(result.read_text(), 'existing evidence')


if __name__ == '__main__':
    unittest.main()
