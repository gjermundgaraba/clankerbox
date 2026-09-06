#!/usr/bin/env python3
"""Summarize latency JSONL without changing, dropping, or pooling raw trials.

Only finite, nonnegative numbers in the top-level `metrics` object's `_ms` and
`_bytes` fields are summarized. Quantiles use linear interpolation at (n-1)*p
in ascending samples (including the median); n=1 returns the only sample.
Failure/cleanup failure metrics never enter successful-trial distributions.
Smoke exclusions require explicit block=smoke, or a numeric trial/repetition
of at least 90000. Missing/invalid metadata never silently excludes a sample.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path


PRIMARY_METRICS = {
    "cold": ("cold_request_to_workload_ms",),
    "warm": ("warm_request_to_workload_ms",),
    "fresh": ("fresh_first_total_ms", "fresh_second_total_ms"),
    "live-first": ("fresh_first_total_ms",),
    "live-second": ("fresh_first_total_ms", "fresh_second_total_ms"),
    "fanout1": ("fanout_total_ms",),
    "fanout4": ("fanout_total_ms",),
    "batch-1": ("fanout_total_ms",),
    "batch-4": ("fanout_total_ms",),
}


def quantile(values, probability):
    """Linear empirical interpolation at (n-1)*probability; empty -> None."""
    if not 0 <= probability <= 1:
        raise ValueError("probability must be between zero and one")
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower, upper = math.floor(position), math.ceil(position)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def exclusion_reasons(sample):
    reasons = []
    if sample.get("block") == "smoke":
        reasons.append("block=smoke")
    runtime = sample.get("runtime")
    key = "trial" if runtime == "smolvm" else "repetition" if runtime == "cocoon" else None
    value = sample.get(key)
    if isinstance(value, int) and not isinstance(value, bool) and value >= 90000:
        reasons.append(f"{key}>=90000")
    return reasons


def outcome(sample):
    reasons = []
    if sample.get("status") != "pass":
        reasons.append("status=" + str(sample.get("status", "missing")))
    if sample.get("cleanup") == "fail" or sample.get("cleanup_error"):
        reasons.append("cleanup_failed")
    if not isinstance(sample.get("runtime"), str):
        reasons.append("runtime_missing_or_not_string")
    if not isinstance(sample.get("case"), str):
        reasons.append("case_missing_or_not_string")
    if not isinstance(sample.get("variant", sample.get("profile")), str):
        reasons.append("variant_or_profile_missing_or_not_string")
    if not isinstance(sample.get("metrics", {}), dict):
        reasons.append("metrics_not_object")
    return ("fail" if reasons else "pass"), reasons


def unit(metric):
    for suffix in ("ms", "bytes"):
        if metric.endswith("_" + suffix):
            return suffix
    return None


def valid_number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value) and value >= 0
    except OverflowError:
        return False


def label(value):
    return value if isinstance(value, str) else "<missing_or_invalid>"


def analyze(records):
    """Accept envelopes {source,line,sample}; preserve each raw sample unchanged."""
    raw, by_group = [], defaultdict(list)
    for record in records:
        sample = record["sample"]
        if not isinstance(sample, dict):
            raise ValueError(f"{record['source']}:{record['line']}: sample must be an object")
        result, reasons = outcome(sample)
        excluded = exclusion_reasons(sample)
        envelope = {**record, "included": not excluded, "exclusion_reasons": excluded,
                    "outcome": result, "outcome_reasons": reasons}
        raw.append(envelope)
        key = (label(sample.get("runtime")), label(sample.get("case")),
               label(sample.get("variant", sample.get("profile"))))
        by_group[key].append(envelope)
    groups = []
    for (runtime, case, variant), rows in sorted(by_group.items()):
        counts = count_rows(rows)
        names = set(PRIMARY_METRICS.get(case, ()))
        ignored = set()
        for row in rows:
            metrics = row["sample"].get("metrics", {})
            if not isinstance(metrics, dict):
                continue
            for name in metrics:
                (names if unit(name) else ignored).add(name)
        summaries = {}
        for name in sorted(names):
            values = []
            unavailable = Counter(missing=0, null=0, invalid=0, failed_present=0, excluded_present=0)
            for row in rows:
                metrics = row["sample"].get("metrics", {})
                metrics = metrics if isinstance(metrics, dict) else {}
                if not row["included"]:
                    unavailable["excluded_present"] += name in metrics
                    continue
                if row["outcome"] != "pass":
                    unavailable["failed_present"] += name in metrics
                    continue
                if name not in metrics:
                    unavailable["missing"] += 1
                elif metrics[name] is None:
                    unavailable["null"] += 1
                elif not valid_number(metrics[name]):
                    unavailable["invalid"] += 1
                else:
                    values.append(metrics[name])
            summaries[name] = {"unit": unit(name), "n": len(values),
                "min": min(values) if values else None, "median": quantile(values, .5),
                "p90": quantile(values, .9), "p95": quantile(values, .95),
                "max": max(values) if values else None, **unavailable}
        groups.append({"runtime": runtime, "case": case, "variant": variant,
                       "counts": counts, "metrics": summaries,
                       "ignored_metrics_without_explicit_ms_or_bytes_unit": sorted(ignored)})
    return {"schema_version": 1,
            "method": "Success-only quantiles, linear interpolation at sorted index (n-1)*p; no cross-case pooling.",
            "exclusion_policy": "Explicit block=smoke, Cocoon repetition>=90000, or smolvm integer trial>=90000.",
            "counts": count_rows(raw), "groups": groups, "raw_samples": raw}


def count_rows(rows):
    return {"total": len(rows),
            "included": sum(row["included"] for row in rows),
            "pass": sum(row["included"] and row["outcome"] == "pass" for row in rows),
            "fail": sum(row["included"] and row["outcome"] == "fail" for row in rows),
            "excluded": sum(not row["included"] for row in rows),
            "excluded_pass": sum(not row["included"] and row["outcome"] == "pass" for row in rows),
            "excluded_fail": sum(not row["included"] and row["outcome"] == "fail" for row in rows)}


def markdown(report):
    counts = report["counts"]
    lines = [f"Trials: {counts['pass']} passed, {counts['fail']} failed, {counts['excluded']} explicitly excluded "
             f"({counts['excluded_pass']} passed, {counts['excluded_fail']} failed).",
             "", "Quantiles use linear interpolation at (n−1)×p over successful included trials. "
             "Raw samples, failures, exclusion reasons and all flat ms/bytes metrics are retained in JSON.",
             "", "| Runtime | Case | Variant | Pass/fail/excl | End-to-end metric (ms) | n | min | median | p90 | p95 | max | Missing/null/invalid |",
             "|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|"]
    def cell(value):
        return str(value).replace("|", "\\|").replace("\n", " ")
    def number(value):
        return "—" if value is None else f"{value:.3f}"
    for group in report["groups"]:
        c = group["counts"]
        for name in PRIMARY_METRICS.get(group["case"], ()):
            m = group["metrics"][name]
            cells = [group["runtime"], group["case"], group["variant"],
                     f"{c['pass']}/{c['fail']}/{c['excluded']}", name.removesuffix("_ms"), str(m["n"]),
                     *[number(m[k]) for k in ("min", "median", "p90", "p95", "max")],
                     f"{m['missing']}/{m['null']}/{m['invalid']}"]
            lines.append("| " + " | ".join(cell(v) for v in cells) + " |")
    if report["counts"]["fail"] or report["counts"]["excluded_fail"]:
        lines += ["", "Failed trial details are in `raw_samples` with source path, line, original error and outcome reasons."]
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+", type=Path, help="Runtime samples.jsonl files")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    records, sources = [], []
    def reject_constant(value):
        raise ValueError("nonstandard JSON constant: " + value)
    for path in args.inputs:
        payload = path.read_bytes()
        sources.append({"path": str(path), "sha256": hashlib.sha256(payload).hexdigest()})
        for line, text in enumerate(payload.decode().splitlines(), 1):
            if not text.strip():
                continue
            try:
                sample = json.loads(text, parse_constant=reject_constant)
            except (json.JSONDecodeError, ValueError) as error:
                parser.error(f"{path}:{line}: invalid JSON: {error}")
            records.append({"source": str(path), "line": line, "sample": sample})
    try:
        report = analyze(records)
    except ValueError as error:
        parser.error(str(error))
    report["sources"] = sources
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "summary.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    (args.output_dir / "summary.md").write_text(markdown(report))
    print(json.dumps({"json": str(args.output_dir / "summary.json"),
                      "markdown": str(args.output_dir / "summary.md"), "counts": report["counts"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
