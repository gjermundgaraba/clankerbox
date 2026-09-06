# Cocoon + upstream Firecracker spike

**Shared RAM acceptance PASS; host execution slot released.** Parent plus two concurrent
RAM children passed the shared acceptance kit. Quarantine, cooperative identity
preparation, daemon reattachment, same-disk stop/start, guest Docker with vfs,
source/checkpoint deletion and recovery of RAM/guest-visible state also passed.
Docker's default overlayfs container run failed on Cocoon's overlay root.

**The separate quiesced-file rollback follow-up passed on KVM; cleanup is verified.**
See [ROLLBACK_RESULTS.md](ROLLBACK_RESULTS.md) and
[rollback-evidence.json](rollback-evidence.json). General application/in-flight
RAM/disk coherence remains NOT RUN.

**Backing-disk rollback/coherence were NOT RUN in the original three-way evidence.** The sentinel's
disk JSON uses guest page-cache reads/writes without fsync or cache bypass, and
the recovery test never changes that disk state after checkpoint capture. Restored
RAM can therefore supply the expected file contents without independently proving
point-in-time backing-disk rollback. Guest-visible state and child-a's cold-boot
disk retention remain PASS; cold-boot retention does not establish rollback/coherence.

See [RESULTS.md](RESULTS.md) for actual outcomes, contended timings, limitations
and verified cleanup; [evidence.json](evidence.json) contains the small machine-readable
evidence. No production deployment was performed.

## Separately authorized disk rollback follow-up

Grant `cocoon-rollback-20260905` authorizes [rollback_host.py](rollback_host.py)
and [rollback_guest.py](rollback_guest.py) to run one disposable 2-GiB / 2-vCPU VM
using the exact retained Cocoon/Firecracker binaries and `guest-rootfs.tar`.
Initial `evidence.json` stays unchanged (SHA256
`8f3ecef3d36bc0a3ad09aaf42e632669cdae4f2ee198410cbe8f0f1c0990bf6b`).
Actual rollback result is **PASS** in [rollback-evidence.json](rollback-evidence.json):
direct backing-file bytes and the continuing RAM counter changed 10 → 110 → 10,
with one unchanged guest PID/marker. [ROLLBACK_RESULTS.md](ROLLBACK_RESULTS.md)
records full scope and contended timings. Grant is released; cleanup verified.

Exact host plan: fresh `/home/clanker/clankerbox-cocoon.b0ngM6/rb01`, VM/image
`cq-rollback-20260905`, snapshot `cq-rollback-20260905-snapshot`, private
`/sys/fs/cgroup/cqrb20260905.slice` plus its `control` and generated `vm-*.scope`
children. Reject existing run/cgroup paths. Empty private CNI config and
`--nics 0` create no NIC, bridge, TAP, namespace, route or firewall object;
management is vsock only. Root is needed for Cocoon/cgroup operations. No daemon,
Docker build, package install or global setting is used. Root controllers must
already be enabled. CLI/VMM descendants share a 5-GiB cgroup limit and four-core
CPU ceiling, leaving 1 GiB for the small Python runner. Additional actual disk
allocation must stay under 12 GiB; sparse disks have 10-GiB logical capacity.
The pinned EROFS/libdeflate packages are downloaded and extracted privately only
to reconvert the frozen tar into runtime storage; nothing is rebuilt.

The guest writes an exclusive 4096-byte checkpoint fixture, fsyncs both file and
directory, explicitly flushes the shared sentinel JSON too, and calls guest
`sync`. Snapshot capture follows. After capture it overwrites and flushes distinct
bytes in the same inode and mutates the live sentinel. Aligned `O_DIRECT` reads
must verify both phases. Restore then uses read-only `O_DIRECT` to verify the
checkpoint bytes while the captured RAM marker/PID/counter continue. Unsupported
direct I/O fails; no buffered fallback and no host `drop_caches` are used.
This tests agreement of an explicitly quiesced fixture; general in-flight I/O,
application transaction coherence and host power-loss durability remain NOT RUN.

Cleanup verifies VM name, private disk/socket paths, executable, process socket
and cgroup membership before force removal, then removes the recorded snapshot,
empty cgroup and newly generated image/runtime files. Only small reports, command
logs, config and this follow-up's scripts remain. Timings are **contended** because
Cube's isolated outer VM may execute concurrently. Local checks:
`python3 test_rollback.py` and `PYTHONOPTIMIZE=1 python3 test_rollback.py`.
Both passed **six tests**. The first cleanup stopped on a briefly exiting control
process; [rollback-cleanup.json](rollback-cleanup.json) proves subsequent cleanup
without signals or more VMs. The raw run keeps the initial failure. Final retained
follow-up paths are `rb01/` (65,536 allocated bytes), `rb-src20260905/` (24,576),
and `rb-clean-src20260905/` (28,672), all beneath the existing private stage:
**118,784 bytes total**. No new runtime/network object remains. The original
rootfs and initial shared evidence are unchanged. This one-shot grant is consumed.

