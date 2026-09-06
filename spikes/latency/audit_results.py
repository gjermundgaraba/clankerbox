#!/usr/bin/env python3
"""Read-only audit of the complete 320-trial latency export; JSON goes to stdout.

Default audits detailed fork evidence too. --summary-only explicitly skips that
phase; it never presents missing detailed proof as verified. Artifact pin checks
compare recorded hashes; --verify-exported-files additionally hashes local bytes.
Resource deltas cover sampled endpoints, not a continuous peak measurement.
"""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re


PROFILES = ("idle", "resident", "dirty", "workspace")
RUNTIMES = ("cocoon", "smolvm")
UPSTREAM = {"cold": "cold", "warm": "warm", "fresh": "live-second",
            "fanout1": "batch-1", "fanout4": "batch-4"}
PIN_KEYS = ("cocoon/cocoon.py", "smolvm/smolvm.py", "shared/latency-guest", "smolvm/bin/smolvm")
COCOON_PINS = {
    "bin/cocoon": "db7ef5fbd609ac28f84f88042eb2ec75e107aea09d24cbbd824a5b049e92bebc",
    "bin/firecracker": "2fd0171309af7e24cf8dafc8a6f921c1434c49b5f9349bb996b7ed0a4deb8aa7",
    "guest-rootfs.tar": "0a64e8ef15c93ff146f10729750955a4b4a1938293260cbf983d99b5466c99ed",
}
IDENTITY = ("pid", "start_monotonic_ns", "ram_marker", "branch", "disk_branch")
METRICS = {"cold": ("cold_request_to_workload_ms",), "warm": ("warm_request_to_workload_ms",),
           "fresh": ("fresh_first_total_ms", "fresh_second_total_ms"),
           "fanout1": ("fanout_total_ms",), "fanout4": ("fanout_total_ms",)}


