#!/usr/bin/env python3
"""Read-only remote export, local analysis and strict evidence auditing."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
REMOTE = 'clanker@203.0.113.10:/home/clanker/clankerbox-latency.RPxPe6'
DEST = HERE/'results/2026-09-05'


def module(name):
    spec = importlib.util.spec_from_file_location('collected_' + name, HERE/(name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def sync(relative, includes, privileged=False):
    destination = DEST/relative
    destination.mkdir(parents=True, exist_ok=True)
    argv = ['rsync', '-a']
    if privileged:
        argv.append('--rsync-path=sudo -n rsync')
    argv += ['--include=' + pattern for pattern in includes]
    argv += ['--exclude=*', REMOTE + ('/' + relative if relative else '') + '/', str(destination) + '/']
    subprocess.run(argv, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--final', action='store_true', help='Require complete audit; also export Cocoon VMM logs.')
    args = parser.parse_args()
    sync('', ['/*.jsonl', '/*.json', '/run.py', '/calibrate.py', '/cleanup.py'])
    sync('cocoon', ['/*.jsonl', '/*.json', '/cocoon.py'] + (['/l/***'] if args.final else []), privileged=True)
    sync('smolvm', ['/*.jsonl', '/*.json', '/smolvm.py', '/results-*/***', '/bin/***'])
    sync('shared', ['/latency-guest', '/guest.c'])
    analyze = module('analyze')
    paths = [DEST/runtime/'samples.jsonl' for runtime in ('cocoon', 'smolvm')]
    analyze.main([*[str(p) for p in paths], '--output-dir', str(DEST/'analysis')])
    audit = module('audit_results').Auditor(DEST, verify_exported_files=True).run()
    target = DEST/('final-audit.json' if args.final and audit['status'] == 'pass' else 'partial-audit.json')
    target.write_text(json.dumps(audit, indent=2)+'\n')
    print(json.dumps(dict(audit=str(target), status=audit['status'], samples=audit['samples'],
                          finding_codes=sorted({f['code'] for f in audit['findings']}))))
    return 1 if args.final and audit['status'] != 'pass' else 0


if __name__ == '__main__':
    raise SystemExit(main())
