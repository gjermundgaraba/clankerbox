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
- **Notation:** `S@<tag>:path` is smolvm's source at that tag, and the
  identifier beside it (a function, constant, environment variable or message)
  finds the code: `git grep -n <identifier> <tag> -- <path>`. Every citation
  is at 1.22.2.
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
  S@1.22.2:scripts/install.sh), always links `$BIN_DIR/smolvm`, with
  `BIN_DIR="${HOME}/.local/bin"`, edits shell rc files without
  `--no-modify-path` (`modify_path`), and puts the agent rootfs in
  `${XDG_DATA_HOME:-$HOME/.local/share}/smolvm/agent-rootfs` (`data_dir` in
  `install_smolvm`). Ours: README's install command runs it with
  `HOME=<prefix>`, so everything lands in the prefix.
- With `SMOLVM_DATA_DIR` set, smolvm sets `HOME` to the data dir and strips
  `XDG_*` (`apply_system_data_root`, S@1.22.2:src/process.rs, called first in
  src/main.rs), so it can't find the agent rootfs on its own. Ours:
  `environment()` sets
  `SMOLVM_AGENT_ROOTFS=<prefix>/.local/share/smolvm/agent-rootfs` and `HOME`
  at the data dir. `SMOLVM_AGENT_ROOTFS` is read per process
  (`default_rootfs_path`, S@1.22.2:src/agent/manager.rs). The wrapper script
  finds its libraries from the prefix (`LD_LIBRARY_PATH=<prefix>/lib`,
  scripts/smolvm-wrapper.sh).
- The disk templates are expanded on first use, with no lock, through one fixed
  `<dest>.partial` (`expand_template`, S@1.22.2:crates/smolvm-pack/src/assets.rs).
  Six concurrent first starts destroyed both templates every time;
  pre-expanding with `zstd -d --sparse` is byte-identical and clean. Ours:
  `templates` in `smolvm.ts`, startup refuses a prefix without them, README's
  install step. If upstream adds a lock, the pre-expansion can go.
- Templates are looked up in `$SMOLVM_DATA_DIR/.smolvm` first, silently (a bogus
  one booted with exit 0); `$HOME/.smolvm` alone is ignored
  (`find_existing_template`, S@1.22.2:crates/smolvm-pack/src/assets.rs). Ours:
  nothing writes there.
- Machines depend on their prefix: default-size disks and overlays are qcow2
  files backed on the prefix's templates by absolute path, and running VMs read
  its agent rootfs. Ours: an old prefix stays until its last machine is deleted
  (README).
- Disk sizing: below the template, a sparse copy plus host `resize2fs -f`; above
  it, a sparse copy and a guest-side resize at boot; at the default, a qcow2
  backed on the template (`open_or_overlay_at`, S@1.22.2:src/storage.rs;
  `copy_disk_from_template`, src/disk_utils.rs). Workload writes land on the
  storage disk (`/dev/vda`). Ours: `diskGib` is `--storage`, the overlay keeps
  its default, `searchPath` holds the sbin directories for `resize2fs`.
- The host-side image seed is built only for `--storage` 20 or none, on a fresh
  image machine (`seedable_image`, S@1.22.2:src/image_seed.rs); other
  sizes pull the image inside the guest at first start. The seed key includes
  the template file's identity, so a new prefix builds a new seed. The seed
  builder's scope names are fixed (`build_seed`). Ours: README's disk
  note; `tests/live/smolvm/remote.py` (seed scopes).
- The registry parser rejects a tag plus a digest (`Reference::parse`,
  S@1.22.2:src/registry.rs: the `:tag` left before the `@` fails
  `is_valid_repo_component`) and the guest then pulls on every create;
  `…/ubuntu@sha256:…` builds a seed. smolvm's own `docker.io` mirror setting
  rewrites the reference before the pull (`get_mirror`,
  `rewrite_image_registry`, S@1.22.2:src/agent/client.rs) and the start fails
  `image not found`. Bases go through `mirror.gcr.io`, a pull-through cache of
  Docker Hub, to avoid Docker Hub's anonymous pull limit. Ours: bases are
  digest-only and name `mirror.gcr.io` directly (README, `remote.py`'s
  `IMAGE`).

**Names and paths**

- A VM name is at most 128 characters, starts with a letter or digit, uses only
  `[A-Za-z0-9_-]`, has no `--` and no trailing `-` (`validate_vm_name`,
  S@1.22.2:src/data/mod.rs); the scope name `smolvm-vm-<name>.scope` adds
  nothing stricter (`scope_name`, src/systemd_scope.rs). Ours: the contract's
  `Name` rule and `packages/contract/tests/ids.test.ts`; `nativeName` and
  `scopeName` in `smolvm.ts`.
