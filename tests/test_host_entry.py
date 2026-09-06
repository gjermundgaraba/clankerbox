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

    def test_structured_control_and_connection(self):
        command = '/bin/echo --config /private/config.json'
        self.assertEqual(self.invoke(command).stdout.strip(), '--config /private/config.json')
        command += ' --connect ' + 'a' * 32
        result = self.invoke(command)
        self.assertEqual(result.returncode, 0)
        self.assertTrue(result.stdout.strip().endswith('--connect ' + 'a' * 32))

    def test_rejects_shell_and_arbitrary_destinations(self):
        prefix = '/bin/echo --config /private/config.json'
        for command in ['', 'sh', prefix + '; echo injected', prefix + ' --connect localhost:22',
                        prefix + ' --connect ' + 'a' * 31, prefix + ' --connect ' + 'a' * 32 + '\n',
                        prefix + ' --connect ' + 'a' * 32 + ' --config /other']:
            with self.subTest(command=command):
                result = self.invoke(command)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()
