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

## Source and scope

- **Pinned in this repo:** `testedVersion` in `packages/host/src/platform/smolvm.ts` is
  exact: startup refuses any other `smolvm --version`. `pin` derives from it
  (`smolvm <version> <platform>-<arch>`) and is recorded on every `ram`
  checkpoint. Tests use `testedVersion` or a neutral `0.0.0-test`; only README
  repeats the version: `git grep -n '<old version>'` finds every place.
- **Target:** the latest stable published `smol-machines/smolvm` release (its
  release metadata, such as `gh release view --repo smol-machines/smolvm`),
  unless the user names one. Not upstream main, an installed binary or a cached
  HEAD. Record old and new tags and commits; if already current, say so.
- **Source:** a read-only cache at `~/.cache/checkouts/github.com/smol-machines/smolvm`.
  Fetch missing tags; read with `git show <tag>:<path>` and
  `git diff <old>..<new>`. Never edit, reset or switch it.
- **Notation:** a citation is a path in smolvm's source at the tested release,
  1.31.1, and the identifier beside it (a function, constant, environment
  variable or message) finds the code: `git grep -n <identifier> <tag> --
  <path>`. Code comments cite the same way, as `// Source: smolvm <path>
  <identifier>`: `git grep -n 'Source: smolvm'`.
- Read the release notes and the full changed-file list between the tags first,
  then each claim's file. A changelog or a clean build is not evidence.

## Claims to re-check

Each: what smolvm does at the tested release, where, and what of ours depends
on it ("Ours:"). A claim with no "Ours:" doesn't belong here, and neither does
release history: the bump's report and this file's log hold that. A claim that
no longer holds needs a code change and a regression test; one that holds stays
as it is.

**The environment**

- Every smolvm call, and so every VM, runs with one environment
  (`environment` in `smolvm.ts`): a fixed `PATH` (`searchPath`), `HOME` and
  `SMOLVM_DATA_DIR` at `<stateDir>/smolvm` (one inventory per host),
  `SMOLVM_AGENT_ROOTFS` in the prefix, `SMOLVM_PUBLISH_ADDR` at the host's
  `listen.address`, `SMOLVM_EGRESS_FLOOR=strict`, `SMOLVM_RESTORE_TMPFS=0`
  (otherwise every root restore leaves `/dev/shm/smolvm-restore`),
  `SMOLVM_VM_USE_SCOPE=1`, `SMOLVM_OOM_VICTIM_ORDER=0`, `SMOLVM_USAGE=0` and
  `NO_COLOR=1`; never `SMOLVM_BOOT_BINARY` or `SMOLVM_MACHINE_NAME` (the
  default of every `--name`, `ENV_SMOLVM_MACHINE_NAME`, src/data/consts.rs).
  The claims below give each variable's reason; re-check the set as a whole,
  and any variable the target adds.

**Install and prefix**

- The installer is `install.sh --version V --prefix DIR --no-modify-path`. It
  aborts non-interactively for a prefix outside `$HOME` (`install_smolvm`,
  scripts/install.sh), always links `$BIN_DIR/smolvm`, with
  `BIN_DIR="${HOME}/.local/bin"`, edits shell rc files without
  `--no-modify-path` (`modify_path`), and puts the agent rootfs in
  `${XDG_DATA_HOME:-$HOME/.local/share}/smolvm/agent-rootfs` (`data_dir` in
  `install_smolvm`). As root without `--prefix` it installs system-wide
  instead (`/opt/smolvm`, a `/usr/local/bin` link, no rc edits; `main`).
  Ours: README's install command runs it with `HOME=<prefix>` and `--prefix`,
  so everything lands in the prefix.
- With `SMOLVM_DATA_DIR` set, smolvm sets `HOME` to the data dir and strips
  `XDG_*` (`apply_system_data_root`, src/process.rs, called first in
  src/main.rs), so it can't find the agent rootfs on its own: it copies an
  installed rootfs into the data root only when `SMOLVM_AGENT_ROOTFS` is unset
  (`installed_agent_rootfs`, `sync_agent_rootfs`), and with `HOME` at the data
  dir it finds none. `--state-dir` only sets `SMOLVM_DATA_DIR` from argv,
  scanning up to the first `--` (`state_dir_from_args`, src/main.rs). Ours:
  `environment()` sets
  `SMOLVM_AGENT_ROOTFS=<prefix>/.local/share/smolvm/agent-rootfs` and `HOME`
  at the data dir; no argument before an exec's `--` is user text.
  `SMOLVM_AGENT_ROOTFS` is read per process (`default_rootfs_path`,
  src/agent/manager.rs). The wrapper script finds its libraries from the
  prefix (`LD_LIBRARY_PATH=<prefix>/lib`, scripts/smolvm-wrapper.sh).
