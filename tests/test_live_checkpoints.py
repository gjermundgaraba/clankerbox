import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import live_checkpoints


class CheckpointEvidenceTests(unittest.TestCase):
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
                '--session-runner',
                'runner',
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
