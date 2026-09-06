# CubeSandbox executed comparison — 2026-09-05

**Concurrent RAM fork: PASS.** Release v0.7.0, source
`d0081641c59822e4e5653b7462e914410b81910a`, executed in the granted disposable
nested-KVM outer VM. No upstream patch. [Procedure and exact isolation](README.md).

| Gate | Result | Evidence |
| --- | --- | --- |
| Release/assets | PASS | [Artifact verification](results/artifact-verification.json), component/image locks |
| Local SDK/lifecycle/mapping fixtures | PASS, 11 tests under Python `-O` | [Local report](local-result.json); fixtures are not RAM evidence |
| Nested KVM instructions | PASS | [MOV AX,42; HLT probe](results/nested-kvm.log) |
| Native stack and template | PASS | [14-unit install/quickcheck](results/cube-install-resume.log), [template build](results/runtime/template/status.json) |
| Three concurrent RAM branches | PASS | [Executed evaluator report](results/runtime/run-ready/result.json), [raw evidence](results/runtime/run-ready/evidence.json) |
| Independent disk and HTTP endpoints | PASS | Final counters 10/100/1000 and branch-specific HTTP bodies after all independent mutations |
| `timeout=-1`, controller restart and idle retention | PASS | [Restart evidence](results/runtime/run-ready/restart.json); restart only Master/API/Ops/LCM; 360 seconds without guest requests |
| Real guest C compilation and Docker build/run | PASS in all three guests | [Workload report](results/runtime/run-ready/workload.json); `vfs`, no bridge/iptables, network-free build/run |
| Owned resource cleanup | PASS | [Deleted sandbox/checkpoint ledger](results/runtime/run-ready/ledger.json), [VMM PIDs gone](results/runtime-pids-cleanup.json), [host rollback checks](results/host-rollback-checks.json) |

## Runtime identity and ordering

The API sandbox ID is tied to the live shim's exact `-id` argument, namespace,
containerd bundle, `vmm.pid`/`shim.pid`, cgroup and KVM VM/vCPU file descriptors.
This pinned version embeds the VMM in its shim. Standalone `cube-runtime` counts
are not used as concurrency evidence. These identities remained unchanged before
and after every branch mutation:

| Branch | Sandbox ID | Runtime PID | Start ticks | Guest sentinel PID |
| --- | --- | --- | --- | --- |
| parent | `8797575fead644bbbec2b73bb80d34e7` | 32444 | 72670 | 21 |
| child-a | `e27b2742cf004b378d459fa9191dcf24` | 32507 | 72836 | 21 |
| child-b | `c4ca1743916845c8921020285b5f4ba2` | 32539 | 72870 | 21 |

Outer boot ID: `db380bdf-9cea-4dc9-afa8-9a128b3a5d28`. All inherit RAM marker SHA-256
`56f61c57b0238ee95e881f1f55d1ad2306dabba99c7184c54a80f62dabf7ef5c` from the single
source sentinel. All final heap/disk reads followed all independent writes.
Network isolation here means independently routed proxy endpoints with distinct
branch contents; restored guests retain matching internal MAC/link-local IPs.
It does not prove fresh guest identities or Cube's pre-resume egress quarantine.

## Retained failures and bounded corrections

1. Restricted SLIRP omitted the outer default gateway; Cubelet failed readiness,
   causing API error 130400, “template has no ready replica.” The original
   [failed run](results/runtime/run/run-failure.json) and empty sandbox inspection
   remain. No parent or RAM sentinel existed in that attempt. The marker-guarded
   route helper changes only the outer VM and confirms outbound connections are
   blocked; Cubelet then became ready.
2. The first metadata check looked for bundles in the observer's mount namespace.
   [That failure](results/runtime/run-ready/run-failure.json) happened before
   mutations. The corrected reader uses `/proc/PID/cwd` in each shim's namespace.
   `observe` continued the same live guests, rechecked inherited state, then
   completed all mutations/readbacks. No sentinel restart, reseed or replacement
   guest was used. The missing fork-to-exec timing remains `null`.
3. Bootstrap fixes covered private-runner CA trust, UID permissions, QEMU block
   device/boot order/serial, exact data disk size parsing, and upstream `MIRROR`
   accepting an empty string rather than the rejected literal string `int`. Original logs remain.
   During outer cloud-init, a floating Ubuntu `.sources` file coexisted with the
   dated source list. This run therefore does **not** claim a wholly snapshot-only
   outer package bootstrap. The recorded Docker/Python/XFS versions also occur in
   the dated repository; the floating file was removed inside the outer VM and
   future cloud-init disables it. All Cube images/components, cloud base and
   workload image were separately digest-pinned. [APT provenance](results/outer-apt-provenance.txt).

## Footprint and limits

One 12 GiB/8-vCPU outer VM inside a 14 GiB/8-CPU-limited QEMU container; three
inner guests each 1 GiB/1 vCPU. Host directory allocation during the RAM run:
11,109,085,184 bytes; after workload, 11,117,576,192 bytes and outer-container
usage about 4.564 GiB. Docker's expanded image accounting reports the runner at
337 MB, guest-base at 147 MB and Ubuntu base at 117 MB, with shared layers.
Conservatively adding all three to the directory stays below 11.8 GB.
These are observations,
not high-water measurements. The configured 40 GiB actual-disk ceiling was not
approached. Root disk is 12 GiB logical; uniquely serialled XFS data disk 24 GiB.

This requires the full 14-unit native stack, eight dependency/application images,
Docker/containerd, Cubelet, shims, guest agent/envd, plus temporary registry and
QEMU runner. See [installed footprint](results/cube-installed-footprint.txt) and
[post-build footprint](results/workload-build-footprint.txt). Filesystem-only
runtime accounting omits `/var/lib/containerd` unless measured separately.

Snapshot RPC took **151.37 ms**. Source pause, complete fork-to-exec time and a
comparable host RSS metric remain unmeasured. All timings are nested and
contended, not directly comparable to bare-metal runs.

Host reboot, abrupt VMM failure, capacity exhaustion, cross-node S3 restore,
parent/checkpoint deletion while children live, independent point-in-time disk
rollback via uncached reads, and a real coding-agent session are **NOT RUN**.
The no-expiry result is a finite 360-second idle observation with `timeout=-1`
and no returned expiration deadline, not indefinite-retention or host-reboot
durability proof. Snapshot and disk mutation checks do not establish crash-time
RAM/disk coherence or uncached backing-disk rollback. Guest identities were not
regenerated; no real credentials or coding-agent sessions were copied.

## Cleanup and handoff

All three sandbox deletions and explicit checkpoint deletion succeeded. Their
exact VMM PIDs exited. The outer VM shut down with exit 0; its labelled container,
runner/intermediate images, newly fetched base-image references and exact fresh
directory `/home/clanker/clankerbox-cube.TqWZtL` were removed. No owned host
resources remain. Existing Cocoon/Hermes image references and shared layers were
preserved; no Docker prune or global rollback was used. Host addresses, routes,
mounts and firewall rules match the preflight record (firewall counters excluded).

The local `.work/` intentionally remains: 1,288,474,624 allocated bytes at handoff
for source, SDK venv, downloaded images/archive and extraction. It contains no
running VM or retained host SSH key. `results/` holds about 620 KiB of evidence.
The source/SDK procedure is **READY_FOR_HOST** in a newly granted fresh scope;
this grant's actual runtime campaign is complete and cleaned. [Aggregate VM
report](vm-result.json) combines the executed RAM, retention, workload and cleanup
results. A rerun needs a new `mktemp` scope/owner record and the pinned inputs,
not host package installation or a reboot.
