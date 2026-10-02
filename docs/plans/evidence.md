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
- `L:<spike>` is a result file from after the tree was emptied, kept locally
  only: `.work/spike-results/<spike>/RESULTS.md`, with its drivers. It is
  deleted at the final cleanup, so this file carries the numbers.

## Dependency versions

Checked 2026-10-01. Each row says what was actually exercised.

| Dependency | Pinned | Exercised |
| --- | --- | --- |
| smolvm | exactly 1.22.2, upstream and unmodified, installed by the operator | 1.22.0 on this Mac (unprivileged) and on the Linux host (unprivileged and as root); 1.22.2 on this Mac (unprivileged). The Linux runs are not yet repeated on 1.22.2. |
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
  - A reachable guest that doesn't acknowledge and doesn't exit is left alive,
    and `stop` fails with "left the VM alive for retry"
    (S@1.22.2:src/agent/manager.rs:2873-2884). smolvm never signals it.
  - `machine stop` takes only `--name`, and `machine delete -f` only skips the
    confirmation prompt (S@1.22.2:src/cli/machine.rs:5331-5335, 5388-5390).
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
  string doesn't change when libkrun state does, so the checkpoint pin stays
  ours (now the smolvm version, since only upstream releases are used).
- **Pending restore directory:** at 1.19.0 an incomplete one made `start`
  cold-boot silently (S@1.19.0:vm_common.rs:1610-1612). At 1.22.2 it is built
  under a `-partial` name, marked pending, then renamed into place, and a failed
  create rolls the whole machine back
  (S@1.22.2:src/portable_checkpoint.rs:4080, 4237, 4247). So no check is needed;
  this stays a bump claim.
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
  launched again on every boot. `machine create --init` runs only on first boot:
  it sets `init_completed` (S@1.22.2:src/cli/vm_common.rs:1955-1968), although
  its help text says "every VM start" (S@1.22.2:src/cli/machine.rs:3969).
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
  owner, uid 1001. Moot now that clankerbox doesn't ship smolvm.
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
whole patch applies to v1.22.0 with offsets only. **None of it is needed by the
rewrite**, so clankerbox runs upstream smolvm unmodified. Per part:

| Part | Verdict | Reason |
| --- | --- | --- |
| `crates/smolvm-agent/src/main.rs`: the persistent-root overlay mounts with `index=off,redirect_dir=off,metacopy=off`, plus a unit test | **drop** with stock images | It only matters for a mutable OS in the agent's persistent root, which was the old custom Ubuntu base. With stock images, workload writes go to the container overlay on ext4, which already uses `index=off` (S@1.22.0:crates/smolvm-agent/src/storage.rs:4545). |
| `src/agent/manager.rs`: a regression test | **drop** | It only asserts upstream behaviour, unconditional since 1.19. |
| `src/agent/state_probe.rs`: `has_frozen_fork_state` uses `restart_blocking_dependent_clones` instead of `db.dependent_clones` | **not needed**: it only affects `machine branch`, which clankerbox never calls (fork is a checkpoint + restore) | Still unfixed at 1.22.2. Start lets a source with retained live-fork children cold-restart (S@1.22.0:src/agent/manager.rs:1828, fork.rs:658-690). The state probe counts every child (state_probe.rs:100-127). The restarted source then reads `frozen` (state_probe.rs:57-58), and `stop` refuses (vm_common.rs:2413-2422). |
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
- **No license or notice files.** clankerbox no longer redistributes smolvm, so
  none of this needs a notice from us.
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
- **Unprivileged, a guest could write the shared agent rootfs.** Moot now that
  Linux hosts always run as root.

**Fork as checkpoint + restore, single-file checkpoints** (L:fork-restore-mac,
L:fork-restore-linux, 1.22.0, 2026-10-02). The procedure: `machine checkpoint` of
the running source, `create --from`, port swap, `start`, then delete the
checkpoint.

- **Works on both OSes, unprivileged and as root.**
  - Every child continued the source's RAM state: the same ticker process,
    uptime and `boot_id`.
  - Every child got a new SSH host key, machine-id and hostname. The inherited
    sshd served the new key on OpenSSH 9.6p1.
  - Children survived deletion of the checkpoint, then stop and cold start.
- **No lineage:** with children kept (one running, one stopped), the source
  cold-started to `running`, then stopped and deleted cleanly. The children
  kept working. The same steps with `machine branch` reproduced `frozen`.
- **Root uids:** children got fresh uids (2000001–2000003); a branch child
  shares its source's (2000000) because it maps the source's memfd
  (S@1.22.0:src/process.rs:1564-1610).
