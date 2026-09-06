import importlib.util
from pathlib import Path
import json
import unittest


spec = importlib.util.spec_from_file_location("summarize_resources", Path(__file__).with_name("summarize_resources.py"))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


class ResourceSummaryTests(unittest.TestCase):
    def test_dirty_rate_uses_counter_delta_midpoints_and_timing_brackets(self):
        identity = dict(pid=10, start_monotonic_ns=100, ram_marker="same", writes_paused=False, dirty_mib_s=64)
        before = dict(identity, dirty_bytes=2 * s.MIB)
        after = dict(identity, dirty_bytes=66 * s.MIB)
        commands = [dict(argv=['{"op":"reset_metrics"}'], stdout=json.dumps(before), start_ns=0, end_ns=100_000_000),
                    dict(argv=['{"op":"status"}'], stdout=json.dumps(after), start_ns=1_000_000_000, end_ns=1_100_000_000)]
        result = s.dirty_window(after, commands)
        self.assertEqual(result["dirty_bytes_advanced"], 64 * s.MIB)
        self.assertEqual(result["achieved_mib_s"], 64)
        self.assertAlmostEqual(result["achieved_lower_mib_s"], 64 / 1.1)
        self.assertAlmostEqual(result["achieved_upper_mib_s"], 64 / .9)
        with self.assertRaises(ValueError):
            s.dirty_window(after, commands[1:])
        with self.assertRaises(ValueError):
            s.dirty_window(after, commands + [commands[1]])

    def test_counter_changes_and_resource_endpoints_are_explicit(self):
        self.assertEqual(s.counter_delta({"oom": 3, "nr_throttled": 10}, {"oom": 3, "nr_throttled": 12}),
                         {"oom": 0, "nr_throttled": 2})
        with self.assertRaises(ValueError):
            s.counter_delta({"oom": 3}, {"oom": 2})
        with self.assertRaises(ValueError):
            s.counter_delta({"oom": 0}, {"oom_kill": 0})
        def group(current, peak, throttled):
            return {"memory.current": str(current), "memory.peak": str(peak),
                    "memory.events": "oom 0\noom_kill 0\n", "cpu.stat": f"nr_throttled {throttled}\nthrottled_usec {throttled * 10}\n"}
        summary = s.Summary("unused")
        sample = dict(case="fanout4", variant="idle", resources_before=dict(cgroup=group(1, 100, 2), allocated_disk_bytes=1000),
                      resources_live=dict(cgroup=group(30, 100, 3), allocated_disk_bytes=1600),
                      resources_after=dict(cgroup=group(2, 100, 4), allocated_disk_bytes=1010))
        summary.resources("smolvm", sample, "trial")
        row = summary.resource_trials[0]
        self.assertEqual(row["observed_memory_peak_bytes"], 100)
        self.assertEqual(row["live_memory_current_bytes"], 30)
        self.assertEqual(row["filesystem_live_minus_before_bytes"], 600)
        self.assertEqual(row["cpu_stat_delta"]["nr_throttled"], 2)


if __name__ == "__main__":
    unittest.main()