- The disk templates are expanded on first use, with no lock, through one fixed
  `<dest>.partial` (`expand_template`, crates/smolvm-pack/src/assets.rs).
  Six concurrent first starts destroyed both templates every time;
  pre-expanding with `zstd -d --sparse` is byte-identical and clean. Ours:
  `templates` in `smolvm.ts`, startup refuses a prefix without them, README's
  install step. If upstream adds a lock, the pre-expansion can go.
- Templates are looked up in registered roots (`TEMPLATE_ROOTS`, registered
  only by an embedder's `set_bundle`, src/embedded/bundle.rs), then
  `$SMOLVM_DATA_DIR/.smolvm`, silently (a bogus one booted with exit 0), then
  beside the binary; `$HOME/.smolvm` alone is ignored
  (`find_existing_template`, crates/smolvm-pack/src/assets.rs). Ours: the CLI
  registers no root and nothing writes the data dir's, so the prefix's are
  found.
- Machines depend on their prefix: default-size disks and overlays are qcow2
  files backed on the prefix's templates by absolute path, a seeded image
  machine's disk of 20 GiB or more is a qcow2 over its seed, itself backed on
  the template, and running VMs read its agent rootfs. A smaller seeded disk is
  a raw clone of its seed (`clone_raw`, src/image_seed.rs: a reflink, else a
  hole-skipping copy). Ours: an old prefix stays until its last machine is
  deleted.
- Disk sizing: below the template, a sparse copy truncated to size, with host
  `resize2fs -f` only when the template's filesystem is larger than the
  request (`copy_disk_from_template`, src/disk_utils.rs); the template holds a
  512 MiB ext4 in a 20 GiB file (scripts/build-dist.sh). At the default, a
  qcow2 backed on the template (`open_or_overlay_at`, src/storage.rs). Above
  it, a seeded image machine gets a qcow2 over its seed, grown
  (`attach_seed_disk`, src/image_seed.rs); otherwise a sparse copy and a
  guest-side resize at boot. Workload writes land on the storage disk
  (`/dev/vda`). Ours: `diskGib` is `--storage`, the overlay keeps its default,
  `searchPath` keeps the sbin directories for smolvm's host tools.
- The host-side image seed is built for every `--storage` but 0 on a fresh
  image machine (`seedable_image`, src/image_seed.rs): 20 or more, or none,
  share the default seed; a smaller size gets a raw seed of its own
  (`small_seed_gb`, `storage-gib:N` in `seed_key`). The seed key includes the
  template file's identity, so a new prefix builds new seeds. The seed
  builder's scope names are fixed (`build_seed`). Ours: a new prefix pulls
  once per distinct `diskGib` below 20, and once for the rest.
- The registry parser accepts a tag plus a digest and drops the tag
  (`Reference::parse`, src/registry.rs). smolvm's own `docker.io` mirror
  setting rewrites the reference before the pull, and the guest caches the
  image under the original one (`cache_as` in the pull, `get_mirror`,
  `rewrite_image_registry`, src/agent/client.rs). Neither was tried live. The
  seed key hashes the reference as written, so `x:tag@d` and `x@d` seed
  separately. Bases go through `mirror.gcr.io`, a pull-through cache of Docker
  Hub, to avoid Docker Hub's anonymous pull limit. Ours: bases name
  `mirror.gcr.io` directly, by digest (README).

**Names and paths**

- A VM name is at most 128 characters, starts with a letter or digit, uses only
  `[A-Za-z0-9_-]`, has no `--` and no trailing `-` (`validate_vm_name`,
  src/data/mod.rs); the scope name `smolvm-vm-<name>.scope` adds nothing
  stricter (`scope_name`, src/systemd_scope.rs). Ours: the contract's `Name`
  rule and `packages/sdk/tests/ids.test.ts`; `nativeName` and `scopeName` in
  `smolvm.ts`.
- A machine's sockets live under `<data root>/.cache/smolvm/vms/<16 hex>/`, so
  the control socket's path depends only on the data root (`vm_data_dir`,
  src/agent/manager.rs; `control_socket_path`, src/agent/fork.rs), and no
  other socket there is longer. Linux allows 107 bytes
  (`MAX_UNIX_SOCKET_PATH`, src/agent/launcher_dynamic.rs, which smolvm checks
  for its other sockets but not the control socket). Ours: `controlSocket` and
  `socketPathMax`; the state dir is at most 52 bytes.

