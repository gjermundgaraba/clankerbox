# Cocoon / upstream Firecracker results

**Shared RAM acceptance and observed lifecycle checks PASS. Host slot released;
cleanup verified. Separate quiesced-file backing rollback PASS; general
application RAM/disk coherence NOT RUN.**
Executed on 2026-09-05 on the authorized Ubuntu 26.04 / EPYC / ext4 host,
`clanker@203.0.113.10`, with three disposable 2 GiB / 2-vCPU Firecracker VMs.
This is actual KVM execution, distinct from the local/source tests below.
Machine-readable evidence is [evidence.json](evidence.json); replay and exact
scope are in [README.md](README.md).

The subsequently authorized one-VM [rollback follow-up](ROLLBACK_RESULTS.md)
passed a flushed A → B → restored A backing-file test using guest `O_DIRECT`
reads, with continuing RAM sentinel PID/marker and counter 10 → 110 → 10.
[rollback-evidence.json](rollback-evidence.json) is separate; original
`evidence.json` remains unchanged. Its 6538.849-ms snapshot and 243.395-ms restore
observations are contended alongside the permitted Cube outer VM. Cleanup is
verified; only 118,784 allocated bytes of new reports/scripts remain remotely.
General in-flight I/O/transaction coherence and host power-loss durability remain
NOT RUN. The original three-way table below retains its original evidence scope.

## Actual acceptance and lifecycle

| Check | Result | Observed evidence |
| --- | --- | --- |
| Source resume + two concurrent RAM children | PASS | Three separate running VMM PIDs/VM IDs/vsock sockets; shared evaluator passed all checks |
| Inherited RAM and continuing guest process | PASS | Parent/a/b all report PID **391** and marker SHA256 `3e54d404dd8114780b0d83662139dea3d61a6ac4f1e2a05ac37f5bdcef7b6f12` |
| Independent RAM and guest-visible file state | PASS | Final counters and guest-visible disk JSON counters **10 / 100 / 1000**, labels parent/child-a/child-b; all final reads occurred after all mutations; distinct COW paths; no cache-bypassed backing-disk check |
| Pre-resume network quarantine | PASS | Final CNI step installed host-veth ingress/egress all-protocol drops before clone launch; canary traffic incremented actual drop counters; no endpoint claim before preparation |
| Cooperative preparation | PASS | Fresh machine IDs, SSH host-key fingerprints and synthetic sessions; inherited PID/marker preserved; stale/invalid preparation rejected |
| Scoped release | PASS | Repaired guest HTTP blocked before release; unique sessions accepted after release; default drop retained for other traffic |
| Representative IPv6 / custom L2 | PASS | Raw IPv6 and EtherType 0x88b5 probes increased default-drop counters after release |
| Daemon restart and reattachment | PASS | Private daemon terminated/restarted; all three VMM PIDs and continuing sentinel state survived |
| Same-disk stop/start | PASS | Child-a retained identical workspace paths and disk JSON across cold boot; establishes retention, not point-in-time rollback or RAM/backing-disk coherence |
| Guest C build | PASS | All three compiled and executed a static C program with gcc |
| Default Docker overlayfs container run | **FAIL** | Image build succeeded, but container run failed with nested overlay mount EINVAL on Cocoon's overlay root |
| Docker vfs build/run | PASS | All three built a local image and ran its static C program with `--network=none`; `storage-driver=vfs`, `containerd-snapshotter=false` |
| Children after source/checkpoint deletion | PASS | Both children retained expected guest-visible file contents; child-b retained its live sentinel after disposable parent/original snapshot removal |
| Backing-file existence after abrupt VMM loss | PASS | SIGKILL targeted only child-b's verified private Firecracker executable/PID; reconciliation retained its COW file; contents/rollback were not independently checked |
| Retained checkpoint RAM/guest-visible recovery | PASS | Child-b restored PID **391**, the same marker, RAM counter **1000**, label and synthetic session; guest-visible disk JSON also reported **1000**, subject to the cache limitation below |
| Point-in-time backing-disk rollback and RAM/backing-disk coherence | NOT RUN | No post-checkpoint disk mutation or fsync/cache-bypass verification |

The sentinel's `guest.py` disk JSON uses ordinary guest page-cache reads/writes,
without fsync or cache bypass. `finish_host.py` never changes that disk state after
checkpoint capture. Restoring the RAM snapshot can therefore restore cached file
contents that satisfy the JSON check without independently establishing rollback
of the backing disk or coherence between restored RAM and backing-disk state.
All 14 shared acceptance checks remain valid for their observed RAM/guest-visible
scope. Child-a's separate cold-boot retention check remains PASS; it does not close
the checkpoint rollback/coherence evidence gap.

Actual bound VMGenID device: `/sys/bus/acpi/drivers/vmgenid/VMGENCTR:00`.
The guest used `6.8.0-139-generic` with `CONFIG_VMGENID=m`,
`CONFIG_VIRTIO_MMIO=y`, and `CONFIG_VIRTIO_VSOCKETS=m`. The first image's
configuration advertised VMGenID but lacked its module; adding the matching
`linux-modules-extra-6.8.0-139-generic` fixed that executed failure.

## Timings and memory — contended host

**All timings are labelled contended / concurrent-host activity.** The coordinator
permitted disjoint smolvm execution during this run. These are single observations,
not isolated benchmarks or production latency guarantees. The root's later
regular-file XFS trial was not part of these measurements.

