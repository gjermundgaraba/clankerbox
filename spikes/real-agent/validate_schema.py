#!/usr/bin/env python3
"""Validate the harness request shapes against the installed CLI schema (stdlib)."""
import argparse
import json
from pathlib import Path
from guest import text_input


def validate(value, schema, root):
    if '$ref' in schema:
        target = root
        for component in schema['$ref'].removeprefix('#/').split('/'):
            target = target[component]
        validate(value, target, root)
    for key in ('anyOf', 'oneOf'):
        if key in schema:
            matches = 0
            for candidate in schema[key]:
                try:
                    validate(value, candidate, root)
                    matches += 1
                except AssertionError:
                    pass
            assert matches >= 1 if key == 'anyOf' else matches == 1, key
    for candidate in schema.get('allOf', []):
        validate(value, candidate, root)
    types = schema.get('type', [])
    if isinstance(types, str):
        types = [types]
    if types:
        mapping = {'object': dict, 'array': list, 'string': str, 'integer': int,
                   'boolean': bool, 'null': type(None), 'number': (int, float)}
        assert any(isinstance(value, mapping[t]) and
                   not (t in ('integer', 'number') and type(value) is bool) for t in types), types
    if 'enum' in schema:
        assert value in schema['enum'], schema['enum']
    if isinstance(value, dict):
        assert all(k in value for k in schema.get('required', [])), schema.get('required')
        properties = schema.get('properties', {})
        for key, item in value.items():
            if key in properties:
                validate(item, properties[key], root)
            elif schema.get('additionalProperties') is False:
                raise AssertionError('unexpected property ' + key)
    if isinstance(value, list) and 'items' in schema:
        for item in value:
            validate(item, schema['items'], root)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('schema_dir')
    args = parser.parse_args()
    shapes = {
        'v2/ThreadStartParams.json': {'cwd': '/opt/real-agent/fixture',
            'approvalPolicy': 'never', 'sandbox': 'danger-full-access',
            'developerInstructions': 'Bounded local fixture task.'},
        'v2/TurnStartParams.json': {'threadId': 'thread-id', 'input': text_input('Bounded test')},
    }
    for file, shape in shapes.items():
        schema = json.loads((Path(args.schema_dir) / file).read_text())
        validate(shape, schema, schema)
    print(json.dumps({'valid': True, 'requests': list(shapes)}))


if __name__ == '__main__':
    main()