**Lifecycle and state** (smolvm's exit codes are trusted; nothing polls around them)

- `machine start` returns once the agent is ready and kills the child on
  failure (`finalize_launch`, src/agent/manager.rs), then stops the scope that
  launch made (`release_failed_launch_scope`). The ready wait fails after 30 s
  without boot progress (the console log growing, or a VMM thread in disk
  wait) or at 180 s (`AGENT_READY_TIMEOUT`, `AGENT_READY_MAX`,
  `BootProgress`). Ours: no bound on start, create or restore.
- `machine start` resolves the state with an agent ping first
  (`resolve_state`, src/agent/state_probe.rs): `running` returns at once,
  `unreachable` (VMM alive, agent silent) has its VMM killed and its record
  cleared, then starts afresh (`cli_recover_if_unreachable` in
  `start_vm_named_with_db`, src/cli/vm_common.rs), and `frozen`, `paused` and
  `pausing` are refused. Ours: `start` reads `machine status` first, leaves
  `running` as it is, boots `unreachable` again and refuses `unstartable`
  before anything native. `copyable` takes only `running`, so an unreachable
  source is refused, and the RAM budget counts `unreachable` as running. The
  ping's socket waits 3 s to read and 3 s to write
  (`connect_for_state_probe`, src/agent/client.rs), so `machine status` reads
  an unreachable machine within the host's 8 s `machineReadWait`, which the
  live stall test relies on.
- `stop` returns after the process is dead. It needs the guest's shutdown ack;
  it hard-kills an unreachable VM or an orphaned VMM
  (`cli_recover_if_unreachable`, `kill_orphaned_boot_process`,
  src/cli/vm_common.rs); a VM that exits after a failed ack counts as stopped.
  A reachable guest that doesn't ack and doesn't exit is left alive and `stop`
  fails with "left the VM alive for retry" (`stop_vm_process`,
  src/agent/manager.rs); smolvm never signals it. The guest's shutdown first
  stops the image's workload, its stop signal (SIGTERM) then SIGKILL after its
  stop timeout, 10 s by default (`workload::stop_all`,
  crates/smolvm-agent/src/main.rs; `DEFAULT_STOP_TIMEOUT_SECS`,
  crates/smolvm-protocol/src/lib.rs); `machine exec` sessions are never
  registered as workloads. Ours: stop returns that error rather than force
  it; delete's path; setup and `start` scripts' daemons are not signalled.
- `machine stop` takes `--name` and `-t/--timeout`, the workload's stop
  timeout, 0 to 300 (`parse_stop_timeout_arg`); `machine delete -f` only skips
  the prompt, and its stop gives the workload no time
  (`stop_with_timeout(Duration::ZERO)` in `delete_vm`) (`StopCmd`,
  `DeleteCmd`, src/cli/machine.rs). `exec` refuses a stopped machine. `delete`
  removes the record only after the process is dead and storage removed. A
  `machine stop` of an unknown name says "vm not found" but leaves an empty
  `vms/<hash>/`. Ours: stop reads `machine status` first and stops only a
  running machine, its workload given its stop timeout; delete reads it first
  too, stops with `--timeout 0` (the guest still syncs and acks), kills a
  still-loaded scope with SIGKILL (the signal smolvm's own `kill_scope` sends,
  src/systemd_scope.rs), then `machine delete -f` and `systemctl
  reset-failed`; CLI stop and delete never touch the scope themselves (only
  `serve`'s handlers call `kill_scope`). A host SIGKILLed mid-boot can leave a
  VMM smolvm reads as stopped: the boot spawns it and adopts it into its scope
  before `finalize_launch` writes `agent.pid`, and the record gets `running`
  and the pid only after the start's image setup (`start_via_subprocess`,
  `start_vm_named_with_db`); re-check whether that window still exists.
- `machine status --name X --json` states are `created`, `running`, `stopped`,
  `paused`, `pausing`, `failed`, `unreachable` and `frozen` (`RecordState`,
  src/config.rs); an unknown name is "machine '<name>' not found"
  (`status_vm_json`). Ours: `RecordState`, `alive` and `stateOf` (`running`,
  `pausing`, `unreachable`, `frozen` have a live VMM), and the not-found text.
  It reports a port count (`ports`), and `branchable: false` even after `start
  --branchable`. For a machine whose state resolves `running` and that
  publishes a port, it also runs `cat /proc/net/tcp /proc/net/tcp6` in the VM
  for `published_ports` (`status_vm_json`, src/cli/vm_common.rs;
  `probe_guest_listeners`, src/cli/port_listen.rs): a second agent connection
  and an exec of up to about 8 s, whose failure only leaves the field out, so
  a slow agent can push a status past `machineReadWait`, and every status of a
  running machine adds a line to its `agent-console.log`. `machine ls` probes
  every running VM, up to about 3 s each (`list_vms`, src/cli/vm_common.rs),
  so it is never used to read one machine.
- Concurrent CLI calls on different machines need no serializing: an inventory
  database in WAL mode with a 15 s busy timeout (`BUSY_TIMEOUT`, src/db.rs), a
  per-VM `vm.lock`, the uid allocation lock, the store's shared/exclusive lock
  (prune waits for captures), the image-seed cache lock, and `fork.rs`'s
  fork-source lock taken by `stop_vm_named` and `delete_vm`
  (src/cli/vm_common.rs). Only a prefix's first use races (the templates
  above). Ours: `observeConcurrency` 8, no host-side lock around smolvm, and
  each machine's status bounded by `machineReadWait` (8 s from the read's
  start, its turn included, under the core's 9 s `stateReadWait`), so a status
  held by the busy timeout reads `unknown`.
