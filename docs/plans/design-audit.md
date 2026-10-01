# Design audit before the rewrite

Status: findings from 2026-09-30 and 2026-10-01, folded into
[typescript-rewrite.md](typescript-rewrite.md) on 2026-10-01. The plan is
authoritative; this file keeps the evidence. Its spike table and phase numbers
are superseded by the plan's. This file is deleted with the plan.

Why this exists: the RAM fork review showed that most of fork's cost was our own
wrapping of smolvm, not smolvm. Five audits then checked every mechanism the
rewrite would carry over against the dependency it wraps.

Notation:
- `S:` is smolvm at the pinned commit `572bb694` (v1.19.0), read with
  `git -C ~/ws/pers/not-mine/smolvm show 572bb694:<path>`.
- `C:` is this repository (the Go implementation).
- `T:` is Tart (`Sources/tart/`) at 2.38.0 unless a line says 2.40.1, `GH:` is
  Ghostty (re-checked at the pin `492300ca` and at main `76895d97`), `CD:` is
  Clankerdesk.
- **Unverified** marks claims made from reading code only.

**Versions.** The audits first ran against the versions the Go release pins
(smolvm 1.19.0, Tart 2.38.0, the Ghostty pin, Node 26.8.2). Every dependency that
had moved was then re-audited at its latest release; see the table below. `S:`
citations are at 1.19.0 unless marked `S@1.22.0:`; every one was re-checked at
1.22.0 and still holds, with moved line numbers.

## Dependency versions

The rewrite uses the latest release of every dependency. Checked 2026-09-30:

