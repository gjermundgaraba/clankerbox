# TypeScript/Effect rewrite: evidence

The facts behind [rewrite.md](rewrite.md): dependency claims, spike results and
defects in the old implementation. The plan is authoritative; this file holds
the evidence. It is deleted with the plan. The bump skills inherit the
dependency claims (design rule, question 5).

Notation:

- `S@<tag>:path:line` is smolvm source at that tag, read with
  `git -C ~/ws/pers/not-mine/smolvm show <tag>:<path>`. Claims first cited at
  1.19.0 were re-checked at 1.22.0 and still hold; only their line numbers moved.
- `T:path:line` is Tart `Sources/tart/` at 2.40.1, unless a line says 2.38.0.
- `G:path:line` is the Go implementation at `c112847` (on `main`).
- `R:<spike>` is the raw result file `88969a9:spikes/<spike>/RESULTS.md`, with
  its driver scripts beside it. The run evidence (logs, status JSON) is under
  `.work/runs/` on this Mac and `~/clankerbox-rewrite/runs/` on the Linux host,
  until the final cleanup.

## Dependency versions

Checked 2026-10-01. Each row says what was actually exercised.

| Dependency | Pinned | Exercised |
| --- | --- | --- |
| smolvm | 1.22.0, plus a one-line `smolvm-bin` patch | Upstream 1.22.0 tarballs, unmodified: on this Mac (unprivileged) and on the Linux host (unprivileged and as root). The patch has not been compiled at 1.22.0; it applies with offsets only. |
| Tart | ≥ 2.40.1 | Audited in source at 2.40.1; S3 ran on 2.38.0. |
| Softnet | 0.24.0 (needs macOS 26) | Audited. It runs its own DHCP server and advertises the gateway as DNS. |
| tart-guest-agent | ≥ 0.15.0 | Audited. Its vsock sockets are close-on-exec. |
| Node | 26.10.0 | SEA built and run on darwin-arm64 and linux-x64 (R:q-sea-min). |
| effect, @effect/platform-node | 4.0.0 (stable, published 2026-10-01 03:11 UTC) | A 666 KB Effect 4.0.0 bundle ran inside a SEA (R:q-sea-min). Nothing else yet. |
| effect-actions | 0.9.0 (published 2026-10-01) | Not yet. Earlier work used 0.8.0. |
| clankerauth-sdk, clankerauth-dev | 0.12.0 (published 2026-10-01) | Not yet. S5 passed on 0.11.0, and 0.11.1 was audited. |
| vite-plus, TypeScript, pnpm | 1.0.0, 7.0.2, 12 | — |

## smolvm claims (1.22.0)

**Lifecycle**

- **Fork-base deletes:** `delete_vm` takes the fork-source lock, checks
  dependent clones and refuses *before* stopping anything
  (S@1.19.0:src/cli/vm_common.rs:2725-2745).
- **`machine start`** returns after the agent is ready and kills the child on
  failure (S@1.19.0:src/agent/manager.rs:2039-2066).
- **`stop`** returns after the process is dead (manager.rs:3109-3199).
  - It requires the guest's shutdown ack (manager.rs:2860-2880).
  - It hard-kills an unreachable VM or an orphaned VMM
    (S@1.22.0:src/cli/vm_common.rs:2394-2396, 2448).
  - Since 1.19.1, a VM that exits after a failed ack counts as stopped, with the
    filesystem sync unconfirmed (S@1.22.0:src/agent/manager.rs:2860-2891).
- **`exec`** refuses a stopped machine (S@1.19.0:vm_common.rs:67-127).
- **`delete`** removes the record only after the process is dead and storage is
  removed.
- **`machine ls`** probes every running VM, up to about 3 s each
  (S@1.19.0:vm_common.rs:3130). Read one machine with `machine status --name X
  --json` instead.
- **Supervision:**
  - The CLI starts the VMM as a detached child in the caller's cgroup
    (S@1.22.0:src/agent/manager.rs:2678).
  - `SMOLVM_BOOT_BINARY` arms a parent-death watchdog
    (S@1.19.0:src/internal_boot.rs:82-110).

**Checkpoints**

- **Capture is atomic:** a temp file, fsync, then publish without clobbering
  (S@1.19.0:crates/smolvm-pack/src/packer.rs:434-484).