- `machine exec` runs as `-u/--user`, by default the machine's configured user,
  then the image's `USER` (`ExecCmd`, src/cli/machine.rs). Ours: every exec
  passes `--user root`, since setup, preparation and the tailnet check run as
  root, and an image such as Amp's orb image sets `USER user`.
- When a `machine exec` client is signalled, smolvm SIGKILLs the guest command
  and every descendant (`kill_child_on_disconnect`,
  crates/smolvm-agent/src/main.rs; `kill_child_tree`,
  crates/smolvm-agent/src/process.rs); a `setsid -f` child whose parent exits
  at once survives. The container's PID 1 is smolvm's keep-alive
  `container-init`, which the image's command is exec'd under and which reaps
  such a child. Ours: a setup killed by its timeout or a host crash runs no
  exit trap and may leave its file in `/var/tmp` (`setupRunner` in
  `packages/host/src/guest.ts`); `start` scripts daemonize with `setsid -f`.
- A `machine exec` sent while `machine start` is still making the guest's
  container made the start fail ("smolvm-fork-ready: No such file", "`/bin/bash`
  not found"). Ours: the host never runs a guest command before start returns.
- smolvm's log lines, which errors carry, are coloured even into a pipe unless
  `NO_COLOR` is set (tracing-subscriber, `NO_COLOR` in `src/fmt/fmt_layer.rs`,
  at the version in smolvm's `Cargo.lock`). Ours: `NO_COLOR=1`.
- The per-VM `agent-console.log` records each guest command's arguments, not its
  stdin; each boot keeps the last one as `agent-console.prev.log`. The image's
  own workload writes its output to the VM's `workload.log`
  (src/workload_log.rs), which exec output never reaches. Ours: setup scripts
  and the preparation seed go on stdin; preparation's text in that log
  carries no secret.
- Every record change, checkpoint and restore appends a line to a usage
  journal under `<data root>/.local/share/smolvm/usage/`, with an `install_id`
  beside it and a sharing path, off unless configured (src/usage.rs);
  `SMOLVM_USAGE=0` turns it off, checked before every write
  (`recording_enabled`). Ours: set; a host has no use for an install id or
  usage sharing.

**Supervision and root**

- The CLI starts the VMM as a detached child, in its own process group, in the
  caller's cgroup, with the CLI's environment (`start_via_subprocess`,
  src/agent/manager.rs). `SMOLVM_VM_USE_SCOPE=1`, root only, gives each VM
  `system.slice/smolvm-vm-<name>.scope` with its limits (`is_available`,
  `scope_name`, `adopt_into_scope`, src/systemd_scope.rs; read in
  `start_via_subprocess`), so it survives the launching unit, with no unit
  files. Ours: `environment()` sets it; a host restart keeps VMs.
- `SMOLVM_BOOT_BINARY` arms a parent-death watchdog (`watch_parent`,
  src/agent/launcher.rs; read in `start_via_subprocess`). Ours: never set.
- As root each VM runs as its own uid from 2000000 up, with only the kvm group
  and no capabilities (`VM_UID_BASE`, `allocate_vm_uid`, `drop_privileges`,
  src/process.rs), in a 0700 directory; a restore gets a fresh uid. The uid
  registry is the data root's own (`<data root>/.cache/smolvm/uids`,
  `vm_uid_registry_dir`, src/agent/manager.rs), so two inventories on one
  machine hand out the same uids. Each start adds others-execute to every
  directory above its data root, agent rootfs and registry
  (`ensure_traversable`, src/process.rs, called in src/agent/manager.rs). The
  agent rootfs is exported to the guest read-only. Ours: guests can't write
  the shared agent rootfs; the live driver's teardown checks for uid ≥ 2000000
  processes, and its test host runs no other smolvm inventory.
- As root every restore creates `/dev/shm/smolvm-restore` and leaves it; only
  `machine pause`/`resume` stage RAM there; `SMOLVM_RESTORE_TMPFS=0` turns it
  off at no cost (`restore_tmpfs_root`, src/portable_checkpoint.rs). Ours: set
  on every call.
- As root every `--store` capture makes `/dev/shm/smolvm-capture` (0711) and
  leaves it, and stages the RAM image in a private directory there, removed
  after, when `/dev/shm` has room for 1.25 × the machine's RAM plus 1 GiB and
  `MemAvailable` is twice that (`capture_tmpfs_root`,
  `runtime_capture_dir_preferring_tmpfs`, src/portable_checkpoint.rs). Nothing
  turns it off. Ours: that RAM is outside the RAM budget while a capture runs.
- Each VMM sets its own `oom_score_adj`: −500 for a branchable machine
  (`SMOLVM_FORKABLE`, which `start --branchable` passes), +500 for a clone or
  a first boot from a restore (`SMOLVM_SNAPSHOT_DIR`, set while a restore is
  pending), 0 otherwise; `SMOLVM_OOM_VICTIM_ORDER=0` keeps every score at 0
  (`oom_score_adj_for`, src/process.rs, applied in src/internal_boot.rs).
  Ours: set, so every VM keeps 0; else a host OOM would kill the clankerbox
  host before any created machine, and a fresh restore or fork before
  anything.
- The guest's `/dev/shm` is half its RAM (`shm_size`,
  crates/smolvm-agent/src/oci.rs), inside `--mem`. Ours: the RAM budget counts
  `--mem` alone.