| Dependency | Audited or spiked | Latest | Moved | Re-audit |
| --- | --- | --- | --- | --- |
| smolvm | 1.19.0 (`572bb694`) | 1.22.0 | yes | done: every cited claim still holds at 1.22.0 (line numbers moved); serve and the Node SDK stay out; see decision 7 and the `--store` spike |
| Tart | 2.38.0 | 2.40.1 | yes | done: floors and clone change folded in |
| Softnet | 0.23.0 | 0.24.0 | yes | done: needs macOS 26 |
| tart-guest-agent | main, 0.14.1 | 0.15.0 | yes | done: floor ≥ 0.15.0 |
| Ghostty (libghostty-vt, no releases) | `492300ca` (2026-09-04) | main `76895d97`, +309 commits | yes | done: API additive only, snapshot codec untouched, still no compatibility guarantee; re-run the S2 filter and snapshot tests on the new wasm (ANSI DECRQM is now answered, CAN/SUB cancel OSC, RIS resets the palette, Unicode 18 widths) |
| Node | 26.8.2 | 26.10.0 | yes | done: re-run S1/S4. 26.9.0 changed the Linux `--build-sea` layout for non-PIE inputs (#65564) and added an optional read-only asset VFS (#65675); 26.10.0 makes stream reads views into a shared 64 KiB slab (#64455), so retained output must copy chunks; `child.kill()` after a failed spawn no longer signals Node's own group (#65054); `node:sqlite` binds `undefined` as NULL. Seed images still pin 26.8.2. |
| clankerauth-sdk, clankerauth-dev | 0.11.0 | 0.11.1 | yes | done: an unknown key triggers a key-list read (at most one per 5 s), so new keys work within seconds, not "about a minute"; unknown or garbage keys now cause issuer reads. Revocation and the 24 h outage window are unchanged. Re-run S5. |
| node-pty | 1.1.0 | 1.2.0-beta.15 (no stable since 1.1.0) | — | done: use the beta source, built as in S1. 1.1.0 leaks a `/dev/ptmx`, the slave and a kqueue fd per spawn on macOS (#882, #931), fatal for a long-lived Tart guest; the beta also closes fds ≥ 3 in the Linux PTY child. Its native `resize` now takes 5 arguments. Re-run S1 counting fds across repeated spawns. |
| pnpm | 12 | 12.8.1 (`latest`; 12.8.2 untagged) | — | — |
| Zig (Ghostty WASM build) | 0.16.0 | 0.16.0 | no | — |
| effect, @effect/platform-node | 4.0.0-rc.118 | 4.0.0-rc.118 | no | — |
| effect-actions | 0.8.0 | 0.8.0 | no | — |
| vite-plus | 1.0.0 | 1.0.0 | no | — |
| TypeScript | 7.0.2 | 7.0.2 | no | — |

## The rule

Before wrapping a dependency operation, ask five questions:

1. **Duplicated bookkeeping.** Does the dependency (or another part of
   clankerbox) already track this? Example: smolvm tracks fork lineage and
   refuses deleting a fork base; we checked it again in the controller and host.
2. **Owning what the dependency owns.** Are we deleting its files or managing its
   processes, and so needing proofs it doesn't? Example: `abandonFailedBranch`.
3. **Unrecorded choices.** Every layout choice, limit and timeout carries a
   recorded reason. Example: one smolvm inventory per machine on Linux had none.
4. **Our comments are not evidence.** "Keep, because X" in the Go code is checked
   against the dependency's source or docs at the pinned version.
5. **Re-audit on every bump.** The rewrite uses the latest release of each
   dependency. A bump re-checks that dependency's claims here, not just the tests,
   because what a dependency guarantees is exactly what changes between releases.

This rule goes into the plan as a standing design rule.

## Summary by bin

### Settled by "simpler and less code"

These go straight into the plan pass.

- **One smolvm inventory per host** on both OSes (D8). No smolvm-side reason for
  per-machine inventories exists (S:src/db.rs:9-27 is built for concurrent VMs;
  socket paths are bounded by a hash directory, S:src/agent/manager.rs:292-303).
  This deletes `StoreID`, per-store template staging and the cross-store port problem.
- **Let smolvm refuse fork-base deletes.** `delete_vm` takes the fork-source lock,
  checks dependent clones and refuses *before* stopping anything
  (S:src/cli/vm_common.rs:2725-2745). Map its error to `Precondition`; delete both
  `machineDependencies` copies.
- **Ports: superseded by decision 9.** This item first deleted ports entirely.
  Decision 9 brings them back in lean form: allocation at create from a fixed
  range, smolvm's own fork remap (S:src/cli/machine.rs:4666-4668), the
  `machine update` swap after restore, and `SMOLVM_PUBLISH_ADDR`. Still deleted:
  the lease registry (C:internal/host/ports.go), `SourcePort` and
  `port_min/port_max`.
- **Delete the `DNS` knob.** smolvm's gateway relays DNS to the host's resolver
  (S:src/data/network.rs:12-45) and smolvm itself refuses capturing a machine with
  custom DNS (S:src/portable_checkpoint.rs:2258).
- **Trust smolvm's exit codes.** `machine start` returns after the agent is ready
  and kills the child on failure (S:manager.rs:2039-2066); `stop` returns after the
  process is dead (S:manager.rs:3109-3199); `exec` refuses a stopped machine
  (S:vm_common.rs:67-127); delete removes the record only after death and storage
  removal. Delete `waitState` polling on Linux, the pre-exec inspect and the 3–4
  inspections per start/delete. Read one machine with `machine status --name X
  --json`, never `machine ls` (it probes every running VM, up to ~3 s each,
  S:vm_common.rs:3130).
- **Stay on the smolvm CLI, not `smolvm serve`.** Serve's only interactive exec is
  a PTY (S:src/api/handlers/exec.rs:448-533), it holds the agent rootfs and HOME as
  process globals, forces virtio-net and its own egress floor, and gives per-VM
  cgroups only when running as root. (Its main API is a Unix socket; the
  `127.0.0.1:10081` listener is the guest-rollout port and is overridable.) The
  Node SDK is not an alternative either. It is the npm package `smolmachines`
  (repository `smol-machines/smol`, released in lockstep with smolvm, 1.22.0 embeds
  smolvm `f40f42c`); the copy inside the smolvm repository is stale. It is an N-API
  addon running smolvm's engine in-process, with `_boot-vm` helper processes. Two
  blockers, each sufficient:
  - exec takes no stdin and returns output as lossily decoded text, so the binary
    guest link can't use it (smolvm has a stdin-capable exec internally, not
    exposed);
  - the agent rootfs and data root are one per process (set once, read from the
    environment on every boot, fork and checkpoint), but we need one rootfs per
    machine.

  It also doesn't remove per-VM supervision (unprivileged VMMs stay in the host's
  cgroup), leaves exited VMMs as zombies of the host, and has no stability
  statement (12 releases in 10 days). Rechecked at 1.22.0.
- **Linux VM supervision:** the CLI starts the VMM as a detached child in the
  caller's cgroup (S:manager.rs:2678), so each VM still needs its own
  cgroup-independent job. Use `systemd-run --user --collect` with kill properties;
  no unit files, no daemon-reload. Lingering stays required. Never set
  `SMOLVM_BOOT_BINARY` (it arms a parent-death watchdog, S:src/internal_boot.rs:82-110).
- **VM jobs never reference the clankerbox binary,** only smolvm or tart, installed
  under a directory keyed by runtime digest. A clankerbox release that doesn't
  change the runtime then leaves running VMs alone.
- **One stop rule for both runtimes:** graceful, bounded wait, then forced.
  - smolvm: upstream `stop` already requires the guest's shutdown ack
    (S:manager.rs:2860-2880). `runtime.patch` hunk 4 (`SMOLVM_STOP_REQUIRE_ACK`)
    only forbids the last-resort kill, and `delete` ignores it anyway
    (S:vm_common.rs:2780-2830). It prevents D5's "stop ends in a confirmed state".
    Drop the hunk and the env. At 1.22.0 this still holds: without the hunk,
    upstream hard-kills an unreachable VM or an orphaned VMM
    (S@1.22.0:vm_common.rs:2394-2396, 2448). Since 1.19.1 a VM that exits after a
    failed ack counts as stopped, with filesystem sync unconfirmed
    (S@1.22.0:manager.rs:2860-2891).
  - Tart: `tart stop` is a hard power-off (T:Stop.swift:51, VM.swift:273-289), so
    keep the in-guest `shutdown -h now`, then `tart stop --timeout 0` as the
    fallback. Today there is no fallback: a hung guest fails stop after 90 s. Drop
    the redundant `sync`. Exit 2 on a stopped VM is success.
