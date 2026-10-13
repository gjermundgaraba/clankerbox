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

- **Pinned in this repo:** `testedVersion` in `packages/host/src/platform/smolvm.ts` is
  exact: startup refuses any other `smolvm --version`. `pin` derives from it
  (`smolvm <version> <platform>-<arch>`) and is recorded on every `ram`
  checkpoint. The version also appears in tests, docs and examples:
  `git grep -n '1\.27\.3'` (README's install table, host config example and
  install command; `tests/live/README.md`; `tests/live/smolvm/{driver,remote}.py`;
  `packages/host/tests/{smolvm,store,config}.test.ts`;
  `packages/sdk/tests/{ids.test,prebuild.test,stub-host}.ts`).
  Source citations in comments use the form below: `git grep -n 'S@1\.27'`.
- **Target:** the latest stable published `smol-machines/smolvm` release (its
  release metadata, such as `gh release view --repo smol-machines/smolvm`),
  unless the user names one. Not upstream main, an installed binary or a cached
  HEAD. Record old and new tags and commits; if already current, say so.
- **Source:** a read-only cache at `~/.cache/checkouts/github.com/smol-machines/smolvm`.
  Fetch missing tags; read with `git show <tag>:<path>` and
  `git diff <old>..<new>`. Never edit, reset or switch it.
- **Notation:** `S@<tag>:path` is smolvm's source at that tag, and the
  identifier beside it (a function, constant, environment variable or message)
  finds the code: `git grep -n <identifier> <tag> -- <path>`. Every citation
  is at 1.27.3.
- Read the release notes and the full changed-file list between the tags first,
  then each claim's file. A changelog or a clean build is not evidence.

## Claims to re-check

Each: what smolvm does, where, and what of ours depends on it. A claim that no
longer holds needs a code change and a regression test; one that holds gets its
citation moved to the new tag.