## Ownership and retained artifacts

Only `spikes/cocoon/` was edited. Upstream checkouts, caches and Linux binaries are
under its ignored `.work/`; the audited `/tmp/cocoon-audit.AgVkok/cocoon` checkout
was read-only. Shared `../acceptance/` code was reused without modification.

Remote files remain at **`/home/clanker/clankerbox-cocoon.b0ngM6`**, approximately
**887 MiB allocated**, chiefly the exact tested rootfs tar (**878,934,528 bytes**)
and private binaries. There are **zero** owned VMs, snapshots, VMM/daemon
processes, bridges, namespaces, cgroups, derived Docker images or export containers.
The shared digest-pinned Docker base image remains cached. Redundant private
image stores, runtime directories, downloads, erofs extraction and build context
were removed. Current raw evidence is in remote `results/`; earlier failures
are in `results-attempt1/` through `results-attempt4/`. Local copies occupy about
844 KiB in `.work/host-evidence/`.

## Exact inputs

[pins.json](pins.json) records the revisions, image digest and download hashes.

| Component | Tested input |
| --- | --- |
| Cocoon | `23a05603479a7552213adfb5fa25f2de7b2dbaf9`; cross-compiled on arm64 macOS with Go 1.27.1 for Linux amd64 |
| Firecracker | Upstream `v1.16.1`, annotated tag verified to peel to `2038188f145fb81b8d098147a10e9d9f392fd22f` |
| CNI bridge + host-local | v1.9.1, commit `adc3e6b5b581638afbd194cf2e9319ecbb0151a1` |
| Base image | `ghcr.io/cocoonstack/cocoon/ubuntu@sha256:0a8de2c70f52f6241f9ad95affb302ef0ca7d36853e6d628ee9a91c5808e4152` (amd64 manifest) |
| Guest agent | Cocoon-agent v0.2.3; executed binary matched the checksum-verified release byte for byte |
| Kernel | Ubuntu `6.8.0-139-generic`, matching `linux-modules-extra`; `VMGENCTR:00` bound to vmgenid |
| Guest rootfs | SHA256 `0a64e8ef15c93ff146f10729750955a4b4a1938293260cbf983d99b5466c99ed` |
| Host image tools | Privately extracted erofs-utils 1.9.1-1 and libdeflate 1.23-2ubuntu1; existing mkfs.ext4 |

The image includes Cocoon overlay boot hooks/kernel/initramfs, vsock agent,
Python 3, systemd, iproute2, ssh-keygen, gcc/libc6-dev and Docker. The Dockerfile
resolves guest packages through apt; the retained tar, package inventory and
checksums are the immutable execution input. The Dockerfile alone is not a
reproducible apt package lock. Management uses private Unix/vsock sockets only.

## Runnable checks

1. `./build-local.sh` pins and cross-compiles Cocoon/CNI into `.work/`, using
   private Go caches and four build jobs. No global installs.
2. `python3 test_local.py` and `PYTHONOPTIMIZE=1 python3 test_local.py` both pass
   four local tests: source ordering, CNI failure/ordering, continuing local
   sentinel preparation, and optimized-mode security checks.
3. `prestage.py` verifies archive checksums and uses `dpkg-deb -x` in the private
   prefix. `render.py BASE` writes configs only. Both are preparation tools.
4. `build-host-image.sh` builds/exports the guest and records kernel/rootfs
   hashes. `run_host.py BASE` executes the baseline using shared `guest.py` and
   `evaluate.py`. `guest_workload.sh` uses Docker vfs for offline build/run.
5. `finish_host.py` continues only the recorded proven VM IDs for workload and
   recovery checks. `cleanup.py BASE --delete-disposable-vms` explicitly removes
   disposable VMs/snapshots/networks; it never runs automatically on failure.

The five relevant upstream Go packages also passed on Darwin/arm64:

```sh
GOMODCACHE="$PWD/.work/gomod" GOCACHE="$PWD/.work/gocache" \
GOPATH="$PWD/.work/gopath" GOMAXPROCS=4 \
go test -C .work/cocoon -p 4 ./hypervisor/firecracker ./cmd/vm ./daemon ./hypervisor ./network/cni
```

Those source/local results are separate from actual KVM evidence in RESULTS.md.

## Quarantine and preparation

The pinned CLI completes CNI preparation before launching/restoring a clone.
CNI `AddNetworkList` completes before Cocoon installs namespace TAP/TC redirects.
The final CNI step proves the host veth is the guest interface's peer and belongs
to the expected private bridge, then installs priority-1 all-protocol drops on
host-veth ingress and egress. This covers the path that namespace OUTPUT misses.
It writes a nonce-bound gate record only after both drops succeed.

