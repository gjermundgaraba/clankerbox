#!/usr/bin/env python3
"""Fake-data proof only: python3 spikes/workspace-backup/roundtrip.py.

Requires installed restic and git. All runtime data stays in a new temp directory.
No production credentials, endpoints, user files, or global Git config are used.
"""
import json
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import tempfile


def main():
    root = Path(tempfile.mkdtemp(prefix="clankerbox-backup-spike-"))
    root.chmod(0o700)
    print(f"Scratch data retained at {root}", flush=True)
    # Explicit environment prevents a real RESTIC_* destination or secret command
    # from leaking into this proof. Git commits also ignore personal config/hooks.
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("RESTIC_", "GIT_"))}
    env.update(RESTIC_REPOSITORY=str(root / "repository"),
               RESTIC_PASSWORD=secrets.token_hex(32),
               GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
    (root / "repository.password").write_text(env["RESTIC_PASSWORD"])
    (root / "repository.password").chmod(0o600)

    def run(*args, cwd=root):
        return subprocess.run(args, cwd=cwd, env=env, check=True,
                              text=True, capture_output=True).stdout

    def restic(*args, cwd=root):
        return run("restic", "--no-cache", *args, cwd=cwd)

    workspace_id = "ws-fake-001"
    worker = root / "worker-a"
    project = worker / "workspace" / "project"
    project.mkdir(parents=True)
    run("git", "init", "-q", cwd=project)
    (project / "tracked.txt").write_text("committed\n")
    (project / "run.sh").write_text("#!/bin/sh\necho restored\n")
    (project / "run.sh").chmod(0o755)
    run("git", "add", ".", cwd=project)
    run("git", "-c", "user.name=Backup Spike", "-c",
        "user.email=spike@example.invalid", "commit", "-qm", "baseline", cwd=project)
    (project / "tracked.txt").write_text("staged change\n")
    run("git", "add", "tracked.txt", cwd=project)
    (project / "tracked.txt").write_text("unstaged change after staging\n")
    (project / "untracked.txt").write_text("unsaved-to-git work\n")
    (project / "current").symlink_to("tracked.txt")
    head = run("git", "rev-parse", "HEAD", cwd=project)
    dirty = run("git", "status", "--porcelain=v1", cwd=project)
    index = run("git", "show", ":tracked.txt", cwd=project)

    live = sqlite3.connect(worker / "live-agent.sqlite")
    live.execute("PRAGMA journal_mode=WAL")
    live.execute("CREATE TABLE sessions (message TEXT)")
    live.execute("INSERT INTO sessions VALUES ('committed WAL conversation')")
    live.commit()
    live.execute("INSERT INTO sessions VALUES ('uncommitted transaction')")
    # Source is open with a writer transaction. A separate reader's online backup
    # captures the committed database, including WAL, without copying raw files.
    selected = worker / "selected-state"
    selected.mkdir()
    with sqlite3.connect(worker / "live-agent.sqlite") as reader:
        with sqlite3.connect(selected / "agent.sqlite") as destination:
            reader.backup(destination)
            assert destination.execute("PRAGMA quick_check").fetchone() == ("ok",)
    live.rollback()
    live.close()
    (worker / "manifest.json").write_text(json.dumps({
        "schema": 1, "workspace_id": workspace_id, "backup_run_id": "fake-run-1",
        "image_ref": "fake-image-digest", "unix_uid": os.getuid(),
        "sqlite_exports": {"selected-state/agent.sqlite": "fresh"},
        "consistency": "workspace fixture quiescent; SQLite online backup",
    }, indent=2) + "\n")

    restic("init")
    events = restic("backup", "--json", "--host", workspace_id,
                    "--tag", "workspace", "--tag", "fake-run-1",
                    "workspace", "selected-state", "manifest.json", cwd=worker)
    summary = next(json.loads(line) for line in events.splitlines()
                   if json.loads(line).get("message_type") == "summary")
    snapshot = summary["snapshot_id"]
    restic("check", "--read-data")
    # Worker identity/path changes; recovery uses the recorded snapshot ID.
    recovered = root / "worker-b"
    restic("restore", snapshot, "--target", str(recovered))
    restored = recovered / "workspace" / "project"
    assert run("git", "rev-parse", "HEAD", cwd=restored) == head
    assert run("git", "status", "--porcelain=v1", cwd=restored) == dirty
    assert run("git", "show", ":tracked.txt", cwd=restored) == index
    for name in ("tracked.txt", "untracked.txt", "run.sh"):
        assert (restored / name).read_bytes() == (project / name).read_bytes()
        assert (restored / name).stat().st_mode == (project / name).stat().st_mode
    assert (restored / "current").is_symlink()
    assert os.readlink(restored / "current") == "tracked.txt"
    assert not (recovered / "live-agent.sqlite").exists()
    with sqlite3.connect(recovered / "selected-state" / "agent.sqlite") as db:
        assert db.execute("PRAGMA quick_check").fetchone() == ("ok",)
        assert db.execute("SELECT message FROM sessions").fetchall() == [
            ("committed WAL conversation",)]
    assert json.loads((recovered / "manifest.json").read_text())["workspace_id"] == workspace_id
    print(json.dumps({"result": "PASS", "restic": run("restic", "version").strip(),
                      "snapshot_id": snapshot, "scratch": str(root),
                      "checks": ["Git HEAD/index/dirty/untracked", "bytes/modes/symlink",
                                 "SQLite committed WAL export/integrity",
                                 "manifest", "new worker path", "restic full data check"],
                      "transport": "local repository; REST/TLS/ACL not tested"}, indent=2))


if __name__ == "__main__":
    main()
