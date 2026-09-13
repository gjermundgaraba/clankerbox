# Real-local engine gates A1 / A4

**PASS on macOS arm64 and Linux amd64, 2026-09-12.** These are isolated native
engine/supervisor tests. They do not qualify product RPC handlers or guest PTYs;
`../real-local-guest` owns the real guest rebind proof.

## Executed boundaries

| Boundary | macOS arm64 | Linux amd64 |
|---|---|---|
| Start under native OS supervisor; detached VM outlives CLI/SSH request | PASS, launchd | PASS, user systemd |
| Live branch, source continues, exact inherited RAM token/PID/counter | PASS | PASS |
| Parent and child mutate RAM counters and disks independently | PASS | PASS |
| Portable capture; source token/PID/counter unchanged afterwards | PASS | PASS |
| Source cold restart while retained child preserves live child RAM | PASS | PASS |
| Source deletion refused while child dependency remains | PASS | PASS |
| Delete owned child and source, restore saved RAM twice | PASS | PASS |
| Each restored machine cold restarts retaining its own mutated disk | PASS | PASS |
| Trusted native exec and loopback-only TCP publication | PASS | PASS |
| Explicit teardown leaves no gate VM records | PASS | PASS |

Machine-readable results: [Mac](../../docs/archive/real-local/engine-evidence/mac/mac-acceptance.json),
[Linux](../../docs/archive/real-local/engine-evidence/linux/acceptance.json). Commands, supervisor jobs and launch logs
are alongside those reports. Mac `parent-job-after-launch.txt` records an exited
launcher while guest execution remains available. Linux SSH command completion
precedes subsequent independent exec/HTTP requests. Final inventories record cleanup.

The sentinel holds a random token and mutable counter **only in process RAM**.
Its executable never initializes them from a file. Inherited PID, token and count
match; POSTs advance the parent to 2 and child to 3 independently. After both
original VM records/disks were deleted, two independent portable restores return
the captured parent count 2 and original token/PID, then retain separate disk
mutations after explicit cold starts. This excludes a cold-restoration substitute.
Tests are sequential restores on the same compatible host, not cross-CPU portability.
They do not establish host-reboot recovery or unsynced-write crash consistency.

## Reconciled engine artifact

[release pins](../../scripts/release/inputs/pins.json) records source/library revisions and artifact hashes.
[runtime.patch](../../scripts/release/inputs/runtime.patch) is the exact five-file deployed-source diff against smolvm
`e8d09ef616d363004d55b80a6cdb31a4e7e1842d` (v1.14.1), retrieved from the retained
Linux build. It includes the later `state_probe.rs` lineage correction missing
from the older local v1.14.1 working tree and original four-file patch manifest.
The actual tested deployed CLI hash is `8d2a6485a91c19af6fbd1eac409e7dd708f50e581afee50cb2929871994f5d29`.
The old documented `66c240...` binary hash is superseded by that lineage build.

The tested libraries are the official matching v1.14.1 bundles, provenance
libkrun `f4cb46a5e6189872394d205494c14e9a6974816c`, libkrunfw
`55bb7c5273178826240b39e907475fb6011afd8e`. No historical DAX/retention patch was
blindly reapplied. Mac CLI was rebuilt from reconciled source and ad-hoc signed
with upstream hypervisor entitlements. Its matching static Linux arm64 agent
was rebuilt using Rust 1.98.0 and Zig 0.16.0. The Linux native CLI and static agent
are copies of the existing exact deployed artifacts; production files were read only.

The explicit profile is the release's bare Alpine agent rootfs with the matching
patched agent and static sentinel. It uses native persistent disk overlay, no
host mounts, no credentials, virtio-net and strict egress policy. This is distinct
from the product Ubuntu profile. Ports bind only 127.0.0.1. GPU and custom DNS are
not part of this tested portable profile.

## Reproduction

`build-mac.sh` records native CLI/agent/sentinel compilation. It requires an
existing Rust toolchain with aarch64-unknown-linux-musl and Zig; it does not
install global packages. `prepare_mac.py` allocates a fresh private root and
refuses an existing gate config. `control.py` journals every command and enforces
an isolated gate root. Before starting, verify the chosen loopback ports are free.

