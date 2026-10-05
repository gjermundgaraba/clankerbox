---
name: bump-smolvm
description: Move clankerbox's tested smolvm release to a new upstream release, re-checking every smolvm claim the host relies on.
disable-model-invocation: true
---

# Bump smolvm

clankerbox runs upstream smolvm, unmodified, at exactly one tested release, which
the operator installs into a versioned prefix. A bump re-checks the claims below
against smolvm's source at the target release, not just the tests: the host's
code embodies each one. Fix what broke, report optional opportunities
separately, and don't deploy, change production hosts, or commit unless asked.
A candidate without the live run below is an **unqualified candidate**, not a
qualified release.

## Source and scope

- **Pinned in this repo:** `testedVersion` in `packages/host/src/smolvm.ts` is
  exact: startup refuses any other `smolvm --version`. `pin` derives from it
  (`smolvm <version> <platform>-<arch>`) and is recorded on every `ram`
  checkpoint. The version also appears in tests, docs and examples:
  `git grep -n '1\.22\.2'` (README's install table, host config example and
  install command; `tests/live/README.md`; `tests/live/smolvm/driver.py`;
  `packages/host/tests/{smolvm,store,config,index}.test.ts`;
  `apps/clankerbox/tests/host-role.ts`; `packages/contract/tests/stub-host.ts`).
  Source citations in comments use the form below: `git grep -n 'S@1\.22'`.
- **Target:** the latest stable published `smol-machines/smolvm` release (its
  release metadata, such as `gh release view --repo smol-machines/smolvm`),
  unless the user names one. Not upstream main, an installed binary or a cached
  HEAD. Record old and new tags and commits; if already current, say so.
- **Source:** a read-only cache at `~/.cache/checkouts/github.com/smol-machines/smolvm`.
  Fetch missing tags; read with `git show <tag>:<path>` and
  `git diff <old>..<new>`. Never edit, reset or switch it.
- **Notation:** `S@<tag>:path:lines` is smolvm's source at that tag. Lines are
  locators and move; the identifier beside a citation finds it again. Claims
  cited at 1.19.0 or 1.22.0 were re-checked and held at 1.22.2.
- Read the release notes and the full changed-file list between the tags first,
  then each claim's file. A changelog or a clean build is not evidence.

## Claims to re-check

Each: what smolvm does, where, and what of ours depends on it. A claim that no
longer holds needs a code change and a regression test; one that holds gets its
citation moved to the new tag.

**Install and prefix**

- The installer is `install.sh --version V --prefix DIR --no-modify-path`. It
  aborts non-interactively for a prefix outside `$HOME`
  (S@1.22.2:scripts/install.sh:422-438), always links `$HOME/.local/bin/smolvm`
  (:26, 612-615), edits shell rc files without `--no-modify-path` (:623-668),
  and puts the agent rootfs in `${XDG_DATA_HOME:-$HOME/.local/share}/smolvm/agent-rootfs`
  (:558-581). Ours: README's install command runs it with `HOME=<prefix>`, so
  everything lands in the prefix.
- With `SMOLVM_DATA_DIR` set, smolvm sets `HOME` to the data dir and strips
  `XDG_*` (S@1.22.2:src/main.rs:132-136), so it can't find the agent rootfs on
  its own. Ours: `environment()` sets `SMOLVM_AGENT_ROOTFS=<prefix>/.local/share/smolvm/agent-rootfs`
  and `HOME` at the data dir. `SMOLVM_AGENT_ROOTFS` is read per process
  (S@1.22.0:src/agent/manager.rs:1051). The wrapper script finds its libraries
  from the prefix (`LD_LIBRARY_PATH=<prefix>/lib`, scripts/smolvm-wrapper.sh:40-46).
- The disk templates are expanded on first use, with no lock, through one fixed
  `<dest>.partial` (`expand_template`, S@1.22.2:crates/smolvm-pack/src/assets.rs:413-438,
  450-465). Six concurrent first starts destroyed both templates every time;
  pre-expanding with `zstd -d --sparse` is byte-identical and clean. Ours:
  `templates` in `smolvm.ts`, startup refuses a prefix without them, README's
  install step. If upstream adds a lock, the pre-expansion can go.