| Measurement | Observed value |
| --- | --- |
| Snapshot CLI command, including bookkeeping | **4302.7 ms** |
| Source pause | Coarse sampled bound **0–711.6 ms**; exact pause **NOT MEASURED** |
| Child-a fork command through working guest exec | **143.1 ms** |
| Child-b fork command through working guest exec | **149.0 ms** |
| Initial PSS parent / child-a / child-b | **352,907,264 / 91,590,656 / 84,621,312 bytes** (about 336.6 / 87.3 / 80.7 MiB) |

Firecracker API sampling ran every 10 ms but API work can delay responses; the
raw samples justify only a broad bound. Snapshot command duration is not source
pause duration. Child readiness here means successful guest exec, before complete
identity preparation or network release. The resource report's summed file-block
count double-counts hard links; it is not a filesystem-capacity measurement.

| Ingress counter test | Parent | Child-a | Child-b |
| --- | --- | --- | --- |
| Quarantine drop count across blocked HTTP/raw probes | 11 → 15 | 8 → 13 | 12 → 17 |
| Default-drop count across IPv6/custom-L2 probes after release | 0 → 3 | 1 → 3 | 1 → 3 |

ARP is intentionally allowed after preparation. These are representative probes,
not exhaustive VLAN/QinQ, tunnel, multi-NIC or adversarial packet coverage. No
general Internet access was opened; only each private fake endpoint's TCP/8080
was allowed. Namespace OUTPUT was not used as the gate.

## Local/source evidence and corrected failures

| Check | Result | Scope |
| --- | --- | --- |
| Cocoon revision and FC v1.16.1 peeled tag | PASS | Source/version verification |
| Cocoon/CNI Linux amd64 binaries | PASS | Cross-build on arm64 macOS, Go 1.27.1 |
| Four spike tests, normal and PYTHONOPTIMIZE=1 | PASS | Local source ordering, mocked host commands, real continuing local sentinel, optimized-mode safety checks |
| Five relevant upstream Go packages | PASS | Darwin/arm64 tests; not Linux execution proof |
| Guest-agent v0.2.3 | PASS | Executed guest binary matched checksum-verified release byte for byte |

Prior failed attempts remain preserved. Besides the missing kernel module, the
harness corrected ssh-keygen progress contaminating JSON stdout and Linux
matchall rejecting replacement with EEXIST. Both preparation failures remained
closed. Release now verifies existing drop actions before installing restrictions
and removing the initial drops. All ownership/input/security checks in gate.py,
render.py and run_host.py use explicit exceptions; optimization cannot disable them.

Docker vfs solved the observed nested-overlay failure. Docker also waited for
networkd-online after preparation had stopped networkd. Masking the **guest-only**
wait-online unit unblocked the offline workload; guest_workload.sh includes that
tested action. A subsequent persistent static networkd configuration enhancement
has local coverage only. The recorded KVM preparation used transient static repair;
no extra run was started to claim networkd-restart persistence.

## Explicit NOT RUN

| Capability | Status |
| --- | --- |
| Point-in-time backing-disk rollback and RAM/backing-disk coherence | NOT RUN; cached guest JSON and unchanged post-checkpoint disk state cannot independently establish either |
| Actual coding-agent application session, cached credentials or arbitrary userspace PRNG repair | NOT RUN; only cooperative synthetic sessions, no copied live credentials |
| Interrupted clone finalization, capacity exhaustion and mismatched checkpoint rejection | NOT RUN |
| Large populated workspace / large dirty-page benchmark | NOT RUN |
| Cross-host restore or migration | NOT RUN |
| Host reboot and reboot recovery | NOT RUN; no reboot authorized |

VMGenID is not a solution for copied arbitrary userspace sessions. Regenerated
files do not erase cached tokens. The spike does not claim systemd/dbus cached
machine identity was refreshed or that quarantine is a production controller.

## Verified cleanup and retained artifacts

Cleanup removed the exact disposable VMs/snapshots, their CNI veths/TAPs and
`q7-<VMID>` namespaces, bridges `cqq7p/cqq7a/cqq7b`, and `cqq7.slice`.
The derived Docker image, export container and specifically recorded untagged
build intermediates were removed without a global prune. Verification found:

| Resource | Remaining |
| --- | --- |
| Owned VMs, snapshots, VMM/daemon processes | **0** |
| Owned bridges, netns, cgroup | **0** |
| Owned derived Docker images / export containers | **0** |
| Private retained directory | `/home/clanker/clankerbox-cocoon.b0ngM6`, **929,468,416 allocated bytes** at cleanup (about **887 MiB**) |
| Exact tested rootfs | `guest-rootfs.tar`, **878,934,528 bytes**, SHA256 `0a64e8ef15c93ff146f10729750955a4b4a1938293260cbf983d99b5466c99ed` |
| Remote raw evidence | `results/` about **288 KiB**; attempts 1–4 about **368 KiB** combined |
| Local raw evidence | `spikes/cocoon/.work/host-evidence/`, about **844 KiB** including intermediate copy |
| Shared Docker base cache | Pinned Cocoon Ubuntu digest retained, reported image size **124,609,741 bytes**; no running container |

Private source/configs and bin/cni-bin are retained with the exact rootfs.
Redundant private OCI store, runtime/log directories, downloads, extracted erofs
payload, image context, IPAM and gate files were removed. Raw cleanup inventory,
before/after routes/links, empty VM/snapshot listings, package inventory, binary
hashes and command logs are in `.work/host-evidence/final/` and remote `results/`.
No unrelated VM, service, firewall, global CNI config, host sysctl, package
installation or production deployment was modified by these scripts.

**Host execution slot is released.** A fresh grant is required for any replay.