**Network**

- `machine create --net` is outbound access, enabled only for `--net` or an
  allow list (`resolve_egress_flags`, src/cli/machine.rs), a deny list or
  `--block-private` (`prepend_deny_cidrs`, `apply_block_private`,
  src/cli/vm_common.rs), never for `-p`; a `-p`-only machine is denied all
  egress.
  Ours: every create passes `--net --net-backend virtio-net -p <port>:22`.
- `-p` binds loopback, or `SMOLVM_PUBLISH_ADDR`, which the VMM reads (`bind`,
  crates/smolvm-network/src/tcp_listeners.rs); it listened on that address and
  `[::1]`. Ours: `SMOLVM_PUBLISH_ADDR` is the host's `listen.address`.
- Setting `SMOLVM_PUBLISH_ADDR` makes the egress floor strict by default; the
  values are `strict`, `metadata` and `off` (`floor_mode`,
  crates/smolvm-network/src/egress.rs), and no per-machine flag weakens strict
  (`with_private_floor`). Strict refuses loopback, link-local, private ranges
  and 100.64.0.0/10 (`is_reserved_v4`) and fc00::/7 (its `0xfc00` test), but
  not the host's public addresses. Ours: `SMOLVM_EGRESS_FLOOR=strict`; guests
  can't reach the host's API or any tailnet peer; no host service may listen
  on a public address.
