# Spike execution

Status: seven workstreams implemented and scoped runtime experiments completed
2026-09-05; owned runtime resources cleaned up. No production service was
deployed. Existing Mac and Hetzner services and original VM inventory are
preserved. Unexecuted checks are listed explicitly below.

Integrated local suite: **43 tests PASS**, including a full rerun with
`PYTHONOPTIMIZE=1`. The smolvm patch also passed its separate 23 native Rust
checks. Those local checks are distinct from the host execution results below.

## Ownership and parallelism

| Workstream | Owner/surface | Owns | Execution |
| --- | --- | --- | --- |
| smolvm retention and RAM forks | Herdr `cb-smolvm` (`wJ`), then fix worker/coordinator | `spikes/smolvm/` | Initial RAM failure reproduced and fixed in libkrun; patched three-way acceptance and synced lifecycle PASS; see RAM_FIX.md |
| Cocoon + Firecracker and fork preparation | Herdr `cb-cocoon` (`wK`) | `spikes/cocoon/` | PASS: concurrent parent + two RAM children, quarantine/preparation, retention and checkpoint recovery; owned runtime/network resources cleaned |
| Shared RAM/process acceptance kit | `spike_acceptance` leaf worker | `spikes/acceptance/` | Implemented; 3 local integration tests passed, independently rerun |
| CubeSandbox | Herdr `cb-cube` (`wM`) | `spikes/cube/` | PASS: nested-KVM RAM forks, distinct runtime identities/endpoints, controller restart, 360-second idle retention and C/Docker workloads; complete owned host scope removed |
| Storage, lineage and backup recovery | coordinator | `spikes/storage-recovery/` | PASS: real Linux ext4 copy/XFS reflink lineage and ancestor deletion; local restic restore; image/mount cleaned |
| Private controller path | coordinator | `spikes/control-path/` | 8 local tests and real SSH fixture retry/reconstruction passed; production VPN NOT RUN |
| Tart checkpoints | Herdr `cb-tart` in `cb-tart-checkpoints` (`wN`) | `spikes/tart-checkpoints/` | PASS: real stopped-disk branches/recovery/SSH identity; 6 local tests; owned VMs cleaned |

The acceptance and fork-preparation workstreams jointly cover the real-agent
forking spike. A synthetic RAM sentinel or fake provider is not evidence that an
actual coding agent preserves its application session correctly; report that
separately and never use real copied credentials for an uncontrolled experiment.

## Shared rules

1. Workers are not alone in the codebase. Edit only owned directories; preserve
   existing files, the canvas and other workers' edits. Do not commit, deploy
   production services, edit personal-cloud, install global packages or change
   system-wide configuration without coordinator review.
2. Source checkouts/build artifacts belong in each owned `.work/` directory or a
   private `mktemp` directory. Pin revisions and record commands and test results.
   Keep credentials, images and large outputs out of source control.
3. Local source changes and process tests may run concurrently. Hetzner host-wide
   mutation is serialized by the coordinator; separate Herdr workspaces do not
   isolate the remote kernel, firewall, CNI bridges, storage or runtime defaults.
   Read-only SSH inspection is allowed. Request an execution slot with exact
   files, network objects, memory/disk budget, privileges and cleanup plan.
4. Use disposable, uniquely named machines only. No host reboot, host filesystem
   reformat, firewall flush, deletion of existing VMs, or exposure of management
   ports publicly. A real host-reboot check needs a separately agreed window.
5. Report PASS, FAIL or NOT RUN for each check. Local/model tests do not establish
   KVM behavior. Implement runnable checks and execute all safely available ones;
   record actual blockers rather than inventing successful results.

## Baseline and gates

Reviewed parallel exception: smolvm's non-root, no-network KVM run can overlap
Cocoon's private CNI/TC run because their paths/processes are disjoint and their
combined memory budget is below host capacity. Cocoon alone owns host network
changes. Performance measurements during overlap are not isolated benchmarks.

Cube's reviewed isolation uses a disposable outer Ubuntu VM in a private,
capability-dropped QEMU container with only the KVM device and owned scratch
storage. The host's existing nested-KVM setting is enabled. The native Cube
installer, XFS formatting and service/network changes run only inside that VM.
Host forwarding is loopback-only; no Docker-published ports or host firewall
changes are permitted. Its nested/contended timings are not bare-metal benchmarks.

Every Linux candidate should eventually run one source plus two concurrent RAM
children. Verify the same inherited RAM-only marker and continuing process,
independent memory/disk mutations, management/network separation, and real guest
build/Docker workloads. Measure source pause separately from child readiness.

Retained workspaces have no TTL. Runtime or control-process failure cannot
authorize disk deletion. Forks get separate workspace and backup identities.
Hourly workspace backups are distinct from RAM checkpoints.

The coordinator owns integration, shared documentation, host slot grants,
capacity admission and the final evidence table. Native and Herdr workers are
leaf workers and must not create additional agents.

## Evidence and handoff

1. [Cocoon results](../spikes/cocoon/RESULTS.md): real concurrent RAM/process
   forks, independent disk writes, quarantine, restart and checkpoint recovery.
   Docker's default overlay backend failed; the tested `vfs` configuration passed.
