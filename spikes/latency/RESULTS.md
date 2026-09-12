# Controlled Cocoon / patched-smolvm latency run

Status: **320/320 measured trials passed**, 160 per runtime, across 28 matched
groups. The strict dataset audit and disposable-cache cleanup passed with zero
dataset findings. Twenty-five preparation/calibration records are excluded
explicitly: 23 passed, and two CLI harness errors were corrected before the final
12-case smoke round, which passed in full.

## Important: these RAM checkpoints have different persistence contracts

These timings compare native live-branch workflows with matching continuing-process
and workspace-isolation checks. **Cocoon writes a file-backed Firecracker RAM
snapshot; the measured smolvm `FORK_CONTINUE` path retains volatile sealed-memfd
RAM generations tied to live processes.** smolvm's faster first capture therefore
does not demonstrate faster durable RAM checkpointing.

Smolvm fsyncs checkpoint/manifest files, but these contain CPU/device state and
owner-PID/FD references, not the RAM payload. Fresh restoration opens those live
process FDs. Already-running children retain their own mappings and can outlive
the original owner; a host reboot loses these RAM generations. The source also
contains a separate portable `memory.bin` path, which this run did not measure.
Workspace disk retention is a separate capability and was tested independently;
this caveat does not mean that smolvm's workspace disk is volatile. Cocoon's
file-backed snapshots were not subjected to a reboot or power-loss recovery test.