- Templates are looked up in `$SMOLVM_DATA_DIR/.smolvm` first, silently (a bogus
  one booted with exit 0); `$HOME/.smolvm` alone is ignored
  (S@1.22.2:crates/smolvm-pack/src/assets.rs:363-405). Ours: nothing writes there.
- Machines depend on their prefix: default-size disks and overlays are qcow2
  files backed on the prefix's templates by absolute path, and running VMs read
  its agent rootfs. Ours: an old prefix stays until its last machine is deleted
  (README).
- Disk sizing: below the template, a sparse copy plus host `resize2fs -f`; above
  it, a sparse copy and a guest-side resize at boot; at the default, a qcow2
  backed on the template (S@1.22.2:src/storage.rs:629-651,
  src/disk_utils.rs:76-188). Workload writes land on the storage disk
  (`/dev/vda`). Ours: `diskGib` is `--storage`, the overlay keeps its default,
  `searchPath` holds the sbin directories for `resize2fs`.
- The host-side image seed is built only for `--storage` 20 or none, on a fresh
  image machine (`seedable_image`, S@1.22.2:src/image_seed.rs:169-195); other
  sizes pull the image inside the guest at first start. The seed key includes
  the template file's identity, so a new prefix builds a new seed. The seed
  builder's scope names are fixed (src/image_seed.rs:381). Ours: README's disk
  note; `tests/live/smolvm/remote.py` (seed scopes).
- The registry parser rejects a tag plus a digest (S@1.22.2:src/registry.rs:575-587)
  and the guest then pulls on every create; `…/ubuntu@sha256:…` builds a seed.
  smolvm's own `docker.io` mirror setting rewrites the reference before the
  pull and the start fails `image not found`
  (S@1.22.2:src/agent/client.rs:1374-1386). Ours: bases are digest-only and
  name `mirror.gcr.io` directly (README, `remote.py`'s `IMAGE`).

**Names and paths**

- A VM name is at most 128 characters, starts with a letter or digit, uses only
  `[A-Za-z0-9_-]`, has no `--` and no trailing `-` (`validate_vm_name`,
  S@1.22.2:src/data/mod.rs:58-98); the scope name `smolvm-vm-<name>.scope` adds
  nothing stricter (src/systemd_scope.rs:151-163). Ours: the contract's `Name`
  rule and `packages/contract/tests/ids.test.ts`; `nativeName` and `scopeName`
  in `smolvm.ts`.
- A machine's sockets live under `<data root>/.cache/smolvm/vms/<16 hex>/`, so
  the control socket's path depends only on the data root
  (S@1.22.2:src/agent/manager.rs:286-306, src/agent/fork.rs:289). Linux allows
  107 bytes. Ours: `controlSocket` and `socketPathMax`; the state dir is at
  most 52 bytes.

**Lifecycle and state** (smolvm's exit codes are trusted; nothing polls around them)

- `machine start` returns once the agent is ready and kills the child on
  failure (S@1.19.0:src/agent/manager.rs:2039-2066).
- `stop` returns after the process is dead. It needs the guest's shutdown ack;
  it hard-kills an unreachable VM or an orphaned VMM
  (S@1.22.0:src/cli/vm_common.rs:2394-2396, 2448); a VM that exits after a
  failed ack counts as stopped. A reachable guest that doesn't ack and doesn't
  exit is left alive and `stop` fails with "left the VM alive for retry"
  (S@1.22.2:src/agent/manager.rs:2873-2884); smolvm never signals it. Ours:
  stop returns that error rather than force it; delete's path.
- `machine stop` takes only `--name`; `machine delete -f` only skips the prompt
  (S@1.22.2:src/cli/machine.rs:5331-5335, 5388-5390). `exec` refuses a stopped
  machine. `delete` removes the record only after the process is dead and
  storage removed. A `machine stop` of an unknown name says "vm not found" but
  leaves an empty `vms/<hash>/`. Ours: delete reads `machine status` first,
  stops gracefully, kills a still-loaded scope with SIGKILL (the signal smolvm's
  own `kill_scope` sends, S@1.22.2:src/systemd_scope.rs:380), then
  `machine delete -f` and `systemctl reset-failed`. A host SIGKILLed mid-boot
  can leave a VMM smolvm reads as stopped, because the boot started it before
  smolvm recorded its pid; re-check whether that window still exists.
- `machine status --name X --json` states are `created`, `running`, `stopped`,
  `paused`, `pausing`, `failed`, `unreachable` and `frozen`
  (S@1.22.2:src/config.rs:36-80); an unknown name is "machine '<name>' not
  found". Ours: `RecordState`, `alive` and `stateOf` (`running`, `pausing`,
  `unreachable`, `frozen` have a live VMM). It reports a port count, not ports
  (`machine ls -v` and `agent.config.json` have them), and `branchable: false`
  even after `start --branchable`. `machine ls` probes every running VM, up to
  about 3 s each (S@1.19.0:src/cli/vm_common.rs:3130), so it is never used to
  read one machine.
- Concurrent CLI calls on different machines need no serializing: an inventory
  database in WAL mode with a 15 s busy timeout (S@1.22.2:src/db.rs), a per-VM
  `vm.lock`, the uid allocation lock, the store's shared/exclusive lock (prune
  waits for captures), the image-seed cache lock, and `fork.rs`'s fork-source
  lock taken by `stop_vm_named` and `delete_vm`
  (S@1.22.2:src/cli/vm_common.rs:2367-2371, 2760-2761). Only a prefix's first
  use races (the templates above). Ours: `observeConcurrency` 8, no host-side
  lock around smolvm.