2. [Cube results](../spikes/cube/RESULTS.md): nested-KVM RAM forks, separate
   endpoints, controller continuity, 360-second idle observation and C/Docker
   workloads passed. This uses the complete 14-unit native stack inside an outer
   VM; no bare-metal performance ranking or general disk-recovery claim.
3. [smolvm results and proposed patches](../spikes/smolvm/README.md): retained
   workspace recovery passed; the initial eager RAM-branch failure was later
   fixed in bundled libkrun. [The follow-up](../spikes/smolvm/RAM_FIX.md) passes
   all 14 RAM checks and the synced lifecycle test. Older checkpoints and other
   device modes are not covered by that result.
4. [Tart results](../spikes/tart-checkpoints/RESULTS.md): stopped-disk checkpoints,
   independent branch identities and cold recovery passed. No Mac RAM-fork claim.
5. [Storage/backup](../spikes/storage-recovery/README.md) and
   [control-path fixture](../spikes/control-path/README.md): real ext4/XFS
   file-level lineage, local restic restore and actual SSH delivery/retry passed.
   The control fixture is not a deployed Clankerbox service.

The [shared acceptance kit](../spikes/acceptance/README.md) provides one RAM-only
marker workload and evaluator reused by the runtime workers. Root independently
reevaluated both Cocoon and Cube's retained evidence: all 14 common VM checks
passed for each. Fixtures and control delivery remain separate from real runtime
evidence; sharing the kit keeps each runtime harness focused on its adapter.

Cube's actual nested-KVM run has now passed all 14 shared VM checks plus separate
HTTP endpoint checks. Root independently recomputed the common acceptance result.
Its identity mapping verifies each sandbox's own shim/VMM process, start time,
bundle and live KVM VM/vCPU descriptors; a global process count is insufficient.
Controller restart, 360 seconds without guest requests, and real C/Docker build
and container execution have also passed. Its owned guest VMs, checkpoint,
outer VM/container, runner images, disks, keys and entire private host directory
were removed. Root independently checked that the labeled container, loopback
listener and transient host netns are absent.
Nested, differently provisioned timings are not bare-metal performance comparisons.

Independent review confirmed Cocoon's process continuity and operation ordering.
Its checkpoint test restores RAM and guest-visible state, but did not mutate the
backing disk after capture or bypass restored guest page cache. Point-in-time
backing-disk rollback and RAM/disk coherence are therefore not independently
proven by that run. Child-a's separate cold-boot disk retention did pass.

A focused follow-up under `cocoon-rollback-20260905` subsequently **passed**:
one 2 GiB/2-vCPU no-NIC VM, the same pinned rootfs/binaries, flushed checkpoint
contents, different flushed post-capture contents, and direct-I/O reads after
restore. It restored backing bytes and the original RAM counter/marker together.
See [separate executed results](../spikes/cocoon/ROLLBACK_RESULTS.md) and
[completed evidence](../spikes/cocoon/rollback-evidence.json). No host cache or
global configuration changes were made. The initially exiting control process
caused a conservative cleanup stop; the final audit confirms no owned VM,
snapshot, process or cgroup remains. In-flight I/O, multi-file/database transaction
coherence and host power-loss durability remain untested.

The initial experiments used no current user login tokens.
Production personal-cloud deployment/WireGuard, host reboot, interrupted-clone
fault injection, capacity exhaustion and broad compatibility/performance coverage
remain separate unexecuted checks. None imposes a lifetime limit on machines.

### Retained scratch data

The completed runtime tests removed their owned VM disks/processes and ephemeral
network resources. Small evidence and reusable private build inputs remain:

| Host | Retained path | Purpose |
| --- | --- | --- |
| Hetzner | `/home/clanker/clankerbox-smolvm.Jf1bpB` | Approximately 6.8 GiB of pinned builds, rootfs and logs; no owned VMM/guardian or VM disk directories |
| Hetzner | `/home/clanker/clankerbox-cocoon.b0ngM6` | Approximately 887 MiB, chiefly the exact tested guest rootfs, private binaries and evidence |
| Hetzner | `/home/clanker/clankerbox-storage.hGbRSB` | Two root-owned JSON reports; XFS image and mount removed |
| Hetzner | `/home/clanker/clankerbox-storage-tools.W7OeJa` | Small private runner copies |
| Extra Mac | `/Users/example/clankerbox-tart-checkpoints.M67Mef` | 72 KiB evidence; no VM disks or disposable private keys |

Cube's `/home/clanker/clankerbox-cube.TqWZtL` was removed completely after
exporting its evidence locally. Its tested VM disks and disposable keys are
deleted, not retained recovery points; the reproducible inputs and logs remain
in `spikes/cube/`. The storage fixture image and Tart test VM disks were likewise
intentionally deleted. No preexisting user VM or workspace was a cleanup target.

Local `.work/` build trees and `results/` are ignored by Git. Herdr workspaces are
left open for inspection. The repository still has no commits; workstreams use
separate owned directories and private upstream checkouts, not Git worktrees.
Existing files and the canvas were preserved.