**The environment** (README's smolvm notes point here)

- Every smolvm call, and so every VM, runs with one environment
  (`environment` in `smolvm.ts`): a fixed `PATH` (`searchPath`), `HOME` and
  `SMOLVM_DATA_DIR` at `<stateDir>/smolvm` (one inventory per host),
  `SMOLVM_AGENT_ROOTFS` in the prefix, `SMOLVM_PUBLISH_ADDR` at the host's
  `publishAddress`, `SMOLVM_EGRESS_FLOOR=strict`, `SMOLVM_RESTORE_TMPFS=0`
  (otherwise every root restore leaves `/dev/shm/smolvm-restore`),
  `SMOLVM_VM_USE_SCOPE=1` and `NO_COLOR=1`; never `SMOLVM_BOOT_BINARY`. The
  claims below give each variable's reason; re-check the set as a whole, and
  any variable the target adds.

**Install and prefix**

- The installer is `install.sh --version V --prefix DIR --no-modify-path`. It
  aborts non-interactively for a prefix outside `$HOME` (`install_smolvm`,
  S@1.27.3:scripts/install.sh), always links `$BIN_DIR/smolvm`, with
  `BIN_DIR="${HOME}/.local/bin"`, edits shell rc files without
  `--no-modify-path` (`modify_path`), and puts the agent rootfs in
  `${XDG_DATA_HOME:-$HOME/.local/share}/smolvm/agent-rootfs` (`data_dir` in
  `install_smolvm`). As root without `--prefix` it installs system-wide
  instead (`/opt/smolvm`, a `/usr/local/bin` link, no rc edits; `main`).
  Ours: README's install command runs it with `HOME=<prefix>` and `--prefix`,
  so everything lands in the prefix.
- With `SMOLVM_DATA_DIR` set, smolvm sets `HOME` to the data dir and strips
  `XDG_*` (`apply_system_data_root`, S@1.27.3:src/process.rs, called first in
  src/main.rs), so it can't find the agent rootfs on its own. Ours:
  `environment()` sets
  `SMOLVM_AGENT_ROOTFS=<prefix>/.local/share/smolvm/agent-rootfs` and `HOME`
  at the data dir. `SMOLVM_AGENT_ROOTFS` is read per process
  (`default_rootfs_path`, S@1.27.3:src/agent/manager.rs). The wrapper script
  finds its libraries from the prefix (`LD_LIBRARY_PATH=<prefix>/lib`,
  scripts/smolvm-wrapper.sh).
- The disk templates are expanded on first use, with no lock, through one fixed
  `<dest>.partial` (`expand_template`, S@1.27.3:crates/smolvm-pack/src/assets.rs).
  Six concurrent first starts destroyed both templates every time;
  pre-expanding with `zstd -d --sparse` is byte-identical and clean. Ours:
  `templates` in `smolvm.ts`, startup refuses a prefix without them, README's
  install step. If upstream adds a lock, the pre-expansion can go.
- Templates are looked up in `$SMOLVM_DATA_DIR/.smolvm` first, silently (a bogus
  one booted with exit 0); `$HOME/.smolvm` alone is ignored
  (`find_existing_template`, S@1.27.3:crates/smolvm-pack/src/assets.rs). Ours:
  nothing writes there.
- Machines depend on their prefix: default-size disks and overlays are qcow2
  files backed on the prefix's templates by absolute path, a seeded image
  machine's disk is a qcow2 over its seed, itself backed on the template, and
  running VMs read its agent rootfs. Ours: an old prefix stays until its last machine is deleted
  (README).
- Disk sizing: below the template, a sparse copy plus host `resize2fs -f`; at
  the default, a qcow2 backed on the template (`open_or_overlay_at`,
  S@1.27.3:src/storage.rs; `copy_disk_from_template`, src/disk_utils.rs).
  Above it, a seeded image machine gets a qcow2 over its seed, grown
  (`attach_seed_disk`, src/image_seed.rs); otherwise a sparse copy and a
  guest-side resize at boot. Workload writes land on the
  storage disk (`/dev/vda`). Ours: `diskGib` is `--storage`, the overlay keeps
  its default, `searchPath` holds the sbin directories for `resize2fs`.
- The host-side image seed is built for `--storage` 20 or more, or none, on a
  fresh image machine (`seedable_image`, S@1.27.3:src/image_seed.rs: `gb <
  DEFAULT` refuses); smaller sizes pull the image inside the guest at first
  start. The seed key includes
  the template file's identity, so a new prefix builds a new seed. The seed
  builder's scope names are fixed (`build_seed`). Ours: README's disk
  note; `tests/live/smolvm/remote.py` (seed scopes).
- The registry parser accepts a tag plus a digest and drops the tag
  (`Reference::parse`, S@1.27.3:src/registry.rs); before 1.23.1 it refused one,
  and the guest pulled on every create. smolvm's own `docker.io` mirror setting
  rewrites the reference before the pull, and since 1.27.0 the guest caches the
  image under the original one (`cache_as` in the pull, `get_mirror`,
  `rewrite_image_registry`, S@1.27.3:src/agent/client.rs); at 1.22.2 the start
  failed `image not found`. Neither was tried live. The seed key hashes the
  reference as written, so `x:tag@d` and `x@d` seed separately. Bases go through
  `mirror.gcr.io`, a pull-through cache of Docker Hub, to avoid Docker Hub's
  anonymous pull limit. Ours: bases name `mirror.gcr.io` directly, by digest
  (README, `remote.py`'s `IMAGE`).

**Names and paths**

- A VM name is at most 128 characters, starts with a letter or digit, uses only
  `[A-Za-z0-9_-]`, has no `--` and no trailing `-` (`validate_vm_name`,
  S@1.27.3:src/data/mod.rs); the scope name `smolvm-vm-<name>.scope` adds
  nothing stricter (`scope_name`, src/systemd_scope.rs). Ours: the contract's
  `Name` rule and `packages/sdk/tests/ids.test.ts`; `nativeName` and
  `scopeName` in `smolvm.ts`.
- A machine's sockets live under `<data root>/.cache/smolvm/vms/<16 hex>/`, so
  the control socket's path depends only on the data root (`vm_data_dir`,
  S@1.27.3:src/agent/manager.rs; `control_socket_path`, src/agent/fork.rs).
  Linux allows 107 bytes. Ours: `controlSocket` and `socketPathMax`; the state
  dir is at most 52 bytes.

**Lifecycle and state** (smolvm's exit codes are trusted; nothing polls around them)

- `machine start` returns once the agent is ready and kills the child on
  failure (`finalize_launch`, S@1.27.3:src/agent/manager.rs), then stops the
  scope that launch made (`release_failed_launch_scope`).
- `machine start` resolves the state with an agent ping first
  (`resolve_state`, S@1.27.3:src/agent/state_probe.rs): `running` returns at
  once, `unreachable` (VMM alive, agent silent) has its VMM killed and its
  record cleared, then starts afresh (`cli_recover_if_unreachable` in
  `start_vm_named_with_db`, S@1.27.3:src/cli/vm_common.rs), and `frozen`,
  `paused` and `pausing` are refused. Ours: `start` reads `machine status`
  first, leaves `running` as it is, boots `unreachable` again and refuses
  `unstartable` before anything native.
  `copyable` takes only `running`, so an unreachable source is refused, and
  the RAM budget counts `unreachable` as running. The ping's socket waits 3 s
  to read and 3 s to write (`connect_for_state_probe`,
  S@1.27.3:src/agent/client.rs), so `machine status` reads an unreachable
  machine within the host's 8 s `machineReadWait`, which the live stall test
  relies on.
- `stop` returns after the process is dead. It needs the guest's shutdown ack;
  it hard-kills an unreachable VM or an orphaned VMM
  (`cli_recover_if_unreachable`, `kill_orphaned_boot_process`,
  S@1.27.3:src/cli/vm_common.rs); a VM that exits after a failed ack counts as
  stopped. A reachable guest that doesn't ack and doesn't exit is left alive
  and `stop` fails with "left the VM alive for retry"
  (S@1.27.3:src/agent/manager.rs); smolvm never signals it. Ours:
  stop returns that error rather than force it; delete's path.
- `machine stop` takes only `--name`; `machine delete -f` only skips the prompt
  (`StopCmd`, `DeleteCmd`, S@1.27.3:src/cli/machine.rs). `exec` refuses a stopped
  machine. `delete` removes the record only after the process is dead and
  storage removed. A `machine stop` of an unknown name says "vm not found" but
  leaves an empty `vms/<hash>/`. Ours: stop reads `machine status` first and
  stops only a running machine; delete reads it first too, stops gracefully, kills a still-loaded scope with SIGKILL (the signal smolvm's
  own `kill_scope` sends, S@1.27.3:src/systemd_scope.rs), then
  `machine delete -f` and `systemctl reset-failed`; CLI stop and delete never
  touch the scope themselves (only `serve`'s handlers call `kill_scope`). A
  host SIGKILLed mid-boot can leave a VMM smolvm reads as stopped: the boot
  spawns it and adopts it into its scope before `finalize_launch` writes
  `agent.pid`, and the record gets `running` and the pid only after the start's
  image setup (`start_via_subprocess`, `start_vm_named_with_db`); re-check
  whether that window still exists.
- `machine status --name X --json` states are `created`, `running`, `stopped`,
  `paused`, `pausing`, `failed`, `unreachable` and `frozen` (`RecordState`,
  S@1.27.3:src/config.rs); an unknown name is "machine '<name>' not found".
  Ours: `RecordState`, `alive` and `stateOf` (`running`, `pausing`,
  `unreachable`, `frozen` have a live VMM). It reports a port count
  (`ports`), and `branchable: false` even after `start --branchable`. For a
  machine whose state resolves `running` and that publishes a port, it also
  runs `cat /proc/net/tcp /proc/net/tcp6` in the VM for `published_ports`
  (`status_vm_json`, S@1.27.3:src/cli/vm_common.rs; `probe_guest_listeners`,
  src/cli/port_listen.rs; since 1.23.0): a second agent connection and an exec
  of up to about 8 s, whose failure only leaves the field out, so a slow agent
  can push a status past `machineReadWait`, and every status of a running
  machine adds a line to its `agent-console.log`. `machine ls` probes every running VM, up to
  about 3 s each (`list_vms`, S@1.27.3:src/cli/vm_common.rs), so it is never
  used to read one machine.
- Concurrent CLI calls on different machines need no serializing: an inventory
  database in WAL mode with a 15 s busy timeout (`BUSY_TIMEOUT`,
  S@1.27.3:src/db.rs), a per-VM
  `vm.lock`, the uid allocation lock, the store's shared/exclusive lock (prune
  waits for captures), the image-seed cache lock, and `fork.rs`'s fork-source
  lock taken by `stop_vm_named` and `delete_vm`
  (S@1.27.3:src/cli/vm_common.rs). Only a prefix's first
  use races (the templates above). Ours: `observeConcurrency` 8, no host-side
  lock around smolvm, and each machine's status bounded by `machineReadWait`
  (8 s from the read's start, its turn included, under the core's 9 s
  `stateReadWait`), so a status held by the busy timeout reads `unknown`.
- When a `machine exec` client is signalled, smolvm SIGKILLs the guest command
  and every descendant (`kill_child_on_disconnect`,
  S@1.27.3:crates/smolvm-agent/src/main.rs; `kill_child_tree`,
  crates/smolvm-agent/src/process.rs); a `setsid -f` child whose parent exits
  at once survives. Since 1.25.4 the container's PID 1 is smolvm's keep-alive
  `container-init`, which the image's command is exec'd under and which reaps
  such a child. Ours: a setup killed by its timeout or a host crash runs no exit
  trap and may leave its file in `/var/tmp` (`setupRunner` in
  `packages/host/src/guest.ts`); `start` scripts daemonize with `setsid -f`.
- A `machine exec` sent while `machine start` is still making the guest's
  container made the start fail ("smolvm-fork-ready: No such file", "`/bin/bash`
  not found"). Ours: the host never runs a guest command before start returns.
- smolvm's log lines, which errors carry, are coloured even into a pipe unless
  `NO_COLOR` is set (tracing-subscriber 0.3.23, `NO_COLOR` in
  `src/fmt/fmt_layer.rs`; check the version in smolvm's `Cargo.lock`). Ours:
  `NO_COLOR=1`.
- The per-VM `agent-console.log` records each guest command's arguments, not its
  stdin; each boot keeps the last one as `agent-console.prev.log`. Ours: setup scripts and the preparation seed go on stdin; preparation's
  text in that log carries no secret.

**Supervision and root**

- The CLI starts the VMM as a detached child, in its own process group, in the
  caller's cgroup (`start_via_subprocess`, S@1.27.3:src/agent/manager.rs).
  `SMOLVM_VM_USE_SCOPE=1`, root only, gives each VM
  `system.slice/smolvm-vm-<name>.scope` with its limits (`is_available`,
  `scope_name`, `adopt_into_scope`, S@1.27.3:src/systemd_scope.rs; read in
  `start_via_subprocess`), so it survives the launching unit, with no unit
  files. Ours: `environment()` sets it; a host restart keeps VMs.
- `SMOLVM_BOOT_BINARY` arms a parent-death watchdog (`watch_parent`,
  S@1.27.3:src/agent/launcher.rs; read in `start_via_subprocess`). Ours: never
  set.
- As root each VM runs as its own uid from 2000000 up, with only the kvm group
  and no capabilities (`VM_UID_BASE`, `allocate_vm_uid`, `drop_privileges`,
  S@1.27.3:src/process.rs), in a 0700 directory; a restore gets a fresh uid.
  The uid registry is the data root's own (`<data root>/smolvm/uids`), so two
  inventories on one machine hand out the same uids. Each start adds
  others-execute to every directory above its data root, agent rootfs and
  registry (`ensure_traversable`, S@1.27.3:src/process.rs, called in
  src/agent/manager.rs). Since 1.24.1 the agent rootfs is exported to the guest
  read-only. Ours: guests can't write the shared agent rootfs; the live
  driver's teardown checks for uid ≥ 2000000 processes, and its test host runs
  no other smolvm inventory.
- As root every restore creates `/dev/shm/smolvm-restore` and leaves it; only
  `machine pause`/`resume` stage RAM there; `SMOLVM_RESTORE_TMPFS=0` turns it
  off at no cost (`restore_tmpfs_root`, S@1.27.3:src/portable_checkpoint.rs).
  Ours: set on every call.
- As root every `--store` capture makes `/dev/shm/smolvm-capture` (0711) and
  leaves it, and stages the RAM image in a private directory there, removed
  after, when `/dev/shm` has room for 1.25 × the machine's RAM plus 1 GiB and
  `MemAvailable` is twice that (`capture_tmpfs_root`,
  `runtime_capture_dir_preferring_tmpfs`, S@1.27.3:src/portable_checkpoint.rs;
  since 1.24.1). Nothing turns it off. Ours: that RAM is outside the
  RAM budget while a capture runs; `remote.py`'s `SHM_DIRS` records and removes
  the directory.

**Network**

- `machine create --net` is outbound access; `resolve_egress_flags` enables it
  only for `--net` or an allow list, never for `-p`
  (S@1.27.3:src/cli/machine.rs); since 1.24.2 a `-p`-only machine is denied
  all egress. Ours: every create passes
  `--net --net-backend virtio-net -p <port>:22`.
- `-p` binds loopback, or `SMOLVM_PUBLISH_ADDR`, which the VMM reads (`bind`,
  S@1.27.3:crates/smolvm-network/src/tcp_listeners.rs); it listened on
  that address and `[::1]`. Ours: `SMOLVM_PUBLISH_ADDR` is the host's
  `publishAddress`.
- Setting `SMOLVM_PUBLISH_ADDR` makes the egress floor strict by default; the
  values are `strict`, `metadata` and `off` (`floor_mode`,
  S@1.27.3:crates/smolvm-network/src/egress.rs). Strict refuses loopback,
  link-local, private ranges and 100.64.0.0/10 (`is_reserved_v4`) and
  fc00::/7 (its `0xfc00` test), but not the host's public addresses. Ours:
  `SMOLVM_EGRESS_FLOOR=strict`; guests can't reach the host's API or any
  tailnet peer, which is why the live suite has no peer check; no host service
  may listen on a public address.
- The virtio-net gateway answers port 53 at every address and relays to the
  host's first IPv4 nameserver in `/etc/resolv.conf`, a loopback stub such as
  systemd-resolved's 127.0.0.53 included, dialled from the host, where the
  egress floor doesn't apply (`effective_dns`, `select_dns`,
  S@1.27.3:src/data/network.rs; since 1.25.4; before, 1.1.1.1 unless `--dns`).
  So guests resolve names through the host's own resolver, tailnet names
  included where it serves them, though the floor still refuses connecting to
  the answers. smolvm refuses to capture a machine with custom DNS
  (`validate_capture_profile`, S@1.27.3:src/portable_checkpoint.rs), so `--dns`
  is no way out. Ours: no DNS setting; the live isolation probe uses
  100.100.100.100:80, not port 53.
- A checkpoint with published ports refuses any backend but virtio-net
  (`validate_compatibility`, S@1.27.3:src/portable_checkpoint.rs); a restore
  reuses the checkpoint's host ports verbatim (`checkpoint_network`,
  `validate_compatibility`); `create --from` a live checkpoint refuses `-p`,
  `--net` and every topology flag (`topology_overridden` in
  `run_from_smolmachine`, S@1.27.3:src/cli/machine.rs). Ours: after `create
  --from`, the port moves with `machine update --remove-port … -p …` before the
  first start.
- smolvm's own fork ports come from 20000–31999: `CLONE_PORT_FLOOR` (20000) up
  to `CLONE_PORT_CEILING` (32000), which is excluded (`alloc_free_host_port`,
  S@1.27.3:src/agent/fork.rs). The CLI allocates no other host port range.
  Ours: `reservedPorts` (`machine-ports.ts`) holds that
  range beside the Linux and macOS ephemeral ranges, and the host config
  refuses a `machinePorts` that reaches into any of them (10000–19999 by
  default; `config.test.ts`).

**Checkpoints, forks and identity**

- Capture refuses a machine that isn't running ("machine '…' must be running",
  `validated_capture_source`, S@1.27.3:src/portable_checkpoint.rs). Started
  `--branchable`, a machine's capture defers its RAM save and pauses it only
  briefly, and a restore reads its RAM in place; without it a store capture
  falls back to a synchronous save, pausing it for the whole RAM write
  (`declined_deferred_save`; since 1.24.0, before which it failed `ENOTSUP`).
  A branchable machine gets no idle balloon reclaim. Ours: every start passes
  `--branchable`; a capture or fork of a stopped machine is `Precondition`
  before anything native.
- Capture is atomic (temp file, fsync, publish without clobbering,
  `pack_artifact_inner`, S@1.27.3:crates/smolvm-pack/src/packer.rs). A restore
  directory is built under a `-partial` name, marked pending, renamed into
  place, and a failed create rolls the machine back (`install_with`,
  S@1.27.3:src/portable_checkpoint.rs). A store checkpoint publishes with
  `RENAME_NOREPLACE` and a parent fsync (`publish`,
  crates/smolvm-checkpoint/src/store.rs). Ours: no checks of our own around
  either.
- smolvm records and enforces CPU, memory, disk sizes, platform (since 1.23.0
  darwin/arm64 restores on linux/arm64), CPU contract, guest CPU features,
  clock, state origin and network (`validate_compatibility`,
  S@1.27.3:src/portable_checkpoint.rs), but not the engine build or the agent,
  and its ABI string (`RUNTIME_ABI`) stayed the same across several libkrun
  bumps. Ours: `pin`, so a RAM state is restored only under the
  release that saved it. If smolvm starts enforcing engine and agent identity
  itself, the pin could go.
- Store mode: `--store` with `--history 0` (the default keeps 32 generations, so
  deleting older checkpoints frees nothing until the newest goes), then
  `checkpoint-prune`; the store's `objects/` layout (`prune`,
  S@1.27.3:crates/smolvm-checkpoint/src/store.rs, read in `smolvm.ts`). A
  restored machine holds no reference into the store (no `.pack-shared`, no hard
  links): each store restore materializes the checkpoint privately
  (`machine_layers_cache_dir`, S@1.27.3:src/agent/manager.rs;
  `run_from_smolmachine`, src/cli/machine.rs: a checkpoint directory is
  `stored`, which takes neither the shared extractions, leases and
  `.pack-shared` of single-file artifacts nor the delta import), so a fork's
  store is removed whole under its running child. A CLI capture into another
  store is whole, not a delta of the checkpoint it was restored from (that is
  `serve`'s), and `prune` frees only objects with one link. The restore cache
  `vms/_restore-checkpoints` survives every command;
  `--restore-cache-entries 0` turns it off. The store's `lineage/<id>.json`
  grows by a small file per capture, which prune never removes. Ours: one
  store per host, fork stores removed whole, restore cache off.
- Fork and restore re-mint the SSH host keys, `/etc/machine-id` and the hostname,
  the restored container's UTS namespace included (`build_rejuvenation_script`,
  S@1.27.3:src/agent/fork.rs; `finalize_live_restore`,
  src/portable_checkpoint.rs), retrying three times, then deleting the clone
  (`rejuvenate_clone`, `REJUVENATE_ATTEMPTS`), each try a `/bin/sh -c` of up
  to 120 s (since 1.23.5). `create --from …
  --keep-identity` skips it. The re-mint only stirs the RNG pool (its
  `/dev/urandom` write; `rejuvenate_clone`'s doc: no `RNDADDENTROPY` or
  VMGENID), and the guest has no vmgenid (it does list a `virtio_rng.0`
  hwrng at 1.27.3), so restores of one RAM state got duplicate host keys (4
  distinct of 20). A running sshd is not touched, and the kernel `boot_id` is not re-minted.
  Ours: preparation reseeds the RNG (`/dev/random` plus `RNDRESEEDCRNG`),
  re-mints the keys and SIGHUPs sshd on every runtime, whatever smolvm did.

