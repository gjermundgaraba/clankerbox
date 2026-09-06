import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location("latency_" + name, Path(__file__).with_name(name + ".py"))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


a = load("audit_results")


def write(path, value, lines=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in value) if lines else json.dumps(value))


def state(branch=0, marker="ram-only-fixture"):
    return dict(ok=True, ready=True, memory_ok=True, disk_ok=True, pid=42,
                start_monotonic_ns=123456789, ram_marker=marker, branch=branch, disk_branch=branch, writes_paused=False)


def resource(runtime, throttled=0, oom=0):
    group = {"memory.events": f"low 0\nhigh 0\nmax 0\noom {oom}\noom_kill {oom}\n",
             "memory.peak": "1048576", "cpu.stat": f"usage_usec 100\nnr_periods 1\nnr_throttled {throttled}\nthrottled_usec {throttled * 10}\n"}
    return dict(group, disk_allocated_bytes=1048576) if runtime == "cocoon" else dict(cgroup=group, allocated_disk_bytes=1048576)


def fixture(root, deep=True, exported=False):
    pins = {key: str(index + 1) * 64 for index, key in enumerate(a.PIN_KEYS)}
    if exported:
        for key in a.PIN_KEYS:
            target = root / key
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(("frozen fixture " + key).encode())
            pins[key] = hashlib.sha256(target.read_bytes()).hexdigest()
    journal = [dict(event="invocation", phase="full", run_id="measure1", trial_offset=0, pins=pins)]
    prepared = dict(a.COCOON_PINS, guest=pins["shared/latency-guest"])
    prepared.update({profile + "_tar": "a" * 64 for profile in a.PROFILES})
    write(root / "cocoon/prepared.json", {"artifacts": prepared})
    samples = {runtime: [] for runtime in a.RUNTIMES}
    audits = []
    cocoon_commands = []
    for task in a.expected_schedule():
        runtime, case, variant, trial = (task[key] for key in ("runtime", "case", "variant", "trial"))
        flag = "--trial-offset" if runtime == "cocoon" else "--trial"
        argv = [flag, str(trial), "--variant" if runtime == "cocoon" else "--profile", variant,
                "--run-case" if runtime == "cocoon" else "--case", case if runtime == "cocoon" else a.UPSTREAM[case]]
        journal.append(dict(event="start", **task, argv=argv))
        journal.append(dict(event="end", **task, returncode=0, stdout="", stderr=""))
        sample = dict(schema_version=1, runtime=runtime, case=case, variant=variant, status="pass",
                      trial=trial, metrics={metric: 10 for metric in a.METRICS[case]},
                      resources_before=resource(runtime), resources_after=resource(runtime, throttled=1))
        if runtime == "cocoon":
            sample.update(trial=f"{case}-{variant}-{trial}-fixture", repetition=trial, block=task["block"], cleanup="pass", adapter_sha256=pins["cocoon/cocoon.py"])
            cocoon_commands.append(dict(trial=sample["trial"], stdout=json.dumps(state()), returncode=0))
            audits.append(dict(runtime=runtime, case=case, variant=variant, trial_offset=trial,
                               block=task["block"], repetitions=1, cleanup="pass", before={"links": []}, after={"links": []}))
            if case in ("cold", "warm"):
                sample["boot"] = {"state": state()}
                if case == "warm":
                    sample["warm_restart_proof"] = {"before": state(91), "after": state(91, "new-ram")}
            else:
                count = 2 if case == "fresh" else 4 if case == "fanout4" else 1
                sample.update(capture={"before": state()}, second_capture={"before": state()}, source_after_proof=state(), children=[])
                for child in range(1, count + 1):
                    sample["children"].append(dict(state=state(), independent_state=state(child), independence="pass",
                                                   runtime={"live_identity": {"pid": 100 + child, "starttime_ticks": 1000 + child}}))
        else:
            inputs = {"/home/clanker/bench/" + key: value for key, value in pins.items() if key.startswith("smolvm/")}
            inputs["/home/clanker/bench/smolvm/image/opt/latency/latency-guest"] = pins["shared/latency-guest"]
            inputs["/home/clanker/bench/smolvm/agent-rootfs/usr/local/bin/smolvm-agent"] = "f" * 64
            sample.update(inputs=inputs, rootfs_sha256=a.COCOON_PINS["guest-rootfs.tar"],
                          resources_live=resource(runtime), cleanup=[{"name": "source", "status": "clean"}], remaining_processes=[])
            if deep:
                directory = root / "smolvm" / f"results-{variant}-{a.UPSTREAM[case]}-{trial}"
                write(directory / "commands.jsonl", [dict(stdout=json.dumps(state()), returncode=0)], lines=True)
                write(directory / "report.json", sample)
                write(directory / "source-baseline.json", state())
                if case == "warm":
                    write(directory / f"warm_shared_ready-lat-smol-{variant}-warm-{trial}-source.json", state(91, "new-ram"))
                elif case not in ("cold", "warm"):
                    count = 3 if case == "fresh" else 5 if case == "fanout4" else 2
                    write(directory / "isolation.json", {f"vm-{i}": state(i) for i in range(1, count + 1)})
                    write(directory / "live-processes.json", {f"vm-{i}": {"pid": 100 + i, "start_time": "1000"} for i in range(1, count + 1)})
                    for phase in (("first", "second") if case == "fresh" else ("first",)):
                        write(directory / f"{phase}-source-heartbeat.json", {"before": state(), "after": state()})
                        write(directory / f"{phase}-children.json", {f"child-{i}": {"status": state(), "prepared": state(3 if phase == "second" else i + 1)}
                                                                      for i in range(1, 5 if case == "fanout4" else 2)})
        samples[runtime].append(sample)
    write(root / "driver-measure1.jsonl", journal, lines=True)
    for runtime, rows in samples.items():
        write(root / runtime / "samples.jsonl", rows, lines=True)
    write(root / "cocoon/case-audits.jsonl", audits, lines=True)
    if deep:
        write(root / "cocoon/commands.jsonl", cocoon_commands, lines=True)
    return journal, samples, audits