- When a `machine exec` client is signalled, smolvm SIGKILLs the guest command
  and every descendant; a `setsid -f` child whose parent exits at once
  survives. Ours: a setup killed by its timeout or a host crash runs no exit
  trap and may leave its file in `/var/tmp` (`setupRunner` in
  `packages/host/src/guest.ts`); `start` scripts daemonize with `setsid -f`.
- A `machine exec` sent while `machine start` is still making the guest's
  container made the start fail ("smolvm-fork-ready: No such file", "`/bin/bash`
  not found"). Ours: the host never runs a guest command before start returns.
- smolvm's log lines, which errors carry, are coloured even into a pipe unless
  `NO_COLOR` is set (tracing-subscriber 0.3.23, `src/fmt/fmt_layer.rs:739-743`;
  check the version in smolvm's `Cargo.lock`). Ours: `NO_COLOR=1`.
- The per-VM `agent-console.log` records each guest command's arguments, not its
  stdin. Ours: setup scripts and the preparation seed go on stdin; preparation's
  text in that log carries no secret.

**Supervision and root**

- The CLI starts the VMM as a detached child in the caller's cgroup
  (S@1.22.0:src/agent/manager.rs:2678). `SMOLVM_VM_USE_SCOPE=1`, root only,
  gives each VM `system.slice/smolvm-vm-<name>.scope` with its limits
  (S@1.22.0:src/systemd_scope.rs:117-130, 151-165, src/agent/manager.rs:2715-2744),
  so it survives the launching unit. Ours: `environment()` sets it; a host
  restart keeps VMs.
- `SMOLVM_BOOT_BINARY` arms a parent-death watchdog
  (S@1.19.0:src/internal_boot.rs:82-110). Ours: never set.
- As root each VM runs as its own uid from 2000000 up, with only the kvm group
  and no capabilities (S@1.22.0:src/process.rs:1305-1345), in a 0700 directory;
  a restore gets a fresh uid. smolvm adds others-execute to every directory above
  its data root. Ours: guests can't write the shared agent rootfs; the live
  driver's teardown checks for uid ≥ 2000000 processes.
- As root every restore creates `/dev/shm/smolvm-restore` and leaves it; only
  `machine pause`/`resume` stage RAM there; `SMOLVM_RESTORE_TMPFS=0` turns it
  off at no cost (S@1.22.0:src/portable_checkpoint.rs:55-82). Ours: set on
  every call.

**Network**

- `machine create --net` is outbound access; `resolve_egress_flags` enables it
  only for `--net` or an allow list, never for `-p`
  (S@1.22.2:src/cli/machine.rs:102-134, 3872-3874). Ours: every create passes
  `--net --net-backend virtio-net -p <port>:22`.
- `-p` binds loopback, or `SMOLVM_PUBLISH_ADDR`, which the VMM reads
  (S@1.22.0:crates/smolvm-network/src/tcp_listeners.rs:111-121); it listened on
  that address and `[::1]`. Ours: `SMOLVM_PUBLISH_ADDR` is the host's
  `publishAddress`.
- Setting `SMOLVM_PUBLISH_ADDR` makes the egress floor strict by default; the
  values are `strict`, `metadata` and `off`
  (S@1.22.0:crates/smolvm-network/src/egress.rs:128-175). Strict refuses
  loopback, link-local, private ranges and 100.64.0.0/10
  (`is_reserved_v4`, S@1.22.2:crates/smolvm-network/src/egress.rs:205-213) and
  fc00::/7 (:228-229), but not the host's public addresses. Ours:
  `SMOLVM_EGRESS_FLOOR=strict`; guests can't reach the host's API or any
  tailnet peer, which is why the live suite has no peer check; no host service
  may listen on a public address.
- The gateway relays DNS to the host's resolver
  (S@1.19.0:src/data/network.rs:12-45) and answers port 53 at every address.
  smolvm refuses to capture a machine with custom DNS
  (S@1.19.0:src/portable_checkpoint.rs:2258). Ours: no DNS setting; the live
  isolation probe uses 100.100.100.100:80, not port 53.
- A checkpoint with published ports refuses any backend but virtio-net
  (S@1.22.0:src/portable_checkpoint.rs:3507-3509); a restore reuses the
  checkpoint's host ports verbatim (:2690-2705, 3495-3509); `create --from` a
  live checkpoint refuses `-p`, `--net` and every topology flag
  (S@1.22.2:src/cli/machine.rs:4304-4344). Ours: after `create --from`, the
  port moves with `machine update --remove-port … -p …` before the first start.
- smolvm's own fork ports come from 20000–32000
  (S@1.22.0:src/agent/fork.rs:2828-2848). Ours: machine ports come from
  10000–19999, below it.

**Checkpoints, forks and identity**

- Capture refuses a machine that isn't running ("machine '…' must be running",
  S@1.22.2:src/portable_checkpoint.rs:1221-1233). A store capture of a machine
  started without `--branchable` fails `ENOTSUP … deferred durable save requires
  file-backed guest RAM`. Ours: every start passes `--branchable`; a capture or
  fork of a stopped machine is `Precondition` before anything native.
- Capture is atomic (temp file, fsync, publish without clobbering,
  S@1.19.0:crates/smolvm-pack/src/packer.rs:434-484). A restore directory is
  built under a `-partial` name, marked pending, renamed into place, and a
  failed create rolls the machine back (S@1.22.2:src/portable_checkpoint.rs:4080,
  4237, 4247). Ours: no checks of our own around either.
- smolvm records and enforces CPU, memory, disk sizes, platform, CPU contract and
  network (S@1.19.0:src/portable_checkpoint.rs:2802-2932), but not the engine
  build or the agent, and its ABI string didn't change when libkrun's state did.
  Ours: `pin`, so a RAM state is restored only under the release that saved it.
  If smolvm starts enforcing engine and agent identity itself, the pin could go.
- Store mode: `--store` with `--history 0` (the default keeps 32 generations, so
  deleting older checkpoints frees nothing until the newest goes), then
  `checkpoint-prune`; the store's `objects/` layout
  (S@1.22.2:crates/smolvm-checkpoint/src/store.rs:1317-1319, read in
  `smolvm.ts`). A restored machine holds no reference into the store (no
  `.pack-shared`, no hard links): each store restore materializes the
  checkpoint privately (S@1.22.2:src/agent/manager.rs:405-406,
  src/cli/machine.rs:4693-4700), so a fork's store is removed whole under its
  running child. The restore cache `vms/_restore-checkpoints` survives every
  command; `--restore-cache-entries 0` turns it off. Ours: one store per host,
  fork stores removed whole, restore cache off.
- Fork and restore re-mint the SSH host keys, `/etc/machine-id` and the hostname,
  the restored container's UTS namespace included
  (S@1.22.0:src/agent/fork.rs:3022-3197, src/portable_checkpoint.rs:4280-4285),
  retrying three times, then deleting the clone (fork.rs:3770-3783).
  `create --from … --keep-identity` skips it. The re-mint only stirs the RNG
  pool (S@1.22.2:src/agent/fork.rs:3176, 3245-3250), and the guest has no vmgenid or
  hwrng, so restores of one RAM state got duplicate host keys (4 distinct of
  20). A running sshd is not touched, and the kernel `boot_id` is not re-minted.
  Ours: preparation reseeds the RNG (`/dev/random` plus `RNDRESEEDCRNG`),
  re-mints the keys and SIGHUPs sshd on every runtime, whatever smolvm did.

**Why things are avoided** (re-check whether the reason still holds)

- `machine branch`: each single-child branch adds a qcow2 backing layer to the
  source's disks and the 33rd is refused (`MAX_FORK_DISK_CHAIN_DEPTH`,
  `MAX_FORK_LINEAGE_DEPTH` = 32, S@1.22.2:src/agent/fork.rs:27, 1019); only a
  pack rebuild resets it, losing RAM. And a source with a retained live-fork
  child cold-restarts (S@1.22.0:src/agent/manager.rs:1828, fork.rs:658-690),
  its state probe counts every child (state_probe.rs:100-127), it reads
  `frozen` (:57-58) and `stop` and `delete` refuse it
  (src/cli/vm_common.rs:2413-2422). Ours: fork is a checkpoint plus a restore.
