# RAM checkpoint lifecycle and independent recovery

Status: complete on 2026-09-06, including independent evidence review, disposable
payload cleanup and final host audit. See the [measured results and limits](RESULTS.md).
No production service, real host reboot, host-wide setting change, or login-token
copy is part of this run. This expands the capability evidence; it does not add
a lease or lifetime restriction to Clankerbox machines.

## Questions and acceptance boundaries

1. Can existing live RAM children continue after their source process dies, and
   can a restored child become the source of another generation?
2. Can a checkpoint recover the original RAM identity and flushed workspace
   state after every originating VMM/control/guardian process is gone?
3. Is the exported artifact self-contained, or does restore depend on the old
   runtime store, absolute paths, live file descriptors, or image cache?
4. Can multiple independent restores diverge safely, retaining useful descendants
   after ancestor deletion?
5. Do malformed/incompatible artifacts and bounded interrupted operations fail
   without damaging a good checkpoint, live source, or retained workspace?

Process-independent recovery is not the same claim as surviving physical power
loss, a real host reboot, another CPU model, or another runtime version. A private
mount-namespace recovery at preserved absolute paths is not arbitrary relocation.
Report these capabilities separately. Existing Tart stopped-disk branching and
recovery evidence remains in ../tart-checkpoints/RESULTS.md; macOS concurrent RAM
forking is not a requirement and is not being retested here.

## Ownership and host isolation

| Owner | Local files | Remote private subtree |
| --- | --- | --- |
| Cocoon worker | cocoon/ | cocoon/ |
| smolvm worker | smolvm/ | smolvm/ |
| Shared-probe worker | shared/ | No remote execution |
| Coordinator | This document, authorization, integration/audit | Shared files and execution gate |

Exact new root: `/home/clanker/clankerbox-recovery.AsnzhP`, UID 1000, mode 0700.
Earlier spike roots and the original local smolvm checkout are read-only inputs.
The repository is already untracked; preserve all unrelated files and the canvas.

Both workers may prepare private source/build/image inputs concurrently. Each
runtime case requires a coordinator slot and the common exclusive `execute.lock`.
Runtime CPU affinity is 4–11; builds use 0–3 with at most four jobs and 8 GiB each.
Runtime limit is a private 32-GiB cgroup, swap disabled, at most five 2-GiB/2-vCPU
guests. Disk usage is checked against a 128-GiB total-root budget; it is not a
continuous quota. No external guest NICs, public management listeners, host
mounts inside guests, global installs, sysctl edits or network changes.

Fault injection may target only the exact disposable runtime's identity-verified
PIDs and copied artifacts. Prove PID birth, binary/config path, UID and cgroup
before signaling. Never kill by process name. Keep valid checkpoint copies and
all failed-attempt logs. No destructive mutation of original source fixtures or
earlier spike results. Mount namespaces require a separate reviewed exact plan;
mount propagation must be private and nothing may escape the test namespace.

## Runtime inputs and test semantics

Cocoon reuses the previous pinned binary/Firecracker/Ubuntu rootfs. smolvm tests
the newer local source at `8a571dce742a15631315ee6b386e5bae8f5af7ea`, plus a
recorded copy of its existing uncommitted libkrun changes. Its original checkout
must not be modified. Record the private source/archive/patch and binary hashes.
These results do not retroactively change the older latency build's contract.

Smolvm's host-backed image profile was rejected by native portable-capture
validation. The successful `ubuntu-bare-v1` profile bundles the same pinned
Ubuntu userland and matching agent in a disk-backed bare VM; its full input tree
is separately hash-pinned. No native validation was bypassed. Cocoon's recovery
adapter carries the full dependency closure at the expected original path layout.

Reuse the unchanged static latency workload for RAM-only nonce, guest PID/start,
page sentinels and branch independence. Add a separate fixed-size direct-I/O disk
probe: flush A, capture, flush B in the source, restore and read A through
`O_DIRECT` without post-restore writes. Missing direct-I/O support is an explicit
failure/limitation, never silently replaced with buffered reads. This establishes
quiesced file rollback, not arbitrary database/in-flight transaction consistency.

Artifact portability tests must record file hashes and independent storage
copies, absence of all originating runtime processes, unavailability of original
runtime paths, and the exact destination configuration/dependencies. No credential
or real-agent session portability claim follows from the synthetic workload.

## Completion

Publish a capability matrix with PASS, FAIL, NOT RUN and any adapter-only support.
Retain failed attempts, input pins, commands, checks and cleanup evidence. Remove
only this run's disposable VMs, artifacts/build caches and runtime objects after
export and verified ownership; preserve reusable source/binaries and results.
Close the execution gate on completion.

Completed run: both runtime/mount execution gates and cleanup grants are closed.
Exact approved disposable payload/build-cache targets were deleted only after
evidence export. Retained runtime/image/source pins and metadata remain available;
deleted synthetic RAM/disk payloads require rerunning the tests to reproduce.