- **Checkpoint pin is `(runtimeDigest, revisionId)`.** smolvm records and enforces
  cpu, memory, disk sizes, platform, CPU contract and network
  (S:src/portable_checkpoint.rs:2802-2932). It does not check the engine build or
  the agent, and the 1.19 qualification showed its ABI string doesn't change when
  libkrun state does, so the runtime digest stays ours. Profile name, host ID and
  base ID leave the pin (they made a rename invalidate restores).
- **Trust smolvm's atomic capture.** It writes a temp file, fsyncs, then publishes
  without clobbering (S:crates/smolvm-pack/src/packer.rs:434-484). Delete the
  post-capture checks and re-chmod; keep only removing `checkpoints/<id>/` after a
  crash, as hygiene.
- **Stop reading smolvm's private directory layout.** `pendingRAMFiles` re-derives
  smolvm's hashed VM directory (C:checkpoint_runtime.go:296-310), and
  `SMOLVM_DISABLE_READONLY_RESTORE=1` exists only to keep that probe valid. The
  guard itself is justified: an incomplete pending directory makes `start` cold-boot
  silently (S:vm_common.rs:1610-1612). Keep one check, derive the path from
  `smolvm machine data-dir`. Whether smolvm runs as root is decision 7.
- **Tart:**
  - Softnet stays (it keeps guests off the LAN and the host), but reduces to
    `--net-softnet-block=@host`. Six of the seven blocked ranges repeat Softnet's
    default (softnet `lib/proxy/vm.rs:108-125`), and `in @host` existed only so
    the host could dial the guest. Record the coupling: blocking `@host` also
    blocks gateway DNS, which is why the image pins public resolvers.
  - Delete `tart ip`, `HOME=<root>` for tart (test on removal: keychain) and the
    refusal to replace a live launchd job (only needed because Start rewrote the
    plist). Write the plist once at create; start is `launchctl print` →
    bootstrap if absent → `kickstart` without `-k`.
  - `tart set --random-serial` once per clone; `--random-mac` is redundant (clone
    already regenerates a colliding MAC, T:Clone.swift:101-103).
  - Trust Tart's clone: it builds in a temp directory under a lock and moves it
    into place; interrupted clones are garbage-collected (T:Clone.swift:95-159 at
    2.40.1, Root.swift:153-161). Since 2.40.1 clone refuses an existing destination
    unless `--overwrite` is passed, checked under its lock (Clone.swift:58,106): map
    "already exists" to a precondition error and never pass `--overwrite`. One rule
    stays ours: clone doesn't require a stopped source (Clone.swift:122-128), so
    "Tart copies a stopped disk" stays.
  - `tart delete` on a missing VM exits 2 ("does not exist"); from 2.40.0 a running
    VM exits 1 instead (before that it was misreported as missing). Delete the
    before and after inspections.
  - **Version floors:** Tart ≥ 2.40.1 (clone refusal, reliable delete exit codes, a
    control-socket fix that kept one accept error from disabling `tart exec` until
    restart, and `tart list` no longer failing on running VMs); tart-guest-agent
    ≥ 0.15.0 (its vsock sockets are close-on-exec, so our long-lived guest daemon no
    longer inherits the agent's listener); Softnet 0.24.0, which requires macOS 26
    and runs its own DHCP server advertising the gateway as DNS, so blocking `@host`
    still blocks DNS and the pinned public resolvers stay.
  - The two-VM limit is enforced by Apple, system-wide, including VMs outside
    clankerbox (T:Run.swift:538-555). Keep a cheap admission count from `tart list`,
    and map the native refusal to `Capacity` when the launchd job exits.
- **Host core** (from the first-principles review, under the stateless controller):
  - No stored machine state: running/stopped/missing comes from the runtime.
  - One durable write before a native effect (`accepted → started`). At startup
    `started` becomes `failed, uncertain`; nothing is replayed past `started`.
  - Native errors are either certain refusals (`failed`) or anything else
    (`failed, uncertain`). Nothing is released without an explicit delete, so no
    proofs are needed.
  - Busy checks against real operation columns (`machine_id`, `source_id`,
    `checkpoint_id`); revision references enforced by foreign keys; builder and
    validation VMs are machine rows, so capacity counts them and a failed cleanup is
    an ordinary delete.
  - IDs carry their host, so the stateless controller routes by prefix. Names are
    unique per host and resolved by fan-out.
  - Idempotency without fingerprints: a known key with the same action returns the
    existing operation; a different action is a conflict. Operations are kept.
  - The host sends the expected machine ID on every guest connect; the guest runs
    new-machine handling on a mismatch. This makes the post-fork/restore call
    self-repairing and removes the `prepared` flag.
- **Guest:**
  - Delete every buffer budget except one small reply cap; the credit window and
    one Input in flight replace them. Delete the output ring. Keep the 48-session
    cap as a memory guard (a terminal is 7.4 MiB typical, 34 MiB worst case, and
    never shrinks), exempting the start session. Bound retained ended sessions by
    count or bytes now that they are in memory.
  - End sequence: `kill(-pid, SIGHUP)` or close the master, then TERM, then KILL.
    The foreground-group HUP can't be done from Node (node-pty exposes only the
    process name).
  - Keep `/var/lib/clankerbox/machine-id` as the identity contract (clankercreds
    reads it; Tart has no smolvm equivalent; smolvm's re-mint of `/etc/machine-id`
    covers fork and restore only, S:src/agent/fork.rs:2955-3136).

