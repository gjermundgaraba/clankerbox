# Idle fanout-four concurrency audit

Read-only audit of the completed **10 measured idle fanout-four trials per
runtime** in the 2026-09-05 export. Trials 0–9 all passed. Smoke/calibration
records were excluded using explicit metadata; other profiles were not pooled.

## What the evidence establishes

| Evidence, across all 10 trials | Cocoon | Patched smolvm |
|---|---:|---:|
| Four launch intervals have a common overlap | 57.144–74.780 ms | 41.823–63.258 ms |
| Spread between earliest and latest launch | 2.029–4.162 ms | 0.176–1.755 ms |
| Children with inherited PID, start timestamp and RAM-only marker | 40/40 | 40/40 |
| Additional heartbeat samples per child between readiness and final isolation check | 352–507 | 713–843 |

For **Cocoon**, a launch interval is the host-monotonic `start_ns`–`end_ns`
of each `vm clone` command in [commands.jsonl](results/2026-09-05/cocoon/commands.jsonl).
The common overlap is `min(end_ns) − max(start_ns)` across the four commands;
launch spread is `max(start_ns) − min(start_ns)`. These are overlapping CLI
requests, including their wrappers, not isolated internal restore intervals.

For **smolvm**, the interval runs from each logged `boot: subprocess spawned`
event to its matching `agent VM is ready` event, joined by VMM PID. The four
intervals overlap in every trial. Bounds use the log's UTC timestamps, not a
separate monotonic restore timer. Each invocation also records `--count 4
--parallel 4`; the PID/timestamp evidence establishes more than those arguments
alone. See, for example, [trial 0 commands](results/2026-09-05/smolvm/results-idle-batch-4-0/commands.jsonl).

Cocoon's [sample records](results/2026-09-05/cocoon/samples.jsonl) contain four
`running` child runtime records, distinct live VMM PID/birth identities, inherited
guest identities and later independent branch values 1–4. Every smolvm trial
has five `running` entries—source plus four children—in `live-records.json`,
matching five distinct inspected processes in `live-processes.json`. Its final
`isolation.json` has distinct branch values 1–5. The corresponding
`first-children.json` and `first-source-heartbeat.json` preserve inheritance and
source-continuity evidence; [trial 0 directory](results/2026-09-05/smolvm/results-idle-batch-4-0/)
is representative.

Together, these records establish overlapping VM lifetimes, concurrent launch
activity and continued execution of inherited guest processes. They do **not**
establish that all vCPUs executed instructions at one exact instant, or measure
sustained parallel CPU throughput. The inspected VMM leaders were sleeping
(`S`), which is compatible with live VMs. RAM verification covers process
identity and one sentinel per page, not every dirty byte.

## Completed idle tails and capture costs

End-to-end time includes one source capture and all four children becoming
usable and completing the shared branch mutation/preparation. Quantiles use
linear interpolation at sorted index `(n−1)×p`; each row has **n = 10**.

| Runtime | Median | p90 | p95 | Maximum |
|---|---:|---:|---:|---:|
| Cocoon | 8,908.629 ms | 8,919.050 ms | 8,920.686 ms | 8,922.322 ms |
| Patched smolvm | 1,597.880 ms | 2,061.831 ms | 2,451.216 ms | 2,840.601 ms |

Cocoon's snapshot-command median was **8,636.321 ms** (p95 8,653.627 ms);
its subsequent clone-only all-ready median was **182.422 ms** (p95 195.319 ms).
Smolvm's logged RAM-checkpoint median was **58 ms** (p95 63.550 ms).
These capture timers have different scopes; neither is an isolated pure-copy
timer. Source guest-observed maximum-gap medians were 8,574.995 ms and
61.235 ms respectively, not exact native vCPU-pause measurements.

**All 10 Cocoon snapshot-save logs and all 40 clone logs report unsupported
reflink and full-copy fallback.** This dataset therefore does not measure a
successful physical-reflink path. The warning does not quantify copied bytes
or isolate copy duration. Smolvm's branch logs report materialized RAM
generation because kernel-fault userfaultfd is unavailable. The numerical
results above are taken directly from each runtime's measured
[Cocoon](results/2026-09-05/cocoon/samples.jsonl) and
[smolvm](results/2026-09-05/smolvm/samples.jsonl) records.