class AuditResultsTests(unittest.TestCase):
    def test_schedule_and_complete_detailed_audit(self):
        self.assertEqual(a.expected_schedule(), load("run").schedule("full"))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture(root)
            result = a.Auditor(root).run()
            self.assertEqual(result["status"], "pass", result["findings"][:5])
            self.assertEqual(result["driver"]["ends"], 320)
            self.assertEqual(result["samples"]["groups"], 28)
            self.assertEqual(result["scope"]["detailed_guest_proofs"], "required")
            self.assertEqual(result["command_response_counts"]["cocoon"]["status_responses"], 160)
            self.assertEqual(result["command_response_counts"]["smolvm"]["status_responses"], 160)
            self.assertTrue(any(row["cpu_stat"]["nr_throttled"] == 1 for row in result["resource_deltas"]))

    def test_missing_trial_and_incomplete_journal_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            journal, samples, _ = fixture(root, deep=False)
            journal.pop()
            samples["smolvm"].pop()
            write(root / "driver-measure1.jsonl", journal, lines=True)
            write(root / "smolvm/samples.jsonl", samples["smolvm"], lines=True)
            result = a.Auditor(root, summary_only=True).run()
            codes = {row["code"] for row in result["findings"]}
            self.assertEqual(result["status"], "fail")
            self.assertTrue({"unfinished_driver_task", "incomplete_driver_schedule", "sample_schedule_mismatch", "sample_group_counts_mismatch"} <= codes)

    def test_failure_pins_oom_and_final_cleanup_are_not_hidden(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            journal, samples, audits = fixture(root, deep=False)
            journal[2]["returncode"] = 1
            invocation = copy.deepcopy(journal[0])
            invocation["pins"]["shared/latency-guest"] = "b" * 64
            journal.append(invocation)
            samples["cocoon"][0]["resources_after"] = resource("cocoon", oom=1)
            samples["smolvm"][0]["status"] = "fail"
            audits[0].update(cleanup="fail", error="cgroup did not drain")
            write(root / "driver-measure1.jsonl", journal, lines=True)
            for runtime in a.RUNTIMES:
                write(root / runtime / "samples.jsonl", samples[runtime], lines=True)
            write(root / "cocoon/case-audits.jsonl", audits, lines=True)
            result = a.Auditor(root, summary_only=True).run()
            codes = {row["code"] for row in result["findings"]}
            self.assertTrue({"driver_failure", "pins_changed", "oom_during_trial", "failed_or_invalid_sample", "final_case_audit_failed"} <= codes)

    def test_missing_proof_fails_and_explicit_summary_scope_is_narrow(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture(root, deep=False)
            strict = a.Auditor(root).run()
            self.assertEqual(strict["status"], "fail")
            self.assertIn("missing_or_invalid_file", {row["code"] for row in strict["findings"]})
            summary = a.Auditor(root, summary_only=True).run()
            self.assertEqual(summary["status"], "pass", summary["findings"][:5])
            self.assertEqual(summary["scope"]["detailed_guest_proofs"], "skipped_explicitly")

    def test_explicit_smoke_excluded_and_duplicate_measurement_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, samples, _ = fixture(root, deep=False)
            smoke = copy.deepcopy(samples["cocoon"][0])
            smoke.update(status="fail", block="smoke", repetition=90000)
            samples["cocoon"].append(smoke)
            write(root / "cocoon/samples.jsonl", samples["cocoon"], lines=True)
            good = a.Auditor(root, summary_only=True).run()
            self.assertEqual(good["status"], "pass", good["findings"][:5])
            self.assertEqual(good["samples"]["excluded_smoke"]["cocoon"], 1)
            samples["cocoon"].append(copy.deepcopy(samples["cocoon"][0]))
            write(root / "cocoon/samples.jsonl", samples["cocoon"], lines=True)
            bad = a.Auditor(root, summary_only=True).run()
            self.assertIn("sample_schedule_mismatch", {row["code"] for row in bad["findings"]})

    def test_exported_artifact_bytes_must_match_when_required(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture(root, exported=True)
            good = a.Auditor(root, verify_exported_files=True).run()
            self.assertEqual(good["status"], "pass", good["findings"][:5])
            self.assertEqual(good["scope"]["pins"], "recorded hashes and exported bytes")
            (root / "shared/latency-guest").write_bytes(b"changed")
            bad = a.Auditor(root, verify_exported_files=True).run()
            self.assertEqual(bad["status"], "fail")
            self.assertIn("exported_artifact_changed", {row["code"] for row in bad["findings"]})

    def test_transient_bad_then_valid_command_response_still_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture(root)
            coco_path = root / "cocoon/commands.jsonl"
            coco = [json.loads(line) for line in coco_path.read_text().splitlines()]
            trial = coco[0]["trial"]
            invalid = dict(state(), memory_ok=False)
            coco[0:0] = [dict(trial=trial, stdout=json.dumps(invalid), returncode=0),
                         dict(trial=trial, stdout=json.dumps({"memory_ok": True}), returncode=0),
                         dict(trial=trial, stdout="connect: No such file or directory", returncode=1)]
            # Unmatched smoke responses must not contaminate measured checks.
            coco.append(dict(trial="smoke-excluded-90000", stdout=json.dumps(invalid), returncode=0))
            write(coco_path, coco, lines=True)
            smol_path = root / "smolvm/results-idle-cold-0/commands.jsonl"
            smol = [json.loads(line) for line in smol_path.read_text().splitlines()]
            smol[0:0] = [dict(stdout=json.dumps(dict(state(), disk_ok=False)), returncode=0),
                         dict(stdout="", returncode=1)]
            write(smol_path, smol, lines=True)
            report = a.Auditor(root).run()
            failures = [finding for finding in report["findings"] if finding["code"] == "invalid_guest_command_response"]
            self.assertEqual(report["status"], "fail")
            self.assertEqual(len(failures), 3)
            self.assertTrue(any("disk_ok" in finding["detail"] for finding in failures))
            coco_counts = report["command_response_counts"]["cocoon"]
            smol_counts = report["command_response_counts"]["smolvm"]
            self.assertEqual((coco_counts["status_responses"], coco_counts["invalid_status_responses"], coco_counts["other_responses"]), (162, 2, 1))
            self.assertEqual((smol_counts["status_responses"], smol_counts["invalid_status_responses"], smol_counts["other_responses"]), (161, 1, 1))

    def test_empty_command_log_cannot_satisfy_detailed_proof(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture(root)
            write(root / "smolvm/results-idle-cold-0/commands.jsonl", [], lines=True)
            report = a.Auditor(root).run()
            self.assertEqual(report["status"], "fail")
            self.assertIn("missing_guest_command_responses", {finding["code"] for finding in report["findings"]})


if __name__ == "__main__":
    unittest.main()
