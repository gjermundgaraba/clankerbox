#!/usr/bin/env python3
"""Evaluate collected evidence; never launches or claims to launch a VM."""
import argparse
import json
from pathlib import Path
import sys


def evaluate(evidence):
    scope = evidence["execution_scope"]
    if scope not in ("vm", "local_process"):
        raise ValueError("execution_scope must be vm or local_process")
    baseline = evidence["baseline"]
    inherited, after = evidence["inherited"], evidence["after"]
    names = {"parent", "child-a", "child-b"}
    checks = []

    def check(name, condition, status=None):
        checks.append({"name": name, "status": status or ("pass" if condition else "fail")})

    check("three_instances", set(inherited) == names and set(after) == names)
    check("concurrent_instances_observed", evidence.get("concurrently_running") is True)
    check("same_inherited_ram_marker", all(s["marker_sha256"] == baseline["marker_sha256"] for s in inherited.values()))
    check("same_guest_pid", all(s["pid"] == baseline["pid"] for s in inherited.values()),
          "not-run" if scope == "local_process" else None)
    check("same_inherited_state", all(s["counter"] == baseline["counter"] and
          s["ram_label"] == baseline["ram_label"] and s["disk"] == baseline["disk"] for s in inherited.values()))
    for name in sorted(names):
        if name not in after or name not in inherited:
            continue
        state, first = after[name], inherited[name]
        delta = {"parent": 10, "child-a": 100, "child-b": 1000}[name]
        check(name + ":same_process", state["pid"] == first["pid"] and state["marker_sha256"] == first["marker_sha256"])
        check(name + ":independent_ram", state["counter"] == baseline["counter"] + delta and state["ram_label"] == name)
        check(name + ":independent_disk", state["disk"] == {"counter": baseline["disk"]["counter"] + delta, "label": name})
    return {"schema_version": 1, "execution_scope": scope,
            "status": "fail" if any(c["status"] == "fail" for c in checks) else "pass",
            "checks": checks, "metrics": evidence.get("metrics", {}),
            "evidence": evidence,
            "limitations": ["Local process checks are not VM/KVM proof."] if scope == "local_process" else
                ["Concurrency and VM provenance are supplied by the runtime harness; retain its logs."]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    try:
        result = evaluate(json.loads(args.evidence.read_text()))
    except (ValueError, KeyError, TypeError, OSError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result, indent=2, sort_keys=True))
    sys.exit(0 if result["status"] == "pass" else 1)