### Decisions (all closed)

Decision 9 removed sessions from clankerbox, which closes 1–5: each is kept below
for the record, marked with what decision 9 did to it.

1. **Terminal query answering. Closed by 9:** no session engine in clankerbox;
   Clankerdesk's session daemon owns it. In Ghostty's C/WASM API, `WRITE_PTY` is the one
   master switch: with it unbound every reply is computed and dropped
   (GH:src/terminal/c/terminal.zig `writePtyTrampoline`; state tracking is
   independent of effects, `terminal.h:57-59`). Other callbacks don't gate
   individually: DA is still answered with defaults when only `DEVICE_ATTRIBUTES`
   is unbound. Checked at the pin and at main `76895d97`. A CLI session attached to
   a real terminal could leave `WRITE_PTY` unbound and let the real terminal answer. That deletes
   `queries.go` (314 lines), `omit_answered_queries`, `terminal_profile` and
   `SetColors`. Clankerdesk uses none of them. It contradicts plan line 262.
   Security: VM programs' queries then reach the real terminal, but queries the
   engine doesn't answer already pass through today (OSC 52 clipboard read,
   CSI 14/16/18 t), so it isn't a new exposure.
2. **Closed by 9: the start-command gate goes;** start ordering is the profile's.
   Was: session creation waits up to 120 s for the machine's start command
   (C:internal/guest/daemon/service.go:236). No ADR records it. Keep or drop.
3. **File copy. Closed by 9:** scp and rsync over the guest's sshd. Host mounts are ruled out: RAM checkpoints refuse them
   (S:src/portable_checkpoint.rs:2232-2289), they can't be hot-added, and on macOS
   the share is an escape channel. What remains is pipe sessions (tar over the
   session stream) or smolvm's single-file `machine cp` (4 GiB cap, smolvm only).
4. **Interactive `clankerbox shell`. Closed by 9:** deleted; use `ssh` to the
   reported `host:port`.
5. **Guest delivery and upgrades. Closed by 9:** there is no clankerbox guest
   daemon. What remains is the preparation contract run over the runtime's exec
   (machine-id file, `machine.json` env, start command, the after-fork/restore
   hook); the session daemon is upgraded by Clankerdesk over ssh. Was: the host-core review proposes a
   digest of the guest-facing contract, checked on connect. Mismatch refuses
   sessions with a typed error; lifecycle keeps working because it uses only the
   runtime's exec. That is the "contract digest" option from earlier.
6. **Host-hop TLS. Decided: drop it.** Hosts and the controller join the user's
   Tailscale tailnet (personal-cloud work, out of scope here), which encrypts and
   authenticates the hop; the clankerauth key per request stays. Deletes the CA,
   host certificates, `tls_ca`, the `pki` directories and rotation. Wherever this
   file says WireGuard address, read tailnet address.
   Background: Today (personal-cloud
   `hosts/clankerbox-controller/{config.json,nftables.conf,hetzner-wg-guard.nft}`):
   the controller (192.168.20.32) reaches Linux at `https://10.203.112.1:8444`
   over a point-to-point WireGuard link that admits only controller → 8444, and
   the Mac at `https://192.168.50.15:8444` across the home LAN through one UniFi
   rule. The plan keeps a host server certificate verified against `tls_ca`
   plus a clankerauth key per request, and drops client certificates. Options:
   keep that; or drop TLS where the hop is already inside WireGuard (Linux) and
   put the Mac on WireGuard too, leaving clankerauth as the only app-level
   check.