- A machine's sockets live under `<data root>/.cache/smolvm/vms/<16 hex>/`, so
  the control socket's path depends only on the data root (`vm_data_dir`,
  S@1.22.2:src/agent/manager.rs; `control_socket_path`, src/agent/fork.rs).
  Linux allows 107 bytes. Ours: `controlSocket` and `socketPathMax`; the state
  dir is at most 52 bytes.

**Lifecycle and state** (smolvm's exit codes are trusted; nothing polls around them)

- `machine start` returns once the agent is ready and kills the child on
  failure (`finalize_launch`, S@1.22.2:src/agent/manager.rs).
- `machine start` resolves the state with an agent ping first
  (`resolve_state`, S@1.22.2:src/agent/state_probe.rs): `running` returns at
  once, `unreachable` (VMM alive, agent silent) has its VMM killed and its
  record cleared, then starts afresh (`cli_recover_if_unreachable` in
  `start_vm_named_with_db`, S@1.22.2:src/cli/vm_common.rs), and `frozen`,
  `paused` and `pausing` are refused. Ours: `start` reads `machine status`
  first, leaves `running` as it is, boots `unreachable` again and refuses
  `unstartable` before anything native.
  `copyable` takes only `running`, so an unreachable source is refused, and
  the RAM budget counts `unreachable` as running.
- `stop` returns after the process is dead. It needs the guest's shutdown ack;
  it hard-kills an unreachable VM or an orphaned VMM
  (`cli_recover_if_unreachable`, `kill_orphaned_boot_process`,
  S@1.22.2:src/cli/vm_common.rs); a VM that exits after a failed ack counts as
  stopped. A reachable guest that doesn't ack and doesn't exit is left alive
  and `stop` fails with "left the VM alive for retry"
  (S@1.22.2:src/agent/manager.rs); smolvm never signals it. Ours:
  stop returns that error rather than force it; delete's path.
- `machine stop` takes only `--name`; `machine delete -f` only skips the prompt
  (`StopCmd`, `DeleteCmd`, S@1.22.2:src/cli/machine.rs). `exec` refuses a stopped
  machine. `delete` removes the record only after the process is dead and
  storage removed. A `machine stop` of an unknown name says "vm not found" but
  leaves an empty `vms/<hash>/`. Ours: delete reads `machine status` first,
  stops gracefully, kills a still-loaded scope with SIGKILL (the signal smolvm's
  own `kill_scope` sends, S@1.22.2:src/systemd_scope.rs), then
  `machine delete -f` and `systemctl reset-failed`. A host SIGKILLed mid-boot
  can leave a VMM smolvm reads as stopped, because the boot started it before
  smolvm recorded its pid; re-check whether that window still exists.
- `machine status --name X --json` states are `created`, `running`, `stopped`,
  `paused`, `pausing`, `failed`, `unreachable` and `frozen` (`RecordState`,
  S@1.22.2:src/config.rs); an unknown name is "machine '<name>' not found".
  Ours: `RecordState`, `alive` and `stateOf` (`running`, `pausing`,
  `unreachable`, `frozen` have a live VMM). It reports a port count, not ports
  (`machine ls -v` and `agent.config.json` have them), and `branchable: false`
  even after `start --branchable`. `machine ls` probes every running VM, up to
  about 3 s each (`list_vms`, S@1.22.2:src/cli/vm_common.rs), so it is never
  used to read one machine.
- Concurrent CLI calls on different machines need no serializing: an inventory
  database in WAL mode with a 15 s busy timeout (`BUSY_TIMEOUT`,
  S@1.22.2:src/db.rs), a per-VM
  `vm.lock`, the uid allocation lock, the store's shared/exclusive lock (prune
  waits for captures), the image-seed cache lock, and `fork.rs`'s fork-source
  lock taken by `stop_vm_named` and `delete_vm`
  (S@1.22.2:src/cli/vm_common.rs). Only a prefix's first
  use races (the templates above). Ours: `observeConcurrency` 8, no host-side
  lock around smolvm, and each machine's status bounded by `stateReadWait`
  (8 s from the read's start, its turn included, under the client's 10 s read
  bound), so a status held by the busy timeout reads `unknown`.
- When a `machine exec` client is signalled, smolvm SIGKILLs the guest command
  and every descendant; a `setsid -f` child whose parent exits at once
  survives. Ours: a setup killed by its timeout or a host crash runs no exit
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
  stdin. Ours: setup scripts and the preparation seed go on stdin; preparation's
  text in that log carries no secret.

