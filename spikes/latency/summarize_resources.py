#!/usr/bin/env python3
"""Summarize local latency resource snapshots and observed pre-capture dirtying.

Reads exports only; writes the requested JSON summary. Filesystem allocation is
the whole benchmark root, not runtime-exclusive storage or total memory use.
"""
import argparse
from collections import defaultdict
import json
import math
from pathlib import Path
import statistics


MIB = 1024**2
GIB = 1024**3
RUNTIMES = ("cocoon", "smolvm")
UPSTREAM = {"fresh": "live-second", "fanout1": "batch-1", "fanout4": "batch-4"}


def excluded(sample):
    return sample.get("block") == "smoke" or any(type(sample.get(k)) is int and sample[k] >= 90000
                                                 for k in ("trial", "repetition"))


def quantile(values, probability):
    if not values:
        return None
    values = sorted(values)
    index = (len(values) - 1) * probability
    lower, upper = math.floor(index), math.ceil(index)
    return values[lower] + (values[upper] - values[lower]) * (index - lower)


def distribution(values):
    return dict(n=len(values), min=min(values) if values else None,
                median=statistics.median(values) if values else None, p95=quantile(values, .95),
                max=max(values) if values else None)


def parse_counters(text):
    if not isinstance(text, str):
        raise ValueError("counter snapshot must be text")
    values = {parts[0]: int(parts[1]) for line in text.splitlines() if len(parts := line.split()) == 2}
    if not values or any(value < 0 for value in values.values()):
        raise ValueError("empty or negative counter snapshot")
    return values


def counter_delta(before, after):
    if set(before) != set(after):
        raise ValueError("counter names changed within trial")
    result = {key: after[key] - before[key] for key in before}
    if any(value < 0 for value in result.values()):
        raise ValueError("counter decreased within trial")
    return result


def command_response(command):
    try:
        value = json.loads(command.get("stdout", ""))
        return value if isinstance(value, dict) and "dirty_bytes" in value else None
    except (ValueError, TypeError):
        return None


def is_reset(command):
    for argument in command.get("argv", []):
        try:
            value = json.loads(argument)
        except (ValueError, TypeError):
            continue
        if isinstance(value, dict) and value.get("op") == "reset_metrics":
            return True
    return False


def dirty_window(baseline, commands):
    """Counter advance / host RPC-midpoint interval, with enclosing time bounds."""
    parsed = [(command, command_response(command)) for command in commands]
    matches = [command for command, response in parsed if response == baseline]
    if len(matches) != 1:
        raise ValueError(f"baseline response matched {len(matches)} command rows; expected exactly one")
    end = matches[0]
    resets = [(command, response) for command, response in parsed if response and is_reset(command)
              and command["end_ns"] <= end["start_ns"]
              and all(response.get(k) == baseline.get(k) for k in ("pid", "start_monotonic_ns", "ram_marker"))]
    if not resets:
        raise ValueError("no preceding reset response for this guest process")
    start, reset = max(resets, key=lambda pair: pair[0]["end_ns"])
    if reset.get("writes_paused") is not False or baseline.get("writes_paused") is not False:
        raise ValueError("pre-capture dirtying window contains a paused writer")
    count = baseline["dirty_bytes"] - reset["dirty_bytes"]
    if count < 0:
        raise ValueError("dirty counter decreased")
    minimum_ns = end["start_ns"] - start["end_ns"]
    maximum_ns = end["end_ns"] - start["start_ns"]
    midpoint_ns = ((end["start_ns"] - start["start_ns"]) + (end["end_ns"] - start["end_ns"])) / 2
    if not 0 < minimum_ns <= midpoint_ns <= maximum_ns:
        raise ValueError("invalid or overlapping reset/baseline RPC intervals")
    return dict(dirty_bytes_advanced=count, target_mib_s=baseline.get("dirty_mib_s"),
                elapsed_midpoint_s=midpoint_ns / 1e9,
                elapsed_lower_s=minimum_ns / 1e9, elapsed_upper_s=maximum_ns / 1e9,
                achieved_mib_s=count / MIB * 1e9 / midpoint_ns,
                achieved_lower_mib_s=count / MIB * 1e9 / maximum_ns,
                achieved_upper_mib_s=count / MIB * 1e9 / minimum_ns,
                reset_rpc_start_ns=start["start_ns"], reset_rpc_end_ns=start["end_ns"],
                baseline_rpc_start_ns=end["start_ns"], baseline_rpc_end_ns=end["end_ns"])