- **What smolvm records and enforces:** CPU, memory, disk sizes, platform, CPU
  contract and network (S@1.19.0:src/portable_checkpoint.rs:2802-2932). It does
  not check the engine build or the agent. The 1.19 qualification showed its ABI
  string doesn't change when libkrun state does, so the runtime digest stays
  ours.
- **An incomplete pending RAM directory** makes `start` cold-boot silently
  (S@1.19.0:vm_common.rs:1610-1612).
- **Ports:**
  - A checkpoint with published ports refuses any backend but virtio-net
    (S@1.22.0:src/portable_checkpoint.rs:3507-3509).
  - A restore reuses the checkpoint's host ports verbatim
    (portable_checkpoint.rs:2690-2705, 3495-3509).
- **Custom DNS:** smolvm refuses capturing a machine that has it
  (S@1.19.0:src/portable_checkpoint.rs:2258).
- **Host mounts:** RAM checkpoints refuse them
  (S@1.19.0:portable_checkpoint.rs:2232-2289).

**Network**

- **DNS:** the gateway relays DNS to the host's resolver
  (S@1.19.0:src/data/network.rs:12-45).
- **Publish address:** `-p HOST:GUEST` binds loopback, or `SMOLVM_PUBLISH_ADDR`,
  which the VMM reads (S@1.22.0:crates/smolvm-network/src/tcp_listeners.rs:111-121).
- **Egress floor:** setting `SMOLVM_PUBLISH_ADDR` switches the floor to strict
  (S@1.22.0:crates/smolvm-network/src/egress.rs:128-175).
  - Strict blocks host-LAN, private, loopback and CGNAT ranges. It does **not**
    block the host's public address.
  - The values are `strict`, `metadata` and `off`. Unset means strict once a
    publish address is set.
- **Fork ports:** forks get fresh host ports from 20000–32000
  (S@1.22.0:src/agent/fork.rs:2828-2848).
- **The default guest link is `100.96.0.0/30`,** inside Tailscale's
  `100.64.0.0/10`. It lives inside each VMM, so it only matters if a guest must
  reach a tailnet peer in that /30.
- **TSI also serves `-p`** (R:q-smolvm-stock).

**Identity**

- **What fork and live restore re-mint:** the on-disk SSH host keys,
  `/etc/machine-id` and the hostname, including the restored container's UTS
  namespace (S@1.22.0:src/agent/fork.rs:3022-3197,
  portable_checkpoint.rs:4280-4285).
  - The script retries three times. If it still fails, smolvm stops and deletes
    the clone and the command fails (fork.rs:3770-3783).
  - The earlier audit said restore doesn't re-mint. That was wrong.
