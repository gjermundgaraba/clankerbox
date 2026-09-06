#!/usr/bin/env python3
"""Run local-only spike checks. Never boots VMs or runs remote deployment scripts."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    suites = ("acceptance", "real-agent", "control-path", "orchard-lifecycle", "cocoon", "smolvm", "cube",
              "storage-recovery", "tart-checkpoints", "latency",
              "recovery/shared", "recovery/cocoon", "recovery/smolvm")
    results = []
    for name in suites:
        directory = root / name
        if not list(directory.glob("test_*.py")):
            results.append({"suite": name, "status": "not-run",
                            "reason": "no direct local Python tests; see suite README"})
            continue
        # Cube's wire-contract tests import its pinned SDK; keep that dependency
        # isolated instead of installing it into the coordinator's interpreter.
        interpreter = directory / ".work/venv/bin/python" if name == "cube" else Path(sys.executable)
        if not interpreter.exists():
            results.append({"suite": name, "status": "not-run",
                            "reason": "missing SDK virtualenv; follow spikes/cube/README.md"})
            continue
        command = [str(interpreter), "-m", "unittest", "discover", "-s", str(directory),
                   "-p", "test_*.py", "-v"]
        print("Local suite: " + name, flush=True)
        started = time.monotonic()
        completed = subprocess.run(command, cwd=root.parent)
        results.append({"suite": name, "status": "pass" if completed.returncode == 0 else "fail",
                        "seconds": round(time.monotonic() - started, 3)})
    report = {"execution_scope": "local-tests", "suites": results,
              "limitations": ["Does not execute VM, SSH, privileged storage or upstream build tests"]}
    payload = json.dumps(report, indent=2) + "\n"
    print(payload)
    if args.report:
        args.report.write_text(payload)
    return int(any(row["status"] != "pass" for row in results))


if __name__ == "__main__":
    raise SystemExit(main())
