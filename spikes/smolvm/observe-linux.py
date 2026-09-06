#!/usr/bin/env python3
"""Read-only /proc observer, narrowly scoped to the staged disposable smolvm."""
import argparse
import json
import os
from pathlib import Path
import sqlite3

STAGE = Path("/home/clanker/clankerbox-smolvm.Jf1bpB")
BINARY = STAGE / "source/target/debug/smolvm"


def inspect(pid):
    if type(pid) is not int or pid <= 1:
        raise ValueError("invalid numeric PID")
    proc = Path("/proc") / str(pid)
    executable = (proc / "exe").resolve(strict=True)
    if executable != BINARY.resolve(strict=True):
        raise ValueError(f"PID {pid} runs a foreign executable")
    status = (proc / "status").read_text()
    uid = next(line.split()[1:] for line in status.splitlines() if line.startswith("Uid:"))
    if uid != ["1000"] * 4:
        raise ValueError(f"PID {pid} is not entirely owned by UID 1000")
    proc_stat = (proc / "stat").read_text()
    fields = proc_stat.rsplit(")", 1)[1].split()
    if len(fields) < 20 or fields[0] == "Z":
        raise ValueError(f"PID {pid} is not alive")
    return {"pid": pid, "start_time": fields[19], "proc_stat": proc_stat,
            "executable": str(executable), "proc_metadata_uid": proc.stat().st_uid,
            "exe_metadata_uid": (proc / "exe").lstat().st_uid,
            "status": status, "cmdline": (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode(),
            "smaps_rollup": (proc / "smaps_rollup").read_text()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", type=int)
    parser.add_argument("--inventory", action="store_true")
    args = parser.parse_args()
    if args.inventory == (args.pid is not None):
        parser.error("choose one numeric PID or the fixed staged-binary inventory")
    if args.inventory:
        result = []
        for proc in Path("/proc").iterdir():
            if not proc.name.isdigit():
                continue
            try:
                if (proc / "exe").resolve(strict=True) == BINARY.resolve(strict=True):
                    result.append(inspect(int(proc.name)))
            except (FileNotFoundError, ProcessLookupError):
                continue
    else:
        with sqlite3.connect(f"file:{STAGE}/d/smolvm/server/smolvm.db?mode=ro", uri=True) as db:
            authorized = {json.loads(data).get("pid") for name, data in db.execute("SELECT name,data FROM vms")
                          if name.startswith("cb-smol-")}
        if args.pid not in authorized:
            raise ValueError(f"PID {args.pid} is absent from disposable VM records")
        result = inspect(args.pid)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