- Bare VMs: on the stock agent rootfs, after a cold boot, copied-up files gave
  `Stale file handle` (`overlayfs: failed to get inode (-116)`), because the
  root overlay has `index=Y` over a virtiofs lower whose nodeids change per
  boot; the container overlay uses `index=off`
  (S@1.22.0:crates/smolvm-agent/src/storage.rs:4545). Ours: machines always run
  an image.
- `systemd-resolved` turns `/etc/resolv.conf` into a symlink, and every later
  start fails refreshing the overlay's resolver
  (S@1.22.0:crates/smolvm-agent/src/storage.rs:3341). Ours: the setup rule
  `--no-install-recommends` (README).
- Packs: `pack create --from-vm` fails for a machine on the image seed
  (`krun_start_enter returned: -22`; S@1.22.2:src/internal_boot.rs:240-243,
  src/pack_export.rs:454-471) and leaks a `smolvm-vm-pack-fromvm-*` scope; it
  drops every xattr, `security.capability` included. Ours: no `disk`
  checkpoints on smolvm. Revisit only if that changes.
- `smolvm serve` (PTY-only interactive exec, process-global agent rootfs and
  HOME, forced virtio-net and its own egress floor) and the `smolmachines` Node
  SDK (no exec stdin, lossy text, one data root per process, zombie VMMs, no
  stability statement). Ours: the CLI. Note anything at the target that removes
  a reason.

