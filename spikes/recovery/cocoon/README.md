# Cocoon checkpoint lifecycle recovery

Status: process-independent RAM/direct-disk recovery and ancestor-deletion lineage
passed real KVM tests on 2026-09-06. Native fresh-root restore fails its path
prevalidation, as expected; five closure faults and native gzip CRC are rejected,
and valid retry passes. Isolated copied-closure recovery passed with two
independent children and the shared evaluator. Local tests alone do not establish
recovery capability.

`host.py --prepare` copies the pinned Cocoon and Firecracker binaries into the new
private `s/bin`, appends the unchanged shared RAM workload and O_DIRECT disk probe
to a copy of the pinned Ubuntu tar, and imports one no-NIC image. This operation
creates no VM or cgroup. `--case process|lineage|native|corruption` requires the
exact coordinator grant, `execution_authorized_runtime: cocoon`, and the common
exclusive `execute.lock`. Every case uses a fresh result/artifact identifier.
SIGTERM raises into cleanup. Valid guest replies disproving RAM/disk integrity
are fatal, never readiness retries. Native detached console relays poll VMM exit
once per second; final process absence gets a bounded 10-second wait.

The private cgroup is `/sys/fs/cgroup/cqrec20260906.slice`: 32 GiB, no swap,
2048 tasks, CPUs 4–11. Every VM is 2 GiB / 2 vCPU, no NICs, with a 10-GiB sparse
COW disk. This adapter caps itself at three VM records. Retained older spike
artifacts are read-only inputs; all mutable runtime paths are under this new root.

Small exportable evidence lives in `results/RUN/{result.json,commands.jsonl}`.
Large snapshots, archives, fault copies and closure trees live in `artifacts/RUN`.
Image cache/runtime paths live in `s/`; the native fresh-store test uses `f/`.
The coordinator may export `results/`, `prepared.json`, and the adapter sources
without traversing the large artifact directories. Good closure manifests are
embedded in each result alongside their separately pinned manifest SHA-256.

1. `process`: flush direct-I/O A, capture, flush B, kill the exact source VMM by
   pidfd after checking PID birth/executable/socket/cgroup, require no originating
   VMM/control processes, then restore. Delete the source record/backing paths and
   restore a second independent child from the retained checkpoint. Both children
   must recover A and continuing RAM, then diverge in RAM and direct disk bytes.
2. `lineage`: source → child → grandchild with captured continuing state; delete
   both ancestors; verify the grandchild remains usable, recover another child
   from the deleted parent's checkpoint, and verify independent branches.
3. `native`: export a snapshot, remove the source, import into a new store at
   another absolute root, and record native restore rejection. The native archive
   contains memory, vmstate, COW and sidecar but omits immutable image/boot files.
   Cocoon rejects sidecar paths outside the new root. Import alone is not recovery.
4. `corruption`: independently copy a valid closure, inject missing memory/COW/base,
   truncated vmstate and bad sidecar, require hash/size preflight rejection before
   runtime invocation, then verify the good closure remains intact. A separate
   gzip CRC fault exercises native import rejection, followed by valid retry.

`closure.py` supplies a bounded adapter-level remedy for fixed-layout recovery:
versioned manifest, snapshot files, every sidecar readonly image/boot dependency,
and runtime/config pins. Files have recorded byte sizes and SHA-256 hashes;
copies use independent inodes and `cp --sparse=always --reflink=never`. It rejects
symlinks, path escapes, unlisted/missing members, and changed bytes against the
separately trusted manifest hash. Files and newly created directories are fsynced.
It leaves Firecracker vmstate unchanged and does not claim arbitrary relocation.

The implemented isolated recovery requires a separately reviewed mount grant:
`sudo unshare --mount --propagation private -- python3 host.py --case isolated`.
It independently copies the closure into `restores/RUN`, kills/removes the source,
removes original snapshot records, then binds the copy's `tree` onto exact `s`.
An empty directory is bound onto exact `artifacts`, hiding the original export
and good closure as well as the original runtime store. `results` is not hidden.
It checks namespace differs from PID1, private propagation, nonsymlink owned
targets, copied inode/hash identity, and absence of original-only sentinel paths.
It restores two children from copied snapshot files into fresh metadata, uses
the shared evaluator, cleans all owned processes/cgroups, then normally unmounts
both bindings. No lazy/force unmount is used. This is canonical-path unavailability
in an isolated mount namespace, not protection against a hostile privileged
process using `/proc` to escape the namespace. It is fixed-layout recoverability,
not arbitrary path relocation. Namespace execution is not enabled by the initial
preparation/VM grant. No host reboot, host-global setting, credentials,
external networking, arbitrary corrupt-memory restore or power-loss claim is made.