- The virtio-net gateway answers port 53 at every address and relays to the
  host's first IPv4 nameserver in `/etc/resolv.conf`, a loopback stub such as
  systemd-resolved's 127.0.0.53 included, dialled from the host, where the
  egress floor doesn't apply (`effective_dns`, `select_dns`,
  src/data/network.rs). So guests resolve names through the host's own
  resolver, tailnet names included where it serves them, though the floor
  still refuses connecting to the answers. smolvm refuses to capture a machine
  with custom DNS (`validate_capture_profile`, src/portable_checkpoint.rs), so
  `--dns` is no way out. Ours: no DNS setting; the live isolation probe uses
  100.100.100.100:80, not port 53.
- A checkpoint with published ports refuses any backend but virtio-net
  (`validate_compatibility`, src/portable_checkpoint.rs); a restore reuses the
  checkpoint's host ports verbatim (`checkpoint_network`,
  `validate_compatibility`); `create --from` a live checkpoint refuses `-p`,
  `--net` and every topology flag (`topology_overridden` in
  `run_from_smolmachine`, src/cli/machine.rs). Ours: after `create --from`,
  the port moves with `machine update --remove-port … -p …` before the first
  start.
- smolvm's own fork ports come from 20000–31999: `CLONE_PORT_FLOOR` (20000) up
  to `CLONE_PORT_CEILING` (32000), which is excluded (`alloc_free_host_port`,
  src/agent/fork.rs). The CLI allocates no other host port range. Ours:
  `reservedPorts` (`machine-ports.ts`) holds that range beside the Linux and
  macOS ephemeral ranges, and the host config refuses a `machinePorts` that
  reaches into any of them (10000–19999 by default; `config.test.ts`).

**Checkpoints, forks and identity**

- Capture refuses a machine that isn't running ("machine '…' must be running",
  `validated_capture_source`, src/portable_checkpoint.rs). Started
  `--branchable`, a machine's capture defers its RAM save and pauses it only
  briefly, and a restore reads its RAM in place; without it a store capture
  falls back to a synchronous save, pausing it for the whole RAM write
  (`declined_deferred_save`). A branchable machine gets no idle balloon
  reclaim. Every capture first compacts the guest's memory (an exec of up to
  300 s) and hints its free pages, both best-effort
  (`release_free_guest_memory`). Ours: every start passes `--branchable`; a
  capture or fork of a stopped machine is `WrongState` before anything native;
  no bound on capture.
- Capture is atomic (temp file, fsync, publish without clobbering,
  `pack_artifact_inner`, crates/smolvm-pack/src/packer.rs). A restore
  directory is built under a `-partial` name, marked pending, renamed into
  place, and a failed create rolls the machine back (`install_with`,
  src/portable_checkpoint.rs). A store checkpoint publishes with
  `RENAME_NOREPLACE` and a parent fsync (`publish`,
  crates/smolvm-checkpoint/src/store.rs). Ours: no checks of our own around
  either.
- smolvm records and enforces CPU, memory, disk sizes, platform, CPU contract,
  guest CPU features, clock, state origin and network
  (`validate_compatibility`, src/portable_checkpoint.rs), but not the engine
  build or the agent, and its ABI string (`RUNTIME_ABI`) has stayed the same
  across libkrun changes to restored device state. Ours: `pin`, so a RAM state
  is restored only under the release that saved it. If smolvm starts enforcing
  engine and agent identity itself, the pin could go.