- **Cost against `machine branch`:**

  | | checkpoint + restore | `machine branch` |
  | --- | --- | --- |
  | Time per fork | 4.2–6 s | 0.65–1.5 s |
  | Source pause, plain source | 0.44–0.92 s; 3.08 s for a 4 GiB guest after writing 1 GiB | 40–110 ms |
  | Source pause, `--branchable` source | 39–112 ms (Mac), about 0.27 s (Linux) | — |
  | Disk per child | 186–188 MiB (Linux), 514–522 MiB (Mac) | about 1 MiB (Linux) |
  | Memory per child | Unprivileged: about +250 MiB `Shmem` (its own RAM copy). Root: reclaimable page cache. | 38–45 MiB |

  - Only restores of the *same* checkpoint as root share RAM pages. Forks don't,
    because each fork has its own checkpoint.
  - On a plain source, the first capture pulls the whole guest RAM resident,
    because the deferred save needs file-backed RAM. A `--branchable` source
    has it and doesn't grow.
  - smolvm marks every restored machine branchable.
- **Single-file restore cache lease:** each restored machine holds a
  `.pack-shared` pointer to `vms/_shared/<crc>/`. Deleting that directory by
  hand made every later `pack prune` fail with "No such file or directory". On
  macOS, a single-file restore extracts into the child's own data dir, so there
  is no shared cache.
- **Scopes:** restores under `SMOLVM_VM_USE_SCOPE=1` work.
- **Unknown names:** `machine stop` on a name smolvm doesn't know returns "vm not
  found" but leaves an empty `vms/<hash>/` directory.
- **Clocks:** the source's guest clock falls about 0.48 s behind per capture,
  until smolvm's 60-second time sync corrects it.

**Restore tmpfs** (L:fork-restore-linux, root):

- **What stages in tmpfs:** only `machine pause` + `machine resume`, never
  `create --from`. As root, every restore still creates an empty
  `/dev/shm/smolvm-restore` (S@1.22.0:src/portable_checkpoint.rs:55-82).
- **What stays there:** a resumed VM keeps its RAM image in `Shmem` (+70 MiB
  here) until it exits, and saves about 75 ms per resume.
- **`SMOLVM_RESTORE_TMPFS=0`:** the directory is never created, and
  `create --from`/`start` cost the same (0.765/0.147 s against 0.785/0.150 s).

**Re-running `start` on a running machine** (L:fork-restore-mac):

- `/etc/clankerbox/start` run via `exec --detach` (0.04–0.06 s) or plain `exec`
  (0.05–0.12 s) starts sshd. Running it again leaves one listener, and after a
  `pkill` it brings ssh back.
- Processes started with `exec --detach` outlive the exec and the host `smolvm`
  command (checked at 5 s and 30 s).
- `pgrep -x sshd` also matches an open session's process. With a session open and
  the listener killed, a script guarded by it did nothing.

## smolvm 1.22.1 and 1.22.2

Released 2026-10-01 and 2026-10-02. Release notes and `git diff v1.22.0 v1.22.2`:

- **`state_probe.rs`, `fork.rs` and the agent's `main.rs`/`storage.rs` are
  unchanged,** so the fork-state, ESTALE and `systemd-resolved` findings hold.