Each VM has one NIC and its own bridge. `isGateway=false` avoids the bridge
plugin's host-wide forwarding sysctl; only private bridge addresses are assigned.
There is no NAT, public listener, shared writable mount or general Internet access.

Fake HTTP endpoints listen before source canary capture and child resume.
The RAM canary repeatedly attempts side effects. The runner checks actual TC
drops and zero claims while quarantined. Management over vsock waits out detached
CLI reseeding, explicitly reseeds, then prepares the cooperative sentinel and
guest identities without restarting its process.

Preparation clears the synthetic session, changes machine ID/hostname, stops
SSH/networkd, regenerates SSH keys, repairs IP/MAC/route and creates a fresh
session. Proof checks continuing PID and RAM marker, and distinct identities.
Failed preparation or a stale/invalid nonce leaves networking blocked.

Linux matchall rejects replacing an existing classifier (EEXIST). Release verifies
the existing all-protocol drop actions, installs restricted rules behind them,
then removes priority 1. Priority 100 remains default-drop; only ARP and TCP/8080
to/from the VM's controlled endpoint pass. IPv6 and representative custom-L2
probes remain blocked after release. The operation is a trusted one-shot spike,
not a general production controller or hostile-guest attestation protocol.

VMGenID is not a cloned-userspace-session solution. Only the cooperative fake
session is tested; no copied real credentials or actual coding-agent sessions
were used. Cached systemd/dbus identity and arbitrary userspace PRNG state are
not claimed repaired. The later persistent networkd config enhancement has local
coverage; executed runtime evidence covers the transient repair. See limitations.

## Authorized host scope and replay

The previous slot is released. Any replay requires a new coordinator grant and
explicit reconciliation of retained `run-started` evidence. Do not blindly
remove that marker or adopt objects from another run.

| Resource | Exact scope |
| --- | --- |
| Files | `/home/clanker/clankerbox-cocoon.b0ngM6`; private bin/cni paths, d/r/l, gates/ipam, source and results |
| VMs / snapshots | `cq-q7-parent`, `cq-q7-child-a`, `cq-q7-child-b`; `cq-q7-ram`, `cq-q7-recovery` |
| Bridges / addresses | `cqq7p`, `cqq7a`, `cqq7b`; 172.30.216/217/218.1/24 with one .2 guest per subnet |
| Namespaces / NICs | `q7-<recorded VMID>`; one CNI veth pair and TAP per VM, exact names/ifindices in gate/VM records |
| Filters / cgroups | clsact on those host veths only; `/sys/fs/cgroup/cqq7.slice` and child scopes |
| Management | Private per-VM API/vsock/console sockets under r/firecracker; fake listeners only on the three private .1:8080 addresses |
| Docker build | `clanker-spike=cocoon-b0ngM6` label, `clanker-cocoon-b0ngm6:acceptance` image and `clanker-cocoon-b0ngm6-export` container |
| Budget | Three VMs × 2 GiB/2 vCPU; never above three × 4 GiB. Guest build ≤4 CPUs/8 GiB. ≤40 GiB allocated private artifacts; COW disks are minimum 10 GiB logical sparse files |

Before mutations, the runner records all host IPv4 routes, links and namespaces;
rejects overlapping private ranges, pre-existing bridge/q7 namespace/cgroup
names, out-of-scope paths, and missing root cpu/cpuset delegation. It never enables
global controllers, forwarding, firewall or CNI settings. All safety checks use
explicit exceptions and remain active with PYTHONOPTIMIZE.

A replay must restore privately extracted erofs/libdeflate with prestage.py and
render its private config. Transfer shared acceptance files to `src/` and current
gate.py to `cni-bin/clanker-gate`. With a new grant, invoke:

```sh
sudo env CLANKER_HOST_SLOT=cocoon python3 /home/clanker/clankerbox-cocoon.b0ngM6/run_host.py \
  /home/clanker/clankerbox-cocoon.b0ngM6
```

No global package installation, installer script, firewall flush, host reboot,
systemd service installation, existing VM deletion or production deploy is used.

## Source references

- [Cocoon clone preparation](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/cmd/vm/run.go), [CNI ordering](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/network/cni/lifecycle.go), [TC redirect](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/network/cni/lifecycle_linux.go).
- [FC clone bind/restore/resume](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/hypervisor/firecracker/clone.go), [detached reseed](https://github.com/cocoonstack/cocoon/blob/23a05603479a7552213adfb5fa25f2de7b2dbaf9/cmd/vm/reseed.go).
- [FC VMGenID restore notification](https://github.com/firecracker-microvm/firecracker/blob/2038188f145fb81b8d098147a10e9d9f392fd22f/src/vmm/src/device_manager/persist.rs), [randomness limitations](https://github.com/firecracker-microvm/firecracker/blob/2038188f145fb81b8d098147a10e9d9f392fd22f/docs/snapshotting/random-for-clones.md).
