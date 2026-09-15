import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from prepared_image import prepare, CONTRACT, WORKLOAD_UID


class PreparedImageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'image'
        for name in ('etc', 'home', 'var/lib', 'usr/local/bin', 'tmp'):
            (self.root / name).mkdir(parents=True, exist_ok=True)
        for name, value in [('passwd', 'root:x:0:0::/root:/bin/sh\n'), ('group', 'root:x:0:\n'), ('shadow', 'root:!:0:0:99999:7:::\n')]:
            (self.root / 'etc' / name).write_text(value)
        self.guest = Path(self.temp.name) / 'guest'
        self.guest.write_bytes(b'qualified guest')

    def test_prepares_static_contract_without_machine_state(self):
        (self.root / 'usr').chmod(0o700)
        prepare(self.root, self.guest)
        self.assertEqual((self.root / 'usr/local/bin/clankerbox-guest').read_bytes(), self.guest.read_bytes())
        self.assertEqual((self.root / 'usr/local/share/clankerbox/prepared').read_text(), CONTRACT)
        self.assertIn('clankerbox:x:32001:32001:', (self.root / 'etc/passwd').read_text())
        self.assertEqual((self.root / 'usr').stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.root / 'tmp').stat().st_mode & 0o7777, 0o1777)
        self.assertFalse((self.root / 'var/lib/clankerbox-guest').exists())
        with self.assertRaisesRegex(ValueError, 'already contains'):
            prepare(self.root, self.guest)

    def test_rejects_uid_and_name_collisions(self):
        for record in ('someone:x:32001:1::/:/bin/sh', 'clankerbox:x:1234:1234::/:/bin/sh'):
            (self.root / 'etc/passwd').write_text(record + '\n')
            with self.assertRaisesRegex(ValueError, 'account collision'):
                prepare(self.root, self.guest)

    def test_preserves_private_sticky_and_application_directory_modes(self):
        modes = {'root': 0o700, 'var/tmp': 0o1777, 'usr/share/private': 0o700,
                 'var/lib/private': 0o700, 'opt/application': 0o775}
        for name, mode in modes.items():
            path = self.root / name
            path.mkdir(parents=True, exist_ok=True)
            path.chmod(mode)
        prepare(self.root, self.guest)
        for name, mode in modes.items():
            with self.subTest(path=name):
                self.assertEqual((self.root / name).stat().st_mode & 0o7777, mode)

    def test_normalizes_only_required_installation_and_state_ancestors(self):
        required = ('', 'home', 'home/clankerbox', 'var', 'var/lib', 'usr', 'usr/local',
                    'usr/local/bin', 'usr/local/share', 'usr/local/share/clankerbox')
        for name in required:
            path = self.root / name
            path.mkdir(parents=True, exist_ok=True)
            path.chmod(0o700)
        prepare(self.root, self.guest)
        for name in required:
            with self.subTest(path=name):
                self.assertEqual((self.root / name).stat().st_mode & 0o7777, 0o755)

    def test_rejects_workload_owned_root_and_entries(self):
        original_lstat = Path.lstat
        for owned in (self.root, self.root / 'etc/passwd'):
            with self.subTest(owned=owned):
                def lstat(path, *args, **kwargs):
                    result = original_lstat(path, *args, **kwargs)
                    if path == owned:
                        fields = list(result)
                        fields[4] = WORKLOAD_UID
                        return os.stat_result(fields)
                    return result

                with patch.object(Path, 'lstat', autospec=True, side_effect=lstat):
                    with self.assertRaisesRegex(ValueError, 'image entry owned by workload UID'):
                        prepare(self.root, self.guest)

    def test_rejects_private_state(self):
        (self.root / 'var/lib/clankerbox-guest').mkdir()
        with self.assertRaisesRegex(ValueError, 'private state'):
            prepare(self.root, self.guest)

    def test_rejects_external_symlink_without_modifying_target(self):
        outside = Path(self.temp.name) / 'external'
        outside.write_bytes(b'untouched')
        (self.root / 'etc/passwd').unlink()
        (self.root / 'etc/passwd').symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'symlink escapes'):
            prepare(self.root, self.guest)
        self.assertEqual(outside.read_bytes(), b'untouched')

    def test_preserves_executable_bits_but_removes_writable_system_files(self):
        tool = self.root / 'usr/local/bin/tool'
        tool.write_bytes(b'tool')
        tool.chmod(0o777)
        prepare(self.root, self.guest)
        self.assertEqual(tool.stat().st_mode & 0o777, 0o755)

    def test_rejects_setid_files(self):
        tool = self.root / 'usr/local/bin/tool'
        tool.write_bytes(b'tool')
        tool.chmod(0o4755)
        with self.assertRaisesRegex(ValueError, 'unsafe image file mode'):
            prepare(self.root, self.guest)

    def test_rejects_setid_directories_even_on_normalized_paths(self):
        (self.root / 'usr').chmod(0o2755)
        with self.assertRaisesRegex(ValueError, 'unsafe image file mode'):
            prepare(self.root, self.guest)
