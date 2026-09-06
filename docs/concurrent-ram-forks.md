# Concurrent RAM forks: runtime investigation

Date: 2026-09-05. This document records the original source-level investigation.
The subsequent [parallel spike execution](spike-execution.md) now includes real
host tests; this is still not a production deployment.

## Executed follow-up

The Cocoon + Firecracker run passed the common three-way concurrent RAM/process
and independent-disk checks, network quarantine/preparation, daemon reattachment
and retained-checkpoint recovery. Guest Docker required its `vfs` backend. See
the [Cocoon evidence](../spikes/cocoon/evidence.json) for measured outcomes and
explicit untested cases. Tart's stopped-disk branches and retention also
[passed on the extra Mac](../spikes/tart-checkpoints/RESULTS.md).

The first recovery run did not independently prove backing-disk rollback.
A [subsequent focused KVM test](../spikes/cocoon/ROLLBACK_RESULTS.md) now passes
that check for a quiesced, flushed fixture: post-capture disk changes were rolled
back, verified with guest `O_DIRECT`, alongside the continuing RAM sentinel.
In-flight I/O and multi-file/database transaction coherence remain untested.

The initial [smolvm retention patch and KVM test](../spikes/smolvm/README.md)
passed the retained-disk lifecycle, but source guest exec broke after the first
eager RAM branch. A subsequent [libkrun DAX fix](../spikes/smolvm/RAM_FIX.md) now
passes all 14 concurrent RAM checks and synced-disk lifecycle recovery. The
original source-exec blocker is therefore resolved in the tested local patch,
not in an upstream release. Fresh patched checkpoints are required; other device
modes and old checkpoint compatibility remain unvalidated.
Cube's isolated execution is tracked in the execution record above.
Its [executed nested-KVM comparison](../spikes/cube/RESULTS.md) has now passed
concurrent RAM forks, independent endpoints, controller restart with a finite
no-traffic retention observation, and C/Docker workloads. It required the full
14-unit native stack. These measurements do not rank it against bare-metal
Cocoon; pre-resume identity preparation and comprehensive recovery remain gaps.

Real Codex/ChatGPT application tests are tracked in the
[separate execution report](real-agent-execution.md). Cocoon, Cube and patched
smolvm have passed the same active-tool, independent coding and conversation-continuity checks,
including explicit connection reset and later disconnect recovery. Runtime RAM
acceptance and actual agent continuation remain separate results.

## Original recommendation and current qualification

Keep Tart for macOS. The original shortlist put Cocoon first and CubeSandbox
second for Linux, before the tested smolvm correction. Patched smolvm now merits
reconsideration; do not exclude it using the earlier reproduced RAM failure.
Use Cocoon with upstream Firecracker for the first acceptance test; keep its
Cloud Hypervisor backend as an alternative if image/device requirements demand it.
Clankerbox remains the small, API-first controller in personal-cloud, with
host-local runtime supervision reached over the private network. Different
machine profiles advertise different capabilities; macOS need not support
concurrent RAM forks. Do not silently substitute a cold disk clone when a caller
requests a RAM fork.

Prefer one Linux runtime that handles both retained ordinary machines and RAM
forks. Adding Incus alongside it is not currently justified. The earlier direct
Tart/Vetu recommendation predates the concurrent-RAM-fork requirement; Vetu's
successful boot and retention tests do not establish this new capability.

The smallest runtime is not necessarily the smallest working system: adopting
something that deletes workspaces during recovery would transfer substantial
lifecycle ownership back into Clankerbox.

## Capability and ownership contract

| Capability | Linux forkable profile | macOS profile |
| --- | --- | --- |
| Retained workspace; no automatic expiry | Required | Required |
| Disk checkpoint and independent disk branch | Required | Required; stopped Tart clones are the established source path |
| Resume captured RAM/process state | Required | Optional, with Tart/Apple compatibility restrictions |
| Source and multiple RAM-derived children run concurrently | Required | Not required or advertised |
| Cross-host RAM migration | Separate, unproven capability | Not promised |

Each fork has its own machine ID, workspace ID, writable disks, network identity
and backup destination, plus a reference to its parent checkpoint. Clankerbox
owns these generic identities, not Herdr sessions or agent conversation IDs.
Shared writable host mounts and shared external databases are not automatically
forked by a VM snapshot.

