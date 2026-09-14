"""Build-only template transformation fails closed without publishing partial output."""

import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('prepare_templates', Path(__file__).with_name('prepare-templates.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


def digest(data):
    return hashlib.sha256(data).hexdigest()


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.output = self.root / 'output'
        self.filesystem = bytearray(4096)
        struct.pack_into('<H', self.filesystem, 1024 + 56, 0xEF53)
        struct.pack_into('<I', self.filesystem, 1024 + 4, 4)
        self.raw = bytes(self.filesystem) + b'\0' * 8192
        self.pins = []
        for name in prepare.RUNTIME_TEMPLATES:
            data = ('original-' + name).encode()
            (self.source / name).write_bytes(data)
            self.pins.append({
                'file': name, 'input_sha256': digest(data), 'input_logical_size': len(self.raw),
                'filesystem_bytes': len(self.filesystem), 'raw_sha256': digest(self.filesystem),
                'sha256': digest(('compact-' + name).encode()),
            })
        self.fsck_error = False
        self.fsck_mutation = False
        self.calls = []

    def tool(self, command, *, check):
        self.assertTrue(check)
        self.calls.append(command)
        if command[0] == 'build-zstd':
            target = Path(command[-1])
            if command[1] == '-dq':
                self.assertEqual(command[2], '--sparse')
                target.write_bytes(self.raw)
            else:
                self.assertEqual(command[1:4], ['-19', '-T1', '-q'])
                target.write_bytes(('compact-' + target.name).encode())
        else:
            self.assertEqual(command[:2], ['build-fsck', '-fn'])
            self.assertEqual(Path(command[2]).read_bytes(), self.filesystem)
            if self.fsck_error:
                raise subprocess.CalledProcessError(1, command)
            if self.fsck_mutation:
                Path(command[2]).write_bytes(b'modified by fsck')
        return subprocess.CompletedProcess(command, 0)

    def run_prepare(self):
        with mock.patch.object(prepare.subprocess, 'run', side_effect=self.tool):
            prepare.prepare(self.source, self.output, self.pins, 'build-zstd', 'build-fsck')

    def test_verified_pair_preserves_inputs_and_publishes_pinned_files(self):
        self.run_prepare()
        self.assertEqual({p.name for p in self.output.iterdir()}, set(prepare.RUNTIME_TEMPLATES))
        for pin in self.pins:
            self.assertEqual(prepare.sha(self.source / pin['file']), pin['input_sha256'])
            self.assertEqual(prepare.sha(self.output / pin['file']), pin['sha256'])
            self.assertEqual((self.output / pin['file']).stat().st_mode & 0o777, 0o644)
        self.assertEqual(len(self.calls), 6)
        self.assertFalse(list(self.root.glob('.prepare-templates-*')))

    def test_bad_input_hash_fails_before_tools(self):
        self.pins[0]['input_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'input checksum mismatch'):
            self.run_prepare()
        self.assertFalse(self.calls)
        self.assertFalse(self.output.exists())

    def test_existing_output_is_not_replaced(self):
        self.output.mkdir()
        (self.output / 'keep').write_bytes(b'keep')
        with self.assertRaises(FileExistsError):
            self.run_prepare()
        self.assertEqual((self.output / 'keep').read_bytes(), b'keep')
        self.assertFalse(self.calls)

    def test_symlink_input_and_dangling_output_are_rejected(self):
        path = self.source / self.pins[0]['file']
        path.rename(self.source / 'original')
        path.symlink_to('original')
        with self.assertRaisesRegex(ValueError, 'regular nonempty file'):
            self.run_prepare()
        self.output.symlink_to(self.root / 'missing')
        with self.assertRaises(FileExistsError):
            self.run_prepare()
        self.assertFalse(self.calls)

    def test_wrong_decompressed_length_is_rejected(self):
        self.raw += b'\0'
        with self.assertRaisesRegex(ValueError, 'length differs'):
            self.run_prepare()
        self.assertFalse(self.output.exists())

    def test_wrong_boundary_is_rejected(self):
        self.pins[0]['filesystem_bytes'] *= 2
        with self.assertRaisesRegex(ValueError, 'boundary differs'):
            self.run_prepare()
        self.assertFalse(self.output.exists())

    def test_nonzero_tail_is_rejected_without_truncation(self):
        raw = self.root / 'disk'
        raw.write_bytes(self.raw[:-1] + b'X')
        with self.assertRaisesRegex(ValueError, 'nonzero data outside'):
            prepare.compact(raw, self.pins[0])
        self.assertEqual(raw.stat().st_size, len(self.raw))

    def test_wrong_filesystem_hash_is_rejected_before_fsck(self):
        self.pins[0]['raw_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'filesystem checksum mismatch'):
            self.run_prepare()
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(self.output.exists())

    def test_fsck_failure_or_mutation_is_rejected(self):
        self.fsck_error = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_prepare()
        self.assertFalse(self.output.exists())
        self.fsck_error = False
        self.fsck_mutation = True
        with self.assertRaisesRegex(ValueError, 'filesystem after fsck checksum mismatch'):
            self.run_prepare()
        self.assertFalse(self.output.exists())

    def test_second_output_hash_failure_publishes_neither_template(self):
        self.pins[1]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'qualified output checksum mismatch'):
            self.run_prepare()
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.root.glob('.prepare-templates-*')))

    def test_decompression_failure_publishes_nothing(self):
        with mock.patch.object(prepare.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'zstd')):
            with self.assertRaises(subprocess.CalledProcessError):
                prepare.prepare(self.source, self.output, self.pins)
        self.assertFalse(self.output.exists())

    def test_ext4_superblock_and_64bit_boundaries(self):
        sb = bytearray(self.filesystem[1024:2048])
        self.assertEqual(prepare.filesystem_size(sb), 4096)
        # High bits are significant only with the ext4 64bit feature enabled.
        struct.pack_into('<I', sb, 336, 1)
        self.assertEqual(prepare.filesystem_size(sb), 4096)
        struct.pack_into('<I', sb, 96, 0x80)
        self.assertEqual(prepare.filesystem_size(sb), ((1 << 32) + 4) * 1024)
        for offset, value, message in [(56, 0, 'superblock'), (24, 7, 'block size'), (4, 0, 'empty')]:
            with self.subTest(message=message):
                invalid = bytearray(self.filesystem[1024:2048])
                struct.pack_into('<I', invalid, offset, value)
                with self.assertRaisesRegex(ValueError, message):
                    prepare.filesystem_size(invalid)
        with self.assertRaisesRegex(ValueError, 'superblock'):
            prepare.filesystem_size(sb[:100])

    def test_boundary_cannot_exceed_input_even_when_pin_agrees(self):
        raw = self.root / 'disk'
        data = bytearray(self.raw)
        struct.pack_into('<I', data, 1024 + 4, 32)
        raw.write_bytes(data)
        with self.assertRaisesRegex(ValueError, 'exceeds input'):
            prepare.compact(raw, dict(self.pins[0], filesystem_bytes=32768))
        self.assertEqual(raw.read_bytes(), data)