def expected_schedule():
    cells = [("cold", "idle", 20), ("warm", "idle", 20)]
    cells += [(case, profile, 10) for profile in PROFILES for case in ("fresh", "fanout1", "fanout4")]
    tasks = []
    for cell, (case, profile, count) in enumerate(cells):
        for block in range(count // 5):
            order = RUNTIMES if (cell + block) % 2 == 0 else RUNTIMES[::-1]
            for runtime in order:
                for trial in range(block * 5, block * 5 + 5):
                    tasks.append(dict(runtime=runtime, case=case, variant=profile, trial=trial,
                                      block=f"measure-{cell}-{block}", key=f"{runtime}-{case}-{profile}-{trial}"))
    return tasks


def smoke(row):
    return row.get("block") == "smoke" or any(
        type(row.get(key)) is int and row[key] >= 90000 for key in ("trial", "repetition", "trial_offset"))


def valid_hash(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value) and value >= 0
    except OverflowError:
        return False


def counters(value):
    if not isinstance(value, str):
        raise ValueError("counter snapshot must be text")
    return {parts[0]: int(parts[1]) for line in value.splitlines() if len(parts := line.split()) == 2}


class Auditor:
    def __init__(self, root, summary_only=False, verify_exported_files=False):
        self.root = Path(root)
        self.summary_only = summary_only
        self.verify_files = verify_exported_files
        self.findings = []
        self.resource_deltas = []
        self.smol_inputs = None
        self.pins = {}
        self.cocoon_commands = None
        self.cocoon_command_trials = set()
        self.command_response_counts = {runtime: Counter(trials=0, commands=0, status_responses=0,
                                                        invalid_status_responses=0, other_responses=0)
                                        for runtime in RUNTIMES}
        self.command_response_trials = []

    def require(self, value, code, location, detail):
        if not value:
            self.findings.append(dict(code=code, location=location, detail=detail))
        return bool(value)

    def read(self, relative, lines=False):
        path = self.root / relative
        try:
            def reject(value):
                raise ValueError("nonstandard JSON constant: " + value)
            text = path.read_text()
            data = [json.loads(line, parse_constant=reject) for line in text.splitlines() if line.strip()] if lines else json.loads(text, parse_constant=reject)
            if lines and not all(isinstance(row, dict) for row in data):
                raise ValueError("JSONL rows must be objects")
            if not lines and not isinstance(data, dict):
                raise ValueError("JSON document must be an object")
            return data
        except (OSError, ValueError) as error:
            self.require(False, "missing_or_invalid_file", str(relative), str(error))
            return [] if lines else {}

    def journal(self):
        rows = self.read("driver-measure1.jsonl", lines=True)
        expected = {task["key"]: task for task in expected_schedule()}
        starts, ends, matched = Counter(), Counter(), {}
        active = None
        offset = None
        invocations = 0
        for index, row in enumerate(rows):
            loc = f"driver-measure1.jsonl:{index + 1}"
            event = row.get("event")
            if event == "invocation":
                invocations += 1
                self.require(active is None, "unfinished_before_invocation", loc, str(active))
                self.require(row.get("phase") == "full" and row.get("run_id") == "measure1", "wrong_run", loc, "Expected full measure1 invocation")
                offset = row.get("trial_offset")
                self.require(type(offset) is int and 0 <= offset <= 8000, "invalid_trial_offset", loc, str(offset))
                pins = row.get("pins", {})
                self.require(isinstance(pins, dict) and set(pins) == set(PIN_KEYS) and all(valid_hash(v) for v in pins.values()),
                             "invalid_invocation_pins", loc, "Four exact frozen artifact hashes required")
                if not self.pins:
                    self.pins = pins if isinstance(pins, dict) else {}
                else:
                    self.require(pins == self.pins, "pins_changed", loc, "Invocation artifact hashes changed")
                continue
            key = row.get("key")
            task = expected.get(key)
            if not self.require(event in ("start", "end") and task is not None, "unexpected_driver_event", loc, str(key)):
                continue
            self.require(all(row.get(k) == v for k, v in task.items()), "driver_task_mismatch", loc, key)
            if event == "start":
                starts[key] += 1
                self.require(active is None and invocations > 0, "overlap_or_no_invocation", loc, str(active))
                active = key
                actual = task["trial"] + offset if type(offset) is int else None
                argv = row.get("argv", [])
                flag = "--trial-offset" if task["runtime"] == "cocoon" else "--trial"
                self.require(isinstance(argv, list) and flag in argv and argv.index(flag) + 1 < len(argv)
                             and argv[argv.index(flag) + 1] == str(actual), "driver_argv_trial_mismatch", loc, key)
                for option, value in (("--variant" if task["runtime"] == "cocoon" else "--profile", task["variant"]),
                                      ("--run-case" if task["runtime"] == "cocoon" else "--case",
                                       task["case"] if task["runtime"] == "cocoon" else UPSTREAM[task["case"]])):
                    self.require(isinstance(argv, list) and option in argv and argv.index(option) + 1 < len(argv)
                                 and argv[argv.index(option) + 1] == value, "driver_argv_case_mismatch", loc, option)
                matched[key] = dict(task, actual_trial=actual)
            else:
                ends[key] += 1
                self.require(active == key and starts[key] == 1, "unmatched_driver_end", loc, key)
                self.require(type(row.get("returncode")) is int and row["returncode"] == 0 and not row.get("error"),
                             "driver_failure", loc, str(row.get("returncode")))
                active = None
        self.require(active is None, "unfinished_driver_task", "driver", str(active))
        self.require(invocations > 0, "missing_invocation", "driver", "No pinned invocation")
        self.require(starts == Counter({key: 1 for key in expected}) and ends == starts,
                     "incomplete_driver_schedule", "driver", f"Expected 320 starts/ends once each; observed {sum(starts.values())}/{sum(ends.values())}")
        return matched, dict(starts=sum(starts.values()), ends=sum(ends.values()), invocations=invocations)

    def pin_checks(self):
        prepared = self.read("cocoon/prepared.json")
        artifacts = prepared.get("artifacts", {})
        self.require(isinstance(artifacts, dict), "prepared_artifacts_missing", "cocoon/prepared.json", "artifacts object required")
        if not isinstance(artifacts, dict):
            artifacts = {}
        for key, value in COCOON_PINS.items():
            self.require(artifacts.get(key) == value, "cocoon_pin_mismatch", "cocoon/prepared.json", key)
        self.require(artifacts.get("guest") == self.pins.get("shared/latency-guest") and valid_hash(artifacts.get("guest")),
                     "guest_pin_mismatch", "cocoon/prepared.json", "Guest differs from driver pin")
        for profile in PROFILES:
            self.require(valid_hash(artifacts.get(profile + "_tar")), "missing_image_pin", "cocoon/prepared.json", profile)
        if self.verify_files:
            for relative, expected in self.pins.items():
                try:
                    with (self.root / relative).open("rb") as stream:
                        actual = hashlib.file_digest(stream, "sha256").hexdigest()
                    self.require(actual == expected, "exported_artifact_changed", relative, actual)
                except OSError as error:
                    self.require(False, "missing_exported_artifact", relative, str(error))

    def resource_checks(self, sample, loc, runtime):
        phases = ("resources_before", "resources_after") if runtime == "cocoon" else ("resources_before", "resources_live", "resources_after")
        observed = {}
        for phase in phases:
            value = sample.get(phase, {})
            try:
                group = value if runtime == "cocoon" else value["cgroup"]
                memory = counters(group["memory.events"])
                cpu = counters(group["cpu.stat"])
                self.require({"oom", "oom_kill"} <= set(memory), "missing_oom_counters", loc, phase)
                self.require({"nr_periods", "nr_throttled", "throttled_usec"} <= set(cpu), "missing_cpu_counters", loc, phase)
                self.require(all(value >= 0 for value in [*memory.values(), *cpu.values()]), "negative_resource_counter", loc, phase)
                peak = int(group["memory.peak"])
                disk = value["disk_allocated_bytes" if runtime == "cocoon" else "allocated_disk_bytes"]
                self.require(0 <= peak <= 32 * 1024**3, "memory_budget_exceeded", loc, f"{phase}: {peak}")
                self.require(finite(disk) and disk <= 96 * 1024**3, "disk_budget_exceeded", loc, f"{phase}: {disk}")
                observed[phase] = (memory, cpu)
            except (KeyError, ValueError, TypeError) as error:
                self.require(False, "missing_resource_evidence", loc, phase + ": " + str(error))
        if "resources_before" in observed:
            before_memory, before_cpu = observed["resources_before"]
            for phase, (memory, cpu) in observed.items():
                if phase == "resources_before":
                    continue
                md = {key: memory[key] - before_memory[key] for key in memory.keys() & before_memory.keys()}
                cd = {key: cpu[key] - before_cpu[key] for key in cpu.keys() & before_cpu.keys()}
                self.require(all(value >= 0 for value in [*md.values(), *cd.values()]), "resource_counter_decreased", loc, phase)
                self.require(md.get("oom", 0) == 0 and md.get("oom_kill", 0) == 0, "oom_during_trial", loc, str(md))
                self.resource_deltas.append(dict(sample=loc, phase=phase, memory_events=md, cpu_stat=cd))

    def state(self, state, loc):
        if not self.require(isinstance(state, dict) and all(state.get(k) is True for k in ("ok", "ready", "memory_ok", "disk_ok")),
                            "invalid_guest_state", loc, "Missing valid ready/RAM/disk status"):
            return False
        self.require(all(k in state for k in IDENTITY) and type(state.get("pid")) is int and state["pid"] > 0
                     and type(state.get("start_monotonic_ns")) is int and state["start_monotonic_ns"] > 0
                     and isinstance(state.get("ram_marker"), str) and bool(state["ram_marker"]),
                     "missing_guest_identity", loc, "PID, start time, RAM marker and branches required")
        self.require(state.get("branch") == state.get("disk_branch"), "guest_branch_mismatch", loc, "RAM/disk branch differs")
        return True

    def same_identity(self, before, after, loc):
        self.state(before, loc + ":before")
        self.state(after, loc + ":after")
        self.require(all(k in before and k in after and before[k] == after[k] for k in IDENTITY),
                     "guest_continuity_failed", loc, "Inherited PID/start/RAM marker/branches differ")

    def same_process(self, before, after, loc):
        self.state(after, loc)
        self.require(all(key in before and key in after and before[key] == after[key] for key in IDENTITY[:3]),
                     "guest_process_replaced", loc, "PID/start/RAM marker changed after mutation")

    def scan_command_responses(self, runtime, commands, relative, sample_loc):
        """Check every status reply, including failed probes followed by success."""
        counts = Counter(commands=0, status_responses=0, invalid_status_responses=0, other_responses=0)
        for line, command in commands:
            counts["commands"] += 1
            try:
                response = json.loads(command.get("stdout", ""))
            except (ValueError, TypeError):
                response = None
            if not isinstance(response, dict) or not ({"memory_ok", "disk_ok"} & response.keys()):
                # Socket-not-found errors, empty successful execs and non-status
                # command output are expected while readiness is being polled.
                counts["other_responses"] += 1
                continue
            counts["status_responses"] += 1
            invalid = [key for key in ("ok", "ready", "memory_ok", "disk_ok") if response.get(key) is not True]
            if invalid:
                counts["invalid_status_responses"] += 1
                self.require(False, "invalid_guest_command_response", f"{relative}:{line}",
                             f"{sample_loc}: flags missing or not true: {', '.join(invalid)}")
        self.require(counts["status_responses"] > 0, "missing_guest_command_responses", sample_loc,
                     "At least one status response is required in the measured trial's command log")
        self.command_response_counts[runtime].update(counts)
        self.command_response_counts[runtime]["trials"] += 1
        self.command_response_trials.append(dict(sample=sample_loc, runtime=runtime, **counts))

    def cocoon_command_responses(self, sample, loc):
        if self.cocoon_commands is None:
            self.cocoon_commands = {}
            for line, command in enumerate(self.read("cocoon/commands.jsonl", lines=True), 1):
                trial = command.get("trial")
                if isinstance(trial, str):
                    self.cocoon_commands.setdefault(trial, []).append((line, command))
        trial = sample.get("trial")
        if not self.require(isinstance(trial, str) and bool(trial) and trial not in self.cocoon_command_trials,
                            "invalid_cocoon_command_trial", loc, "Unique string trial identity required for command matching"):
            return
        self.cocoon_command_trials.add(trial)
        self.scan_command_responses("cocoon", self.cocoon_commands.get(trial, []), "cocoon/commands.jsonl", loc)

    def embedded_cocoon(self, sample, loc):
        case = sample["case"]
        if case in ("cold", "warm"):
            state = sample.get("boot", {}).get("state", {})
            self.state(state, loc + ":boot")
            if case == "warm":
                proof = sample.get("warm_restart_proof", {})
                before, after = proof.get("before", {}), proof.get("after", {})
                self.state(before, loc + ":warm-before")
                self.state(after, loc + ":warm-after")
                self.require(before.get("ram_marker") != after.get("ram_marker") and after.get("branch") == 91
                             and after.get("disk_branch") == 91, "warm_reuse_failed", loc, "Expected fresh RAM and retained branch91")
            return
        baseline = sample.get("capture", {}).get("before", {})
        self.same_identity(baseline, sample.get("source_after_proof", {}), loc + ":source")
        children = sample.get("children", [])
        expected_count = 2 if case == "fresh" else 4 if case == "fanout4" else 1
        self.require(isinstance(children, list) and len(children) == expected_count, "child_count_mismatch", loc, str(expected_count))
        identities = []
        for index, child in enumerate(children if isinstance(children, list) else [], 1):
            inherited = child.get("state", {})
            reference = sample.get("second_capture", {}).get("before", {}) if case == "fresh" and index == 2 else baseline
            self.same_identity(reference, inherited, loc + f":child{index}")
            independent = child.get("independent_state", {})
            self.same_process(inherited, independent, loc + f":child{index}-independent")
            self.require(independent.get("branch") == index and child.get("independence") == "pass", "child_isolation_failed", loc, str(index))
            vmm = child.get("runtime", {}).get("live_identity", {})
            identity = (vmm.get("pid"), vmm.get("starttime_ticks"))
            self.require(all(type(value) is int and value > 0 for value in identity), "missing_vmm_identity", loc, str(index))
            identities.append(identity)
        self.require(len(set(identities)) == expected_count, "vmm_not_distinct", loc, str(identities))

    def smol_details(self, sample, loc):
        case, variant, trial = sample["case"], sample["variant"], sample["trial"]
        relative = Path("smolvm") / f"results-{variant}-{UPSTREAM[case]}-{trial}"
        commands_path = relative / "commands.jsonl"
        commands = enumerate(self.read(commands_path, lines=True), 1)
        self.scan_command_responses("smolvm", commands, commands_path, loc)
        report = self.read(relative / "report.json")
        self.require(report == sample, "detailed_report_mismatch", str(relative), "report.json must equal samples.jsonl row")
        baseline = self.read(relative / "source-baseline.json")
        self.state(baseline, loc + ":baseline")
        if case == "cold":
            return
        if case == "warm":
            name = f"lat-smol-{variant}-warm-{trial}-source"
            after = self.read(relative / f"warm_shared_ready-{name}.json")
            self.state(after, loc + ":warm")
            self.require(baseline.get("ram_marker") != after.get("ram_marker") and after.get("branch") == 91,
                         "warm_reuse_failed", loc, "Expected fresh RAM and retained disk branch91")
            return
        for phase in (("first", "second") if case == "fresh" else ("first",)):
            heartbeat = self.read(relative / f"{phase}-source-heartbeat.json")
            self.same_identity(baseline, heartbeat.get("before", {}), loc + ":" + phase + "-baseline")
            self.same_identity(heartbeat.get("before", {}), heartbeat.get("after", {}), loc + ":" + phase + "-source")
            children = self.read(relative / f"{phase}-children.json")
            self.require(len(children) == (4 if case == "fanout4" else 1), "child_count_mismatch", loc, phase)
            for index, (name, child) in enumerate(children.items(), 2):
                self.same_identity(heartbeat.get("before", {}), child.get("status", {}), loc + ":" + name)
                prepared = child.get("prepared", {})
                self.same_process(child.get("status", {}), prepared, loc + ":" + name + "-prepared")
                expected_branch = 3 if phase == "second" else index
                self.require(prepared.get("branch") == expected_branch and prepared.get("writes_paused") is False,
                             "child_preparation_failed", loc, name)
        isolation = self.read(relative / "isolation.json")
        live = self.read(relative / "live-processes.json")
        count = 3 if case == "fresh" else 5 if case == "fanout4" else 2
        self.require(len(isolation) == count and set(isolation) == set(live), "isolation_inventory_mismatch", loc, str(count))
        branches = []
        for name, state in isolation.items():
            self.same_process(baseline, state, loc + ":isolation:" + name)
            branches.append(state.get("branch"))
        self.require(Counter(branches) == Counter(range(1, count + 1)), "sibling_isolation_failed", loc, str(branches))
        pids = [value.get("pid") for value in live.values()]
        self.require(len(pids) == count and all(type(pid) is int and pid > 0 for pid in pids)
                     and len(set(pids)) == count and all(value.get("start_time") for value in live.values()),
                     "vmm_not_distinct", loc, str(pids))

    def samples(self, matched):
        expected = Counter((task["runtime"], task["case"], task["variant"], task["actual_trial"]) for task in matched.values())
        observed, groups, excluded = Counter(), Counter(), Counter()
        for runtime in RUNTIMES:
            for index, sample in enumerate(self.read(f"{runtime}/samples.jsonl", lines=True)):
                loc = f"{runtime}/samples.jsonl:{index + 1}"
                if smoke(sample):
                    excluded[runtime] += 1
                    continue
                trial = sample.get("repetition" if runtime == "cocoon" else "trial")
                case, variant = sample.get("case"), sample.get("variant")
                if not self.require(type(trial) is int and isinstance(case, str) and case in METRICS and isinstance(variant, str) and variant in PROFILES,
                                    "invalid_sample_identity", loc, str((case, variant, trial))):
                    continue
                observed[(runtime, case, variant, trial)] += 1
                groups[(runtime, case, variant)] += 1
                self.require(type(sample.get("schema_version")) is int and sample["schema_version"] == 1 and sample.get("runtime") == runtime
                             and sample.get("status") == "pass", "failed_or_invalid_sample", loc, "Expected schema1 and runtime-matching pass")
                self.require(not any(value for key, value in sample.items() if key == "error" or key.endswith("_error")),
                             "sample_contains_error", loc, "Error fields present")
                if runtime == "cocoon":
                    self.require(sample.get("cleanup") == "pass", "sample_cleanup_failed", loc, "Cocoon cleanup must pass")
                    self.require(sample.get("adapter_sha256") == self.pins.get("cocoon/cocoon.py"), "adapter_pin_mismatch", loc, runtime)
                    matching_task = next((task for task in matched.values() if (task["runtime"], task["case"], task["variant"], task["actual_trial"]) == (runtime, case, variant, trial)), None)
                    self.require(matching_task is not None and sample.get("block") == matching_task["block"], "sample_block_mismatch", loc, str(sample.get("block")))
                else:
                    cleanup = sample.get("cleanup")
                    self.require(isinstance(cleanup, list) and bool(cleanup) and all(isinstance(item, dict) and item.get("status") == "clean" for item in cleanup)
                                 and sample.get("remaining_processes") == [], "sample_cleanup_failed", loc, "Smol cleanup/inventory incomplete")
                    inputs = sample.get("inputs", {})
                    if self.smol_inputs is None:
                        self.smol_inputs = inputs
                    self.require(isinstance(inputs, dict) and inputs == self.smol_inputs and len(inputs) >= 4
                                 and all(valid_hash(value) for value in inputs.values()), "smol_inputs_changed", loc, "Frozen complete input map required")
                    if isinstance(inputs, dict):
                        for suffix, pin in (("/smolvm/smolvm.py", "smolvm/smolvm.py"), ("/smolvm/bin/smolvm", "smolvm/bin/smolvm"),
                                            ("/smolvm/image/opt/latency/latency-guest", "shared/latency-guest")):
                            values = [value for path, value in inputs.items() if path.endswith(suffix)]
                            self.require(values == [self.pins.get(pin)], "smol_pin_mismatch", loc, pin)
                    self.require(sample.get("rootfs_sha256") == COCOON_PINS["guest-rootfs.tar"], "rootfs_pin_mismatch", loc, runtime)
                metrics = sample.get("metrics", {})
                self.require(isinstance(metrics, dict) and all(finite(metrics.get(name)) for name in METRICS[case]),
                             "missing_primary_metric", loc, str(METRICS[case]))
                self.resource_checks(sample, loc, runtime)
                if not self.summary_only:
                    try:
                        if runtime == "cocoon":
                            self.cocoon_command_responses(sample, loc)
                        self.embedded_cocoon(sample, loc) if runtime == "cocoon" else self.smol_details(sample, loc)
                    except (KeyError, TypeError, AttributeError) as error:
                        self.require(False, "malformed_proof", loc, str(error))
        self.require(observed == expected and sum(observed.values()) == 320, "sample_schedule_mismatch", "samples",
                     f"Expected320 unique matched samples; observed{sum(observed.values())}; missing{sum((expected-observed).values())}; extra{sum((observed-expected).values())}")
        wanted = Counter((task["runtime"], task["case"], task["variant"]) for task in expected_schedule())
        self.require(groups == wanted, "sample_group_counts_mismatch", "samples", "Expected28 groups: startup20, other10;160/runtime")
        return dict(non_smoke=sum(observed.values()), groups=len(groups), excluded_smoke=dict(excluded))

    def case_audits(self, matched):
        expected = Counter((task["case"], task["variant"], task["actual_trial"], task["block"]) for task in matched.values() if task["runtime"] == "cocoon")
        observed = Counter()
        for index, row in enumerate(self.read("cocoon/case-audits.jsonl", lines=True)):
            if smoke(row) or row.get("case") is None:
                continue
            loc = f"cocoon/case-audits.jsonl:{index + 1}"
            key = (row.get("case"), row.get("variant"), row.get("trial_offset"), row.get("block"))
            observed[key] += 1
            self.require(row.get("runtime") == "cocoon" and row.get("repetitions") == 1 and row.get("cleanup") == "pass"
                         and not row.get("error") and row.get("before") is not None and row.get("before") == row.get("after"),
                         "final_case_audit_failed", loc, str(key))
        self.require(observed == expected and sum(observed.values()) == 160, "case_audit_schedule_mismatch", "cocoon/case-audits.jsonl", "Exactly one final successful audit per160 Cocoon trials required")

    def run(self):
        matched, driver = self.journal()
        self.pin_checks()
        samples = self.samples(matched)
        self.case_audits(matched)
        return dict(schema_version=1, status="fail" if self.findings else "pass", driver=driver, samples=samples,
                    scope=dict(detailed_guest_proofs="skipped_explicitly" if self.summary_only else "required",
                               command_status_responses="skipped_explicitly" if self.summary_only else "all measured trials required",
                               pins="recorded hashes and exported bytes" if self.verify_files else "recorded hashes",
                               resources="Sampled endpoint deltas; not continuous peak monitoring. Nonzero throttling counters are reported, not automatically failed."),
                    finding_count=len(self.findings), findings=self.findings, resource_deltas=self.resource_deltas,
                    command_response_counts=self.command_response_counts, command_response_trials=self.command_response_trials)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="Export root containing driver-measure1.jsonl, cocoon/ and smolvm/")
    parser.add_argument("--summary-only", action="store_true", help="Explicitly skip guest/fork detailed proof phase")
    parser.add_argument("--verify-exported-files", action="store_true", help="Also require and hash four locally exported pinned artifacts")
    args = parser.parse_args(argv)
    report = Auditor(args.root, args.summary_only, args.verify_exported_files).run()
    print(json.dumps(report, separators=(",", ":"), allow_nan=False))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