Sources: [memfd allocation](https://github.com/smol-machines/libkrun/blob/dbf5f235047333ac7b831b5a32497aa8c1d46663/src/vmm/src/builder.rs#L1849),
[fork checkpoint handler](https://github.com/smol-machines/libkrun/blob/dbf5f235047333ac7b831b5a32497aa8c1d46663/src/libkrun/src/lib.rs#L1253),
[live-FD restore](https://github.com/smol-machines/libkrun/blob/dbf5f235047333ac7b831b5a32497aa8c1d46663/src/libkrun/src/lib.rs#L1409),
[separate portable restore](https://github.com/smol-machines/libkrun/blob/dbf5f235047333ac7b831b5a32497aa8c1d46663/src/libkrun/src/lib.rs#L1328),
[Cocoon snapshot files](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/hypervisor/firecracker/snapshot.go).

Source links pin the audited upstream revisions. The measured libkrun also
includes the checked-in [DAX fork correction](../smolvm/libkrun-dax-fork.patch);
[RAM_FIX.md](../smolvm/RAM_FIX.md) records its provenance and bounded validation.
Line anchors refer to the unpatched pin, not an author-local working tree.

## Startup measurements

Cached local images, 4-GiB / 2-vCPU guests, the same Ubuntu userspace and static
workload, 64 MiB of initialized workload RAM. No image pull or host-cache reset.
Times include creation/start and successful shared-workload readiness.

| Operation | Cocoon median / p95 | Patched smolvm median / p95 | n per runtime |
| --- | ---: | ---: | ---: |
| Fresh VM from cached image | 2.307 / 2.352 s | 0.805 / 0.850 s | 20 |
| Restart the same writable disk | 2.234 / 2.303 s | 0.784 / 0.823 s | 20 |

The restart proof requires a new RAM identity and the retained, fsynced disk
branch marker. These are whole-stack measurements: Cocoon boots Ubuntu/systemd;
smolvm boots its appliance and runs the Ubuntu workload container. They are not
isolated hypervisor boot timers. Quantiles are empirical interpolations; these
sample counts do not establish production tail guarantees.

## Clean-RAM fork measurements

Medians in seconds, ten trials per cell. Every VM still has **4 GiB configured
RAM**; columns vary the initialized resident workload. Fork totals end after
the child is workload-ready, has applied its independent fsynced branch marker,
and has resumed writes if cooperatively paused. A second fresh capture is of
the continuing source while the first child remains alive. Fresh dirty-profile
captures leave its writer active; cooperative fanout pauses the source writer
before capture and resumes it after all children are prepared. Dirty fanout
therefore measures previously dirtied RAM, not capture under ongoing writes.

| Operation, including a new capture | Cocoon, 64 MiB | smolvm, 64 MiB | Cocoon, 1 GiB | smolvm, 1 GiB |
| --- | ---: | ---: | ---: | ---: |
| First fresh capture + one child | 8.814 | 0.897 | 8.984 | 1.917 |
| Second fresh capture + another child | 5.220 | 5.039 | 5.372 | 5.406 |
| One cooperative capture + one child | 8.872 | 1.064 | 8.998 | 1.726 |
| One cooperative capture + four children | 8.909 | 1.598 | 9.115 | 2.352 |

smolvm has wider observed tails in these clean-workload samples. For example,
the first fresh 1-GiB fork has empirical p95 **2.693 s** versus its **1.917 s**
median; Cocoon's corresponding p95 is **9.018 s** versus **8.984 s** median.
The repeated-capture medians are effectively tied in this workload, not a
continuation of smolvm's first-capture advantage.

Cocoon also exposes a separately measurable **existing-checkpoint** path:

| Existing checkpoint → all children workload-ready, excluding capture | 64 MiB workload | 1 GiB workload |
| --- | ---: | ---: |
| One child | 0.157 s | 0.885 s |
| Four concurrent children | 0.182 s | 0.971 s |

Those endpoints exclude later branch-marker preparation. Do not compare them
directly to smolvm's capture-plus-prepared totals. This smolvm CLI run uses one
capture per batch; an equivalent independent saved-checkpoint refill operation
was not measured. All guest access is local vsock/agent execution, not SSH or
network identity readiness.

## Dirty RAM and populated workspaces

Medians in seconds, ten trials per cell, 4-GiB / 2-vCPU guests throughout.
Both profiles initialize 1 GiB of workload RAM. Dirty targets 64 MiB/s writes;
workspace adds 2 GiB of nonzero, fsynced data across 1,024 files. Initial workload
population occurs before the fork timer. The dirty fanout pause policy is as
described above; fresh dirty captures keep the source writer active.

| Operation, including a new capture | Cocoon, dirty | smolvm, dirty | Cocoon, workspace | smolvm, workspace |
| --- | ---: | ---: | ---: | ---: |
| First fresh capture + one child | 8.998 | 2.000 | 12.146 | 2.358 |
| Second fresh capture + another child | 5.391 | 5.462 | 9.077 | 4.628 |
| One cooperative capture + one child | 9.029 | 1.853 | 12.209 | 1.915 |
| One cooperative capture + four children | 9.115 | 2.673 | 15.158 | 2.974 |

Populated disks increase Cocoon's costs on this ext4/full-copy path. Workspace
fanout4 empirical p95 is **16.998 s** for Cocoon and **3.582 s** for smolvm;
maxima are 17.417 s and 3.624 s. This is a whole-stack result including their
different disk and RAM persistence paths, not an isolated hypervisor ranking.
All distributions and individual samples are retained in the
[full table](results/2026-09-05/analysis/summary.md) and
[analysis JSON](results/2026-09-05/analysis/summary.json).

## Why capture and child startup are separate operations

Cocoon's pinned Firecracker path uses **full** RAM snapshots for both first and
second captures. Configured RAM, not only the workload's resident allocation,
therefore matters. It pauses the source, captures RAM, copies writable disks,
then resumes. Firecracker flushes and syncs the memory file during capture;
Cocoon also persists the snapshot store afterward. This host's ext4 volume
does not support the requested reflinks, so the disk path falls back to copying
allocated extents while preserving holes. Restoring children from the resulting
checkpoint is a separate, much shorter operation.

Sources: [Cocoon capture ordering](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/hypervisor/firecracker/snapshot.go),
[disk capture](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/hypervisor/disks.go),
[sparse-copy fallback](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/utils/sparse_linux.go),
[snapshot persistence](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/snapshot/localfile/localfile.go).

Patched smolvm's first capture can seal its existing RAM backing and let the
source continue through private copy-on-write mappings. A later capture must
materialize newer private RAM into a new generation. On this host,
`vm.unprivileged_userfaultfd=0`; the eager path scans configured RAM, skips zero
pages, and copies nonzero runs. The source resumes **before** that copy finishes,
so capture-command duration is not equivalent to source interruption. A 64-MiB
workload still entails a scan over roughly 4 GiB of configured RAM on that path.

Sources: [RAM generations](https://github.com/smol-machines/libkrun/blob/dbf5f235047333ac7b831b5a32497aa8c1d46663/src/vmm/src/snapshot.rs#L773),
[resume before copy completion](https://github.com/smol-machines/libkrun/blob/dbf5f235047333ac7b831b5a32497aa8c1d46663/src/vmm/src/lib.rs#L1251),
[eager scan](https://github.com/smol-machines/libkrun/blob/dbf5f235047333ac7b831b5a32497aa8c1d46663/src/vmm/src/snapshot.rs#L1183),
[retained DAX correction](../smolvm/RAM_FIX.md).

## Source interruption: important limit

Both guest clocks detected five approximately 100-ms host VMM-process
suspensions: Cocoon observed 100.57–101.40 ms and smolvm 101.43–102.69 ms.
All VMM threads were confirmed stopped, PID descriptors prevented PID-reuse
signals, and resume ran in `finally` before cleanup.

**That does not validate guest heartbeat as an exact native snapshot-pause
timer.** smolvm's native resume adjusts the KVM clock by subtracting paused time;
the SIGSTOP calibration bypasses that path. Cocoon's Firecracker API also blocks
concurrent state queries during snapshot creation, leaving timeout gaps in the
state observer. We retain guest-observed heartbeat gaps and raw state samples,
but do not rank the runtimes by a falsely precise vCPU-pause number.

Sources: [smolvm KVM clock adjustment](https://github.com/smol-machines/libkrun/blob/dbf5f235047333ac7b831b5a32497aa8c1d46663/src/vmm/src/linux/vstate.rs#L1017),
[calibration harness](calibrate.py), [measurement boundaries](README.md).

## Concurrent means concurrent, not four sequential reboots

The completed idle fanout4 trials establish overlapping launch intervals,
simultaneously live source-plus-four-child VM records, inherited workload process
identity, independent branch writes, and advancing guest heartbeat counters in
all 40 children per runtime. Cocoon's four clone command intervals overlap in
every trial; smolvm's four spawn-to-agent-ready intervals also overlap. This is
evidence of concurrent machine lifetimes and continuing RAM state, not a claim
that every vCPU executes on a physical core at precisely the same instant.
See the [independent concurrency audit](CONCURRENCY_AUDIT.md).

## Reproduction and evidence

The host is an AMD EPYC 7502P, 32 physical / 64 logical cores, approximately
125 GiB RAM, Ubuntu kernel 7.0.0-31-generic, and an ext4 NVMe filesystem. Runtime
work is confined to CPUs 4–11, eight physical cores without their SMT siblings;
host work outside that affinity is not claimed absent merely because the initial
load was low. Both stacks use 4-GiB / 2-vCPU guests, no external guest NICs, a
32-GiB hard cgroup memory cap with swap disabled, and a 96-GiB private disk budget
checked at sampled endpoints rather than enforced continuously as a disk quota.
No host sysctl, global cache flush, service, firewall, package or filesystem
changes were made. No login credentials or model calls are involved.

This controlled C workload does not measure model-response
latency, network reconnection, arbitrary in-flight filesystem transactions, or
full payload-byte integrity. Status verifies a RAM-only process identity,
eight sentinel bytes per RAM page, and the independently overwritten disk marker.
For the workspace profile, full smolvm mountinfo resolves its overlay upper
directory to `/storage`, ext4 on `/dev/vda`; Cocoon records its writable
`cow.raw` block backing. The workspace path is `/var/tmp`, not `/tmp` tmpfs.

Cocoon commit `23a05603479a7552213adfb5fa25f2de7b2dbaf9` + Firecracker v1.16.1;
patched smolvm commit `4e4b992593b42e27484c873b2c08feb69e832c4f` with the retained
corrected libkrun and an optimized private CLI build. The shared guest SHA-256 is
`c0db3a0cab9c3f039d45b9098b1e57746d37ac7ac16467885c34e9fe9281701e`.
Prepared manifests and driver journals pin every runtime/adapter input.

All nine local test suites pass, including 43 latency harness/analysis/ownership
tests. The measurement driver executed serially on the remote host; local tests
do not launch VMs or alter the measured host.

See [full protocol and matrix](README.md), [Cocoon adapter notes](COCOON_NOTES.md),
[smolvm adapter notes](SMOLVM_NOTES.md), and
[raw distribution table](results/2026-09-05/analysis/summary.md).

## Final audit and cleanup

The [resource summary](results/2026-09-05/resource-summary.json) covers all 320
trials and 80 pre-capture dirtying windows, with no missing evidence. Achieved
dirtying was a median **63.14 MiB/s in Cocoon** and **63.43 MiB/s in smolvm**
against the 64-MiB/s target, using dirty-byte deltas and actual host RPC timing.
The per-window midpoint estimates ranged 62.39–63.45 and 62.79–64.30 MiB/s;
the wider RPC timing brackets are recorded, not treated as confidence intervals.

Maximum observed cgroup memory peaks were **21.76 GiB / 9.48 GiB**
(Cocoon / smolvm), below the 32-GiB cap. Smolvm's reused cgroup makes its peak
cumulative, not an isolated per-trial value. All measured OOM, OOM-kill and CPU
throttling counter deltas were zero. Peak observed whole-benchmark-root filesystem
allocation was 26.70 GiB during Cocoon trials and 10.50 GiB during smolvm trials,
below the 96-GiB sampled budget. These allocations include both runtime caches
and evidence, exclude volatile memfd RAM, and do not establish equal-contract
storage efficiency or total-memory savings. Disk use was not continuously sampled.

The [strict audit](results/2026-09-05/final-audit.json) matches all 320 driver
starts/ends to 320 unique samples across 28 groups, verifies exported artifact
hashes and detailed guest proofs, and checks all measured command logs including
retries. It found **zero invalid responses among 5,020 guest-state responses**
(2,300 Cocoon; 2,720 smolvm). RAM identity and independent branch-marker checks
passed; that remains narrower than a complete application-consistency proof.

The timing gate is closed. The [cleanup record](results/2026-09-05/final-cleanup.json)
confirms owned VM/snapshot inventories and runtime listeners were empty before
removing only the new benchmark's disposable image/build/runtime caches and its
remaining empty cgroup. It reclaimed **8.37 GiB** (8,991,055,872 bytes), retaining
source, pinned binaries, raw proofs and logs. Deleted fixtures are regenerable;
no user workspace or earlier spike root was removed. Approximately 140 MiB of
exported evidence is also retained locally.