**Supervision and root**

- The CLI starts the VMM as a detached child, in its own process group, in the
  caller's cgroup (`start_via_subprocess`, S@1.22.2:src/agent/manager.rs).
  `SMOLVM_VM_USE_SCOPE=1`, root only, gives each VM
  `system.slice/smolvm-vm-<name>.scope` with its limits (`is_available`,
  `scope_name`, `adopt_into_scope`, S@1.22.2:src/systemd_scope.rs; read in
  `start_via_subprocess`), so it survives the launching unit, with no unit
  files. Ours: `environment()` sets it; a host restart keeps VMs.
- `SMOLVM_BOOT_BINARY` arms a parent-death watchdog (`watch_parent`,
  S@1.22.2:src/agent/launcher.rs; read in `start_via_subprocess`). Ours: never
  set.
- As root each VM runs as its own uid from 2000000 up, with only the kvm group
  and no capabilities (`VM_UID_BASE`, `allocate_vm_uid`, `drop_privileges`,
  S@1.22.2:src/process.rs), in a 0700 directory; a restore gets a fresh uid.
  smolvm adds others-execute to every directory above its data root
  (`apply_system_data_root`). Ours: guests can't write the shared agent
  rootfs; the live driver's teardown checks for uid ≥ 2000000 processes.
- As root every restore creates `/dev/shm/smolvm-restore` and leaves it; only
  `machine pause`/`resume` stage RAM there; `SMOLVM_RESTORE_TMPFS=0` turns it
  off at no cost (S@1.22.2:src/portable_checkpoint.rs). Ours: set on every
  call.

**Network**

- `machine create --net` is outbound access; `resolve_egress_flags` enables it
  only for `--net` or an allow list, never for `-p`
  (S@1.22.2:src/cli/machine.rs). Ours: every create passes
  `--net --net-backend virtio-net -p <port>:22`.
- `-p` binds loopback, or `SMOLVM_PUBLISH_ADDR`, which the VMM reads (`bind`,
  S@1.22.2:crates/smolvm-network/src/tcp_listeners.rs); it listened on
  that address and `[::1]`. Ours: `SMOLVM_PUBLISH_ADDR` is the host's
  `publishAddress`.
- Setting `SMOLVM_PUBLISH_ADDR` makes the egress floor strict by default; the
  values are `strict`, `metadata` and `off` (`floor_mode`,
  S@1.22.2:crates/smolvm-network/src/egress.rs). Strict refuses loopback,
  link-local, private ranges and 100.64.0.0/10 (`is_reserved_v4`) and
  fc00::/7 (its `0xfc00` test), but not the host's public addresses. Ours:
  `SMOLVM_EGRESS_FLOOR=strict`; guests can't reach the host's API or any
  tailnet peer, which is why the live suite has no peer check; no host service
  may listen on a public address.
- The gateway relays DNS to the host's resolver (`host_dns`,
  S@1.22.2:src/data/network.rs) and answers port 53 at every address. smolvm
  refuses to capture a machine with custom DNS (`validate_capture_profile`,
  S@1.22.2:src/portable_checkpoint.rs). Ours: no DNS setting; the live isolation
  probe uses 100.100.100.100:80, not port 53.
- A checkpoint with published ports refuses any backend but virtio-net
  (`validate_compatibility`, S@1.22.2:src/portable_checkpoint.rs); a restore
  reuses the checkpoint's host ports verbatim (`checkpoint_network`,
  `validate_compatibility`); `create --from` a live checkpoint refuses `-p`,
  `--net` and every topology flag (`topology_overridden` in
  `run_from_smolmachine`, S@1.22.2:src/cli/machine.rs). Ours: after `create
  --from`, the port moves with `machine update --remove-port … -p …` before the
  first start.
- smolvm's own fork ports come from 20000–32000 (`CLONE_PORT_FLOOR`,
  `CLONE_PORT_CEILING`, S@1.22.2:src/agent/fork.rs). Ours: machine ports come from
  10000–19999, below it.

**Checkpoints, forks and identity**

- Capture refuses a machine that isn't running ("machine '…' must be running",
  `validated_capture_source`, S@1.22.2:src/portable_checkpoint.rs). A store
  capture of a machine started without `--branchable` fails `ENOTSUP … deferred
  durable save requires file-backed guest RAM`. Ours: every start passes
  `--branchable`; a capture or fork of a stopped machine is `Precondition`
  before anything native.
