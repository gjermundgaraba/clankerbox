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
| Ubuntu (smolvm base) | 26.04 LTS, `ubuntu:26.04` (resolute), digest-pinned in host config | On Docker Hub with amd64 and arm64 builds (index digest `sha256:3595d7fc…`, checked 2026-10-02). Not yet run on smolvm; the stock-image runs used 24.04 and 25.10. |
| boat.dev API | v1 (`https://boat.dev/api/v1`) | Three spikes on 2026-10-02 against an account on boat's trial, calling the API directly (L:boat). Docs and `openapi/boat-v1.yaml` read the same day. |
| Node | 26.10.0 | SEA built and run on darwin-arm64 and linux-x64 (R:q-sea-min). |
| effect, @effect/platform-node | 4.0.0 (stable, published 2026-10-01 03:11 UTC) | A 666 KB Effect 4.0.0 bundle ran inside a SEA (R:q-sea-min). Nothing else yet. |
| effect-actions | 0.9.0 (published 2026-10-01) | Not yet. Earlier work used 0.8.0. |
| vite-plus, TypeScript, pnpm | 1.0.0, 7.0.2, 12 | — |

## smolvm claims

**Install**

- **Installer:** `scripts/install.sh --version VERSION --prefix DIR`, with
  `~/.smolvm` as the default prefix and links in `~/.local/bin`
  (S@1.22.2:scripts/install.sh:11-26).
- **Contents** (v1.22.0 tarball): a wrapper `smolvm` script, `smolvm-bin`,
  `lib/` (libkrun 3285db74, libkrunfw b8c9994d with Linux 6.12.95),
  `agent-rootfs/` (Alpine 3.19, 48 MB) and 20/10 GiB templates. There are no
  license or notice files; clankerbox doesn't redistribute any of it.
- **Templates:** at 1.22, a disk smaller than the template needs host
  `resize2fs` and fails without it (S@1.22.0:src/disk_utils.rs:110-119, 134-150).
  smolvm looks for templates in `~/.smolvm/` first
  (S@1.22.0:crates/smolvm-pack/src/assets.rs:373-403).

**Lifecycle**

- **`machine start`** returns after the agent is ready and kills the child on
  failure (S@1.19.0:src/agent/manager.rs:2039-2066).
- **`stop`** returns after the process is dead (manager.rs:3109-3199).
  - It requires the guest's shutdown ack (manager.rs:2860-2880).
  - It hard-kills an unreachable VM or an orphaned VMM
    (S@1.22.0:src/cli/vm_common.rs:2394-2396, 2448).
  - A VM that exits after a failed ack counts as stopped, with the filesystem
    sync unconfirmed (S@1.22.0:src/agent/manager.rs:2860-2891).
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
- **Locks:** `manager.rs`, `fork.rs` and `vm_common.rs` take `flock`s. Whether
  concurrent CLI calls on different machines are safe is P12.
- **Supervision:**
  - The CLI starts the VMM as a detached child in the caller's cgroup
    (S@1.22.0:src/agent/manager.rs:2678).
  - `SMOLVM_BOOT_BINARY` arms a parent-death watchdog
    (S@1.19.0:src/internal_boot.rs:82-110).

**Checkpoints**

- **Running machines only:** capture refuses a machine that isn't running:
  "machine '…' must be running" (S@1.22.2:src/portable_checkpoint.rs:1221-1233).
- **Capture is atomic:** a temp file, fsync, then publish without clobbering
  (S@1.19.0:crates/smolvm-pack/src/packer.rs:434-484).
- **What smolvm records and enforces:** CPU, memory, disk sizes, platform, CPU
  contract and network (S@1.19.0:src/portable_checkpoint.rs:2802-2932). It does
  not check the engine build or the agent. Its ABI string didn't change when
  libkrun state did (1.19 qualification), so the checkpoint pin is ours: the
  smolvm version.
- **Restore directory:** it is built under a `-partial` name, marked pending,
  then renamed into place, and a failed create rolls the whole machine back
  (S@1.22.2:src/portable_checkpoint.rs:4080, 4237, 4247). No check of ours is
  needed.
- **Topology:** `create --from` a live checkpoint refuses `-p`, `--net` and every
  other topology flag; a pack, whose manifest has no checkpoint, accepts them
  (S@1.22.2:src/cli/machine.rs:4304-4344).
- **Ports:**
  - A checkpoint with published ports refuses any backend but virtio-net
    (S@1.22.0:src/portable_checkpoint.rs:3507-3509).
  - A restore reuses the checkpoint's host ports verbatim
    (portable_checkpoint.rs:2690-2705, 3495-3509).
