# Point-in-time disk rollback follow-up

**PASS on actual KVM; cleanup verified and grant released.** One disposable
2-GiB / 2-vCPU VM ran on 2026-09-05 at approximately 13:44 CEST. It reused the exact
retained Cocoon, upstream Firecracker v1.16.1 and guest-rootfs tar; no rebuild.
It had only loopback and was managed through vsock. No host network objects,
global settings, packages, Docker objects or host cache controls were changed.

The separate [rollback-evidence.json](rollback-evidence.json) combines the
[unaltered raw run](rollback-run.json), [command log](rollback-commands.jsonl)
and [completed cleanup proof](rollback-cleanup.json). The original three-way
[evidence.json](evidence.json) remains byte-for-byte unchanged, SHA256
`8f3ecef3d36bc0a3ad09aaf42e632669cdae4f2ee198410cbe8f0f1c0990bf6b`.

## Actual backing-file and RAM proof

The guest created one exclusive 4096-byte file, fsynced its file and directory,
explicitly fsynced the shared sentinel JSON and its directory, and called guest
`sync` before capture. After capture it overwrote different bytes in the same
inode, changed the continuing sentinel's RAM/disk counter, and repeated the
flushes. Both files were checked using `O_DIRECT`, a page-aligned anonymous mmap
buffer and `readv`; direct-I/O errors are fatal with no buffered fallback.

| Observation | Before capture | Flushed after capture | After RAM restore |
| --- | --- | --- | --- |
| Guest sentinel PID | 329 | 329 | 329 |
| RAM and direct-read JSON counter | 10 | 110 | 10 |
| Label | checkpoint | after-capture | checkpoint |
| 4096-byte file SHA256 prefix | `62f97f6420782cbc` | `c962be183555d79f` | `62f97f6420782cbc` |
| File inode | 131200 | 131200 | 131200 |
| Probe flush | fsync file/directory + sync | fsync file/directory + sync | **none: read only** |

All three phases retained the same RAM-only marker commitment:
`813f8e1d5eb8e3e1948c6298d9613bddae405646fcc314a860daa76416ff4a2b`.
The sentinel was started exactly once. VM `67SZFCSH5YLVZATKEEJ36EB2FN` restored
checkpoint `RQ7L3SJZB2JH7BIGJRAG2YF2FS`; host VMM PID changed from 60662 to 60806
while guest execution continued. The final direct fixture read performed no
write, fsync or sync after restore. A status call immediately before it read
only the separate sentinel JSON; that JSON was then checked directly too.

This closes the original page-cache evidence gap for **point-in-time backing
bytes of this quiesced fixture and agreement with captured sentinel RAM**.
Restoring cached guest file contents alone cannot satisfy the direct file read.

**NOT RUN:** coherence with concurrent/in-flight application I/O, multi-file or
database transactions, multiple writable disks, host reboot/power loss and
cross-host migration. File-level direct I/O bypasses the guest file page cache;
it does not bypass host or storage-device caches. No physical-media durability
or general crash-consistency claim follows. The original three-way run retains
its narrower guest-visible disk claims; this is separate evidence, not a rerun
of three-child acceptance, Docker or network quarantine.

## Contended timings and budget

Cube's isolated outer VM was permitted concurrently. These are single
**contended / concurrent-host activity** observations, not isolated benchmarks.

| Measurement | Observed |
| --- | --- |
| Snapshot CLI command including bookkeeping | 6538.849 ms |
| Restore command through working sentinel call | 243.395 ms |
| Exact source pause | NOT MEASURED |
| CLI/VMM cgroup memory peak | 3,282,575,360 bytes (3.06 GiB) |
| Maximum sampled additional actual disk allocation | 2,828,578,816 bytes (2.63 GiB) |

The CLI/VMM cgroup was capped at 5 GiB/four CPU cores, leaving 1 GiB of the grant
for the small runner; the VM was 2 GiB/2 vCPU. Its sparse COW capacity was 10 GiB
logical. No second VM or extra runtime check was started.

## Cleanup, retained artifacts and local checks

VM/snapshot removal passed. The first cleanup check briefly saw an exiting
process in the private control cgroup and correctly stopped; raw evidence keeps
that failure. A read-only follow-up found no matching process. The bounded
[rollback_cleanup.py](rollback_cleanup.py) verified the recorded cgroup inode
67399 and empty VM/snapshot inventories, removed only empty cgroups and owned
runtime/image files, and proved the host link/route/netns inventory unchanged.
It sent no signals. **No rollback VM, snapshot, matching process, cgroup, network
object or generated rootfs/COW/RAM image remains.**

| Retained remote path beneath `/home/clanker/clankerbox-cocoon.b0ngM6` | Allocated size |
| --- | --- |
| `rb01/`: raw run, cleanup proof, command log, config | 65,536 bytes |
| `rb-src20260905/`: exact executed host/guest scripts | 24,576 bytes |
| `rb-clean-src20260905/`: cleanup script and runner with bounded exit wait | 28,672 bytes |
| Total new retained artifacts | **118,784 bytes (116 KiB)** |

Final full private-stage allocation was **929,685,504 bytes**. Within `rb01/`,
raw run/cleanup/commands/config logical sizes are **16,880 / 3,788 / 30,438 / 660
bytes** respectively. Local `rollback-evidence.json` is the completed summary;
the remote raw run deliberately preserves the earlier cleanup failure, linked
by SHA256 from the successful cleanup report.

The frozen original tar remains 878,934,528 bytes with unchanged SHA256
`0a64e8ef15c93ff146f10729750955a4b4a1938293260cbf983d99b5466c99ed`.
Local raw artifacts and the exact executed runner are in `.work/rollback/raw/`.
The source [rollback_host.py](rollback_host.py) now allows up to five seconds
for an exiting empty-scope check; that correction had local coverage and was
used by cleanup, with no additional VM test.

**Six local safety/unit tests PASS**, both normally and with `PYTHONOPTIMIZE=1`:
phase validation, direct-I/O failure without fallback, flush error propagation,
optimized ownership/grant guards, setup failure cleanup/error preservation, and
bounded cgroup exit waiting. Those tests are local/source evidence, separate
from the actual KVM file/continuing-RAM proof above. Reusing this one-shot runner
requires a fresh approved run path/name/cgroup; do not rerun the consumed grant.
