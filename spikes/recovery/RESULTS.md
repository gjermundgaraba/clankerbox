# Recovery capability results — 2026-09-06

Status: complete. Recovery/lifecycle tests, independent evidence review, local
checks and final cleanup/host audit finished on 2026-09-06. The limitations below
remain explicit; no production service was deployed.

## Completed Cocoon checks

| Capability | Result | Evidence |
| --- | --- | --- |
| Two independent RAM/flushed-disk restores after origin process loss and source VM deletion | PASS | process-7051f6cc |
| Descendants checkpoint; grandchild survives ancestor deletion; deleted parent's checkpoint remains useful | PASS | lineage-7d3cd0d4 |
| Native export/import into an arbitrary fresh store | FAIL capability; expected-negative test passed | native-ac5f590b |
| Five malformed closure members rejected; native gzip CRC rejected; valid retry restores | PASS, adapter preflight + native archive checks | corruption-b672d3de |
| Complete copied closure restores twice with original store/artifacts hidden | PASS, fixed-layout adapter | isolated-d67acf56 |

All completed successful cases passed runtime cleanup, empty-cgroup removal and unchanged
network checks. They use 2-GiB / 2-vCPU no-NIC guests and a 64-MiB RAM workload.
The direct disk probe distinguishes captured/flushed A from later/flushed B with
Linux `O_DIRECT`; restored guest page cache alone cannot satisfy that check.

Native export/import preserves absolute storage dependencies. Import succeeded in
a fresh store, but clone refused the original EROFS path as outside its trusted
store. That is a native portability limitation, not corrupted RAM. The process
case intentionally reports `source_paths_unavailable=false`; it proves surviving
source deletion, not an independently relocated artifact. The lineage case saved
a grandchild checkpoint but did not restore that final checkpoint.

The separate isolated case passed the strict shared evaluator with both
`independent_restore_proven=true` and `sibling_isolation_proven=true`. It used
independently hashed, non-reflink copies of the snapshot and dependencies. A
private mount namespace exposed only the copied store at the expected absolute
path and hid the original snapshot artifacts. Source processes and records were
gone before restore. Both bindings were normally unmounted after guest cleanup;
the final audit found no owned host mounts, processes or cgroup.

## Recorded preparation and harness fixes

Cocoon's first preparation used a three-character `net_scope`; native config
validation requires two. It was corrected before any VM launch, with the failed
attempt retained. The first process-loss attempt then caught an asynchronous
native console relay outliving the VMM briefly. It exited itself; the corrected
harness waits for every originating control/VMM process, and the independent
cleanup-recovery record verifies removal of the empty owned cgroup. Neither
attempt is relabeled a successful runtime trial or a snapshot-recovery defect.

Both adapters were hardened before successful acceptance: SIGTERM enters cleanup,
actual runtime input hashes are checked, and valid integrity-failure responses
cannot be hidden by readiness retries. The Cocoon closure helper rejects changed,
missing, unlisted or redirected files before launching a VMM.

Smolvm attempts `portable-01` and `portable-02` exposed harness assumptions about
its transient boot-config file and kernel dummy interface. Both were corrected
with regression tests and all owned VMMs cleaned up. `portable-03` then reached
a genuine native restriction: portable capture rejects host-backed image layers.
The successful next attempt uses a separately pinned, supported bare-VM Ubuntu
profile with its own disk and bundled agent rootfs; it does not bypass profile
validation.

## Completed smolvm core check

`portable-04` passed native portable capture and two independent restores using
`ubuntu-bare-v1`. The 523,225,925-byte artifact was copied twice, then the source
VMM/guardians were terminated and the source XDG/image/rootfs tree and original
artifact pathname were hidden. Both restores continued the saved guest RAM
identity and heartbeat, read captured/flushed A rather than later/flushed B via
`O_DIRECT`, and diverged independently into RAM/disk branches 101 and 102. The
strict shared evaluator and final runtime cleanup passed.

This uses smolvm commit `8a571dce742a15631315ee6b386e5bae8f5af7ea`, the recorded
existing libkrun patch, and a new private parent-directory-fsync publication
patch. The original checkout/build inputs were preserved. See
[build pins](smolvm/BUILD_RESULTS.md). It is not the earlier latency build. The
portable profile is constrained by native runtime/device/CPU compatibility; on
this AMD host the CPU contract is an exact fingerprint.

The coordinator's exported-evidence audit now passes all six core cases, checking
10 exported binary paths, profile-manifest consistency, raw journals and the
strict recovery proofs.

## Extended smolvm results