class PinTests(unittest.TestCase):
    def test_checked_in_lineage_matches_enforced_inventory(self):
        for platform in ['darwin-arm64', 'linux-amd64']:
            self.assertEqual(len(prepare.platform_pins(platform)), 2)

    def test_mismatched_inventory_and_duplicate_pins_are_rejected(self):
        inputs = prepare.ROOT / 'scripts/release/inputs'
        provenance = json.loads((inputs / 'template-provenance.json').read_text())
        artifacts = json.loads((inputs / 'runtime-artifacts.json').read_text())
        artifacts['platforms']['darwin-arm64']['files'] = [
            dict(item, sha256='0' * 64) if item['path'] in prepare.RUNTIME_TEMPLATES else item
            for item in artifacts['platforms']['darwin-arm64']['files']
        ]
        with mock.patch.object(prepare.json, 'loads', side_effect=[provenance, artifacts]):
            with self.assertRaisesRegex(ValueError, 'differs from enforced'):
                prepare.platform_pins('darwin-arm64')
        provenance['templates'].append(provenance['templates'][0])
        with mock.patch.object(prepare.json, 'loads', return_value=provenance):
            with self.assertRaisesRegex(ValueError, 'exactly the two'):
                prepare.platform_pins('darwin-arm64')


if __name__ == '__main__':
    unittest.main()