- **Custom DNS:** smolvm refuses capturing a machine that has it
  (S@1.19.0:src/portable_checkpoint.rs:2258).

**Packs**

- **`pack create --from-vm`:**
  - It keeps uid/gid, setuid/setgid and modes.
  - It drops every xattr, including `security.capability`, because the export
    uses busybox `tar` (S@1.22.0:crates/smolvm-agent/src/main.rs:6634).
  - The pack is self-contained, one flattened layer: 2.2 s to pack, a 79 MiB
    sidecar and a 42 MiB stub. A machine created from it uses 637 MiB.
- **Format version:** smolvm writes `FORMAT_VERSION` (1) into every pack and
  reads versions 1–3, so older packs stay usable
  (S@1.22.2:crates/smolvm-pack/src/format.rs:59-73). An unsupported version is
  refused (format.rs:153-156).
- **Machines created from a pack:** the pack's layers are extracted into the
  machine's own directory once, at create. Later starts don't need the
  `.smolmachine` file; only finishing an interrupted create does
  (S@1.22.2:src/agent/launcher.rs:395-412).

**Network**

- **Outbound:** `machine create --net` means "Enable outbound network access"
  (S@1.22.2:src/cli/machine.rs:3872-3874). `resolve_egress_flags` turns it on
  only for `--net` or an allow list; `-p` doesn't (machine.rs:102-134).
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
  launched again on every boot.
- **Status JSON:** `machine status --json` reports a port count, not the ports;
  `machine ls -v` and `agent.config.json` have them. It reports
  `branchable: false` after `start --branchable`, although branching works.
- **Paths:** `SMOLVM_DATA_DIR` places the data root. Socket paths are limited to
  108 bytes on Linux, so data roots must be short. `SMOLVM_AGENT_ROOTFS` is read
  per process (S@1.22.0:src/agent/manager.rs:1051).

**Root mode** (R:q-root-linux)

- **Per-VM uid:** as root, smolvm drops each VM to its own uid, from 2000000 up,
  with only the kvm group and no capabilities
  (S@1.22.0:src/process.rs:1305-1345). Each VM's directory is 0700 and owned by
  that uid. A restore gets a fresh uid.
- **Shared rootfs:** every file in the agent rootfs is world-readable, so the
  VM boots. A guest can mount the root share, but creating files in it fails
  with "Permission denied".
- **Restores:** they use read-only shared RAM and a copy-on-write disk top
  (S@1.22.0:src/portable_checkpoint.rs:3785-3830), confirmed by smolvm's log
  lines. A single-file restore used about 0.7 MiB of private disk, and took
  1.67 s to create (0.08 s for a second one) and 0.77 s to start.
- **Restore cache:** the extracted checkpoint stays on disk after the restores
  are deleted. The data root stayed at 943 MiB.
- **Restore temp directory:** root restores create `/dev/shm/smolvm-restore`
  and leave it. `SMOLVM_RESTORE_TMPFS=0` turns it off.
- **Scopes:** `SMOLVM_VM_USE_SCOPE=1`, root only, gives each VM its own
  `system.slice/smolvm-vm-<name>.scope` with memory/CPU/task limits
  (S@1.22.0:src/systemd_scope.rs:117-130, 151-165,
  src/agent/manager.rs:2715-2744).
  - Stopping the launching unit, with the default or `KillMode=control-group`,
    left the VM alive and answering `exec`.
  - Without the variable, the VM died with the unit.
- **Parent directories:** smolvm adds others-execute to every directory above
  its data root; `/home/clanker` went from 0750 to 0751.
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

## Upstream defects the design avoids

All three are unfixed at 1.22.2: `state_probe.rs`, `fork.rs` and the agent's
`main.rs`/`storage.rs` are unchanged from 1.22.0.

- **Fork-state bug, so `machine branch` is never called:**
  - Start lets a source with retained live-fork children cold-restart
    (S@1.22.0:src/agent/manager.rs:1828, fork.rs:658-690). The state probe
    counts every child (state_probe.rs:100-127). The restarted source then reads
    `frozen` (state_probe.rs:57-58), and `stop` refuses
    (vm_common.rs:2413-2422).
  - Reproduced on the Linux host (R:q-estale-linux): `stop` was refused with "is
    the fork base for 1 live clone(s) …; stop or delete the clones first",
    although the child was already stopped, and `delete --force` was refused
    too. Deleting the child first worked.
  - A fork made by checkpoint + restore has no lineage, so it never arises.