**Why things are avoided** (re-check whether the reason still holds)

- `machine branch`: since 1.23.0 a source's disk chain is flattened at depth 16
  in the background and 24 before freezing (`COMPACT_AT_DEPTH`,
  `SYNC_COMPACT_AT_DEPTH`, S@1.27.3:src/agent/fork/compact.rs), so
  `MAX_FORK_DISK_CHAIN_DEPTH` (32, src/agent/fork.rs) is a backstop;
  branch-of-branch generations stop at `MAX_FORK_LINEAGE_DEPTH` (32). Since
  1.26.0 a branchable child shares its source's memory. A source with a
  retained live-fork child cold-restarts (`restart_blocking_dependent_clones`,
  S@1.27.3:src/agent/fork.rs), its state probe counts every child
  (`has_frozen_fork_state`, src/agent/state_probe.rs), it reads `frozen`
  (`resolve_state`) and `stop` and `delete` refuse it ("is the fork base for"
  in `stop_vm_named` and `delete_vm`, src/cli/vm_common.rs). Ours: fork is a
  checkpoint plus a restore, and `machine branch` is never called.
- Bare VMs: on the stock agent rootfs, after a cold boot, copied-up files gave
  `Stale file handle` (`overlayfs: failed to get inode (-116)`), because the
  root overlay has `index=Y` over a virtiofs lower whose nodeids change per
  boot; the container overlay uses `index=off` (`mount_overlay_fsconfig`,
  S@1.27.3:crates/smolvm-agent/src/storage.rs). Ours: machines always run
  an image.
