#!/usr/bin/env python3
"""Exercise the durable fake host over SSH; no VM or production service changes."""
import json
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

from control import Controller

TARGET = "clanker@203.0.113.10"


def require(condition, detail):
    if not condition:
        raise RuntimeError(detail)


def main():
    ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", TARGET]
    created = subprocess.run(ssh + ["umask 077; mktemp -d /home/clanker/clankerbox-control.XXXXXX"],
                             check=True, text=True, capture_output=True, timeout=20)
    remote = created.stdout.strip()
    if not re.fullmatch(r"/home/clanker/clankerbox-control\.[A-Za-z0-9]{6}", remote):
        raise RuntimeError("unexpected remote scratch path; refusing further writes")
    script, database = remote + "/control.py", remote + "/fixture.sqlite"
    failure = None
    try:
        subprocess.run(["scp", "-q", "-o", "BatchMode=yes", str(Path(__file__).with_name("control.py")),
                        TARGET + ":" + script], check=True, timeout=20)
        command = ssh + ["python3 " + shlex.quote(script) + " fixture-host --db " +
                         shlex.quote(database) + " --lose-reply-once"]
        with tempfile.TemporaryDirectory(prefix="cb-control-ssh-") as directory:
            path = Path(directory) / "controller.sqlite"
            controller = Controller(path, command)
            controller.submit("ssh-create", {"action": "create", "machine": "ssh-fixture"})
            controller.reconcile()
            require(controller.get("ssh-create")["status"] == "pending", "lost reply was not pending")
            controller = Controller(path, command)  # Reconstruct from persisted intent.
            controller.reconcile()
            created = controller.get("ssh-create")
            require(created["status"] == "complete", "create retry did not complete")
            marker = created["result"]["machine"]["disk_marker"]
            for action in ("start", "stop"):
                key = "ssh-" + action
                controller.submit(key, {"action": action, "machine": "ssh-fixture"})
                controller.reconcile()
                require(controller.get(key)["status"] == "pending", "lost reply was not pending")
                controller.reconcile()
                result = controller.get(key)
                require(result["status"] == "complete", "lifecycle retry did not complete")
                require(result["result"]["machine"]["disk_marker"] == marker, "fixture disk identity changed")
            result = {"status": "pass", "execution_scope": "ssh_fixture", "target": TARGET,
                      "checks": ["SSH JSON transport", "committed-before-reply-loss retry",
                                 "controller ledger reconstruction", "retained fixture identity"],
                      "limitations": ["No actual VM", "No personal-cloud/WireGuard route",
                                      "Reply loss injected at host process, not network outage"]}
    except BaseException as exc:
        failure = exc
        raise
    finally:
        # Only the two files this program created, under the validated mktemp path.
        cleanup = "rm -f -- " + shlex.quote(script) + " " + shlex.quote(database)
        cleanup += " && rmdir -- " + shlex.quote(remote)
        try:
            subprocess.run(ssh + [cleanup], check=True, timeout=20)
        except Exception as cleanup_error:
            if failure is None:
                raise
            failure.add_note(f"Remote cleanup also failed; inspect {remote}: {cleanup_error}")
    result["cleanup"] = "remote fixture script/database and directory removed"
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