- **What is not re-minted:**
  - stop/start;
  - `machine create --from` a pack (it keeps the source's host key);
  - the kernel `boot_id`, which is identical across a source, its fork and its
    restores.
- **A running sshd is not touched.** On OpenSSH 10.0 a fork's inherited sshd
  kept serving the source's key until restarted; on 9.6 it served the new one
  (R:q-smolvm-stock).

**Stock images**

- **Layout:**
  - `machine exec` runs inside a privileged container
    (`/run/smolvm/init container-init`) with no user namespace.
  - The container root is the image layers plus a writable layer on the VM's own
    ext4 disk (`/dev/vda`), mounted with `index=off`.
  - Below it, the VM root is an overlay on smolvm's 48 MiB agent rootfs, shared
    read-write over virtiofs (S@1.22.0:src/agent/launcher.rs:1049).
- **No init:** a service survives as an `exec --detach` child and must be
  launched again on every boot. `machine create --init` runs only on first boot.
- **Status JSON:** `machine status --json` reports a port count, not the ports;
  `machine ls -v` and `agent.config.json` have them. It reports
  `branchable: false` after `start --branchable`, although branching works.
- **Paths:**
  - `SMOLVM_DATA_DIR` applies only on Linux. On macOS, paths resolve through
    `dirs::` from `HOME`.
  - Socket paths are limited to 104 bytes (macOS) or 108 bytes (Linux), so data
    roots must be short.
  - `SMOLVM_AGENT_ROOTFS` is read per process (S@1.22.0:src/agent/manager.rs:1051).
- **The `systemd-resolved` restart failure:** installing it (pulled in by
  `openssh-server`'s recommends) turns `/etc/resolv.conf` into a symlink. Every
  later start then fails with `refresh persistent overlay resolver
  …/upper/etc/resolv.conf: No such file or directory`
  (S@1.22.0:crates/smolvm-agent/src/storage.rs:3341). The machine can't be
  repaired from inside. This is an upstream bug.
- **`pack create --from-vm`:**
  - It keeps uid/gid, setuid/setgid and modes.
  - It drops every xattr, including `security.capability`, because the export
    uses busybox `tar` (S@1.22.0:crates/smolvm-agent/src/main.rs:6634).
  - The pack is self-contained, one flattened layer: 2.2 s to pack, a 79 MiB
    sidecar and a 42 MiB stub. A machine created from it uses 637 MiB.

**Root mode** (R:q-root-linux)

- **Per-VM uid:** as root, smolvm drops each VM to its own uid, from 2000000 up,
  with only the kvm group and no capabilities
  (S@1.22.0:src/process.rs:1305-1345). Each VM's directory is 0700 and owned by
  that uid.
- **Fork and restore uids:** a `machine branch` child runs under its source's
  uid. A restore gets a fresh one.
- **Shared rootfs:** every file in the agent rootfs is world-readable, so the
  VM boots. A guest can mount the root share, but creating files in it fails
  with "Permission denied".
- **Restores:** they use read-only shared RAM and a copy-on-write disk top
  (S@1.22.0:src/portable_checkpoint.rs:3785-3830), confirmed by smolvm's log
  lines.

  | Restore | Private disk | create (first / second) | start |
  | --- | --- | --- | --- |
  | root | about 0.7 MiB | 1.67 s / 0.08 s | 0.77 s |
  | unprivileged | 213 MiB | 2.21 s | 1.27 s |

  Unprivileged, the memory is also copied, in 346 ms.
- **Restore cache:** the extracted checkpoint stays on disk after the restores
  are deleted. The data root stayed at 943 MiB.
- **Restore temp directory:** root restores create `/dev/shm/smolvm-restore`
  and leave it. `SMOLVM_RESTORE_TMPFS=0` turns it off.
- **Scopes:** `SMOLVM_VM_USE_SCOPE=1`, root only, gives each VM, including a
  branch child, its own `system.slice/smolvm-vm-<name>.scope` with
  memory/CPU/task limits (S@1.22.0:src/systemd_scope.rs:117-130, 151-165,
  src/agent/manager.rs:2715-2744).
  - Stopping the launching unit, with the default or `KillMode=control-group`,
    left the VM alive and answering `exec`.
  - Without the variable, the VM died with the unit.
  - A restore under scopes was not run.
- **Parent directories:** smolvm adds others-execute to every directory above
  its data root; `/home/clanker` went from 0750 to 0751.
- **Release ownership:** extracting the release tarball as root keeps the CI
  owner, uid 1001.
- **Egress:** guest traffic leaves as the VM's uid, so `meta skuid 1000` rules
  no longer match it.
- **Published port:** with `SMOLVM_PUBLISH_ADDR=127.0.0.2`, the port listened on
  `127.0.0.2` and `[::1]`, but not on `127.0.0.1`.

**Why not `smolvm serve` or the Node SDK**

- **Serve:**
  - Its only interactive exec is a PTY.
  - It holds the agent rootfs and HOME as process globals.
  - It forces virtio-net and its own egress floor.
  - It gives per-VM cgroups only as root.
- **The `smolmachines` Node SDK:** an N-API addon running the engine in-process.
  - Exec takes no stdin and returns lossily decoded text.
  - The agent rootfs and data root are one per process.
  - It doesn't remove per-VM supervision, it leaves exited VMMs as zombies of the
    host, and it has no stability statement.

## The smolvm patch

The old `runtime.patch` touches 4 files with 7 hunks (R:q-runtime-patch). The
whole patch applies to v1.22.0 with offsets only. Per part:

| Part | Verdict | Reason |
| --- | --- | --- |
| `crates/smolvm-agent/src/main.rs`: the persistent-root overlay mounts with `index=off,redirect_dir=off,metacopy=off`, plus a unit test | **drop** with stock images | It only matters for a mutable OS in the agent's persistent root, which was the old custom Ubuntu base. With stock images, workload writes go to the container overlay on ext4, which already uses `index=off` (S@1.22.0:crates/smolvm-agent/src/storage.rs:4545). |
| `src/agent/manager.rs`: a regression test | **drop** | It only asserts upstream behaviour, unconditional since 1.19. |
| `src/agent/state_probe.rs`: `has_frozen_fork_state` uses `restart_blocking_dependent_clones` instead of `db.dependent_clones` | **keep** in `smolvm-bin`, send upstream | Start lets a source with retained live-fork children cold-restart (S@1.22.0:src/agent/manager.rs:1828, fork.rs:658-690). The state probe counts every child (state_probe.rs:100-127). The restarted source then reads `frozen` (state_probe.rs:57-58), and `stop` refuses (vm_common.rs:2413-2422). |
| `src/cli/vm_common.rs`: `SMOLVM_STOP_REQUIRE_ACK` | **drop** | It does nothing without the env var, and it blocks the last-resort kill that "stop ends in a confirmed state" needs. |

**ESTALE, on the Linux host with unmodified 1.22.0** (R:q-estale-linux):

- **Bare VM on the stock agent rootfs:** reproduced.
  - After a cold boot, `ls` gave `Stale file handle` on `/etc/nsswitch.conf` and
    `/etc/e2scrub.conf`.
  - The kernel logged `overlayfs: failed to get inode (-116)`.
  - The root overlay has `index=Y` (`/sys/module/overlay/parameters/index`).
- **Mechanism:**
  - A copied-up file stores a FUSE file handle (nodeid, generation 0) from the
    virtiofs lower, and libkrun hands out nodeids in a new order on each boot.
  - The error appears only when a stale handle points at a different regular
    file that is already cached. Reproducing it means listing most of the
    filesystem on the second boot before touching the modified files. The first
    procedure didn't do that and gave two false negatives.
  - Turning off `index` alone would not prevent it (from kernel source, not
    tested).
- **`ubuntu:24.04` image machine:** not reproduced in 4 cold restarts with up to
  28 modified files. Container file handles are ext4 handles carrying the
  filesystem uuid. A package install wrote only to the container's layer.
- **Fork-state bug:** confirmed on unpatched 1.22.0. After a cold restart the
  source reads `frozen`.
  - `stop` is refused: "is the fork base for 1 live clone(s) …; stop or delete
    the clones first", although the child was already stopped.
  - `delete --force` is refused too.
  - Deleting the child first works, and stopping the source before the restart
    succeeds.

**Upstream tarball contents** (v1.22.0):

- **Files:**
  - a wrapper `smolvm` script;
  - `smolvm-bin`, ad-hoc signed on darwin with `hypervisor`,
    `cs.disable-library-validation` and `cs.allow-jit`;
  - `lib/`: libkrun 3285db74, libkrunfw b8c9994d (Linux 6.12.95), and MoltenVK,
    epoxy and virgl on darwin;
  - `agent-rootfs/` (Alpine 3.19, 48 MB);
  - 20/10 GiB templates.
- **No license or notice files.**
- **Checksums:** darwin-arm64 `8e6f9d7a…`, linux-x86_64 `00d2f057…`.
- **Templates:** at 1.22, a disk smaller than the template needs host
  `resize2fs` and fails without it (S@1.22.0:src/disk_utils.rs:110-119, 134-150).
  smolvm looks for templates in `~/.smolvm/` first
  (S@1.22.0:crates/smolvm-pack/src/assets.rs:373-403).

## Tart claims (2.40.1)

- **Stop:** `tart stop` is a hard power-off (T@2.38.0:Stop.swift:51,
  VM.swift:273-289). Exit 2 on a stopped VM is success.
- **Clone:**
  - Built in a temp directory under a lock, then moved into place; interrupted
    clones are garbage-collected (T:Clone.swift:95-159, Root.swift:153-161).
  - Since 2.40.1 it refuses an existing destination unless `--overwrite` is
    passed (Clone.swift:58,106).
  - It doesn't require a stopped source (Clone.swift:122-128).
  - It regenerates a colliding MAC (Clone.swift:101-103).
- **Delete:** on a missing VM it exits 2. From 2.40.0 a running VM exits 1
  instead.
- **Two-VM limit:** enforced by Apple, system-wide, including VMs outside
  clankerbox (T@2.38.0:Run.swift:538-555).
- **Why ≥ 2.40.1:**
  - clone refuses an existing destination;
  - delete exit codes are reliable;
  - a control-socket fix stops one accept error from disabling `tart exec` until
    restart;
  - `tart list` no longer fails on running VMs.
- **Softnet:** six of the seven ranges the old code blocked are Softnet's
  default (softnet `lib/proxy/vm.rs:108-125`). The inbound `@host` exception
  existed only so the host could dial the guest.

## Spike results

**S3, exec transport** (2026-09-30, clankerbox 0.11.0 scaffolding):

- **Latency:** echo round trips of 0.2–0.9 ms.
- **First exec:** 150–215 ms on smolvm, about 560 ms on Tart. This sizes the Tart
  forwarder.
- **Throughput:** 70–250 MiB/s bulk. Raw exec on the Linux host: 115 MiB/s in,
  117 MiB/s out.
- **Idle:** streams survived 11+ minutes.

**SEA** (S4, then R:q-sea-min on 26.10.0):

- **Build:** both targets build from this Mac with `node --build-sea` and each
  target's official Node binary; no postject.
- **What works:**
  - Every role, `node:sqlite` (3.53.4, no warning), `node:http`, `fetch` and
    `child_process`.
  - Re-exec through `process.execPath`, including through an `.app` and a
    symlink.
  - A Node flag passed as the first argument reaches the app.
  - The official linux-x64 Node is non-PIE. `--build-sea` adds two read-only
    segments, and the binary runs on the host (glibc 2.43).
- **Sizes:** 145.2 MB (darwin-arm64) and 150.1 MB (linux-x64); gzipped 43.8 MB
  and 47.1 MB.
- **Startup:**
  - `--version`: 40.4 ms on the Mac and 37.1 ms on the Linux host, against
    38.7 ms and 32.3 ms for plain `node -e 0`.
  - An Effect bundle adds about 20 ms (Mac) and 70 ms (Linux), whether or not
    it's in a SEA.
- **Build time:** 6 s for both targets when cached; 25.6 s cold.
- **`execArgvExtension: "none"`** makes the SEA ignore `NODE_OPTIONS`.
- **Code cache and snapshot:** they work only for same-platform builds, so leave
  them off.
- **Signing and notarization:**
  - darwin needs the hardened runtime with `allow-jit`.
  - curl downloads get no quarantine attribute, so notarization is needed only
    for browser downloads.
  - An `.app` wrapper is about 4 more lines.
- **A bundled `.mjs` plus a pinned Node** would save about 8 lines. It would cost
  the single-file deploy and our own signing identity, and it would run under
  Node's broad entitlements.

**S5, clankerauth 0.11.0: 10/10.**

- Dev mode embeds `startDisposableIssuer` in-process, with `dataDir` and a fixed
  port.
- Tests use `startFakeIssuer` with a `Clock` override.
- One key can carry grants on several resources (clankerauth-sdk README:228). It
  can be replayed between the hosts it covers, which is acceptable when the
  hosts are equally trusted.

**Stock image on macOS** (R:q-smolvm-stock, unprivileged):

- **Timings:** create 0.04 s; first start 21.6 s with a cold image pull, 1.15 s
  once cached.
- **Disk:** about 200 MiB per machine. The image (113 MiB) and the agent rootfs
  (48 MiB) are shared.
- **sshd:** installed over `exec` and run under `exec --detach`. ssh worked
  through `-p` on virtio-net and TSI, and packages persisted across stop/start.
- **Fork:** `machine branch` took 0.78 s, got a fresh port (30922 → 25785) and a
  new on-disk key.
- **Restores:** two restores of one checkpoint, each 1.2–1.4 s to create, both
  clashed on the checkpoint's port at start. `machine update --remove-port
  30922:22 -p NEW:22`, then `start`, worked for both.
- **Unprivileged, a guest could write the shared agent rootfs.** That is accepted
  for dev.

## Defects in the Go implementation not to port

- **Profile capture:** tar over exec with unprivileged extraction dropped
  uid/gid, xattrs and file capabilities. `pack` keeps uid/gid but still drops
  xattrs.
- **Restore:** it copied the rootfs with plain `cp -a`
  (G:internal/host/checkpoint_runtime.go:438-444). This is moot now that there
  is no per-machine rootfs copy.
- **Tart stop:** it had no forced fallback, so a hung guest failed stop after
  90 s.
- **Supervision:** VM jobs ran in the caller's cgroup, with unit files and
  daemon-reloads per VM. Root mode needs neither.
- **`pendingRAMFiles`:** it re-derived smolvm's private hashed VM directory
  (G:internal/host/checkpoint_runtime.go:296-310), and
  `SMOLVM_DISABLE_READONLY_RESTORE=1` existed only to keep that probe valid.
- **Recorded reasons that were wrong:** the per-machine copy was blamed on a
  readiness marker (the real reason was isolation), and the docs promised
  private copies that forks didn't give.
