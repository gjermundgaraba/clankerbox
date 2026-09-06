# Patched smolvm latency adapter

The adapter is scoped to `/home/clanker/clankerbox-latency.RPxPe6/smolvm`,
grant `latency-20260905`. It uses an optimized private build of the previously
tested patched smolvm source and the exact previously tested libkrun and guest
agent. The agent rootfs is privately copied because upstream writes per-VM
readiness markers there; the old rootfs remains untouched. The OCI workload
rootfs is the same Ubuntu tar used by Cocoon, SHA-256
`0a64e8ef15c93ff146f10729750955a4b4a1938293260cbf983d99b5466c99ed`.
Image extraction and static shared-workload installation happen before timing.
There are no credentials, model calls, guest NICs, host ports, or additional
host-workspace/credential mounts; runtime-managed image backing remains part of
smolvm's implementation.

The private CLI release build completed in 11m34s using the existing offline
Cargo cache, one build job, CPU affinity 0–3 and a 4 GiB virtual-memory limit.
`CARGO_PROFILE_RELEASE_LTO=false` and
`CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16`; all outputs use the fresh private
`build-target`. CLI SHA-256 is
`4a99103546b32c1a96b874d487e3ebdbcdab0cfbf8710b7e1818473436e937d4`.
The exact copied guest-agent SHA-256 is
`06ca71089f5103ff3a7cf73bcfc8b4346150f1607127bf28d0b286b75f1cf93b`.

## Invocation and output

Run one independently cleaned trial at a time:

```sh
sudo -n -u clanker -g kvm -- taskset -c 4-11 python3 \
  /home/clanker/clankerbox-latency.RPxPe6/smolvm/smolvm.py \
  --root /home/clanker/clankerbox-latency.RPxPe6/smolvm \
  --host-slot latency-20260905 --profile idle --case cold --trial 0
```

Profiles: `idle` (64 MiB), `resident` (1024 MiB clean), `dirty` (1024 MiB,
64 MiB/s writer), `workspace` (1024 MiB clean plus 2 GiB/1024 synced files).
Cases map to the common coordinator
schema as follows:

| Adapter case | Common case | Action |
| --- | --- | --- |
| cold | cold | Cached local image, fresh disk/VM, first exec and shared status |
| warm | warm | Cold setup, mutate disk marker, stop, same-disk start |
| live-second | fresh | Two sequential fresh captures of the same continuing source |
| batch-1 | fanout1 | One cooperative boundary, one capture, one child |
| batch-4 | fanout4 | One cooperative boundary, one capture, four parallel children |

`live-first` is a focused first-capture diagnostic, not the full repeated-capture
case. Each trial writes `results-PROFILE-CASE-TRIAL/report.json`, command JSONL
with host monotonic start/end timestamps, guest identities/status, copied VMM
logs, and a row to `samples.jsonl`. Trial numbers must be unique for a case and
profile; the adapter refuses to overwrite an existing output directory.

`authorization.json` must have `timing_authorized: true`. The whole measured
process holds the shared `measure.lock` and requires exact CPU affinity 4–11.
Every guest requests 4096 MiB and 2 vCPUs; at most source plus four children.
The runner and all inherited VMM processes join the exact private cgroup
`/sys/fs/cgroup/smlat20260905.slice`: 32 GiB memory, no swap, 2048 tasks, cpuset
4–11, and no CPU quota. Root `--prepare-cgroup` records its inode/device in a
root-owned marker and only reuses that proven group; `--close-cgroup` requires
matching identity/limits, no processes or child groups, and no scoped VMMs.
Before-start, live-before-cleanup, and after-cleanup host PSI, cgroup usage/events
and common-root allocation are saved. Cgroup snapshots also include `cpu.stat`,
`cpu.pressure`, `io.stat`, `memory.pressure`, and `io.pressure`. Smolvm's
`memory.peak` is cumulative across the persistent cgroup's lifetime, including
earlier trials; it is not a per-trial peak. Live and final allocated disk usage must
remain within 96 GiB. Preflight/input/resource errors produce failed sample rows
and execute cleanup; later cleanup/resource errors preserve the original failure.
Cold/request timing starts before create, warm/request timing before start;
image preparation and warm setup are excluded. CLI return, first `/bin/true`
exec, and valid shared-workload status are recorded separately. First exec and
shared status run concurrently after CLI return. The workload endpoint and child
preparation do not wait for the first-exec probe to finish; a failed exec still
invalidates the trial.

## Batch boundary semantics

Pinned source `src/cli/machine.rs::ForkCmd::run` dispatches `--count 1` through
the single-child path, so fanout1 explicitly adds `--wait-ready`. Count4 uses
`--count 4 --name-prefix PREFIX --parallel 4 --wait-ready`. The actual
`src/cli/vm_common.rs::fork_vm_batch` calls `prepare_forks` exactly once, boots
children with bounded concurrency, installs child identity/environment, commits
their Running records, then releases all inherited helper barriers. It does not
perform four fresh captures. The upstream CLI maximum is 1024; this experiment
allows only 1 or 4. Batch children cannot themselves be branchable and cannot
have pinned port mappings. No retained-checkpoint refill is claimed here.

The shared C process starts once before the boundary. The adapter pauses its
dirty writer, invokes the real `/usr/local/bin/smolvm-branch-ready` helper in a
separate inherited shell, and waits for the official generation marker. The
helper parks that shell while the C heartbeat remains active. Restored helper
release publishes a local release marker and leaves the existing C writer paused.
Shared-ready child status requires this marker and the inherited C PID,
process start timestamp, RAM marker, RAM branch and disk branch. Fully prepared
latency ends after the child applies its independent branch mutation and resumes
its writer if paused. The release-marker check shares the status guest RPC; it
adds no separate guest exec. The
shared-ready and first-exec endpoints are retained separately. Source status is
sampled in parallel with child probes immediately after branch CLI return, and
again after all child preparation/inspection completes.

The source's helper is not automatically released by upstream. After child
readiness and source heartbeat observation, the adapter writes the official
generation-addressed release token in the source's private forkpoint directory,
allowing its existing shell to leave the barrier, then explicitly resumes the
source writer. Thus the source writer stays paused until all children finish
preparation. Cooperative writer pause and
helper setup are reported separately as `fanout_cooperative_setup_ms`.

## Timing limits and cleanup

The `golden RAM checkpoint written elapsed_ms=...` log measures the control
request/reply interval after source filesystem sync and disk-generation setup.
It is labeled backend capture time, not exact source pause. The adapter requires
exactly one such capture log per branch call and preserves the full command log.
Child restore is not separately measurable from existing public CLI readiness;
that metric stays null. Guest heartbeat maximum gaps measure guest-observed
stall, including scheduling and clock behavior, not exact vCPU stop duration.
Host caches are retained; these are cached-image boots, not cache-cold boots.
Before each capture the heartbeat metrics are reset, observed for one second,
saved, then reset again immediately before the branch request.

Warm boots use the same disk and `--reuse-workspace`: existing payload sizes and
metadata are verified and branch marker retained while the RAM process/marker
are freshly created. Branch isolation is checked by distinct mutations after
all branches are ready and final reads only after all mutations finish.

Cleanup deletes children before source. Before destructive runtime commands,
the observer validates exact optimized executable, UID 1000, `_boot-vm` argv
under the fresh XDG root, and recorded PID birth. Hardened process inspection
uses the specifically authorized read-only sudo observer in this same script.
Inventory checks include inherited snapshot guardians with the same executable
and boot config. No old runtime database, directory, or PID is a cleanup target.
Any remaining process/record or failed cleanup changes the trial to failure.