- `systemd-resolved` turns `/etc/resolv.conf` into a symlink, and every later
  start fails refreshing the overlay's resolver (`refresh_overlay_resolver`,
  S@1.27.3:crates/smolvm-agent/src/storage.rs). Ours: the setup rule
  `--no-install-recommends` (README).
- Packs: `pack create --from-vm` fails for a machine on the image seed
  (`krun_start_enter returned: -22`; `seed_dir_for_disk`,
  S@1.27.3:src/internal_boot.rs; the export helper's boot,
  src/pack_export.rs) and leaked a `smolvm-vm-pack-fromvm-*` scope (since
  1.26.0 a failed launch's scope is stopped and orphaned export helpers are
  reaped; untried); an image export's guest `tar` drops every xattr,
  `security.capability` included. Ours: no `disk`
  checkpoints on smolvm. Revisit only if that changes.
- `smolvm serve` (process-global agent rootfs and HOME, forced virtio-net and
  its own egress floor, lossy non-streamed exec output; since 1.24.0 its
  interactive exec takes an argument vector on pipes) and the `smolmachines`
  Node SDK (now in smol-machines/smol; the in-tree embedded engine has no exec
  stdin and one runtime per process; zombie VMMs are reaped since 1.26.1; no
  stability statement). Ours: the CLI. Note anything at the target that removes
  a reason.

## Verify

- Unit: `vp test` in `packages/host` (`platform/smolvm.test.ts` fakes each smolvm call
  as the tested release answers it; `platform/sqlite.test.ts`) and `packages/sdk`
  (`ids.test.ts`), then `vp run --no-cache ready`. Update a fake only to match
  smolvm's real behaviour at the target.
- Live: `pnpm live:smolvm --ssh USER@HOST --address TAILNET_ADDRESS --root OWNED_ROOT --smolvm-prefix PREFIX`,
  with the target installed into its own prefix on the Linux test host, as root,
  with its `READY` marker and `.zst` templates (`tests/live/README.md` lists what
  else it needs). The suite covers forks, `ram` checkpoints, the RAM budget,
  crashes mid-boot, a call past 300 s and the guest's isolation. It runs as a
  work run (`scripts/WORK_RUNS.md`); report what it leaves running and what it
  retains.

## After

- Set `testedVersion`, then update every place `git grep` found. Move every
  `S@<old>` citation, in this skill and in code comments, to the new tag (code
  comments' also to their current lines), check that each identifier still
  finds the code, and add claims the new release introduced.
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
