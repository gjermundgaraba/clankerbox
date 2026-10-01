#!/usr/bin/env python3
"""Startup timing: bench.py RUNS CMD... -> JSON {median_ms, min_ms, max_ms}. Used locally and on Linux."""
import json
import statistics
import subprocess
import sys
import time

runs, cmd = int(sys.argv[1]), sys.argv[2:]
subprocess.run(cmd, check=True, capture_output=True, timeout=30)  # warm the page cache
samples = []
for _ in range(runs):
    start = time.perf_counter()
    subprocess.run(cmd, check=True, capture_output=True, timeout=30)
    samples.append((time.perf_counter() - start) * 1000)
print(json.dumps(dict(cmd=cmd, runs=runs, median_ms=round(statistics.median(samples), 1),
                      min_ms=round(min(samples), 1), max_ms=round(max(samples), 1))))
