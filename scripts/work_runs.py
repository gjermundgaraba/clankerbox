#!/usr/bin/env python3
"""Owned disposable runs. CLI commands must not leave VMs or detached services.

Python callers register synchronous teardown with run.on_cleanup(callback).
Callbacks must stop and wait for every owned resource; failure retains scratch.
Evidence and manifests are retained. clean never removes unrecognized directories.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time
import uuid

DEFAULT_ROOT = Path(__file__).resolve().parents[1] / '.work' / 'runs'
OWNER = 'clankerbox-work-run-v1'


def safe_path(path):
    path = Path(os.path.abspath(path))
    if path.resolve() != path:
        raise ValueError(f'symlink paths are not allowed: {path}')
    return path


def manifest(path):
    safe_path(path)
    safe_path(path / 'manifest.json')
    data = json.loads((path / 'manifest.json').read_text())
    if data.get('owner') != OWNER or data.get('id') != path.name:
        raise ValueError(f'not an owned run: {path}')
    return data


def save(path, data):
    temp = path / 'manifest.tmp'
    safe_path(temp)
    temp.write_text(json.dumps(data, indent=2) + '\n')
    temp.replace(path / 'manifest.json')


@contextmanager
def locked(path):
    safe_path(path / '.lock')
    with (path / '.lock').open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError(f'run is active: {path.name}') from None
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def remove_scratch(path):
    scratch = safe_path(path / 'scratch')
    if scratch.exists():
        shutil.rmtree(scratch)


class WorkRun:
    def __init__(self, label, *, root=DEFAULT_ROOT, keep=False):
        self.root = safe_path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        slug = re.sub(r'[^a-zA-Z0-9_-]+', '-', label).strip('-')[:48] or 'run'
        self.path = self.root / f'{slug}-{uuid.uuid4().hex[:12]}'
        self.path.mkdir(mode=0o700)
        self.scratch = self.path / 'scratch'
        self.evidence = self.path / 'evidence'
        self.keep = keep
        self.callbacks = []
        self.data = dict(owner=OWNER, id=self.path.name, label=label,
                         created_at=datetime.now(timezone.utc).isoformat(),
                         state='created', keep=keep)
        self._lock = None
        save(self.path, self.data)

    def on_cleanup(self, callback):
        """Register a synchronous teardown callback; callbacks run in reverse order."""
        self.callbacks.append(callback)

    def __enter__(self):
        self._lock = locked(self.path)
        self._lock.__enter__()
        try:
            self.scratch.mkdir()
            self.evidence.mkdir()
            self.data['state'] = 'running'
            save(self.path, self.data)
        except BaseException:
            self._lock.__exit__(None, None, None)
            raise
        return self

    def __exit__(self, exc_type, exc, tb):
        errors = []
        try:
            for callback in reversed(self.callbacks):
                try:
                    callback()
                except BaseException as error:
                    errors.append(str(error))
            self.data['outcome'] = 'failed' if exc_type else 'succeeded'
            if errors:
                self.data.update(state='needs_teardown', cleanup_errors=errors)
            elif self.keep:
                self.data['state'] = 'retained'
            else:
                remove_scratch(self.path)
                self.data['state'] = 'cleaned'
            save(self.path, self.data)
            if errors:
                raise RuntimeError('teardown failed; scratch retained: ' + '; '.join(errors))
        finally:
            self._lock.__exit__(None, None, None)


def clean(root, run_id, *, resources_stopped=False):
    root = safe_path(root)
    if Path(run_id).name != run_id or run_id in ('', '.', '..'):
        raise ValueError('expected a run ID, not a path')
    path = root / run_id
    manifest(path)
    with locked(path):
        data = manifest(path)
        # An unlocked running run may have crashed while its VM survived.
        if data['state'] not in ('created', 'cleaned', 'retained') and not resources_stopped:
            raise RuntimeError(f'{run_id}: teardown not confirmed; inspect owned resources first')
        remove_scratch(path)
        data['state'] = 'cleaned'
        save(path, data)


def stop_group(process):
    """Reap the direct child and stop any children left in its process group."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait()
        return
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        process.poll()
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            process.wait()
            return
        time.sleep(.05)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            return
        time.sleep(.05)
    raise RuntimeError('subprocess group still exists after shutdown; inspect before cleaning')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('list')
    delete = sub.add_parser('clean', help='remove scratch only after confirmed teardown')
    delete.add_argument('ids', nargs='*')
    delete.add_argument('--all', action='store_true')
    delete.add_argument('--resources-stopped', action='store_true',
                        help='assert native inventory/teardown confirmed all owned resources stopped; never overrides active locks')
    execute = sub.add_parser('run', help='run a foreground command; no VM/service teardown')
    execute.add_argument('--label', default='command')
    execute.add_argument('--keep', action='store_true')
    execute.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    root = safe_path(args.root)
    if args.action == 'run':
        command = args.command
        if command[:1] == ['--']:
            command = command[1:]
        if not command:
            parser.error('run requires a command')
        def interrupted(signum, frame):
            raise KeyboardInterrupt
        old_term = signal.signal(signal.SIGTERM, interrupted)
        try:
            with WorkRun(args.label, root=root, keep=args.keep) as run:
                print(run.path, flush=True)
                env = dict(os.environ, TMPDIR=str(run.scratch),
                           WORK_RUN_SCRATCH=str(run.scratch), WORK_RUN_EVIDENCE=str(run.evidence))
                # Do not lose ownership if interrupted between spawn and registration.
                pending_signals = []
                previous_handlers = {sig: signal.signal(sig, lambda signum, frame: pending_signals.append(signum))
                                     for sig in (signal.SIGINT, signal.SIGTERM)}
                try:
                    process = subprocess.Popen(command, env=env, start_new_session=True)
                    run.on_cleanup(lambda: stop_group(process))
                finally:
                    for sig, handler in previous_handlers.items():
                        signal.signal(sig, handler)
                if pending_signals:
                    raise KeyboardInterrupt
                code = process.wait()
                run.data['exit_code'] = code
                if code:
                    raise subprocess.CalledProcessError(code, command)
            return 0
        except subprocess.CalledProcessError as error:
            return error.returncode if error.returncode > 0 else 128 - error.returncode
        except KeyboardInterrupt:
            return 130
        finally:
            signal.signal(signal.SIGTERM, old_term)
    ids = args.ids if args.action == 'clean' and not args.all else (
        sorted(p.name for p in root.iterdir()) if root.exists() else [])
    if args.action == 'clean' and not ids and not args.all:
        parser.error('clean requires run IDs or --all')
    failed = False
    for run_id in ids:
        try:
            path = root / run_id
            data = manifest(path)
            if args.action == 'clean':
                clean(root, run_id, resources_stopped=args.resources_stopped)
                print(f'{run_id}: scratch removed; evidence retained')
            else:
                size = sum(p.stat().st_size for p in path.rglob('*') if p.is_file() and not p.is_symlink())
                try:
                    with locked(path):
                        active = False
                except RuntimeError:
                    active = True
                print(f'{run_id}\t{data["state"]}\t{"active" if active else "inactive"}\t{size / 1024**2:.1f} MiB')
        except (OSError, ValueError, KeyError, RuntimeError) as error:
            failed = True
            print(f'{run_id}: {error}')
    return int(failed)


if __name__ == '__main__':
    raise SystemExit(main())