- Store mode: `--store` with `--history 0` (the default keeps 32 generations, so
  deleting older checkpoints frees nothing until the newest goes), then
  `checkpoint-prune`; the store's `objects/` layout (`prune`,
  crates/smolvm-checkpoint/src/store.rs, read in `smolvm.ts`). A restored
  machine holds no reference into the store (no `.pack-shared`, no hard
  links): each store restore materializes the checkpoint privately
  (`machine_layers_cache_dir`, src/agent/manager.rs; `run_from_smolmachine`,
  src/cli/machine.rs: a checkpoint directory is `stored`, which takes neither
  the shared extractions, leases and `.pack-shared` of single-file artifacts
  nor the delta import), so a fork's store is removed whole under its running
  child, and two creates from one checkpoint only read its `objects/`. A CLI
  capture into another store is whole, not a delta of the checkpoint it was
  restored from (that is `serve`'s), and `prune` frees only objects with one
  link. The restore cache `vms/_restore-checkpoints` survives every command;
  `--restore-cache-entries 0` turns it off. The store's `lineage/<id>.json`
  grows by a small file per capture, which prune never removes. Ours: one
  store per host, fork stores removed whole, restore cache off.
- Fork and restore re-mint the SSH host keys, `/etc/machine-id` and the hostname,
  the restored container's UTS namespace included, and map the new hostname to
  127.0.1.1 in `/etc/hosts`, never removing the source's line
  (`build_rejuvenation_script`, `rejuvenation_hosts_script`,
  src/agent/fork.rs; `finalize_live_restore`, src/portable_checkpoint.rs),
  retrying three times, then deleting the clone (`rejuvenate_clone`,
  `REJUVENATE_ATTEMPTS`), each try a `/bin/sh -c` of up to 120 s. `create
  --from … --keep-identity` skips it. The re-mint only stirs the RNG pool (its
  `/dev/urandom` write; `rejuvenate_clone`'s doc: no `RNDADDENTROPY` or
  VMGENID), and the guest has no vmgenid, so restores of one RAM state got
  duplicate host keys (4 distinct of 20). A running sshd is not touched, and
  the kernel `boot_id` is not re-minted. Ours: preparation reseeds the RNG
  (`/dev/random` plus `RNDRESEEDCRNG`), re-mints the keys and SIGHUPs sshd on
  every runtime, whatever smolvm did.

**Why things are avoided** (re-check whether the reason still holds)

- `machine branch`: branch children pin their source. `stop` refuses a source
  whose children don't let it continue, and `delete` and a disk resize refuse
  one with any child (`has_frozen_fork_state`, src/agent/state_probe.rs; "is
  the fork base for" in `stop_vm_named`, `ensure_fork_base_delete_is_safe`,
  `expand_disks`, src/cli/vm_common.rs). Ours: fork is a checkpoint plus a
  restore.
- Bare VMs: copied-up files gave `Stale file handle` after a cold boot, from
  the root overlay's `index=Y` over a virtiofs lower; the root overlay is now
  `index=off` (`setup_persistent_rootfs`, crates/smolvm-agent/src/main.rs),
  untried. Ours: machines always run an image.
- Packs: an image export's guest `tar` drops every xattr,
  `security.capability` included (no `--xattrs`, crates/smolvm-agent/src/main.rs).
  Ours: no `disk` checkpoints on smolvm.
- `smolvm serve`: a process-global agent rootfs and HOME, forced virtio-net and
  its own egress floor, lossy non-streamed exec output (src/api/handlers/).
  The embedded engine: exec stdin only as text, one runtime per process
  (src/embedded/), no stability statement. Ours: the CLI.

## Verify

- Unit: `vp test` in `packages/host` (`platform/smolvm.test.ts` fakes each smolvm call
  as the tested release answers it; `platform/sqlite.test.ts`) and `packages/sdk`
  (`ids.test.ts`), then `vp run --no-cache ready`. Update a fake only to match
  smolvm's real behaviour at the target.

## After

- Set `testedVersion`, the version in README (`git grep` for the old one) and
  the release in Notation above. Edit a claim or a `Source: smolvm` comment
  only where the target changed it: check each identifier still finds the
  code, and add claims the new release introduced.
- Tell the operator what the bump does to a running host: the host refuses to
  start until its config names a prefix with the new release (install into a
  new prefix, expand its templates, change `linux.prefix`, restart); running
  VMs keep their old prefix, which must stay until its last machine is deleted;
  the new prefix builds new image seeds; and every existing `ram` checkpoint
  now fails its restore with `PinMismatch`, since its pin names the old
  release.
- Report the tag transition, the claims that changed and their fixes, the checks
  actually run, optional opportunities (with touchpoints and the smallest useful
  check), and remaining runtime resources and retained disk separately.