7. **Run smolvm as root on Linux. Decided: root on the production Linux host,
   unprivileged in dev**, after two spikes: the per-machine rootfs is readable by
   the dropped per-VM uid, and whether `SMOLVM_VM_USE_SCOPE` replaces our
   `systemd-run` jobs (if not, `systemd-run` in both modes, system manager in
   production). Deploy changes: system units, state out of `/home/clanker`, and
   the `skuid 1000` egress rule in `hetzner-wg-guard.nft` becomes a uid-range or
   cgroup match.
   Background (new at 1.22.0): Several smolvm features only
   work with a root engine that drops each VM to its own uid:
   - restoring a checkpoint's disk as a copy-on-write top and sharing RAM read-only,
     instead of private copies (S@1.22.0:portable_checkpoint.rs:99-172, 3795-3830);
   - per-VM cgroup scopes via `SMOLVM_VM_USE_SCOPE=1` on the system bus, which
     could replace our per-VM `systemd-run` jobs (S@1.22.0:manager.rs:2718-2744;
     unverified end to end);
   - a separate uid per VM, which is stronger isolation than today.

   Production runs smolvm as user `clanker` with systemd user units. Root is a
   larger privilege on the host; unprivileged keeps today's model and the slower
   private copies on ext4.

   Upstream's convention: laptops and `smolvm machine run` are unprivileged; server
   nodes ("smolfleet nodes, the Kubernetes shim") run as root
   (S@1.22.0:docs/pack-layer-ownership.md:20-21). Running as root turns the per-VM
   uid drop on by default (`SMOLVM_VM_UID_DROP=off` opts out,
   S@1.22.0:src/process.rs:1282-1287), and `serve` then moves state to
   `/var/lib/smolvm`. The standalone security model scopes state to the invoking
   user (S@1.22.0:docs/security-model.md:10).
8. **Multi-host placement (future).** With a stateless controller, a same-key retry
   reaches the same host only while profile → host is unique. Several hosts per
   platform will need either every pool host reachable at placement or a key → host
   record in the controller. Not needed now.
