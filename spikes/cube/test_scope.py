"""Wrapper authorization checks; no Docker, SSH or SDK required."""
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from cube_spike import GRANT, validate_host_scope


class ScopeTests(unittest.TestCase):
    def test_shared_grant_path_and_owner_validation(self):
        scope = dict(root='/home/clanker/clankerbox-cube.TqWZtL',
                     owner='clanker-cube-tqwztl', grant=GRANT)
        directory = Path(scope['root']) / 'cube'
        validate_host_scope(scope, directory)
        for changes, path in [
            ({'grant': 'not-authorized'}, directory),
            ({'owner': 'foreign-owner'}, directory),
            ({'root': '/tmp/clankerbox-cube.TqWZtL'}, directory),
            ({'root': '/home/clanker/clankerbox-cube.TqWZtL/../foreign'}, directory),
            ({}, directory.parent / 'other'),
        ]:
            with self.subTest(changes=changes, path=path):
                with self.assertRaises(RuntimeError):
                    validate_host_scope(dict(scope, **changes), path)

    def test_actual_wrapper_guards_before_any_shell_actions(self):
        scope = dict(root='/home/clanker/clankerbox-cube.TqWZtL',
                     owner='clanker-cube-tqwztl', grant=GRANT)
        for wrapper in ('host.sh', 'outer.sh'):
            # Execute only the initial Python guard, never Docker or SSH.
            source = Path(__file__).with_name(wrapper).read_text().split("<<'PY'\n", 1)[1].split('\nPY', 1)[0]
            with (patch.object(Path, 'cwd', return_value=Path(scope['root']) / 'cube'),
                  patch.object(Path, 'read_text', side_effect=lambda: json.dumps(scope)),
                  patch.dict(os.environ, {'CUBE_HOST_SLOT_GRANTED': GRANT})):
                exec(compile(source, wrapper, 'exec'), {})
                scope['grant'] = 'wrong'
                with self.assertRaises(RuntimeError):
                    exec(compile(source, wrapper, 'exec'), {})
                scope['grant'] = GRANT
                if wrapper == 'host.sh':
                    with patch.dict(os.environ, {'CUBE_HOST_SLOT_GRANTED': 'wrong'}):
                        with self.assertRaises(RuntimeError):
                            exec(compile(source, wrapper, 'exec'), {})


if __name__ == '__main__':
    unittest.main()