- **ESTALE on bare VMs, so machines always run an image** (R:q-estale-linux):
  - On a bare VM on the stock agent rootfs, after a cold boot, `ls` gave `Stale
    file handle` on `/etc/nsswitch.conf` and `/etc/e2scrub.conf`, and the kernel
    logged `overlayfs: failed to get inode (-116)`. The root overlay has
    `index=Y`.
  - Mechanism: a copied-up file stores a FUSE file handle (nodeid, generation 0)
    from the virtiofs lower, and libkrun hands out nodeids in a new order on
    each boot. The error appears only when a stale handle points at a different
    regular file that is already cached.
  - An `ubuntu:24.04` image machine didn't reproduce it in 4 cold restarts with
    up to 28 modified files. Container file handles are ext4 handles carrying
    the filesystem uuid, a package install wrote only to the container's layer,
    and that overlay already uses `index=off`
    (S@1.22.0:crates/smolvm-agent/src/storage.rs:4545).
- **The `systemd-resolved` restart failure, so setup avoids it:** installing it
  (pulled in by `openssh-server`'s recommends) turns `/etc/resolv.conf` into a
  symlink. Every later start then fails with `refresh persistent overlay
  resolver …/upper/etc/resolv.conf: No such file or directory`
  (S@1.22.0:crates/smolvm-agent/src/storage.rs:3341). The machine can't be
  repaired from inside.

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
- **Softnet:** its default block list already holds six of the seven ranges the
  Go host blocked (softnet `lib/proxy/vm.rs:108-125`). An inbound `@host`
  exception is needed only by a host that dials the guest, which the forwarder
  doesn't.
- **Guest agent and sudo:** Cirrus images start tart-guest-agent as a per-user
  LaunchAgent (88969a9:docs/plans/design-audit.md:476-479). The Go host ran its
  scripts as `tart exec -i <vm> sudo -n /bin/bash -c <script>`
  (G:internal/host/guest.go:85), but on seeds its own `images/finalize-mac.sh`
  prepared (G:images/finalize-mac.sh:59), so passwordless sudo on stock images
  is unverified (P3).
- **Local Network permission:** personal-cloud's runbook for the 0.11.0 Mac host,
  which dialed guest IPs, says a new host build needs a fresh Local Network grant
  (`personal-cloud/hosts/clankerbox-runtime/README.md`).
- **Cirrus images:** `cirruslabs/macos-image-templates` publishes
  `macos-{golden-gate,tahoe,sequoia,sonoma}-base` and `…-xcode:N`, the base with
  Xcode N and Flutter (its README, checked 2026-10-02).

## boat claims (API v1)

`D:` is docs.boat.dev and `docs.boat.dev/openapi/boat-v1.yaml`, read
2026-10-02. Everything else was observed in L:boat, on a trial account with
`type: small` and `noEnv: true`.

- **Account limits (D:, observed):**
  - The trial allows 2 active sandboxes and 5/25/75 starts per
    minute/hour/day. Paid plans raise these (100 active on the $20 plan). A
    subscription in its 7-day trial keeps the trial limits until its first
    payment.
  - Create, fork and resume each count as a start. Two 429 refusals counted
    too (4 → 6 per hour); 403 type refusals and idempotent repeats didn't.
  - The trial refuses `ttlSeconds: null` and anything over 7200 with 400
    `trial_auto_stop_required`. Create and resume default to a 1 h TTL, and a
    fork always does unless the call passes `ttlSeconds` (D:).
  - Types: on the trial, `large` is 403 `trial_machine_class_not_allowed`.
    `xlarge` is 403 `machine_class_plan_required` below the $100 plan.
- **Create (observed):** 202 in about 0.2 s, ready 0.1–2.2 s later. The machine
  had booted 28 minutes before, from boat's pool. The body has no name, tag or
  metadata field (D:, which lists `type`, `ttlSeconds`, `env`, `environment`, `noEnv`,
  `snapshots`, `failFast`, `setupScript`, `org`); `PATCH {name}` sets a display
  name afterwards. `GET /sandboxes` filters by state only. A sandbox echoes
  nothing the client chose: until renamed it is `Box <time>`, and
  `createdBy` is the account's user.
- **Refusals (D:, observed):**
  - 429 `limit_reached` at the active limit, with and without `failFast`, and
    nothing created.
  - `failFast` answers within about 1.5 s, and when no machine is ready it
    returns 503 `no_ready_machine` with nothing started (D:; not seen, the pool
    was warm).
  - A create or fork that finds no machine later ends in state `cancelled`;
    the sandbox is reported once, then 404 (D:).
  - 429 also covers `rate_limited` and `daily_limit_reached` (D:). The 403
    type refusals above created nothing either.
  - An 11th named snapshot is 409 `named_snapshot_limit`.
- **Idempotency-Key (D:, observed):** on create (also with `from`) and fork.
  Same key and body
  return the same sandbox, also after it is ready. Another body is 409
  `idempotency_key_reused`; a retry during creation is 409
  `idempotency_in_progress`. Keys last 24 h, and a create that failed before
  the sandbox existed releases its key within about 2 minutes (D:).
- **noEnv (observed):** no GitHub credentials, `gh` config or model logins in
  the guest, and `holdsCreatorLogins: false`. The guest still has an
  `ASCII_TOKEN`, which D: says is confined to that sandbox.
- **Access (D:, observed):**
  - `POST /sshkey` authorizes a public key for `user`. Its key survives fork,
    resume and named-snapshot deploys in `~/.ssh/authorized_keys`.
  - `ip` is IPv6 or IPv4. `sshEndpoint` is a public IPv4 `host:port` relay to
    port 22, set only when the machine has no IPv4 of its own (D:). All seven
    machines had an IPv6 `ip` and a relay on a 190xx port.
  - SSH streams stdin, returns the exit code, and a 650 s session through the
    relay ran to the end. ssh joins argv into one string.
  - `user` has passwordless `sudo -n`. sshd allows root with a key
    (`permitrootlogin without-password`, no passwords), and its one host key
    (ed25519), read through `POST /commands`, matched `ssh-keyscan`.
  - `POST /sshkey`'s reply also carries the sandbox's `hostKey`, "to pin in
    `known_hosts`" (D:; not tried).
- **Hosted ports (D:, not tried):** `POST /sandboxes/{id}/host {port, public?}`
  opens the sandbox firewall for the port and returns a stable
  `https://<subdomain>-<port>.on.boat.dev` URL. It is HTTPS only, and gated by
  a `_token` query parameter unless `public`. The docs don't say whether it
  survives a stop or a fork.
- **Forwarding (observed):** a connection to a guest port by `ssh -W` through
  the relay took 0.31–0.32 s to a full HTTP response, like a plain `ssh true`
  (0.29–0.33 s). Over a ControlMaster connection it took 0.05–0.07 s.
- **Command API (D:, observed):** `POST /sandboxes/{id}/commands` runs a bash
  string as `user` in `/home/user`. It returns `exitCode`, `signal`, `stdout`,
  `stderr` and `timedOut`. `timeoutSeconds` is 1–600, and a timeout kills the
  command (exit 143). `detached` returns a process ID to poll. There is no
  stdin.
- **Identity (observed):** every create, fork, resume and deploy is a new
  machine, with new SSH host keys, hostname, machine-id and endpoint (seven of
  seven). Snapshots exclude host keys and hostname (D:).
- **Guest image (observed):** Ubuntu 24.04.4, x86_64, with systemd, sshd,
  Docker, Node, Python and preinstalled coding agents. `ufw` is active. The
  image is boat's and not digest-pinned. Sizes are fixed: `small`
  2 vCPU/4 GB/12 GB, `default` 4/8/50, `large` 8/16/125, `xlarge` 16/32/251
  ($100+ plan) (D:). `small` showed 3916 MiB. D: lists the OS as Ubuntu
  24.04 LTS with no other choice.
- **Setup (observed):** as root over SSH, `apt-get update`, `openssh-server`
  without recommends (already installed), a root key, a line in
  `/etc/environment` and a `start` that `setsid -f`s a server took 5.8 s.
  `/etc/resolv.conf` is the systemd-resolved stub. New SSH sessions saw the
  `/etc/environment` line, and the server outlived the setup session.
- **Firewall (D:):** boat's agent listens on TCP 8911, and its HTTPS routes use
  a WireGuard tunnel. A guest rule that blocks either marks the sandbox
  degraded.
- **Snapshots (D:, observed):**
  - Taken about once a minute while the sandbox runs, plus a final one on stop.
    A stop whose snapshot fails is refused and the sandbox keeps running.
  - Observed carried: `/home/user`, `/etc`, `/usr`, `/opt`, `/srv`, `/root`,
    `/var/lib` (including the dpkg database) and `/var/opt`. Observed dropped:
    `/tmp`, `/var/tmp`, `/var/cache`, `/var/log`, processes, and `ufw` rules.
    D: lists a narrower set (`/var/lib` only for Docker volumes and the apt
    database).
  - Enabled systemd units start again after a restore.
- **Fork (observed):**
  - A fork of a running sandbox comes from its latest background snapshot. A
    file written and synced 0.56 s before the fork was missing.
  - Waiting until a snapshot attempt that began after the write had
    `completed` (`lastSnapshotAttemptAt`, `lastSnapshotStatus`,
    `snapshotCompletedAt`) took 40.8 s, and that fork had the file. After
    writing 3 GiB, the wait took 101.8 s.
  - The source keeps running. A fork is ready in 2.2–4.4 s, and a fork of a
    stopped sandbox holds everything up to the stop.
- **Stop and resume (observed):** stop took 2.3–18.9 s to `archived`. Resume
  was ready in 2.4–2.5 s, on a new node.
- **Lazy restore (observed):**
  - At `ready`, the binds (`/home/user`, `/etc`, `/usr`, `/opt`, `/root`,
    `/srv`) are mounted, and their files are fetched on first read. 2 GiB in
    `/home/user` took 24–277 s to read after a restore.
  - `/var/lib` and `/var/opt` are restored in full before
    `/var/lib/ascii-lazy/sys-done` appears. A 1 GiB file in `/var/lib`
    appeared in the same 0.25 s poll as the marker, 9–13 s after the first
    SSH, on a fork, a resume and a restore. It read in about 1 s. Enabled units
    start after that.
  - With little data, 0.4 s after a resume reported ready, `/var/lib`, the
    dpkg record and the unit's run were missing. The unit started 4 s after
    ready.
  - A fresh create had neither `sys-done` nor `hydration-done` within 60 s.
    `hydration-done` hadn't appeared 300 s into the restores of 3 GiB.
  - The marker is undocumented. The documented signal is the
    `sandbox.hydrated` webhook (D:), which needs a public receiver.
- **Named snapshots (D:, observed):**
  - Saving from a running sandbox took 126.7 s. From a stopped one it took
    0.2–1.3 s, and 21.1 s for the first save after writing 3 GiB.
  - An 11th is refused with 409 `named_snapshot_limit`. Re-saving an existing
    name at the cap works.
  - A named snapshot is independent of its source: a deploy after the source
    was deleted had every file.
  - Names are account-wide, and an account keeps at most 10 (D:).
- **Delete (D:, observed):**
  - `DELETE` needs `X-Ascii-Confirm-Delete: <id>`. It returns 202 with an
    operation, and the sandbox answers 404 within 0.2 s.
  - The operation then purges data and sat `blocked` / `waiting_for_uploads`
    with an `expectedBy` 6 h out.
  - A repeated DELETE returns the same operation. Named snapshots survive
    their sandbox's deletion (D:).

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

**Stock image** (R:q-smolvm-stock, on this Mac, `ubuntu:24.04`):

- **Timings:** create 0.04 s; first start 21.6 s with a cold image pull, 1.15 s
  once cached.
- **Disk:** about 200 MiB per machine. The image (113 MiB) and the agent rootfs
  (48 MiB) are shared.
- **sshd:** installed over `exec` and run under `exec --detach`. ssh worked
  through `-p` on virtio-net and TSI, and packages persisted across stop/start.
- **Restores:** two restores of one checkpoint, each 1.2–1.4 s to create, both
  clashed on the checkpoint's port at start. `machine update --remove-port
  30922:22 -p NEW:22`, then `start`, worked for both.

**Fork as checkpoint + restore, single-file checkpoints** (L:fork-restore-mac,
L:fork-restore-linux, 1.22.0). The procedure: `machine checkpoint` of the
running source, `create --from`, port swap, `start`, then delete the checkpoint.

- **Works on both OSes, unprivileged and as root.**
  - Every child continued the source's RAM state: the same ticker process,
    uptime and `boot_id`.
  - Every child got a new SSH host key, machine-id and hostname. The inherited
    sshd served the new key on OpenSSH 9.6p1.
  - Children survived deletion of the checkpoint, then stop and cold start.
- **No lineage:** with children kept (one running, one stopped), the source
  cold-started to `running`, then stopped and deleted cleanly. The children
  kept working.
- **Root uids:** children got fresh uids (2000001–2000003).
- **Cost:**
  - Time per fork: 4.2–6 s (store mode, below, is faster).
  - Source pause: 0.44–0.92 s for a plain source, and 3.08 s for a 4 GiB guest
    after writing 1 GiB. A `--branchable` source paused 39–112 ms (Mac) or about
    0.27 s (Linux).
  - On a plain source, the first capture pulls the whole guest RAM resident,
    because the deferred save needs file-backed RAM. A `--branchable` source has
    it and doesn't grow.
  - Disk per child: 186–188 MiB (Linux), 514–522 MiB (Mac).
  - Memory per child as root: reclaimable page cache. Only restores of the
    *same* checkpoint share RAM pages; forks don't, because each fork has its
    own checkpoint.
  - smolvm marks every restored machine branchable.
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
  and overlay disks. The 33rd failed with nothing changed: "…/storage.qcow2
  already has 32 qcow2 backing layers; the safe limit is 32. Stop and pack this
  machine into a new root before creating another live fork".
- **What doesn't reset it:** deleting the children, and stopping and
  cold-starting the source. Checkpoint + restore doesn't flatten either: a
  restore of a depth-32 source came back at depth 32, in both checkpoint modes.
- **The only reset:** stop (0.23 s), `pack create --from-vm` (1.44 s), then
  `create --from` the pack (2.97 s) and start (0.65 s). That loses RAM and keeps
  the old identity.

**Fork through the checkpoint store** (L:smolvm-1222-mac, 1 vCPU / 1 GiB, with
the source started `--branchable`):

- **Source pause:** 39 / 170 / 86 ms.
- **Time per fork:** 1.63 / 1.90 / 2.38 s. The first exec ran 0.06 s after start.
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

## Consumers and production

- **Production hosts:** the Mac host runs Tart only and the Linux host smolvm
  only (`personal-cloud/hosts/clankerbox-runtime/{mac,linux}-host.json`).
- **clankercreds:** it reads `/var/lib/clankerbox/machine-id` as the machine's
  audit-log label and accepts only `^[A-Za-z0-9_-]{1,62}$`
  (clankercreds `apps/cli/src/state.ts:10-18`).
- **cliamp-verify:** its `clankerbox.md` drives the CLI against `cliamp-dev`:
  `create`, `shell -T` with stdin, `fork`, `profile publish`/`logs` and
  `operation`. Its fork (`clankerbox.md:96-104`) keeps the code shipped to
  `/root/cliamp` for new runs, and no run survives a stop: it needs the disk,
  not RAM.
- **Profile recipes:** `linux-dev` and `mac-xcode` (personal-cloud),
  `gg-linux-dev` (clankerbox-profiles) and `cliamp-dev` (cliamp-verify). The
  live profile catalog wasn't queried, so a production profile without a
  tracked recipe would be missed when the profiles are rewritten.
  - `gg-linux-dev/setup.sh` is 137 lines. It installs vp, Node 26, pnpm, pi,
    Codex, clankercreds, Claude Code, gh and fish, mostly at `latest`, and
    installs `files/` (`clankercreds-config.json`, `clankercreds-key`,
    `machine.json`; 306 bytes). It never runs `clankercreds sync`, so that the
    image carries no credentials.
  - `cliamp-dev` installs docker.io, golang-go, gcc, ffmpeg and PulseAudio.
    cliamp-verify documents DNS in the VM failing intermittently, on the old
    base.
  - Neither setup has been timed.
- **garaba-home** (checked 2026-10-02): its PLAN.md says it replaces
  personal-cloud. `access.ts` denies anything it doesn't name: the admin
  device reaches everything, and its one clankerbox rule lets `tag:apps`
  reach `tag:agent-host` on 8444 for the controller's mTLS identity. PLAN.md
  runs a clankerbox controller on the compute node and has it mint tailnet
  keys for elevated agent profiles.
- **Long calls** (checked on Node 26.8.2 on this Mac): `requestTimeout`
  defaults to 300 000 ms and covers only receiving the request. With it at
  2 s, a handler that replied 5 s after the body arrived returned 200. The
  undici client behind `fetch` has its own header and body timeouts; check
  their values at 26.10.0.

## Defects in the Go implementation not to port

- **Tart stop:** it had no forced fallback, so a hung guest failed stop after
  90 s.
- **Supervision:** VM jobs ran in the caller's cgroup, with unit files and
  daemon-reloads per VM. Root mode needs neither.
- **`pendingRAMFiles`:** it re-derived smolvm's private hashed VM directory
  (G:internal/host/checkpoint_runtime.go:296-310), and
  `SMOLVM_DISABLE_READONLY_RESTORE=1` existed only to keep that probe valid.