| Capability | Result | Evidence |
| --- | --- | --- |
| Corrupt/truncated artifact and incompatible runtime ABI rejected; good same-name retry works | PASS, native checks | full-01 |
| Restored VM can fork; child checkpoints after ancestor process death; grandchild recovers RAM/disk 201 | PASS | full-01 |
| Cold restart of a recovered VM retains mutated workspace/disk 102 with original source paths absent | PASS; new RAM identity as expected | full-01 |
| Existing volatile RAM children survive source SIGKILL; new fork from dead source fails | PASS, including final all-sibling RAM/disk sweep | full-01 + volatile-final-01 |
| Checkpoint CLI killed during native RAM save | Source remains paused; explicit reconciliation succeeds | interrupted-01 |

The cold-restart check is intentionally different from RAM restoration: it
requires a new RAM nonce/start time while retaining the previously mutated disk.
Lineage removes ancestor **processes**, not all ancestor disk backing files while
live volatile descendants still depend on them. Clankerbox must track those
dependencies before garbage collection.

The independent audit found that `full-01` reread both children's disks after all
mutations but lacked a final all-sibling RAM sweep. `volatile-final-01` closes
that gap in a separate recorded run: final RAM and direct-disk reads for both
branches 301/302 follow the common mutation barrier, preserve the inherited RAM
identity and show advancing heartbeats. The original run's evidence is unchanged.
See the [supplemental independent review](shared/SUPPLEMENTAL_REVIEW.md).

`interrupted-01` killed the identity-verified checkpoint CLI while
`memory.bin.partial` had appeared (observed length zero: SAVE staging had begun).
Native `STATUS` then returned `OK paused` about 247 ms after confirmed CLI death.
It had **not automatically resumed before the adapter intervened**. The adapter
recorded that state before sending `RESUME`; the original RAM identity and direct
disk A survived, no final interrupted artifact was published, and a good
checkpoint capture retry succeeded. That retry artifact was not restored in this
case, and no long autonomous-resume wait was performed. This is a tested
reconciliation path, not an automatic native guarantee or a production service
implementation.

## Architectural conclusion

The current pinned smolvm build is a strong default for Linux/headless forkable
machines; Tart remains the macOS path. Cocoon is also viable, but independent
recovery needs our complete dependency bundle and a preserved path layout.
The older statement that smolvm RAM snapshots are necessarily tied to a live
source process does **not** describe this newer portable checkpoint path.

1. Expose separate capabilities for retained disks, live RAM forks and portable
   RAM checkpoints. Do not silently cold boot when a requested RAM fork is lost.
2. Use a supported disk-backed smolvm image profile for checkpointable machines.
   Host-backed image layers, forwarded host resources and incompatible CPU/runtime
   profiles must fail explicitly; the tests did not remove native validation.
3. Persist operation intent and reconcile paused/interrupted checkpoint jobs.
   Keep checkpoint artifacts immutable and retain disk dependencies until no live
   machine or checkpoint references them. Stop is not deletion; no TTL is needed.
4. Keep hourly workspace backups separate from RAM checkpoints. Treat RAM/disk
   checkpoint storage as secret-bearing even when workspace backup excludes
   credential files. These tests used no credentials.

## Verification and cleanup

All 12 local test suites passed. The independent evidence audit checked 100 RAM
status replies, 70 direct-disk replies and 10 exported runtime binary paths, with
no integrity findings. Five failed attempts remain visible: two Cocoon harness
attempts, two smolvm harness attempts and the native host-image profile rejection.
Core, full-stage and supplemental proof scopes are recorded separately:
[core audit](results/2026-09-06/audit-core.json),
[full-stage audit](results/2026-09-06/audit-full.json), and
[supplemental review](shared/SUPPLEMENTAL_REVIEW.md).

The coordinator approved hashed cleanup plans only after the VM/mount gates
closed and metadata was exported. The helpers removed 29 exact disposable
targets, accounting for 58,612,703,232 allocated bytes (54.59 GiB); this is target
accounting, not a host-wide free-space measurement. All 201 archived metadata
files were independently exported and hash-checked before deletion. Synthetic
VM/checkpoint payloads are no longer recoverable from that metadata alone; caches
are rebuildable. Pinned binaries, images, source archives/patches and evidence
remain, with retained inputs rehashed. Older spike roots were not removed.

The final [host comparison](results/2026-09-06/host-comparison.json) passed:
no owned runtime processes, listeners or cgroups; network links/routes/namespaces
and the three recorded sysctls unchanged. Both runtime cleanup checks also found
no owned mounts and the common lock available. The new root retained about
2.97 GiB at audit time. Execution, namespace and cleanup grants are closed.

## Not established by this run

Process-independent restoration on the same host is not a real host reboot,
physical power-loss test, cross-CPU compatibility result or arbitrary application
transaction guarantee. No credentials or real agent sessions are captured here.
The runtime/device/CPU profile is pinned; cross-host/cross-version migration,
long-duration soak and production supervision/networking remain untested here.
[Tart stopped-disk results](../tart-checkpoints/RESULTS.md) remain separate evidence;
they were not rerun against the newer portable artifact profile. See
[scope and protocol](README.md).
