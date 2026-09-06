import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("latency_analyze", Path(__file__).with_name("analyze.py"))
analyzer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analyzer)


def row(value=10, **extra):
    sample = {"runtime": "cocoon", "case": "cold", "variant": "small", "trial": "trial-1",
              "repetition": 0, "status": "pass", "metrics": {"cold_request_to_workload_ms": value}}
    sample.update(extra)
    return {"source": "samples.jsonl", "line": 1, "sample": sample}


class AnalysisTests(unittest.TestCase):
    def test_linear_quantiles(self):
        self.assertIsNone(analyzer.quantile([], .5))
        self.assertEqual(analyzer.quantile([42], .95), 42)
        self.assertEqual(analyzer.quantile([40, 10, 30, 20], .5), 25)
        self.assertAlmostEqual(analyzer.quantile([10, 20, 30, 40], .9), 37)
        self.assertAlmostEqual(analyzer.quantile([10, 20, 30, 40], .95), 38.5)
        with self.assertRaises(ValueError):
            analyzer.quantile([1], 2)

    def test_failures_and_smoke_are_explicit_and_raw_is_preserved(self):
        records = [row(10), row(30), row(100, status="fail", error="capture failed"),
                   row(200, cleanup="fail", cleanup_error="remaining VM"),
                   row(300, block="smoke", status="fail"), row(400, repetition=90001),
                   row(500, runtime="smolvm", profile="small", variant="small", trial=90000)]
        original = json.loads(json.dumps(records))
        report = analyzer.analyze(records)
        self.assertEqual(records, original)
        self.assertEqual(report["counts"], {"total": 7, "included": 4, "pass": 2, "fail": 2,
                                          "excluded": 3, "excluded_pass": 2, "excluded_fail": 1})
        cocoon = report["groups"][0]
        metric = cocoon["metrics"]["cold_request_to_workload_ms"]
        self.assertEqual((metric["n"], metric["median"], metric["failed_present"], metric["excluded_present"]),
                         (2, 20, 2, 2))
        self.assertEqual([item["sample"] for item in report["raw_samples"]], [item["sample"] for item in records])
        self.assertEqual(report["raw_samples"][4]["exclusion_reasons"], ["block=smoke"])
        self.assertIn("cleanup_failed", report["raw_samples"][3]["outcome_reasons"])

    def test_missing_null_invalid_and_unknown_units(self):
        records = [row(metrics={}), row(None), row(True), row(-1),
                   row(metrics={"cold_request_to_workload_ms": 8, "flat_bytes": 1024,
                                "nested": {"duration_ms": 500}, "mystery": 99})]
        report = analyzer.analyze(records)
        group = report["groups"][0]
        metric = group["metrics"]["cold_request_to_workload_ms"]
        self.assertEqual((metric["n"], metric["missing"], metric["null"], metric["invalid"]), (1, 1, 1, 2))
        self.assertEqual(group["metrics"]["flat_bytes"]["unit"], "bytes")
        self.assertEqual(group["ignored_metrics_without_explicit_ms_or_bytes_unit"], ["mystery", "nested"])
        absent = analyzer.analyze([row(metrics={})])["groups"][0]["metrics"]["cold_request_to_workload_ms"]
        self.assertEqual(absent["n"], 0)
        self.assertIsNone(absent["p95"])

    def test_case_grouping_does_not_pool_setup_boots(self):
        records = [row(10, runtime="smolvm", profile="small", trial=1),
                   row(100, runtime="smolvm", profile="small", trial=2, case="live-first",
                       metrics={"cold_request_to_workload_ms": 100, "fresh_first_total_ms": 50})]
        report = analyzer.analyze(records)
        self.assertEqual(len(report["groups"]), 2)
        self.assertEqual(report["groups"][0]["metrics"]["cold_request_to_workload_ms"]["median"], 10)
        table = analyzer.markdown(report)
        self.assertIn("fresh_first_total", table)
        self.assertEqual(table.count("cold_request_to_workload"), 1)

    def test_only_explicit_metadata_excludes_and_cli_writes_both_outputs(self):
        strange = row(trial="smoke-99999", block="1", repetition=1)
        self.assertFalse(analyzer.exclusion_reasons(strange["sample"]))
        smol = row(runtime="smolvm", trial="90000")
        self.assertFalse(analyzer.exclusion_reasons(smol["sample"]))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "samples.jsonl"
            source.write_text(json.dumps(strange["sample"]) + "\n")
            self.assertEqual(analyzer.main([str(source), "--output-dir", str(root / "out")]), 0)
            report = json.loads((root / "out" / "summary.json").read_text())
            self.assertEqual(report["counts"]["pass"], 1)
            self.assertEqual(report["sources"][0]["path"], str(source))
            self.assertTrue((root / "out" / "summary.md").read_text().startswith("Trials:"))


if __name__ == "__main__":
    unittest.main()