Hourly workspace backup remains separate from on-demand RAM checkpoints. A
runtime or host upgrade may invalidate RAM restore compatibility without making
the workspace backup unusable. A host reboot cannot recover execution newer than
the last usable checkpoint; normal controller restart must not kill running VMs.

## Cocoon: first candidate

Audited engine commit
[`23a05603479a7552213adfb5fa25f2de7b2dbaf9`](https://github.com/cocoonstack/cocoon/tree/23a05603479a7552213adfb5fa25f2de7b2dbaf9),
which is newer than release v0.6.2. These findings must not be assumed to apply
unchanged to the release binary.

1. **Actual memory branching is implemented.** Capture pauses the source,
   saves memory/device state and writable disks, then resumes it. Children
   restore saved execution into independently named VMs. The Cocoon Cloud
   Hypervisor fork maps snapshot RAM privately: unchanged pages can be shared
   while child writes diverge. This is not a filesystem-only clone.
   [Capture sequence](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/hypervisor/snapshot.go#L59),
   [child restore](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/hypervisor/cloudhypervisor/clone.go#L166),
   [private RAM mapping](https://github.com/cocoonstack/cloud-hypervisor/blob/c314b10633189bad0a18739db8be1d1d06fe2364/vmm/src/memory_manager.rs#L3636).
2. **The existing ext4 host is functional, not necessarily fast.** Reflink
   failure falls back to a sparse disk copy. Writable disk capture occurs
   inside the source pause window, so a large, weeks-old workspace can create
   long pauses and multiply allocated storage. RAM copy-on-write does not
   require the disk filesystem to support reflinks. Keep runtime and checkpoint
   files on the same filesystem; cross-filesystem memory-link fallback has
   additional pathname dependencies.
   [Disk-copy ordering](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/hypervisor/disks.go#L49),
   [ext4 fallback](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/utils/reflink_linux.go#L23),
   [snapshot file handling](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/hypervisor/utils.go#L364).
3. **Recovery is substantially closer to the retained-machine contract.** The
   daemon adopts committed live VMM processes and does not automatically restart
   dead ones. Unfinished `creating` operations are different: reconciliation can
   kill and delete an uncommitted child. Return `ready` only after finalization,
   and reconcile interrupted API outcomes before retrying a fork.
   [Daemon adoption](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/daemon/reconcile.go),
   [unfinished-create cleanup](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/hypervisor/supervisor.go#L212).
4. **Post-fork preparation is incomplete by default.** Cloud Hypervisor replaces
   NICs while paused, but guest network repair is left to hints and entropy /
   machine-ID reset is a best-effort CLI action after resume. Calling the engine
   does not automatically run that CLI action. This does not rotate copied SSH
   host keys, backup credentials or application sessions. A fail-closed network
   gate plus synchronous guest preparation is an integration requirement, not
   an already verified feature of Clankerbox.
   [Clone CLI](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/cmd/vm/run.go#L125),
   [reseed ordering](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/cmd/vm/reseed.go#L39).
5. **Backend choice needs deliberate validation.** Cloud Hypervisor's efficient
   mmap restore requires Cocoon's VMM fork; the inspected installer downloads
   upstream CH v53.0. Hugepages/shared-memory configurations can disable that
   fast path. Firecracker is another supported backend and has native VMGenID,
   but different disk/device/network constraints. Select and pin an engine,
   VMM, kernel and guest-agent combination together, not independent latest
   versions.
   [Snapshot backend contract](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/docs/snapshots.md),
   [installer](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/doctor/check.sh#L497).

### Follow-up: quarantine hook and preferred VMM

Quarantine can be integrated without forking Cocoon. A named CNI configuration
selected through `--network` runs synchronously before clone launch. A custom
CNI-chain step can establish a fail-closed host-side gate; alternatively, a
library caller can prepare networking and install the gate before invoking the
clone operation. This is an available extension point, not a shipped policy.
[Pre-clone network preparation](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/cmd/vm/run.go#L312),
[synchronous CNI setup](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/network/cni/lifecycle.go#L279).

The gate must cover Cocoon's actual host-side veth/bridge path, all guest NICs,
IPv4/IPv6 and relevant L2 traffic. Cocoon's namespace TC redirect can bypass
assumptions based on ordinary namespace IP forwarding. Merely leaving an
interface down or adding namespace `OUTPUT` rules is not sufficient evidence.
[TAP/TC plumbing](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/network/cni/lifecycle_linux.go#L122).

Firecracker v1.16.1, commit
`2038188f145fb81b8d098147a10e9d9f392fd22f`, changes VMGenID and injects its guest
notification before resuming vCPUs. The inspected CH fork did not implement
VMGenID. This makes Cocoon + upstream Firecracker the preferred first test when
clone-time disk hotplug is unnecessary. Verify guest kernel support. Firecracker
also documents a race until the guest handles the notification; this is not a
complete userspace-identity guarantee or a replacement for quarantine.
[Restore notification](https://github.com/firecracker-microvm/firecracker/blob/2038188f145fb81b8d098147a10e9d9f392fd22f/src/vmm/src/device_manager/persist.rs#L190),
[randomness limitations](https://github.com/firecracker-microvm/firecracker/blob/2038188f145fb81b8d098147a10e9d9f392fd22f/docs/snapshotting/random-for-clones.md#L104).

## CubeSandbox: credible, larger alternative

Audited release v0.7.0,
[`d0081641c59822e4e5653b7462e914410b81910a`](https://github.com/TencentCloud/CubeSandbox/tree/d0081641c59822e4e5653b7462e914410b81910a).

1. **Real memory restoration and sharing.** Its VMM captures CPU, RAM and
   devices. Local-XFS restore maps the original snapshot RAM file privately,
   allowing children to share clean pages and diverge on writes. Shipped file
   and tmpfs demos are not enough to prove an arbitrary continuing heap/PID
   workload; that still needs a real-host test.
   [RAM mapping](https://github.com/TencentCloud/CubeSandbox/blob/d0081641c59822e4e5653b7462e914410b81910a/hypervisor/vmm/src/memory_manager.rs#L1514),
   [shared snapshot inode](https://github.com/TencentCloud/CubeSandbox/blob/d0081641c59822e4e5653b7462e914410b81910a/Cubelet/storage/local.go#L995).
2. **More infrastructure and a storage prerequisite.** Supported local
   deployment requires XFS with reflink at `/data/cubelet`; current ext4 is not
   a direct substitute. A dedicated XFS volume or loopback filesystem is
   possible without reformatting the host. The native control target includes
   MySQL, Redis, MinIO, several Cube services, proxy/DNS and UI components.
   A minimal control-only deployment in personal-cloud was not established.
   [Host requirements](https://github.com/TencentCloud/CubeSandbox/blob/d0081641c59822e4e5653b7462e914410b81910a/docs/guide/quickstart.md),
   [actual service target](https://github.com/TencentCloud/CubeSandbox/blob/d0081641c59822e4e5653b7462e914410b81910a/deploy/one-click/systemd/cube-sandbox-control.target).
3. **No mandatory lifetime limit, but recovery still needs proof.**
   `timeout: -1` supports never-expiring sandboxes. Device and guest-network
   setup is more integrated, but RNG reset still happens after execution
   resumes, without proven pre-egress application-identity handling. At the time
   of this source review neither controller-restart nor host-reboot recovery
   was executed; the later comparison establishes controller continuity only.
   [Lifecycle](https://github.com/TencentCloud/CubeSandbox/blob/d0081641c59822e4e5653b7462e914410b81910a/docs/guide/lifecycle.md),
   [restore/setup ordering](https://github.com/TencentCloud/CubeSandbox/blob/d0081641c59822e4e5653b7462e914410b81910a/CubeShim/shim/src/sandbox/sb.rs#L436).

Cube is worth reconsidering if its broader sandbox product replaces enough
Clankerbox implementation work to justify that operational footprint. Its
supported image path converts OCI root filesystems into microVM templates; do
not assume arbitrary OS/kernel import or guest Docker is already proven.
[Template contract](https://github.com/TencentCloud/CubeSandbox/blob/d0081641c59822e4e5653b7462e914410b81910a/docs/guide/templates.md).

## Other candidates and concrete reasons not to choose them now

| Candidate | Finding | Consequence |
| --- | --- | --- |
| smolvm | Real live branching, but recovery deletes VM data when a recorded running process is dead | Violates retained-workspace expectations after VMM death or host reboot |
| forkd | Real RAM branches, but controller startup kills surviving Firecracker processes rather than adopting them | Controller maintenance interrupts running execution |
| agentkernel | Full-state Firecracker support explicitly cannot reattach orphaned VMMs after a service crash | Durable supervision still needs to be supplied |
| BoxLite / Microsandbox | Inspected clone/snapshot paths restore disk state with a cold boot | Do not satisfy concurrent RAM forks |
| Incus | Stateful copy rejects a differently named destination; disk branches and same-VM RAM restore are supported | Not an established API for the required independent concurrent RAM children |

Sources: [smolvm recovery](https://github.com/smol-machines/smolvm/blob/4e4b992593b42e27484c873b2c08feb69e832c4f/src/api/state.rs#L404),
[forkd orphan handling](https://github.com/deeplethe/forkd/blob/07a1ffb1543c0f7e12719064c881ae769cf4dcec/crates/forkd-controller/src/state.rs#L305),
[agentkernel full-state contract](https://github.com/thrashr888/agentkernel/blob/2c4716443768e0323a401e256092be1ade4dabf6/docs/operations/firecracker-full-state.md),
[BoxLite clone](https://github.com/boxlite-ai/boxlite/blob/d39b0496dfdcdac282cf9425f114bf3639869aa2/src/boxlite/src/litebox/clone_export.rs#L33),
[Microsandbox snapshots](https://github.com/superradcompany/microsandbox/blob/main/docs/sandboxes/snapshots.mdx),
[Incus copy restriction](https://github.com/lxc/incus/blob/main/cmd/incusd/instances_post.go#L742).

## VM execution can fork; external reality cannot

A RAM fork duplicates cached credentials, userspace random-generator state,
open connection state and application session IDs. VMGenID can help reseed the
guest kernel; it does not reset arbitrary applications. Network/vsock connections
can break during restore. These are documented limitations, not specific to an
agent product.
[Firecracker snapshot security and uniqueness](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md#snapshot-security-and-uniqueness).

Proposed generic fork lifecycle:

1. Capture RAM and all writable VM disks consistently; resume the parent.
2. Restore each child with networking blocked before its first resumed execution.
3. Use the guest management channel to assign child identities, configure
   networking and establish new control/backup credentials. Run cooperative
   application hooks where required; do not silently restart the workload and
   call that RAM continuity.
4. Open networking and mark the child ready only when required preparation has
   succeeded. Persist the operation result before advertising completion.

Network quarantine prevents early outbound side effects, but does not by itself
make arbitrary userspace PRNG state or application identities unique. Applications
that require such guarantees need cooperation. Old tokens embedded in running
process memory are not removed merely by replacing credential files.

## Original acceptance checklist on the actual Hetzner host

This checklist guided the subsequent spikes; the linked execution reports above
distinguish completed checks from remaining work. It is not a restriction on the
eventual system's lifetime or capabilities.

1. **Process continuity:** run a process with a RAM-only random marker and mutable
   counter; capture it and concurrently run the source plus two children. Check
   the original process/marker survives and each counter can diverge. A copied
   file or a new process reading `/dev/shm` is insufficient evidence.
2. **Independent branches:** mutate each child disk and heap, test each network
   endpoint, and verify no child egress before preparation completes. Exercise
   guest Docker and an actual coding workload rather than only a minimal shell.
3. **Durability:** restart the local supervisor; stop/start a child retaining its
   workspace; delete disposable source/checkpoint references and verify children.
   Separately verify retained-checkpoint recovery after VMM loss. A host reboot
   requires its own coordinated window because the host runs other services.
4. **Cost:** measure source pause separately from first-child readiness, physical
   RAM attribution/PSS, dirty-page growth and allocated disk bytes. Use both a
   clean image and a populated workspace on ext4; compare reflink storage only
   through an explicitly scoped disposable volume, not a host reformat.
5. **Failure paths:** interrupt creation before/after finalization, reject a
   mismatched checkpoint/runtime, and test capacity exhaustion. Preserve the
   parent and last good workspace recovery point on failure; never evict them
   merely to admit a new branch.

No new product decision is needed to run this test. Filesystem provisioning,
the precise Cocoon VMM/backend and any required upstream patch remain contingent
on these results.