Local checks: `python3 -m unittest discover -s spikes/recovery/cocoon -p 'test_*.py'`:
12 tests for closure integrity, corruption rejection, inventory parsing, fatal
integrity replies, SIGTERM cleanup, namespace gates and safe unmounts. Closure
tests use small stand-in files and mocked copying; Linux O_DIRECT and KVM success
comes from actual runtime cases.

Recorded harness attempts: preparation `prepare-14646703` failed native validation
of an overlong net_scope; fixed to two characters and `prepare-990d5d71` passed.
The failed staging tree's small inputs are retained as `failed-prepare-14646703`
(its duplicate guest.tar was removed in approved bulk cleanup). First process
attempt `process-2ba83a05` failed an immediate no-control-process audit during the
native relay's polling interval; its exact empty-cgroup cleanup retry is recorded
as `prepare-71363687` (case field `cleanup-retry`). Neither is classified as a
checkpoint recovery failure. Process retry `process-7051f6cc` and lineage
`lineage-7d3cd0d4` passed, including cleanup/network/cgroup audits.
`native-ac5f590b` recorded successful import followed by explicit untrusted
absolute-storage-path rejection before VMM creation. `corruption-b672d3de`
passed all five copied-closure preflight faults, native gzip CRC rejection and
valid archive retry with continuing RAM and O_DIRECT A recovery. Temporary
damaged closure trees were removed during the case; full good closures and
archives were subsequently removed in approved bulk cleanup. Their small
metadata, hashes and raw test evidence remain; new snapshots can be generated
from the retained prepared image and runtime inputs.
`isolated-d67acf56` passed fixed-layout independent closure recovery: the shared
evaluator reports both independent restoration and sibling isolation proven,
with no findings. All original VMM/control processes were absent; original `s`
and `artifacts` contents were hidden under the two approved private binds.
Both mounts were normally removed in reverse order, the cgroup was removed,
and the namespace process exited. A separate host audit found no owned runtime
processes, cgroup or mounts and acquired/released the common lock successfully.

## Explicit bulk cleanup (completed)

`cleanup.py --plan --isolated-run isolated-d67acf56` archives small closure,
native-envelope and sidecar JSON into a new `results/cleanup-ID/evidence/` before
publishing an exact target/inode/content inventory and SHA-256 plan hash. The
allowlist contains the four recorded process/native/corruption artifact trees,
the failed preparation's guest.tar, and only explicitly named successful isolated
run artifact/restore trees. It never sweeps the root. Planning requires the global
execution slot and namespace grant closed, no Cocoon processes/cgroup/mounts, and
the common lock.

Deletion requires a separate coordinator approval in
`authorization.json:cocoon_cleanup_plan_sha256`, then
`cleanup.py --execute /exact/results/cleanup-ID/plan.json --plan-sha256 HASH`.
It rechecks every target and archived evidence, logs byte counts and each exact
deletion, rejects symlinks/hardlinks and changed identities, and deletes relative
to verified directory descriptors. Results, pins, scripts, private runtime/tools,
and the reusable sub-GiB prepared image/boot cache are retained. Five additional
local tests cover target expansion, symlinks, active state, metadata preservation
and inode/content changes (17 tests total).

Approved plan `results/cleanup-3983b2b5/plan.json`, SHA-256
`b0560bc3b56ee3c4579922adf0a5d3d9639e8bf2c19ef140ba162f9a48f85bbc`,
was executed successfully after separate coordinator hash approval. All seven
targets were removed: target-accounted allocated bytes decreased from
20,040,982,528 to zero (18.66 GiB). This is not a measured host-wide free-space
delta. All 28 archived metadata files remain, along with results, pins, tools,
runtime binaries and the prepared image/boot cache. The retained binaries,
configuration, erofs and boot files were rehashed against the archived closure
manifest and all matched. No owned processes, cgroup or mounts remained; the
common lock was independently acquired and released. Small metadata is in the
plan's `evidence/`; execution records are `deletion.jsonl` and `cleanup-result.json`.
Deleted full checkpoints are not recoverable from metadata alone; fresh test
checkpoints can be recreated using retained inputs. Smol and older roots were
not modified by this cleanup.