## Verify

- Unit: `vp test` in `packages/host` (`smolvm.test.ts` fakes each smolvm call
  as the tested release answers it; `store.test.ts`) and `packages/contract`
  (`ids.test.ts`), then `vp run --no-cache ready`. Update a fake only to match
  smolvm's real behaviour at the target.
- Live: `pnpm live:smolvm --ssh USER@HOST --address TAILNET_ADDRESS --root OWNED_ROOT --smolvm-prefix PREFIX`,
  with the target installed into its own prefix on the Linux test host, as root,
  with its `READY` marker and `.zst` templates (`tests/live/README.md` lists what
  else it needs). Add `--recipe DIR` for the real-recipe test. The suite covers
  forks, `ram` checkpoints, the RAM budget, crashes mid-boot, a call past
  300 s and the guest's isolation. It runs as a work run (`scripts/WORK_RUNS.md`);
  report what it leaves running and what it retains.

## After

- Set `testedVersion`, then update every place `git grep` found. Move each
  `S@<old>` citation, in this skill and in code comments, to the new tag and its
  current lines, and add claims the new release introduced.
- Tell the operator what the bump does to a running host: the host refuses to
  start until its config names a prefix with the new release (install into a
  new prefix, expand its templates, change `smolvm.prefix`, restart); running
  VMs keep their old prefix, which must stay until its last machine is deleted;
  the new prefix builds a new image seed (one pull); and every existing `ram`
  checkpoint now fails its restore with `Precondition`, since its pin names the
  old release.
- Report the tag transition, the claims that changed and their fixes, the checks
  actually run, optional opportunities (with touchpoints and the smallest useful
  check), and remaining runtime resources and retained disk separately.
