# Cocoon latency adapter

`cocoon.py` uses retained Cocoon commit `23a05603479a7552213adfb5fa25f2de7b2dbaf9`,
Firecracker v1.16.1, and exact Ubuntu rootfs SHA256
`0a64e8ef15c93ff146f10729750955a4b4a1938293260cbf983d99b5466c99ed`.
It hashes the retained binaries and rootfs before prepare and each execution block.
Prepared image hashes and shared static guest hash are retained in `prepared.json`.
This document describes the harness; it does not claim that measurements passed.

1. Root coordinator creates `authorization.json` in the benchmark root with `grant`,
   `cocoon_root`, `cocoon_cgroup`, `lock_path`, and `timing_authorized: false`.
   The `cocoon` subdirectory and shared `measure.lock` must exist.
2. Run `python3 cocoon.py --root EXACT/cocoon --grant latency-20260905
   --lock EXACT/measure.lock --guest EXACT/shared/latency-guest --prepare`.
   Preparation imports four images once, without booting a VM. Private dependency
   downloads are checksum verified and extracted only beneath the new run root.
3. Coordinator opens the timing gate, then invokes the same common arguments with
   `--run-case cold|warm|fresh|fanout1|fanout4 --variant idle|resident|dirty|workspace
   --repetitions N --block ID --trial-offset N`. Every case holds the same nonblocking
   exclusive flock throughout; a competing runtime causes refusal, not overlap.

All VMs use 4 GiB RAM, 2 vCPUs, a 10-GiB sparse writable disk, and zero NICs.
CPU affinity and Cocoon's cgroup fence both restrict work to CPUs 4–11. A private
32-GiB cgroup limits Cocoon CLI/VMM descendants, with swap disabled and a 2048-task
limit. The parent CPU quota is unlimited (`max 100000`); affinity caps the pool at
eight cores. Disk checks include both runtime subdirectories against 96 GiB allocated.
The pinned CLI requires a finite per-VM CPU quota, so each VM requests
`800000 100000` with zero burst. Inspection records exact per-VM controls and
`cpu.stat`; absence of effective throttling requires unchanged throttle counters.
No host service, sysctl, package installation, cache drop or network change occurs.
VM inspection ties name, ID, socket, executable, cgroup, PID and process starttime.
Children are removed before sources and snapshots; cleanup errors retain the
original trial failure and record remaining objects. The derived cached images
remain between blocks for coordinator final cleanup.

The image appends the identical static C workload and a systemd service. Guest
Docker, Docker socket, containerd and network wait-online services are masked.
Cocoon still boots systemd and its vsock agent; smolvm's startup architecture is
different. Shared workload profiles are 64-MiB idle, 1024-MiB idle resident,
1024-MiB with 64 MiB/s dirtying,
and 1024-MiB with a synced 2-GiB workspace in 1024 files. `--reuse-workspace` verifies
and reuses those files during same-disk starts; cold boots populate them afresh.
The workspace is `/var/tmp/clanker-latency-workspace`; mountinfo/statvfs checks reject
RAM filesystems. The guest service removes only its exact stale management socket
before starting after a disk reboot.

Raw `samples.jsonl` retains every repetition and `commands.jsonl` retains wall and
monotonic start/end, exit status, stdout and stderr for every Cocoon command.
No credentials or model calls occur. Host proc-stat/PSI and cgroup CPU/memory/I/O
snapshots bracket each trial. Successful `true` and full shared workload status
are polled concurrently with 15-ms sleep between attempts after CLI return.
Thus readiness is an upper-bound observation from the management path; it does
not establish the earliest instant the guest was ready during the CLI command.
The shared status touches a sentinel on every RAM page and verifies its disk marker.

Cold excludes image import and cache removal; warm writes and fsyncs branch 91,
then stops and restarts the same writable disk. Its successful status must retain
disk branch 91 and report a new RAM marker; preparation and proof checking are
outside the measured start-to-ready interval. Fresh takes a new source capture for child 1 and another capture
for child 2, reporting each capture-through-prepared-child total separately.
Each fanout trial cooperatively pauses dirty writes, captures once and restores
1 or 4 children from that snapshot. Each child prepares immediately when its own
readiness probe succeeds, then resumes writes before its preparation endpoint.
The source resumes only after all children have prepared. Fresh single-child captures keep dirty writes active.
it reports capture-through-all-prepared and clone-only-through-all-shared-ready.
Branch preparation changes only shared workload RAM and its fsynced disk marker,
because there are no NICs or external sessions to prepare.

Every restored child must retain source workload PID, start time, RAM marker and
checkpoint branch. Distinct host VMM identities plus child-specific RAM/disk branch
mutations, sibling rechecks and unchanged source state prove independent continuing
workload state. Shared marker version 2 stores a fixed 128-byte record. Each mutation
uses `pwrite` at offset zero and `fsync` on the existing file, preserving its inode
and size without rename or truncation. This exercises writes to a file inherited
from the snapshot. This is a quiesced marker-file and RAM test, not general
transactional disk consistency or host-power-loss durability. Disk reads use the
guest page cache.

Snapshot command time is never called source pause. A read-only Firecracker `GET /`
observer samples state at 10 ms and records conservative observed bounds when it
sees `Paused` bracketed by `Running`. A missed pause is reported as unobserved,
not zero. Shared heartbeat metrics are reset, a one-second baseline is collected,
and a second reset separates baseline maxima from capture maxima. Capture-only and
source-postfork workload metrics accompany capture. The immediate post-capture
status probe runs concurrently with child creation and readiness, with explicit
probe timestamps. Observer joining and probe completion
are checked after child preparation's timing endpoint. Guest heartbeat stalls
may omit hypervisor-paused time depending on virtual clock behavior and include
scheduling or probe effects; the Firecracker observer supplies separate evidence.

Offline checks: `python3 spikes/latency/test_cocoon.py` and the same command with
`PYTHONOPTIMIZE=1`. Runtime results and any limitations remain in the coordinator's
report after actual execution.
