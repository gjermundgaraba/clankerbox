# Controlled startup and RAM-fork measurements

Status: **320/320 measured trials passed**, completed 2026-09-05; strict dataset
audit passed. See [results](RESULTS.md). The timing gate is now closed. No model
calls or copied login credentials. This is an explicitly disposable measurement
run, not a change to the retained-machine product contract.

## Scope

The benchmark compares the pinned Cocoon + Firecracker runtime and corrected
smolvm/libkrun runtime from the earlier acceptance tests. Source, artifacts and
old reports remain untouched. The new host scope is
`/home/clanker/clankerbox-latency.RPxPe6`; a shared exclusive file lock serializes
timed cases. Both use CPU affinity 4–11 (eight physical cores, no SMT siblings),
4 GiB / two vCPU guests, at most one source plus four children, a hard 32-GiB
runtime cgroup memory limit and a 96-GiB allocated-disk budget checked at sampled
endpoints, not a continuously enforced disk quota. The actual host filesystem is
ext4. No host reformat, global cache flush, reboot, sysctl, firewall, service or
package changes are authorized. No guest external NICs are used.

Host preflight: AMD EPYC 7502P, 32 physical / 64 logical CPUs, about 123 GiB available RAM,
807 GiB free disk, near-zero background load. Record host counters per sample;
an idle preflight is not a claim of a dedicated machine throughout execution.

## Workload and remaining differences

Both adapters use the same static C workload and the same pinned Ubuntu rootfs
tar (`0a64e8ef15c93ff146f10729750955a4b4a1938293260cbf983d99b5466c99ed`).
Cocoon boots the guest OS; smolvm boots its appliance and starts the workload
container. Different guest kernels, boot paths and disk representations remain
part of the compared stacks. Use an optimized smolvm CLI rather than the debug
CLI that produced the earlier incidental timing numbers.

RAM persistence also differs: Cocoon writes a file-backed RAM snapshot, whereas
the measured smolvm `FORK_CONTINUE` path retains volatile sealed-memfd generations
referenced through live processes. Its separate portable RAM path is not measured.
Treat these as live-branch workflow timings, not equivalent durable-RAM-checkpoint
timings. Workspace disk retention is evaluated independently. See the
[persistence explanation and source references](RESULTS.md#important-these-ram-checkpoints-have-different-persistence-contracts).

| Variant | Resident workload RAM | Dirtying | Synced workspace |
| --- | ---: | ---: | ---: |
| idle | 64 MiB | off | marker only |
| resident | 1,024 MiB | off | marker only |
| dirty | 1,024 MiB | target 64 MiB/s | marker only |
| workspace | 1,024 MiB | off | 2,048 MiB across 1,024 files |

Pages and files contain actual nonzero deterministic data, not sparse
reservations. Report achieved dirtying and actual disk allocation. Reused disk
starts preserve files; RAM forks preserve the continuing workload identity and
must independently mutate RAM and a synced branch marker in every child. The
128-byte marker is overwritten in place with `pwrite` and `fsync`, preserving
its inode and size; this checks inherited-file isolation, not physical reflink
extent sharing. RAM verification touches eight sentinel bytes on every page,
not every mutable payload byte.

## Measurement boundaries

1. Cached-image cold VM creation/start: request through runtime return, first
   successful guest command and shared workload readiness as separately timed,
   independently probed endpoints. Image import and
   fixture construction are reported separately. This is not cold host page cache.
2. Same-disk restart: request through the same readiness checks. Cold-booting a
   workload is not labelled RAM restoration.
3. Fresh live forks: capture and create one child, then capture the continuing
   source again and create a second child. Record both complete request-to-ready
   intervals and the runtime's separately observable capture/restore components.
4. One-capture fan-out: one source checkpoint and one or four children. Record
   capture plus all children prepared, clone-only phase where independently
   observable, per-child readiness and actual overlap. Do not subtract unlike
   operations and label the result an equivalent native API measurement.
5. Source execution interruption: compare baseline and capture-window heartbeat
   gaps using guest monotonic and raw clocks. These include scheduler delay and
   are **not exact vCPU pause measurements**. Cocoon's state sampling supplies
   an additional bounded observation, not a substitute for this distinction.

Target sample counts are 20 cached-image cold starts and 20 same-disk restarts
for the idle variant; ten trials per variant for fresh paired forks and each
fan-out size. Preparation/smoke tests are excluded. Alternate runtime blocks to
reduce ordering effects; no build or competing benchmark overlaps timed blocks.
Report counts, individual samples, median and empirical tail/order statistics;
ten or twenty trials do not establish a reliable production p95/SLA.

Pre-measurement smoke attempts are retained separately. Two Cocoon CLI harness
errors (8-GiB disk below the 10-GiB minimum; unsupported Firecracker clone NIC
override) were corrected before the final smoke round. All twelve final smoke
cases passed after aligning parallel readiness probes, immediate per-child
preparation, and cooperative writer resume policies.

Five calibration holds per runtime suspended every thread of an identity-checked
source VMM through a PID file descriptor. A measured approximately 100-ms hold
produced 100.57–101.40 ms guest heartbeat gaps in Cocoon and 101.43–102.69 ms in
smolvm. Resume is in `finally`, including SIGTERM handling. This establishes
clock sensitivity to host process suspension; native checkpoint clock handling
can still differ, so the fork heartbeat is not relabelled exact vCPU pause.

`run.py` serializes 320 trials in alternating five-trial runtime blocks. Both
runtime adapters and workload inputs are frozen for this run. `analyze.py`
preserves all raw rows and groups only matching runtime/case/profile; partial or
failed preparations are never mixed into the successful latency distribution.

For the dirty profile, fresh paired captures leave the writer active. Cooperative
fanout cases pause it before capture; children resume after independent branch
preparation, and the source resumes after all children are prepared. Thus dirty
fanout measures a previously dirtied RAM image, not capture under continuing
64-MiB/s source writes.

Every sample records process identities, control-operation timestamps, fixture
checks and cleanup. Invalid or failed attempts remain visible, not silently
dropped or averaged into successful readiness. Export sanitized measurements and
remove owned VMs, snapshots, runtime disks, active locks/listeners and cgroups after
execution. Keep source and small reports for reproduction.