9. **Who owns guest access. Decided: A and B as below, and our session daemon
   becomes a separate guest program owned by Clankerdesk.** Clankerbox needs only lifecycle, preparation
   and a way to say where a machine is reachable; sshd and sessions can be the
   profile's. Two separable choices: A (who owns the guest side) and B (how it
   is reached).
   - **Lead option: the profile owns the guest side (A).** The profile ships sshd,
     and zmx or tmux if wanted; its start command launches them; its
     `authorized_keys` carries the user's key. Clankerbox keeps lifecycle,
     preparation over the runtime's exec (machine-id file, `machine.json` env,
     start command), a declarative `expose` list in `profile.json`, reporting
     where each machine is reachable, and recording its identity. This deletes
     D1–D3 as session machinery, the guest daemon, the Ghostty engine in the
     guest, the session relay in host and controller, and the orphan-reaper
     requirement. Decisions 1–4 go away (copy is scp/rsync, the shell is ssh,
     the gate is the profile's own start ordering); decision 5 shrinks to the
     preparation contract. Given up: LOST, the final screen, session records
     across guest restarts, and labels and the start flag as clankerbox
     concepts.
     - **Identity becomes the SSH host key.** After preparation, read the host
       public key over exec, store its fingerprint on the machine and return it
       from status; clients pin it. That replaces expected-machine-ID-on-connect.
     - **smolvm forks re-mint identity.** Fork rejuvenation, fail-closed, gives
       the clone a new hostname, `/etc/machine-id` and SSH host keys
       (S@1.22.0:src/agent/fork.rs:3219-3260). It runs on forks only, not on
       checkpoint restore, and it doesn't touch RAM: a running sshd keeps the
       old key until restarted. So preparation after fork *and* restore must
       re-mint the keys where smolvm didn't and restart sshd: one declarative
       profile hook.
   - **Reach (B): published ports, or exec as a fallback.** smolvm `-p HOST:GUEST`
     binds host loopback, or the address in `SMOLVM_PUBLISH_ADDR` (read in the
     VMM: S@1.22.0:crates/smolvm-network/src/tcp_listeners.rs:105-121). On the
     WireGuard address, clankerbox leaves the data path entirely. What it costs:
     - **virtio-net for every reachable machine.** Checkpoints with ports refuse
       anything else (S@1.22.0:src/portable_checkpoint.rs:3505-3509). TSI stays
       for machines without exposure.
     - **Setting `SMOLVM_PUBLISH_ADDR` switches the egress floor to strict**
       (host LAN, private and CGNAT ranges blocked;
       crates/smolvm-network/src/egress.rs:118-165). Pin `SMOLVM_EGRESS_FLOOR`
       explicitly either way.
     - **Forks get fresh host ports from smolvm** (fork.rs:2828-2848,
       20000–32000). Create takes explicit host ports, so clankerbox picks one
       (bind-probe below the ephemeral range, as smolvm does) and smolvm's
       record keeps it.
     - **Restore reuses the checkpoint's host ports verbatim**
       (portable_checkpoint.rs:2690-2705, 3495-3509). Restoring while the
       source runs, or twice, clashes at start. That is why the Go code swaps
       ports with `machine update` after restore; that step comes back.
     - **Auth is sshd's.** Anything on the WireGuard mesh can reach the port;
       keys and the pinned host key are the protection.
     - **Tart** has no port publishing; the guest has a Softnet IP on the Mac's
       private NAT subnet, reachable from the Mac only. `guestIP:22` works for
       clients on the Mac. It reverses two Tart items above: keep the inbound
       `@host` exception in Softnet, and keep `tart ip` (a DHCP lease, so read it
       per status, not once). For clients elsewhere, the Mac either runs a small
       TCP forwarder per exposed port on its WireGuard address (same `host:port`
       shape as smolvm), or routes the subnet into WireGuard (OS config, no code,
       but every guest port becomes reachable). Routing is not available on
       smolvm: virtio-net is a userspace gateway inside each VMM, every guest
       defaults to `100.96.0.2/30` (inside Tailscale-style CGNAT space), and no
       host interface exists to route to
       (S@1.22.0:crates/smolvm-network/src/lib.rs:122-180). TSI guests have no
       IP at all. On smolvm, `-p` is the forwarder.
     - **Network: the user's Tailscale tailnet (in progress, out of scope).**
       smolvm's default guest link `100.96.0.0/30` sits inside Tailscale's
       `100.64.0.0/10`; it lives inside each VMM, so it only matters if a guest
       must reach a tailnet peer whose address falls in that /30 (smolvm can
       draw the link from another subnet).
     - **No WireGuard mesh exists today.** The only clankerbox WireGuard link
       is controller ↔ Hetzner, guarded to controller → 8444. The laptop is on
       the UniFi admin WireGuard (192.168.110.10), which doesn't reach Hetzner.
       Clankerdesk runs in a policed Docker network whose egress is "DNS, edge
       controller/wtf" (platforms/deploy/NETWORK-POLICY.md:40). B needs a
       network where Clankerdesk and the laptop reach guest ports on both
       hosts: personal-cloud work (WireGuard peers and firewall rules), not
       clankerbox code.
     - **Tart clients are elsewhere on WireGuard (answered), so the Mac
       forwards.** Two ways to reach the guest from the forwarder:
       - Dial `guestIP:port`: keeps the Softnet inbound `@host` exception and
         `tart ip`, and brings back macOS Local Network permission, so darwin
         ships as the `.app` wrapper (reverses plan D9; Go needed it for exactly
         this dial).
       - **Recommended: each accepted connection runs `tart exec -i` into the
         guest's `nc 127.0.0.1 <port>`.** No guest IP, no Softnet exception, no
         Local Network permission; the audit's Tart deletions stand. Costs
         ~560 ms per connection (S3) and depends on the Tart agent (already
         required). The forwarder lives in the host process, so a host restart
         drops Tart connections (smolvm's `-p` listeners live in the VMM).
       - Either way the port is allocated by the same code as smolvm create.
     - **Fallback** if the spike fails: `ssh -o ProxyCommand="clankerbox pipe
       MACHINE -- sshd -i"` (and `ssh2` with a custom socket in Clankerdesk).
       Same ownership; clankerbox stays a dumb pipe. `--expose-socket` is the
       other fallback (spike below).
   - **zmx 0.8.1** (MIT, Zig, one maintainer, pre-1.0; binaries for linux and
     macOS on amd64 and arm64) is a session server built on libghostty-vt. Checked in
     source at `54b212d`:
     - It keeps sessions across detaches, supports labels and lists sessions.
       `list` output is tab-separated text, not JSON.
     - On reattach it serialises the terminal state as VT bytes
       (`src/loop.zig:977-990`), so any client terminal restores it. That would
       delete the Ghostty engine lockstep, the snapshot format and chunking.
     - While no client is attached it answers DA1/DA2 only
       (`src/loop.zig:358-367`, `src/util.zig:257-290`). CPR and colour queries
       go unanswered.
     - When the shell exits, the daemon shuts down and removes the session
       (`src/loop.zig:345-351`, `:780`). No final screen, no exit status for
       attached sessions, and no records surviving a guest restart (no LOST).
     - Several clients can attach at once, with a leader that sets the size. That
       differs from evict-on-open.
     - It has no expected-machine-ID slot. The identity check would move to the
       host, before it tunnels anything.
     - Re-read at `6f80792` for integration:
       - Each session is its own daemon process. It forks and calls `setsid`
         (`src/daemonize.zig`) and listens on its own socket, `$ZMX_DIR/<name>`.
         Names are limited by `sun_path`.
       - The wire format is a 5-field TLV over that socket (`src/ipc.zig`). The
         authors keep it backward compatible on purpose: tags are non-exhaustive
         so old daemons ignore unknown ones, `Info` is frozen, and the client
         sends both resize encodings (#211). Fields are native-endian packed
         structs.
       - `attach NAME [cmd…]` creates the session or attaches to it. That matches
         our create rule (an unknown ID starts, a known ID opens). The cwd is the
         client's cwd; the size comes from `TIOCGWINSZ` and later SIGWINCH, and
         falls back to 24x120 without a TTY (`src/main.zig:1572-1640`,
         `src/loop.zig:18-50`). So an attach needs a PTY on the client side.
         Ctrl+\ detaches unless `ZMX_NO_DETACH_KEY` is set.
       - Input from a non-leader becomes leader input once it looks like user
         input (`src/loop.zig:893-908`).
       - Each client's output buffer is unbounded (`src/loop.zig:398-411`). A
         stalled reader grows daemon memory instead of stalling the program, so
         the relay must always drain and keep our Gap rule.
       - Scrollback is 10,000 lines (`src/cfg.zig:12`).
       - `run` types the command into a bash in the PTY and scans for a
         completion marker. It is not an exec. Pipe sessions stay on the
         runtime's exec.
       - Exited daemons orphan to PID 1, so the orphan-reaper requirement covers
         them too. Sessions must be created under a long-lived subreaper.
     - What Clankerdesk uses (CD:terminals.ts:120-140, 300-317;
       guest-mirror.ts:99-102):
       - the final screen, with its own mirror's screen as a fallback;
       - `exitCode`;
       - LOST.

       It doesn't use pipe sessions. A session wrapper (`argv; code=$?;
       zmx history --vt` and the code into a file, then exit) could supply the
       final screen and exit code from inside the still-live session; spike it.
       LOST can be derived from a `boot_id` change plus the session missing from
       `zmx list`.
   - **Our session daemon as a separate guest program (user's proposal).**
     Clankerdesk's profile ships it; clankerbox never sees it. Reach it through
     the guest's sshd, not a port of its own: Clankerdesk opens an SSH
     connection and runs `sessiond connect` (or a streamlocal forward) into its
     Unix socket, the D2 pattern with ssh in place of the runtime's exec. sshd
     then supplies auth, encryption, flow control (SSH channel windows replace
     the D1 credit window) and identity (the pinned host key). It keeps LOST,
     the final screen and exit codes. It lives with Clankerdesk, so the Ghostty
     engine lockstep is one repository's problem, and Clankerdesk can upgrade it
     over the same connection (copy the binary, restart). The orphan-reaper
     requirement moves with it.
   - **tmux**: mature, but reattach redraws only the visible screen, history lives
     inside tmux (copy mode), and a browser terminal becomes a tmux client.
   - **Our own daemon** (the current plan): exact snapshots, a final screen, LOST,
     and a query filter, at the cost of the Ghostty lockstep and the session code
     in phases 3 and 5.
   - Upgrade angle: a tunnelled third-party CLI tolerates version skew far better
     than our binary protocol, but its upgrades are then out of our hands.
   - Cost not to undersell: host and controller become byte relays but stay, flow
     control stays end to end, and Clankerdesk's `terminals.ts`, `guest-mirror.ts`
     and `guest-terminal.ts` would drive a zmx client over a PTY stream instead of
     the session API.

### Requirements (not choices)

- **An orphan reaper in the smolvm guest.** The smolvm agent is PID 1 and has no
  global `waitpid(-1)` reaper (S:crates/smolvm-agent/src/main.rs:7224 says so);
  spike S1's "the agent will reap" is wrong. Node can't be a subreaper. Launch the
  guest daemon under a minimal reaper (a `tini -s`-style wrapper). The Go daemon has
  the same exposure today. Live-check first. Tart's init is launchd.
- **The Tart guest agent runs as a root LaunchDaemon** in image preparation. The
  `sudo -n` relay, the sudoers dependency and `privilegedScript` exist only because
  the Cirrus images start it as a per-user LaunchAgent; the agent documents the
  daemon mode for exactly this. (Our own guest daemon stays host-launched on both
  runtimes, so the host can later replace it.) Pin the agent version (≥ 0.15.0).

### Spikes (verified by code reading only)

| Spike | Gates |
| --- | --- |
| smolvm `pack create --from-vm` as profile capture: works on our Ubuntu lower, keeps ownership, pack time and size. It produces delta-on-base revisions, against ADR 0008's "self-contained". | phase 4 (builds) |
| The 2.1 GiB agent rootfs in every checkpoint: capture tars the whole lower (S:src/portable_checkpoint.rs:1239) and restore unpacks it again; smolvm assumes ~29 MB. Measure with smolvm's `restore_*` log spans before designing. | phase 4 (checkpoints) |
| Read-only template install making `stageTemplates` unnecessary; whether the compact 512 MiB templates are still needed at 1.19. | phase 4 |
| macOS smolvm: one host launchd job with `AbandonProcessGroup` versus one plist per VM. | phase 4 |
| Tart third VM: fast refusal or a hang until timeout. | phase 4 |
| Concurrent smolvm CLI calls against one inventory (gates raising the native-call semaphore). | phase 4 |
| smolvm `--store` checkpoints instead of single files: the restore cache and `checkpoint-warm` (1.22.0) and dedupe apply only to store checkpoints; the agent rootfs tar cache applies only to single files. Measure both. | phase 4 |
| `runtime.patch` hunk 1 (overlay `index=off,…`): does ESTALE reproduce without it? Hunk 3 is an upstream inconsistency worth sending upstream; hunk 2 is test-only. | phase 4 |
| Linux PTY master fds leaking into other sessions (node-pty doesn't set `O_CLOEXEC`); `sh -c 'sleep 999 &'` exit detection and the post-exit drain (node-pty uses 200 ms, Go 2 s). | phase 3 |
| Query round trip over the exec channel, if decision 1 goes the lean way. | phase 3 |
| On Linux, `child_process` pipe-session children inherit PTY masters (libuv forks without closing extra fds; macOS spawns with `POSIX_SPAWN_CLOEXEC_DEFAULT`). | phase 3 |
| smolvm `--expose-socket GUEST:HOST` (since v1.6.4, `b310083f`; missed by the audits): libkrun bridges a guest Unix socket to a host Unix socket over vsock (S@1.22.0:src/agent/launcher.rs:1732-1800), which could replace `exec -i` + `guest connect` in D2. Check: whether forks and restores inherit `published_sockets` and can override `HOST_PATH` (a pinned path shared by a fork and its source would collide; the default path is inside smolvm's private per-VM directory, which we said to stop reading); close propagation across the bridge; behaviour while the VM is stopped; macOS libkrun. Tart has no equivalent, so D2's exec path stays there. | phase 4 |
| zmx as the session layer (decision 9):<br>• `smolvm machine exec -t` and `tart exec -t` driven from a host node-pty, with resize forwarding<br>• the exit wrapper for the final screen and exit code<br>• detached CPR and colour queries with Claude Code and fish<br>• subreaper placement for session daemons<br>• memory per session<br>• attaching a newer client to an older daemon | phase 3 |
| Profile-owned access (decision 9 A+B) on the Linux test host: a virtio-net machine with `-p` on the WireGuard address and a pinned `SMOLVM_EGRESS_FLOOR`; sshd in the profile; fork (fresh port, re-minted key after sshd restart), restore beside a running source (port clash and the `machine update` swap), a second restore from the same checkpoint (host key re-mint in preparation); RAM fork and checkpoint on virtio-net; ssh, scp and rsync from a laptop. | phase 1 (gates the plan shape) |
| Tart forwarder: WireGuard listener → `tart exec -i` → guest `nc 127.0.0.1 22`; ssh and rsync throughput, idle survival, and whether accepting on the WireGuard interface needs Local Network permission (outbound is gated; inbound unverified). | phase 1 |
| Re-run spikes on the latest versions: S1 and S4 on Node 26.10.0 with node-pty 1.2.0-beta.15, S2 on Ghostty main, S5 on clankerauth-sdk 0.11.1. | phase 1 |

### Defects in the Go implementation

Not rewrite risks, but things to fix rather than port:

- **Profile capture loses ownership.** Tar over exec with unprivileged host
  extraction drops uid/gid, xattrs and file capabilities (C:docs/profiles.md says
  so).
- **Fork children share their source's writable lower.** The guest can write the
  agent rootfs through `/oldroot` (S:crates/smolvm-agent/src/main.rs:1125-1459,
  virtiofs `read_only=false` at S:src/agent/launcher.rs:1028,1052). The per-machine
  copy is therefore an isolation boundary, not a performance choice, and fork
  families break it. No read-only option exists in smolvm; that is an upstream ask.
- **Restore copies the rootfs without copy-on-write.** `restoreRAM` runs `cp -a`
  without the reflink/clone flags `materializeImage` uses (C:checkpoint_runtime.go:438-444).
- **Zombie processes in smolvm guests** (see Requirements).
- **Tart stop has no forced fallback** (see Settled).
- **Recorded reasons that are wrong:** `docs/lifecycle-performance.md` blames the
  per-machine copy on a readiness marker (the real reason is isolation), and
  `docs/module-contracts.md` promises private copies that forks don't give.

## Conflicts between audits, resolved

- **Per-machine rootfs copy:** one audit proposed a per-revision read-only directory,
  but smolvm has no read-only option for the lower. The copy stays, for isolation.
- **Profile capture:** tar pipeline versus pack export is a spike; the tar path is
  the fallback, and its ownership loss is a defect either way.
- **Machine identity:** our file stays the contract; smolvm's re-mint is a bonus.
- **Guest daemon launch on Tart:** host-launched (for the upgrade seam); only
  Tart's own agent becomes a root LaunchDaemon.
- **Fork-base delete ordering:** closed. smolvm refuses before stopping.

## Clankerdesk migration additions (phase 8)

- `GetMachine` answering `not_found` means deleted (today it reads `machine.deleted`,
  CD:apps/server/src/machines.ts:366,379).
- `admissionRefusals` (CD:apps/server/src/machine-recovery.ts:32-43) maps to the new
  tags; `Unavailable` must stay out of it, so an offline-host submission stays
  unconfirmed and is replayed with the same key.
- `unresolved` disappears; `LOST` becomes not-found on reconnect.
- Session create repeats reopen the existing session (plan correction).
- `guest-mirror.ts` is a rewrite: offsets, `offset === cut`, `Resized` ordering and
  ack timeouts all go.
- The checkpoint dialog says Tart needs a stopped source but never stops it: either
  the Tart module stops and captures, or Clankerdesk adds the stop.
