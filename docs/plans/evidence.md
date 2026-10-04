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
- `N@v26.10.0:path:line` is Node's source at that tag, `E@4.0.0:` effect,
  `PN@4.0.0:` @effect/platform-node (both from their npm tarballs) and
  `EA@v0.9.0:` effect-actions.

## Dependency versions

Checked 2026-10-01. Each row says what was actually exercised.

| Dependency | Pinned | Exercised |
| --- | --- | --- |
| smolvm | exactly 1.22.2, upstream and unmodified, installed by the operator | 1.22.0 on this Mac (unprivileged) and on the Linux host (unprivileged and as root); 1.22.2 on this Mac (unprivileged) and on the Linux host as root (phase 0: P1, P3, P8). |
| Tart | ≥ 2.40.1 | Audited in source at 2.40.1; S3 ran on 2.38.0; P2 ran on 2.40.1 (release tarball, checksum verified). |
| Softnet | 0.24.0 (needs macOS 26) | Audited. It runs its own DHCP server and advertises the gateway as DNS. |
| tart-guest-agent | ≥ 0.15.0 | Audited. Its vsock sockets are close-on-exec. P2 ran on 0.14.1 (the old pipeline's seed), P3 on 0.15.0 (stock Cirrus image). |
| Ubuntu (smolvm base) | 26.04 LTS, `ubuntu:26.04` (resolute), digest-pinned in host config, from `mirror.gcr.io/library/ubuntu` | On Docker Hub with amd64 and arm64 builds. The tag moved: index digest `sha256:3595d7fc…` on 2026-10-02, `sha256:f144425f…59f7` on 2026-10-04. Run on smolvm 1.22.2 as root in phase 0 (guest reports 26.04.1 LTS), pulled from Docker Hub. mirror.gcr.io answered an anonymous manifest request for `sha256:f144425f…59f7` with 200, and its `26.04` tag carried that digest, on 2026-10-04; smolvm's seed build and a guest pull from it have not run yet. |
| boat.dev API | v1 (`https://boat.dev/api/v1`) | Three spikes on 2026-10-02 against an account on boat's trial, calling the API directly (L:boat). Docs and `openapi/boat-v1.yaml` read the same day. |
| Node | 26.10.0 | SEA built and run on darwin-arm64 and linux-x64 (R:q-sea-min). |
| effect, @effect/platform-node | 4.0.0 (stable, published 2026-10-01 03:11 UTC) | A 666 KB Effect 4.0.0 bundle ran inside a SEA (R:q-sea-min). P5: an effect-actions server and client in a SEA on both targets. |
| effect-actions | 0.9.0 (published 2026-10-01) | P5, inside a SEA, including 330 s calls. |
| vite-plus, TypeScript, pnpm | 1.0.0, 7.0.2, 12 | P5: `vp pack` bundled the spike, tsc 7.0.2 strict, pnpm 12.5.1. |

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
- **Locks:** `manager.rs` and `fork.rs` take `flock`s; `vm_common.rs` has none
  of its own and takes `fork.rs`'s fork-source lock in `stop_vm_named` and
  `delete_vm` (S@1.22.2:src/cli/vm_common.rs:2367-2371, 2760-2761). Concurrent
  CLI calls on different machines are safe, except a new prefix's first use
  (P12, under "Phase 3").
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

**Packs** (no design of ours uses them since smolvm `disk` checkpoints were
dropped in the phase-4 review; kept as smolvm's behaviour at 1.22.2)

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

**Native names** (checked in phase 2):

- **smolvm:** a VM name is at most 128 characters, starts with a letter or
  digit, uses only `[A-Za-z0-9_-]`, and has no `--` and no trailing `-`
  (S@1.22.2:src/data/mod.rs:58-98). The scope name `smolvm-vm-<name>.scope`
  adds nothing stricter (src/systemd_scope.rs:151-163). The rule for
  checkpoint and store names was not found.

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
- **Names:** a local VM name only has to be free of `/`
  (T:Commands/Clone.swift:43-46).
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
- **Names (D:):** a named snapshot's name must match
  `^[a-z0-9][a-z0-9-]{0,62}$` (`boat-v1.yaml` lines 2371 and 2449, sha256
  `79aa87e2…f210`, fetched 2026-10-04). A display name is 1–120 characters.
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

## Phase 0 spikes (2026-10-04)

Run with `scripts/work_runs.py`. smolvm ran as root on the Linux host, from a
1.22.2 prefix install (L:smolvm-install, L:p8-disk, L:p1-ports, L:p3-smolvm).
Tart ran on this Mac (L:p2-tart-forwarder), and the SEA on both (L:p5-pins).
Single samples unless a count is given.

**P5, pins and long calls** (L:p5-pins):

- **Versions:** pnpm 12.5.1 resolved effect 4.0.0, @effect/platform-node 4.0.0
  and effect-actions 0.9.0 exactly. effect-actions has no dependencies; its
  peers are `effect ^4.0.0` and an optional MCP client. platform-node depends on
  undici 8.11.2 and declares `redis >=5 <7` as a required peer, so pnpm installs
  redis 6.3.0; subpath imports keep it out of the bundle.
- **Module layout at effect 4.0.0:** `effect/http`, `effect/http-api` and
  `effect/cli` are top-level subpaths of `effect` (its `package.json` exports).
- **No timeout of effect-actions' own:** a 330 s unary call replied 200 after
  330.01–330.02 s, through `HttpApiClient` and through `ActionHttpClient.promise`,
  once the transport's timeouts were off. EA@v0.9.0:src/ has no timer outside
  its MCP module.
- **Node 26.10.0's fetch** bundles undici 8.10.2, with `headersTimeout` and
  `bodyTimeout` both 300 000 ms (N@v26.10.0:deps/undici/src/lib/dispatcher/client.js:316-317);
  0 disables them. With defaults the 330 s call failed at 300.9 s with
  `UND_ERR_HEADERS_TIMEOUT`, and the server interrupted the handler at the same
  moment (499).
- **Turning them off:** Node has no public API for it. Observed working at
  330 s: a per-request or global undici `Agent({headersTimeout: 0,
  bodyTimeout: 0})` from npm undici pinned to `process.versions.undici`; a
  wrapper around Node's undocumented `undici.globalDispatcher` symbol; and
  `NodeHttpClient.layerNodeHttp` (`node:http`), which sets no timeout at all
  (PN@4.0.0:src/NodeHttpClient.ts:402-470). `NodeHttpClient.layerUndici` forces
  `headersTimeout` to 1 h after the caller's options
  (PN@4.0.0:src/NodeHttpClient.ts:152-170), so it can't run a longer mutation.
- **Server defaults at 26.10.0:** `requestTimeout` 300 000, `headersTimeout`
  60 000, `keepAliveTimeout` 5 000 and `timeout` 0
  (N@v26.10.0:lib/_http_server.js:537-562, 665). 330 s handlers replied under
  them.
- **Closed input:** effect-actions decodes with `onExcessProperty: "error"`
  (EA@v0.9.0:src/ActionHttp.ts:187-192). The Effect client refuses an
  undeclared field before sending. On the wire, a group without a `schemaError`
  policy answers 400 with an empty body; a group whose policy maps to a tagged
  `Invalid` (status 400) answers `{"_tag":"Invalid","message":…}`.
- **Client disconnect:** an aborted request interrupts the handler in the same
  millisecond (PN@4.0.0:src/NodeHttpServer.ts:213-215); effect-actions doesn't
  shield it (EA@v0.9.0:src/internal/implementation.ts:93-110).
- **SEA:** `vp pack` made one 3.4 MB ESM bundle (773 KB gzipped) with
  `deps.alwaysBundle` and code splitting off, since platform-node imports its
  undici module dynamically. SEAs were 148.3 MB (darwin-arm64) and 153.5 MB
  (linux-x64), built in 1.5–2.4 s. Short calls took 11–16 ms in process (35 of
  35 OK on darwin; 32–40 ms on the Linux host). `NODE_OPTIONS` was ignored.
- **Pins:** `node-v26.10.0-darwin-arm64.tar.xz` sha256 `f222f7e8…28af` and
  `node-v26.10.0-linux-x64.tar.xz` sha256 `ca70e9e3…f022`, matching
  SHASUMS256.txt and R:q-sea-min.

**smolvm install** (L:smolvm-install, L:p8-disk):

- **The installer as written doesn't fit a root host.** `install.sh` aborts
  non-interactively for a prefix outside `$HOME`
  (S@1.22.2:scripts/install.sh:422-438), always links `$HOME/.local/bin/smolvm`
  (:26, 612-615), edits shell rc files unless `--no-modify-path` (:623-668), and
  puts the agent rootfs in `${XDG_DATA_HOME:-$HOME/.local/share}/smolvm/agent-rootfs`,
  never in the prefix (:558-581).
- **The form that worked,** unprivileged, with nothing written outside the
  prefix: `env -i PATH=… HOME=<prefix> TMPDIR=<scratch> bash install.sh
  --version 1.22.2 --prefix <prefix> --no-modify-path`. 1.60 s, 114 MiB. The
  tarball's sha256 `95d62621…b582` matched the release checksums.
- **The agent rootfs must be passed:** with `SMOLVM_DATA_DIR` set, smolvm sets
  `HOME` to the data dir and strips `XDG_*` (S@1.22.2:src/main.rs:132-136), so
  a start without `SMOLVM_AGENT_ROOTFS=<prefix>/.local/share/smolvm/agent-rootfs`
  failed with "agent rootfs not found". The wrapper finds its libraries from the
  prefix (`LD_LIBRARY_PATH=<prefix>/lib`, scripts/smolvm-wrapper.sh:40-46).
- **The prefix is written at runtime:** the first root start expands the
  templates into 20 GiB and 10 GiB sparse files in the prefix
  (crates/smolvm-pack/src/assets.rs:412-440).
- **Machines depend on their prefix:** default-size disks and every overlay are
  qcow2 files backed on the prefix's template files by absolute path, and
  running VMs read the prefix's agent rootfs. An old prefix must outlive every
  machine created under it.
- **Template shadowing** comes from `$SMOLVM_DATA_DIR/.smolvm`, not
  `/root/.smolvm`, and is silent: a bogus template there booted with exit 0. A
  bogus `$HOME/.smolvm` alone was ignored (assets.rs:363-405).

**P8, disk sizing** (L:p8-disk):

- **Workload writes land on the storage disk** (`/dev/vda`): 1 GiB written to
  `/root` grew `storage.qcow2` by 1024.4 MiB and the overlay disk by 0.3 MiB.
  `/tmp` and `/run` are tmpfs.
- **Sizes:** below the 20/10 GiB templates, smolvm makes a sparse copy and runs
  host `resize2fs -f` (about 10 ms; present on the host); above them, a sparse
  copy and a guest-side resize at boot; exactly the default, a qcow2 backed on
  the template (S@1.22.2:src/storage.rs:629-651, src/disk_utils.rs:76-188). The
  host's ext4 has no FICLONE, so the copy is a 2.6 MiB sparse file.
- **Mapping:** `diskGib` → `--storage <diskGib>`, with `--overlay` left at its
  default (a 3 MiB qcow2 that grew at most 0.3 MiB). No compact templates. The
  guest's `/` is 1.6–2% smaller than `diskGib` (5 → 4.90, 40 → 39.35 GiB).
- **A full disk:** `dd` hit ENOSPC at 5 132 451 840 bytes on 5 GiB. Stop then
  succeeded, but the next start failed with "crun create failed".
- **Image references:** `ubuntu:26.04@sha256:…` (tag plus digest) is rejected by
  smolvm's registry parser (S@1.22.2:src/registry.rs:575-587), which then pulls
  in the guest on every create: 26.1 s on the first start, 7.0–7.2 s on each new
  machine. `ubuntu@sha256:…` builds a host seed: 9.31 s first, 1.36 s for the
  next machine.
- **Timings:** create 0.025–0.03 s, stop 0.50 s, cold start 0.49 s. Each VM had
  its own uid and `smolvm-vm-<name>.scope`.

**P1, published ports** (L:p1-ports, then L:p1-tailnet once the Linux host had
joined the tailnet as `hetzner-node`). The first runs used
`SMOLVM_PUBLISH_ADDR=127.0.0.2`:

- **Listeners:** `127.0.0.2:PORT` and `[::1]:PORT`. ssh, scp and rsync from this
  Mac through `ssh -J` worked into a source, a fork and two restores, each on
  its own swapped port, with pinned host keys; a wrong pin was refused.
- **Throughput,** 256 MiB, 2 samples: 28 MiB/s up and 17 MiB/s down from the Mac
  through the jump host; 45–49 up and 18–19 down on the host itself.
- **Fork on Linux as root** (store checkpoint, `create --from`, port swap,
  start, start script): 6.87 s, with a 0.744 s source pause; the store was
  1813 MiB with `--history 0`. Restores from the store: create 2.84–2.86 s,
  start 0.44–0.49 s.
- **Duplicate host keys after RAM restores:** a RAM restore clones the guest's
  CRNG, and the guest has no vmgenid or hwrng. smolvm's re-mint only stirs the
  pool (S@1.22.2:src/fork.rs:3176, 3245-3250). Distinct keys across restores of
  one RAM state: smolvm's own re-mint 4 of 20; a second `ssh-keygen -A` 5 of 7
  (a fork and a restore got the same new key); stirring 4 of 5; stirring plus
  `RNDRESEEDCRNG` 8 of 8. A cold boot (a `disk` restore) gets fresh keys. The
  inherited OpenSSH 10.2p1 sshd kept serving the source's key until restarted.
- **Re-mint plus sshd restart:** 0.15–0.55 s in the guest (26 samples).
- **Probes from a guest:** `127.0.0.1`, `127.0.0.2` and other VMs' published
  ports were refused. Root-owned listeners on the host's public IPv4 and IPv6
  addresses were reachable, and so was the host's sshd on :22. Listeners owned by
  uid 1000 timed out, consistent with production's `meta skuid 1000` rule
  (ruleset read, not changed).

**P3, setup and preparation on smolvm** (L:p3-smolvm):

- **openssh-server without recommends** on stock 26.04: `apt-get update`
  2.22–2.70 s, install 4.71–6.69 s (5 machines); ssh answered 8–9.5 s after the
  first start. 18 packages, no `systemd-resolved` (with recommends: 107,
  including it). `/etc/resolv.conf` stayed a regular file across a cold start.
- **`setsid -f` under plain exec** outlives the exec (checked at 5 s and 30 s).
  With stdio redirected the exec returned in 0.054 s; with inherited pipes, only
  after 5.05 s.
- **Environment:** `/etc/environment` reaches ssh sessions, and daemons launched
  from them, through `pam_env` (`/etc/pam.d/sshd:44`). It does not reach
  `/etc/clankerbox/start` under exec, the daemons it launches, or plain exec.
- **Pack restore:** `pack create --from-vm` 4.69 s (46 MiB stub, 86 MiB
  sidecar), `create --from` 1.70 s, start 0.47 s. It keeps the source's host
  key; re-mint plus restart took 0.35–0.49 s and gave distinct keys (3 samples).
- **gg-linux-dev** fails unmodified on stock 26.04 after 35.1 s: node can't load
  `libatomic.so.1`. With `libatomic1` installed first (2.53 s), the unmodified
  recipe took 81.1 s; create to set-up machine about 98.5 s, using 2.31 GB.
  Stop, cold start and start took 1.26/0.67/0.16 s, and its tools worked after
  the cold start. The recipe installs no sshd, key or `start`.
- **A realistic `start`:** the sshd guard 0.027 s and launching sshd 0.066 s in
  the guest (5 samples each). A full `start` that reads `/etc/environment`
  itself, guards sshd and runs a successful clankercreds sync took 0.80–1.02 s
  per exec (5 samples), and 1.48–1.52 s right after a cold start (2). The sync
  alone took 0.82–0.84 s. (Earlier the same day the service answered HTTP 530
  during its move to garaba-home; failing syncs took 0.64–1.47 s.)
- **Recipe packing on macOS:** `tar` adds AppleDouble `._*` files and
  `LIBARCHIVE.xattr.com.apple.provenance` pax headers, which GNU tar in the
  guest reports. `COPYFILE_DISABLE=1` removes the first; the second also needs
  `--no-xattrs` (or `--no-mac-metadata`).

**P2, Tart forwarder** (L:p2-tart-forwarder, Tart 2.40.1, on an APFS clone of
the old pipeline's `macos-tahoe-vanilla` seed with tart-guest-agent 0.14.1):

- **Latency,** 10 samples: `ssh … true` through the forwarder took a median of
  0.397 s, against 0.103 s direct to the guest IP, so the forwarder adds about
  0.29 s per connection. A bare `tart exec true` takes 0.05 s back to back and
  0.25–0.31 s after an idle gap.
- **Throughput,** 1 GiB through the forwarder: scp 185 up / 165 down MiB/s,
  rsync 202 / 106 (direct: 269 / 227 / 257 / 147). sha256 matched in all 11
  transfers, so `tart exec -i` with `nc` streamed cleanly on 0.14.1.
- **Idle:** 3 of 3 sessions survived 11.5 minutes idle with keepalives off.
- **Tailnet address:** a forwarder bound to this Mac's tailnet address, from a
  shell and as a LaunchAgent, accepted 46 connections with no prompt and nothing
  in the unified log about Local Network. They came from this Mac itself; a
  connection from another tailnet machine is unverified.
- **Ending a connection:** when the ssh client dies, the forwarder closes the
  exec's stdin and everything exits in 0.05 s. When `tart exec` itself is
  killed (a host restart), the guest's `nc` and `sshd-session` stay until the
  session next writes (T:ControlSocket.swift:98-113). The same holds on
  tart-guest-agent 0.15.0 (P3, one sample each for SIGTERM and SIGKILL).
- **Memory:** a raw 1 GiB upload through `tart exec -i` peaked at 2.0–2.4 GiB
  RSS in the host's tart process (stdin is read into an unbounded stream,
  T:Commands/Exec.swift:100-160). Through the forwarder ssh's window kept it at
  18–22 MiB.
- **Boot** (old seed, not the P3 answer for stock images): `tart exec` answered
  25.1 s after `tart run`; `sudo -n true` succeeded for `admin`.
- **From another tailnet machine:** blocked. From the Linux host, a connection to
  a forwarder on this Mac's tailnet address timed out (5 of 5) and the forwarder
  saw nothing. This Mac's tailnet packet filter admits only its own addresses,
  so garaba-home's policy has no rule that lets the Linux host reach it.

**P1 over the tailnet** (L:p1-tailnet), with
`SMOLVM_PUBLISH_ADDR=100.95.240.37`, the Linux host's tailnet address:

- **Listeners:** `100.95.240.37:PORT` and `[::1]:PORT`. ssh, scp and rsync from
  this Mac went straight to the published port, with no jump host and a pinned
  key, into a source, a fork and a restore, each on its own port. sha256 matched
  in 8 of 8 transfers; a wrong pin was refused.
- **Throughput through Tailscale's DERP relay:** this Mac reaches the host only
  through a relay (`hel` from this side; the host side reported `ams`), never
  directly. 256 MiB, 2 samples: scp and rsync about 1.0 MiB/s up and 2.6 down.
  The host's own sshd gave 1.1 / 1.9 over the tailnet and 22.4 / 25.3 MiB/s over
  the public address (64 MiB, 1 sample).
- **Fork:** 7.32 s in total with a 1.28 s source pause; the restore took
  3.28–3.52 s to ready (1 sample each, 2 vCPU / 2 GiB).
- **Guest probes:** root-owned listeners on the host's tailnet IPv4 and IPv6
  addresses were refused in 15–17 ms, and so were the host's sshd on the tailnet
  address, another machine's published port and the guest's own. The IPv4
  refusal is the strict floor's CGNAT rule
  (S@1.22.2:crates/smolvm-network/src/egress.rs:205-213); the IPv6 (ULA)
  refusal is its fc00::/7 rule (egress.rs:228-229). `1.1.1.1:443` was reached.
- **Production's guard** (`meta skuid 1000 … fib daddr type local reject`, and
  its IPv6 twin) also refuses the host's own uid-1000 processes connecting to
  published ports on the tailnet address.

**The RNG reseed, as preparation runs it** (L:p1-tailnet):

- Stock `ubuntu@sha256:f144…` ships `perl-base` 5.40.1 (Essential).
- On 6 restores of one RAM checkpoint: 64 fresh host bytes on stdin into
  `/dev/urandom`, then `ioctl(0x5207)` (`RNDRESEEDCRNG`) through `perl`, both
  exit 0 as root; then `ssh-keygen -A` and an sshd restart. 6 of 6 served keys
  were distinct (8 of 8 with the fork and the restore). Interleaved controls
  without the reseed: 3 of 4; smolvm's own re-mint: 4 of 10.
- The reseed took 0.062–0.084 s per exec (8 samples); re-mint plus restart
  after it 0.19–0.51 s (12).

**P3 on a stock Cirrus image** (L:p3-tart, Tart 2.40.1,
`ghcr.io/cirruslabs/macos-tahoe-base@sha256:87f3aa5c…7377`, the digest of
`latest`, its only tag, on 2026-10-04; macOS 26.6.2, OpenSSH 10.3p1):

- **The seed:** pulled by digest in 280 s; 30.8 GiB on disk.
- **tart-guest-agent 0.15.0** runs as a root LaunchDaemon and as a per-user
  LaunchAgent for the auto-login user `admin`; exec is served by the
  LaunchAgent (uid 501).
- **Exec after boot:** `tart exec` first answered 18.5–32.3 s after `tart run`
  was spawned (5 boots). An exec before the VM runs fails at once (rc 2); one
  sent while it boots blocks until the agent is up, then succeeds.
- **sudo:** `sudo -n true` exits 0; `admin` has `NOPASSWD: ALL`.
- **Exec form:** `tart exec -i <vm> sudo -n /bin/bash -c <script>` passed exit
  codes through, returned stdout and stderr separately, ran as uid 0, and saw
  end-of-input at once with stdin closed (0.07–0.27 s per call, 6 runs).
- **Host keys:** every clone carries the image's keys, so the re-mint is
  needed. `rm /etc/ssh/ssh_host_*; ssh-keygen -A` took 0.22–0.55 s in the
  guest. sshd is started per connection by launchd, so the next connection
  served the new key without a restart (3 of 3).
- **RNG seed:** macOS refuses writes to `/dev/urandom` ("Operation not
  permitted", 15 of 15) and accepts them on `/dev/random`, which reseeds at
  once (xnu-12377.121.6:bsd/dev/random/randomdev.c:178-185,
  osfmk/prng/prng_random.c:413-435). The write took about 0.04–0.08 s.
- **Environment:** there is no `/etc/environment` and sshd's PAM stack has no
  `pam_env`. ssh sessions run zsh and read `/etc/zshenv`; exec and
  `sudo -n bash` read neither.
- **Guest clock** (not verified): the guest seems to boot at the image's build
  time, about 24 h behind, and is stepped forward around the time exec first
  answers.

## Phase 3 (2026-10-04)

**P12, concurrent smolvm CLI calls on one inventory** (L:p12, as root on the
Linux host, 1.22.2, machines 1 vCPU / 1 GiB, 6 per batch):

- **Steady state needs no serializing.** Thousands of concurrent create,
  `start --branchable`, exec, stop, `delete -f`, `status --json`, `ls --json`,
  `update`, captures into one store, `create --from` a checkpoint or a pack,
  `checkpoint-prune` and `pack create --from-vm` calls on different machines
  had no failure or inconsistency caused by concurrency. smolvm guards every
  shared piece itself: the inventory database (WAL, a 15 s busy timeout, one
  row per machine; S@1.22.2:src/db.rs), a per-VM `vm.lock`, the uid
  allocation lock, the store's shared/exclusive lock (prune waits for
  captures), and the image-seed cache lock.
- **First use of a prefix races.** smolvm expands the `.zst` disk templates on
  first use with no lock, through one fixed `<dest>.partial`
  (S@1.22.2:crates/smolvm-pack/src/assets.rs:413-438, 450-465). Six concurrent
  first starts destroyed both templates in 6 of 6 reps; 4 of 6 machines got a
  blank disk and some guests mounted a damaged overlay. With the templates
  written beforehand by `zstd -d --sparse` (byte-identical to smolvm's own
  expansion), 2 of 2 reps were clean.
- **Image seeds only at 20 GiB:** `seedable_image` returns none unless
  `--storage` is the default 20 (S@1.22.2:src/image_seed.rs:184-195). At
  `--storage 8`, first starts took 7.3 s against 1.6 s with a seed, and about 50
  of them in 14 minutes hit Docker Hub's anonymous limit (`ratelimit-limit:
  100;w=3600`, shared with production's address).
- **`pack create --from-vm` fails for a `--storage 20` machine** (`krun_start_enter
  returned: -22`), 36 of 36, and works at `--storage 8`. A failed export leaks
  its helper's scope, `smolvm-vm-pack-fromvm-<pid>-<ns>.scope`, whose name
  can't carry a prefix. Phase 4 met this with `disk` checkpoints, which the
  phase-4 review then dropped, so nothing of ours runs `pack create`.
- **Timings,** concurrent ×6 wall / sequential ×6: first start at 20 GiB
  1.75 / 9.27 s, stop 0.41 / 1.40 s, capture into one store 1.76 / 4.32 s.

**Phase 3 live** (local run `.work/runs/p3-live-83a307cd65ff`, drivers in
`.work/p3-live/`, remote run `~/clankerbox-rewrite/runs/p383`). The host's linux-x64 SEA ran as root in a
transient system unit on the Linux host, listening on and publishing to its
tailnet address, with `ramBudgetMib` 3072. `tests/live/tests/smolvm.test.ts`
ran from this Mac through the CLI, over Tailscale's DERP relay (no direct
path; the 45.3 MiB gzipped SEA uploaded at 0.67–0.94 MiB/s). Machines had
1 vCPU, 512–1024 MiB and `diskGib` 20.

- **Result:** 22 of 22 in the final run, on the committed host and suite. Two
  earlier full runs each failed one test on the smolvm start failure below.
- **Timings,** 3 runs, from the Mac, so each includes a relayed HTTP round
  trip: create with setup (`apt-get install openssh-server rsync`, a packed
  recipe) 10.1–11.8 s; stop 0.67–0.86 s; cold start with preparation
  0.91–0.93 s; start of a running machine (preparation only) 0.30–0.38 s;
  delete of a running machine 0.69–0.72 s; delete after a failed stop
  2.61–2.63 s, of which smolvm's own wait is 2 s. The first create on a fresh
  inventory, which builds the image seed, took 20.4 s.
- **Reseed:** the `/dev/random` write and `RNDRESEEDCRNG` succeed as root in a
  smolvm guest (every create's identity step ran them under `set -e`).
- **SIGHUP:** with sshd started by setup, preparation's re-mint left the
  listener's pid unchanged, and `clankerbox ssh`, pinned to `Machine.hostKey`,
  logged in; a forced re-mint on a running machine changed `hostKey`, the new
  pin worked and the old one was refused.
- **Guest `/var/tmp`** is on the container's overlay root, executable; `/tmp`
  and `/run` are tmpfs.
- **A killed exec:** smolvm SIGKILLs the guest command and every process
  descended from it when its `machine exec` client is signalled. Setup's exit
  trap never ran, and `/var/tmp/clankerbox-setup.*` stayed after a timeout. A
  `setsid -f` child, whose parent exits at once, survived; a background child
  that called `setsid()` while its parent lived did not. Fixed with a guard
  forked out of the tree (`ada19ec`).
- **ANSI colour:** smolvm's log lines, which errors carry, were coloured into a
  pipe until `NO_COLOR=1` (tracing-subscriber 0.3.23, `fmt_layer.rs:739-743`;
  `e154141`).
- **A refused stop:** `/storage` (ext4 on `/dev/vda`) is mounted read-write in
  the container. After `fsfreeze -f /storage` there (that exec never returns),
  `machine stop` failed after about 2 s with "freeze /storage: Resource busy"
  and "guest did not confirm filesystem synchronization; left the VM alive for
  retry". `delete` then killed the scope, deleted the machine and reset the
  scope: no scope, no VM-uid process and no `vms/<hash>` left.
- **Crashes:** a host SIGKILLed during setup came back with the row `failed`
  ("host restarted during create") and the VM running; the setup command and
  file were gone. A host SIGKILLed inside step 3's `machine status` of another
  machine (5 times, by a root watcher on the host's children, 0.67–0.83 s
  after arming) left a `failed` row and nothing native; `delete` removed the
  row. A graceful restart kept VMs running (guest uptime kept rising), with
  the same ports, host keys and machine IDs.
- **Isolation:** a guest's connection to its host's API port on the tailnet
  address was refused, while `1.1.1.1:443` was reached. A decoy native
  `<name>-<8 hex>` stayed running through that name's create and delete.
- **Unexplained smolvm start failure:** 2 of 77 create requests (both the
  first create after the restart test) failed in the first `machine start`:
  the guest pulled the image, with no seed and no warning, then "crun create
  failed: open `…/merged/usr/local/bin/smolvm-fork-ready`: No such file or
  directory". 4 creates around a manual restart didn't reproduce it.
- **Stop after a crash** (re-run `.work/runs/p3-live-1df82ead13ef`, remote
  `~/clankerbox-rewrite/runs/p31d`, 22 of 22 on `6e19274`; the SEA uploaded
  at 0.79 MiB/s over the DERP relay): after the host was SIGKILLed during
  setup, `stop` on the `failed` row stopped the VM and recorded `stop`/`done`;
  smolvm listed the machine `stopped` and no scope remained. After the crash
  inside step 3, `stop` found the machine `missing` and left the row's
  `create`/`failed` as it was.
- **Owned-root layout:** the state dir may be at most 52 bytes;
  `~/clankerbox-rewrite/runs/<4 chars>/scratch/s` is exactly that.

## Phase 4 (2026-10-04)

smolvm `disk` checkpoints were dropped in the phase-4 review, after these runs:
a smolvm checkpoint is always `ram`. Their `disk` results stay as the record.

**P9, restores as root** (L:p9, smolvm 1.22.2 as root on the Linux host, 1 vCPU
/ 1 GiB, `--storage 20`, `--restore-cache-entries 0`; run
`.work/runs/p9-restores-root-76b9d642f3eb`, remote `~/clankerbox-rewrite/runs/p976`):

- **Store `ram` restores** map their RAM read-only and get copy-on-write disk
  tops, as single-file restores do, but share nothing with a sibling: each
  restore materializes the checkpoint into its own directory
  (S@1.22.2:src/agent/manager.rs:405-406, src/cli/machine.rs:4693-4700). Per
  restore: about 725 MiB of private disk (an unlinked RAM file of 466 MiB plus
  242 MiB of disk copies), about 25 MiB of private dirty memory plus page cache
  of its own RAM file, create 0.95–0.98 s and start 0.43–0.47 s. `delete` frees
  all of it; store mode leaves nothing behind, while single-file restores leave
  `vms/_shared/<crc>`.
- **Store capture needs `--branchable`:** a capture of a machine started
  without it fails with `ENOTSUP … deferred durable save requires file-backed
  guest RAM`.
- **A fork's store deleted under its children:** about 3.1 s to a running child
  (capture 1.66–1.71 s with a 0.32 s source pause). No child file, mapping or fd
  pointed into the store; `rm -rf` of the stores freed 910 MiB with no
  `checkpoint-prune`, and all 3 children then answered exec and ssh, stopped,
  cold-started and served their keys.
- **`disk` restores:** `machine create --from <pack>.smolmachine --net
  --net-backend virtio-net -p` works (4 of 4; create 1.74–1.76 s for a pack's
  first machine, 0.12 s for the next; start 0.59–0.69 s; no pull). Each served
  its source's key until preparation re-minted it (5 of 5 distinct after). A
  machine needs 5–7 MiB of its own plus one shared extraction per pack,
  `vms/_shared/<crc>` (430 MiB). The pack file isn't needed after create, but
  the extraction outlives the pack's last machine until `smolvm pack prune
  --all` (src/cli/pack.rs:1474-1499). A pack doesn't carry its source's disk
  size: an 8 GiB source's restores came up at 20 GiB.
- **`pack create --from-vm` fails for a machine on smolvm's image seed** (every
  fresh `--storage 20` machine; 4 of 4, `krun_start_enter returned: -22`): the
  export helper attaches the source's disk as an extra disk, and smolvm mounts
  the root-only seed only for a main disk's chain
  (S@1.22.2:src/internal_boot.rs:240-243, src/pack_export.rs:454-471). Packs of
  a 20 GiB machine restored from a `ram` checkpoint (4.59 s), of an 8 GiB
  machine, and of a 20 GiB machine with `SMOLVM_IMAGE_SEEDS=0` worked.
- **Image seeds:** only for `--storage` 20 or none, on a fresh image machine
  (S@1.22.2:src/image_seed.rs:169-195); the seed key includes the template
  file's identity, so a new prefix builds a new seed (one pull per upgrade).
  `machine resize --storage` grows a seeded machine (stopped or live), and the
  size survives a checkpoint and restore.

**Phase 4 live smoke** (local run `.work/runs/p4-smoke-d12b3a00a9b6`, driver
`.work/p4-smoke/`, remote `~/clankerbox-rewrite/runs/p4d1`, on `58436e7`). The
linux-x64 SEA ran as root in a transient system unit on the Linux host,
listening and publishing on its tailnet address (`publishAddress` left to its
default), and the same binary's CLI drove it on that host, so only the 45.3 MiB
gzipped SEA crossed the DERP relay (0.96 MiB/s). Machines had 1 vCPU, 1 GiB and
`diskGib` 20; the source's setup installed sshd.

- **All steps passed:** a `ram` capture of the running source (1.40 s through
  the CLI), its restore (1.53 s), a fork (3.31 s), a `disk` capture (5.14 s) and
  its restore (3.24 s). Each new machine ran, reported its own port, and
  served the `hostKey` it reported (ssh-keyscan), distinct from the source's;
  each had its own ID in `/var/lib/clankerbox/machine-id`. The `ram` restore
  and the fork kept the source's tmpfs marker; the `disk` restore kept the disk
  marker and lost the tmpfs one. The forks area was empty after the fork.
- **The `disk` checkpoint** came from a 20 GiB machine restored from the `ram`
  checkpoint and then stopped (P9's working case, no pull). smolvm accepted
  `--storage 20` with the pack, and the restore came up at 20 GiB; another
  size wasn't tried. A restored machine cold-started with
  `--branchable` (0.70 s) and kept its key.
- **A `disk` capture of a stopped, seeded 20 GiB create** failed in 0.33 s with
  `krun_start_enter returned: -22`, plus the host's sentence that smolvm 1.22.2
  can't pack a machine on its image seed. It leaked
  `smolvm-vm-pack-fromvm-<pid>-<ns>.scope`, which the run stopped and reset;
  `checkpoint delete` removed the failed row.
- **Deletes:** both checkpoints' deletes left the store at 96 KiB and no pack
  directory. After every machine was deleted, `vms/_shared` still held 430 MiB:
  the `disk` restore's pack extraction, as P9 found.
- **Counts:** 1 image pull (the image-seed build of the run's fresh inventory;
  Docker Hub's IPv6 counter went 99 to 98); 0 pull markers in any output; 0
  `smolvm-fork-ready` failures in 25 CLI calls and the host's journal. No
  `/dev/shm/smolvm-restore` and no `vms/_restore-checkpoints`.

**Phase 4 live** (local run `.work/runs/live-smolvm-9dd402357c3b`, driver
`tests/live/smolvm/driver.py`, remote `~/clankerbox-rewrite/runs/l9dd`; the
host's code as of `9525ed5`). The linux-x64 SEA ran as root in a
transient system unit on the Linux host with `ramBudgetMib` 8192; the suite
ran from this Mac through the darwin CLI over Tailscale's DERP relay (no direct
path; the 45.3 MiB gzipped SEA uploaded at 0.68–0.92 MiB/s), so every timing
includes a relayed HTTP round trip. Machines had 1 vCPU, 512–1024 MiB and
`diskGib` 20. Six suite runs on one inventory, reset in between:

- **Result:** every test passed in the last two runs (25, with the peer check
  skipped, below). The other
  runs failed one test each: a probe of port 53 (smolvm's gateway answers it
  at every address, so the test now probes 100.100.100.100:80), a smolvm stop
  (below), and the crash test's probe racing a start (below).
- **Timings,** 5 runs: `ram` capture of a running 1 GiB machine 1.18–1.25 s;
  fork 2.65–3.31 s; two concurrent `ram` restores of one checkpoint together
  1.64–2.19 s; one `ram` restore 1.32–1.56 s; `disk` capture 4.90–5.03 s;
  `disk` restore 3.06–3.42 s.
- **Disk per child:** a fork or `ram` restore, 241 MiB in its own smolvm
  directory (246920–247116 KiB; its RAM file is unlinked and held by the
  VMM, so `du` doesn't count it; P9: 466 MiB). A `disk` restore, 6–7 MiB of its
  own, plus one shared pack extraction in `vms/_shared` that grew by about
  423 MiB per run and that no delete freed (P9).
- **Verified:** each copy's own port, host key (pinned by `clankerbox ssh`),
  machine ID and instance, with the source's RAM marker for `ram` copies and
  only the disk marker for a `disk` restore; `new-identity` ran once on each
  fork and restore and not on a later stop and start; a fork's source
  stopped, cold-started and deleted while the fork kept its RAM and answered
  ssh, with the forks area empty; a restore under the deleted source's name
  got a new instance and key and its old port (the port swap was skipped); a
  `disk` capture of a 20 GiB machine restored from a `ram` checkpoint;
  `Capacity` for a fork and a restore with no row and the source's action put
  back; a `ram` restore under an edited pin refused with `Precondition` and no
  row; a restart emptying a planted `forks/` entry; checkpoint deletes leaving
  no `.checkpoint` directory and no pack.
- **Tailnet:** a guest couldn't open 100.100.100.100:80, which the host
  reaches; `ip route get` from the host to 100.100.100.100 and to this Mac was
  the same before any machine and with four running. Port 53 opens at every
  address, 10.0.0.1 and 100.64.0.1 included: smolvm's gateway answers it with
  its DNS relay, and the relay didn't resolve a tailnet name (nor does the
  host, whose resolver isn't Tailscale's). The check against another peer
  didn't run: the tailnet policy drops the Linux host's connections to this
  Mac (10 ports timed out, among them the driver's own listener and an sshd
  listening on the Mac's tailnet address), so the control failed and the
  suite skipped it. The phase-4 review dropped the check: the strict floor
  refuses every destination in 100.64.0.0/10
  (S@1.22.2:crates/smolvm-network/src/egress.rs:205-213), which holds every
  tailnet IPv4 address, and in fc00::/7 (egress.rs:228-229).
- **A smolvm stop of a `ram`-restored machine failed once in 24** ("orphan
  process still alive … still alive after stop attempts"); its scope ended
  0.1 ms after smolvm gave up, so the machine was stopped while `stop`
  reported `Internal`.
- **The intermittent start failure explained:** phase 3's "smolvm-fork-ready:
  No such file" came back once as "`/bin/bash` not found in $PATH", again in
  the first create after a restart, with an in-guest pull. Both times the
  crash test's probe ran `smolvm machine exec` while the host's `machine
  start` was still making the guest's container (the exec came before the
  VM's scope started). The probe now
  waits until the host runs setup, and it didn't recur in two runs. The host
  never runs a guest command before its start returns.
- **Counts:** 1 image-seed build (Docker Hub's IPv6 counter went 100 to 99),
  plus 1 in-guest pull in that failed start; 0 `smolvm-fork-ready` failures in
  the suite logs and the host's journal. smolvm's per-VM `agent-console.log`
  records each guest command's arguments, so the preparation script's text
  (not its seed, which goes on stdin) is in every machine's log until delete.
  Accepted in the phase-4 review: the preparation text carries no secret.
- **Rerun after the review fixes** (run `live-smolvm-dc551f1bc155`, remote
  `runs/ldc5`, code as of `3d34da5`; same host, relay and sizes): 23 of 24
  tests passed in 189 s. A `disk` restore of a 1 vCPU / 1 GiB checkpoint,
  now created with `--cpus` and `--mem`, reported 1 CPU and at most 1 GiB of
  MemTotal in the guest; P9's pack restores without them came up at 4 vCPU and
  8192 MiB. The peer check failed, as it now does when its control fails:
  the host again reached no listener on this Mac. Counts: 1 image-seed build
  (Docker Hub's IPv6 counter 100 to 99), no other pull, 0
  `smolvm-fork-ready` failures.

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