- Capture is atomic (temp file, fsync, publish without clobbering,
  `pack_artifact_inner`, S@1.22.2:crates/smolvm-pack/src/packer.rs). A restore
  directory is built under a `-partial` name, marked pending, renamed into
  place, and a failed create rolls the machine back (`install_with`,
  S@1.22.2:src/portable_checkpoint.rs). Ours: no checks of our own around
  either.
- smolvm records and enforces CPU, memory, disk sizes, platform, CPU contract
  and network (`validate_compatibility`, S@1.22.2:src/portable_checkpoint.rs),
  but not the engine build or the agent, and its ABI string didn't change when
  libkrun's state did. Ours: `pin`, so a RAM state is restored only under the
  release that saved it. If smolvm starts enforcing engine and agent identity
  itself, the pin could go.
- Store mode: `--store` with `--history 0` (the default keeps 32 generations, so
  deleting older checkpoints frees nothing until the newest goes), then
  `checkpoint-prune`; the store's `objects/` layout (`prune`,
  S@1.22.2:crates/smolvm-checkpoint/src/store.rs, read in `smolvm.ts`). A
  restored machine holds no reference into the store (no `.pack-shared`, no hard
  links): each store restore materializes the checkpoint privately
  (`machine_layers_cache_dir`, S@1.22.2:src/agent/manager.rs;
  `run_from_smolmachine`, src/cli/machine.rs), so a fork's store is removed
  whole under its running child. The restore cache `vms/_restore-checkpoints`
  survives every command; `--restore-cache-entries 0` turns it off. Ours: one
  store per host, fork stores removed whole, restore cache off.
- Fork and restore re-mint the SSH host keys, `/etc/machine-id` and the hostname,
  the restored container's UTS namespace included (`build_rejuvenation_script`,
  S@1.22.2:src/agent/fork.rs; `finalize_live_restore`,
  src/portable_checkpoint.rs), retrying three times, then deleting the clone
  (`rejuvenate_clone`, `REJUVENATE_ATTEMPTS`). `create --from …
  --keep-identity` skips it. The re-mint only stirs the RNG pool (its
  `/dev/urandom` write; `rejuvenate_clone`'s doc: no `RNDADDENTROPY` or
  VMGENID), and the guest has no vmgenid or
  hwrng, so restores of one RAM state got duplicate host keys (4 distinct of
  20). A running sshd is not touched, and the kernel `boot_id` is not re-minted.
  Ours: preparation reseeds the RNG (`/dev/random` plus `RNDRESEEDCRNG`),
  re-mints the keys and SIGHUPs sshd on every runtime, whatever smolvm did.

**Why things are avoided** (re-check whether the reason still holds)

- `machine branch`: each single-child branch adds a qcow2 backing layer to the
  source's disks and the 33rd is refused (`MAX_FORK_DISK_CHAIN_DEPTH`,
  `MAX_FORK_LINEAGE_DEPTH` = 32, S@1.22.2:src/agent/fork.rs); only a
  pack rebuild resets it, losing RAM. And a source with a retained live-fork
  child cold-restarts (`restart_blocking_dependent_clones`,
  S@1.22.2:src/agent/fork.rs), its state probe counts every child
  (`has_frozen_fork_state`, src/agent/state_probe.rs), it reads `frozen`
  (`resolve_state`) and `stop` and `delete` refuse it ("is the fork base for"
  in `stop_vm_named` and `delete_vm`, src/cli/vm_common.rs). Ours: fork is a
  checkpoint plus a restore, and `machine branch` is never called.
- Bare VMs: on the stock agent rootfs, after a cold boot, copied-up files gave
  `Stale file handle` (`overlayfs: failed to get inode (-116)`), because the
  root overlay has `index=Y` over a virtiofs lower whose nodeids change per
  boot; the container overlay uses `index=off` (`mount_overlay_fsconfig`,
  S@1.22.2:crates/smolvm-agent/src/storage.rs). Ours: machines always run
  an image.
- `systemd-resolved` turns `/etc/resolv.conf` into a symlink, and every later
  start fails refreshing the overlay's resolver (`refresh_overlay_resolver`,
  S@1.22.2:crates/smolvm-agent/src/storage.rs). Ours: the setup rule
  `--no-install-recommends` (README).
- Packs: `pack create --from-vm` fails for a machine on the image seed
  (`krun_start_enter returned: -22`; `seed_dir_for_disk`,
  S@1.22.2:src/internal_boot.rs; the export helper's boot,
  src/pack_export.rs) and leaks a `smolvm-vm-pack-fromvm-*` scope; it
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
