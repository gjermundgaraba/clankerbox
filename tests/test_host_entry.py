import os
from pathlib import Path
import subprocess
import unittest


ENTRY = Path(__file__).resolve().parents[1] / 'scripts/host-entry.sh'


class HostEntryTests(unittest.TestCase):
    def invoke(self, command):
        return subprocess.run(
            ['sh', str(ENTRY), '/bin/echo', '/private/config.json'],
            env={**os.environ, 'SSH_ORIGINAL_COMMAND': command},
            capture_output=True, text=True, check=False,
        )

    def test_structured_commands(self):
        machine_id = '0123456789abcdef' * 2
        for tail in ('', ' --connect ' + machine_id, ' --guest-prepare ' + machine_id):
            with self.subTest(tail=tail):
                result = self.invoke('/bin/echo --config /private/config.json' + tail)
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stdout.strip(), '--config /private/config.json' + tail)

    def test_rejects_invalid_ids(self):
        for action in ('--connect', '--guest-prepare'):
            prefix = '/bin/echo --config /private/config.json ' + action + ' '
            for suffix in ['', 'a' * 31, 'a' * 33, 'A' * 32, 'é' * 32, '../config', 'localhost:22',
                           'a' * 32 + '\n', 'a' * 32 + ' --connect ' + 'b' * 32,
                           'a' * 32 + '; echo injected', '$(echo injected)',
                           'a' * 32 + ' --config /other']:
                with self.subTest(action=action, suffix=suffix):
                    result = self.invoke(prefix + suffix)
                    self.assertEqual(result.returncode, 64)
                    self.assertEqual(result.stdout, '')

    def test_rejects_unknown_commands(self):
        prefix = '/bin/echo --config /private/config.json'
        for command in ['', 'sh', prefix + ' --auth-prepare ' + 'a' * 32,
                        prefix + '; echo injected', prefix + ' --connect', prefix + ' --guest-prepare']:
            with self.subTest(command=command):
                result = self.invoke(command)
                self.assertEqual(result.returncode, 64)
                self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()