- **RAM prefetch on restored starts** (#1497, #1502): the RAM file is read into
  the page cache in the background during boot. The first commands after a
  restore no longer fault RAM in from disk: about 0.6 s → 0.05 s for 2 GiB
  (S@1.22.2:src/portable_checkpoint.rs, `prefetch_restore_memory`).
- **`create --from … --keep-identity`** skips the identity re-mint ("a resumed or
  rewound machine keeps its own"), for rewinding a machine as itself.
- **libkrunfw moved to a guest kernel with conntrack marks** (#1493, #1494).
- The rest is `serve`/API work (mTLS client CN, closed API input, egress
  amendments) and `machine update --outbound-localhost-only`, none of which
  clankerbox uses.

**`machine branch` depth limit** (L:smolvm-1222-mac):

- **The limit:** `MAX_FORK_DISK_CHAIN_DEPTH = 32` and
  `MAX_FORK_LINEAGE_DEPTH = 32` (S@1.22.2:src/agent/fork.rs:27, 1019).
- **Each single-child branch adds one backing layer** to the source's storage
  and overlay disks.
  - Branches 1–32 took 0.25–0.31 s each.
  - The 33rd failed in 0.05 s with nothing changed: "…/storage.qcow2 already has
    32 qcow2 backing layers; the safe limit is 32. Stop and pack this machine
    into a new root before creating another live fork".
- **What doesn't reset it:** deleting the children, and stopping and
  cold-starting the source. Checkpoint + restore doesn't flatten either: a
  restore of a depth-32 source came back at depth 32, in both checkpoint modes.
- **Batches:** a `--count` batch adds one layer per batch. Batches need
  `smolvm-branch-ready` running in the source.
- **The only reset:** stop (0.23 s), `pack create --from-vm` (1.44 s), then
  `create --from` the pack (2.97 s) and start (0.65 s). That loses RAM and keeps
  the old identity.
- **The fork-state bug is still present at 1.22.2.**

**Fork through the checkpoint store** (L:smolvm-1222-mac, 1 vCPU / 1 GiB, with
the source started `--branchable`):

- **Source pause:** 39 / 170 / 86 ms.
- **Time per fork:** 1.63 / 1.90 / 2.38 s. The first exec ran 0.06 s after start.
  A `machine branch` of the same machine took 0.3 s.
- **Dedup:** the store grew 199 / 271 / 306 MiB, against 195 / 409 / 651 MiB as
  standalone files. The 2nd capture saved 34% and the 3rd 53%, 38% overall.
- **No lease:** a machine restored from a store checkpoint has no `.pack-shared`
  file, no hard links into the store, and no symlinks.
- **Delete and prune are safe:** after deleting every checkpoint directory and
  running `checkpoint-prune`, the children kept running, answered exec and ssh,
  and survived stop and cold start with their new identity.
- **History:** with the default `--history 32`, deleting older checkpoints and
  pruning reclaimed 0 MiB, and deleting the last one reclaimed 769 MiB. With
  `--history 0`, each checkpoint's own objects are freed when it is deleted.
- **Restore cache:** `vms/_restore-checkpoints` (3 entries, about 1.5 GiB real)
  survived every smolvm command, including deleting every machine. Children
  kept working after it was removed. `--restore-cache-entries 0` disables it.
- **Disk per restored child:** 547–1112 MiB, of which the RAM file is
  276–618 MiB and stays until the machine is deleted.
- **Identity:** the SSH host key, machine-id and hostname are re-minted by
  default.

## Plan review findings (2026-10-02)

Facts checked while answering two reviews of the plan. smolvm lines are at
1.22.2.

- **Outbound network:** `machine create --net` means "Enable outbound network
  access" (S@1.22.2:src/cli/machine.rs:3872-3874). `resolve_egress_flags` turns
  it on only for `--net` or an allow list; `-p` doesn't (machine.rs:102-134).
- **Live checkpoint topology:** `create --from` a live checkpoint refuses `-p`,
  `--net` and every other topology flag (machine.rs:4307-4344). That is why a
  restore's ports are swapped with `machine update`.
- **Pack-created machines:** the pack's layers are extracted into the machine's
  own directory once, at create. Later starts don't need the `.smolmachine`
  file; only finishing an interrupted create does
  (S@1.22.2:src/agent/launcher.rs:395-412).
- **smolvm's own locks:** `manager.rs`, `fork.rs` and `vm_common.rs` take
  `flock`s. Whether concurrent CLI calls on different machines are safe is P12.
- **Upstream installer:** `scripts/install.sh --version VERSION --prefix DIR`,
  with `~/.smolvm` as the default prefix and links in `~/.local/bin`
  (S@1.22.2:scripts/install.sh:11-26).
- **Go's Tart exec:** `tart exec -i <vm> sudo -n /bin/bash -c <script>`
  (G:internal/host/guest.go:85). Seeds were prepared by `images/finalize-mac.sh`,
  which wrote the prepared marker (G:images/finalize-mac.sh:59). The old design
  audit records that Cirrus images start tart-guest-agent as a per-user
  LaunchAgent (88969a9:docs/plans/design-audit.md:476-479). Passwordless sudo on
  current images is unverified (P3).
- **Local Network permission:** personal-cloud's runbook for the 0.11.0 Mac host,
  which dialed guest IPs, says a new host build needs a fresh Local Network grant
  (`personal-cloud/hosts/clankerbox-runtime/README.md`).
- **Production hosts:** the Mac host runs Tart only and the Linux host smolvm
  only (`personal-cloud/hosts/clankerbox-runtime/{mac,linux}-host.json`).
- **clankercreds:** it reads `/var/lib/clankerbox/machine-id` as the machine's
  audit-log label and accepts only `^[A-Za-z0-9_-]{1,62}$`
  (clankercreds `apps/cli/src/state.ts:10-18`).
- **cliamp-verify:** its `clankerbox.md` drives the CLI against `cliamp-dev`:
  `create`, `shell -T` with stdin, `fork`, `profile publish`/`logs` and
  `operation`. The tracked recipes are `linux-dev` and `mac-xcode`
  (personal-cloud), `gg-linux-dev` (clankerbox-profiles) and `cliamp-dev`
  (cliamp-verify). The live profile catalog wasn't queried.
- **Long calls:** Node's HTTP server `requestTimeout` defaults to 300 000 ms
  (checked on Node 26.8.2). The undici client behind `fetch` has its own header
  and body timeouts; check their values at 26.10.0.

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