class Summary:
    def __init__(self, root):
        self.root = Path(root)
        self.findings = []
        self.resource_trials = []
        self.dirty_windows = []

    def read(self, relative, lines=False):
        try:
            payload = (self.root / relative).read_text()
            value = [json.loads(line) for line in payload.splitlines() if line.strip()] if lines else json.loads(payload)
            if (lines and not all(isinstance(row, dict) for row in value)) or (not lines and not isinstance(value, dict)):
                raise ValueError("expected JSON object(s)")
            return value
        except (OSError, ValueError) as error:
            self.findings.append(dict(location=str(relative), error=str(error)))
            return [] if lines else {}

    def resources(self, runtime, sample, label):
        before, after = sample["resources_before"], sample["resources_after"]
        live = after if runtime == "cocoon" else sample["resources_live"]
        group = lambda phase: phase if runtime == "cocoon" else phase["cgroup"]
        disk_key = "disk_allocated_bytes" if runtime == "cocoon" else "allocated_disk_bytes"
        phases = (before, live, after)
        peak = max(int(group(phase)["memory.peak"]) for phase in phases)
        current = int(group(live)["memory.current"])
        disk = [int(phase[disk_key]) for phase in phases]
        if min(peak, current, *disk) < 0:
            raise ValueError("negative resource observation")
        mem_delta = counter_delta(parse_counters(group(before)["memory.events"]), parse_counters(group(after)["memory.events"]))
        cpu_delta = counter_delta(parse_counters(group(before)["cpu.stat"]), parse_counters(group(after)["cpu.stat"]))
        if not {"oom", "oom_kill"} <= mem_delta.keys() or not {"nr_throttled", "throttled_usec"} <= cpu_delta.keys():
            raise ValueError("required OOM/throttling counters absent")
        self.resource_trials.append(dict(runtime=runtime, case=sample["case"], variant=sample["variant"], trial=label,
            observed_memory_peak_bytes=peak, live_memory_current_bytes=current,
            filesystem_allocated_before_bytes=disk[0], filesystem_allocated_live_bytes=disk[1],
            filesystem_allocated_after_bytes=disk[2], observed_filesystem_allocated_max_bytes=max(disk),
            filesystem_live_minus_before_bytes=disk[1] - disk[0],
            memory_events_delta=mem_delta, cpu_stat_delta=cpu_delta))

    def run(self):
        counts = {}
        coco_commands = defaultdict(list)
        for row in self.read("cocoon/commands.jsonl", lines=True):
            if isinstance(row.get("trial"), str):
                coco_commands[row["trial"]].append(row)
        for runtime in RUNTIMES:
            all_samples = self.read(f"{runtime}/samples.jsonl", lines=True)
            samples = [row for row in all_samples if not excluded(row)]
            counts[runtime] = dict(measured=len(samples), excluded=len(all_samples) - len(samples),
                                   passed=sum(row.get("status") == "pass" for row in samples))
            if len(samples) != 160:
                self.findings.append(dict(location=runtime, error=f"expected160 measured samples, found{len(samples)}"))
            for sample in samples:
                number = sample.get("repetition" if runtime == "cocoon" else "trial")
                label = f"{runtime}/{sample.get('case')}/{sample.get('variant')}/{number}"
                if sample.get("runtime") != runtime or sample.get("status") != "pass":
                    self.findings.append(dict(location=label, error="invalid runtime or failed sample; not summarized"))
                    continue
                try:
                    self.resources(runtime, sample, label)
                except (KeyError, TypeError, ValueError) as error:
                    self.findings.append(dict(location=label, error="resource evidence: " + str(error)))
                if sample.get("variant") != "dirty":
                    continue
                case = sample.get("case")
                phases = ("first", "second") if case == "fresh" else ("first",)
                if runtime == "smolvm":
                    directory = Path("smolvm") / f"results-dirty-{UPSTREAM[case]}-{number}"
                    commands = self.read(directory / "commands.jsonl", lines=True)
                else:
                    commands = coco_commands.get(sample.get("trial"), [])
                for phase in phases:
                    if runtime == "cocoon":
                        baseline = sample.get("capture" if phase == "first" else "second_capture", {}).get("baseline", {})
                    else:
                        baseline = self.read(directory / f"{phase}-source-baseline-heartbeat.json")
                    try:
                        if baseline.get("dirty_mib_s") != 64:
                            raise ValueError("expected64 MiB/s target")
                        result = dirty_window(baseline, commands)
                        self.dirty_windows.append(dict(runtime=runtime, case=case, phase=phase, trial=label, **result))
                    except (KeyError, TypeError, ValueError) as error:
                        self.findings.append(dict(location=label + "/" + phase, error="dirtying evidence: " + str(error)))
        summaries = {}
        for runtime in RUNTIMES:
            resource_rows = [row for row in self.resource_trials if row["runtime"] == runtime]
            windows = [row for row in self.dirty_windows if row["runtime"] == runtime]
            if len(windows) != 40:
                self.findings.append(dict(location=runtime, error=f"expected40 pre-capture dirty windows, found{len(windows)}"))
            grouping = defaultdict(list)
            for row in windows:
                grouping[row["case"] + "/" + row["phase"]].append(row["achieved_mib_s"])
            summaries[runtime] = dict(
                resource_trials=len(resource_rows), dirtying_windows=len(windows),
                achieved_dirtying_mib_s=distribution([row["achieved_mib_s"] for row in windows]),
                achieved_dirtying_by_case_phase={key: distribution(values) for key, values in grouping.items()},
                achieved_bracket_lower_min_mib_s=min((row["achieved_lower_mib_s"] for row in windows), default=None),
                achieved_bracket_upper_max_mib_s=max((row["achieved_upper_mib_s"] for row in windows), default=None),
                observed_memory_peak_max_bytes=max((row["observed_memory_peak_bytes"] for row in resource_rows), default=None),
                live_memory_current_max_bytes=max((row["live_memory_current_bytes"] for row in resource_rows), default=None),
                observed_filesystem_allocated_max_bytes=max((row["observed_filesystem_allocated_max_bytes"] for row in resource_rows), default=None),
                filesystem_live_minus_before_bytes=distribution([row["filesystem_live_minus_before_bytes"] for row in resource_rows]),
                oom_delta_sum=sum(row["memory_events_delta"]["oom"] for row in resource_rows),
                oom_kill_delta_sum=sum(row["memory_events_delta"]["oom_kill"] for row in resource_rows),
                nr_throttled_delta_sum=sum(row["cpu_stat_delta"]["nr_throttled"] for row in resource_rows),
                throttled_usec_delta_sum=sum(row["cpu_stat_delta"]["throttled_usec"] for row in resource_rows))
        return dict(schema_version=1, status="fail" if self.findings else "pass", counts=counts,
                    summaries=summaries, findings=self.findings, dirtying_windows=self.dirty_windows,
                    resource_trials=self.resource_trials, caveats=[
                        "Dirtying rates use counter advance between reset and baseline responses and host RPC midpoints. Rate brackets cover RPC observation timing, not statistical confidence or sub-quota writer accounting.",
                        "Each runtime has40 baseline windows:10 each for fresh first, fresh second, fanout1 and fanout4. Fanout pauses writes after these baselines; capture-window rates are not compared.",
                        "Smolvm memory.peak is cumulative in its reused cgroup; the maximum is a run-wide observed peak, not an isolated per-trial peak. Live memory.current uses Cocoon resources_after and smolvm resources_live.",
                        "Cgroup memory includes charged anonymous/file-cache memory. Summed VMM RSS can double-count shared mappings; neither disk allocation nor RSS establishes total-memory efficiency.",
                        "Filesystem allocation is measured for the entire benchmark root, including both runtime caches and evidence. Live-minus-before includes the active trial's VM/snapshot/log allocations and excludes volatile memfd RAM backing.",
                        "Resource values are sampled endpoints, not continuous peak disk monitoring. Memory/CPU counter deltas run from preflight to Cocoon's live resources_after endpoint or smolvm's after-cleanup resources_after endpoint; nonzero throttling is reported without a performance-failure inference.",
                        "The memory cgroup has an enforced32 GiB limit; the96 GiB disk budget is checked at observations. This summary does not replace the strict dataset/cleanup audit."])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--output", type=Path, help="Defaults to ROOT/resource-summary.json")
    args = parser.parse_args(argv)
    report = Summary(args.root).run()
    target = args.output or args.root / "resource-summary.json"
    target.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps(dict(path=str(target), status=report["status"], summaries=report["summaries"], findings=report["findings"])))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