```
bash spikes/real-local-engine/build-mac.sh
python3 spikes/real-local-engine/prepare_mac.py
python3 spikes/real-local-engine/control.py machine create --name gate-parent --cpus 2 --mem 768 --storage 1 --overlay 1 --net --net-backend virtio-net --port 48181:18080 -- /bin/true
python3 spikes/real-local-engine/supervise_mac.py parent machine start --name gate-parent --branchable
# Wait for native machine status to become running; never restart an ambiguous job.
python3 spikes/real-local-engine/control.py machine exec --name gate-parent --detach -- /usr/local/bin/gate-sentinel
python3 spikes/real-local-engine/control.py machine exec --name gate-parent -- sh -c 'echo source-A > /root/gate-disk; sync'
curl -fsS -X POST http://127.0.0.1:48181/
python3 spikes/real-local-engine/supervise_mac.py child machine branch --from gate-parent --name gate-child --branchable --port 48182:18080
# Wait for both native status and HTTP readiness.
python3 spikes/real-local-engine/qualify_mac.py
python3 spikes/real-local-engine/restore_mac.py
```

Linux preparation is `prepare_linux.py ROOT` on an **empty newly allocated**
`/home/clanker/cbre.XXXXXX` root. Copy `control.py`, `qualify.py`,
`supervise_linux.py`, `restore_linux.py` and the static amd64 sentinel into that
root. Set `ENGINE_GATE_CONFIG=ROOT/config.json` for each command. Use the same
native creation/bootstrap commands; `supervise_linux.py ROOT parent ...` and
`... child ...` replace the Mac supervisor invocations. Then `qualify.py` followed
by `restore_linux.py` runs qualification and exact native cleanup. The Linux host
already permits this user's KVM access; no groups, permissions or host policy changed.

Initial Mac harness deletion omitted `--force`, which means interactive native
confirmation. It returned success without deleting the child; the following
parent deletion correctly refused. The failed transcript is retained. The harness
now explicitly confirms only its owned test names with `--force`; the continued
run (`GATE_RESUME_AFTER_STOP=1`) completed both restorations. No engine fix was needed.

## Adapter conclusions

- Select OS supervision by host platform, not engine. macOS supports native
  branch-and-continue and portable RAM restore with this artifact/profile.
- The validated launchd description uses `AbandonProcessGroup=true` for detached VMM lifetimes,
  `RunAtLoad=false`, `KeepAlive=false`, explicit bootstrap/kickstart and native
  stop before bootout. Never replay first branch as ordinary start.
- systemd uses oneshot + RemainAfterExit, Restart=no, preserving the VMM cgroup.
  The gate bounds each unit with CPUQuota=200% and MemoryMax=3G.
- macOS `dirs` uses `HOME/Library/Caches` and `HOME/Library/Application Support`,
  ignoring XDG overrides. A short private HOME is necessary to keep sockets under
  native limits. Linux uses the explicitly isolated XDG trees.
- Pass SMOLVM_LIB_DIR and DYLD_LIBRARY_PATH on Mac; LD_LIBRARY_PATH on Linux.
  Distribute compressed disk templates beside the binary; expand them once.
  Requested 1 GiB disks are replaced by the release template's logical size
  during formatting (sparse APFS clones), so inspect actual sizes for accounting.
- Guest rootfs ownership requires explicit handling: extracting/copying on Mac
  maps host ownership (UID 501) into the bare guest. The subsequent real guest
  gate found `/root` owned by 501; its state-directory trust checks correctly
  rejected this. Native sentinel tests do not qualify ownership-sensitive
  applications. The guest gate repairs only its private guest `/root` to UID/GID
  0 and mode 0700; shipped image provisioning must establish intended guest
  ownership before claiming that artifact supported.
- Keep first branch, pending first RAM restoration and ordinary retained restart
  distinct in launch descriptions. Source deletion follows engine lineage rules.

The Mac engine gate root was `/private/tmp/cbre-0bkjipap`; Linux was
`/home/clanker/cbre.WEMt4r`. Their VM records/jobs were removed, portable artifacts
and logs retained. A **separate** `/private/tmp/cbre-guest-fay0t82o` and
`.work/real-local-guest/mac.json` were handed to the guest-RPC gate owner, which
owns those VMs and their cleanup.
