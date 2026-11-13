---
name: bump-tart
description: Qualify a new Tart release and Cirrus's newest macOS base for clankerbox's Tart host, re-checking every Tart claim the host relies on, and raise the floor when needed.
disable-model-invocation: true
---

# Bump Tart

clankerbox's Tart host runs the operator's versioned `tart` install, any release
at or above a floor, and makes its machines from one Cirrus base. A bump
re-checks the claims below against Tart's source at the target release, not
just the tests: the host's code embodies each one. Every bump also moves the
base to Cirrus's newest image, even when Tart itself hasn't moved, and re-checks
the claims about the base on a VM made from it. Fix what broke, report optional
opportunities separately, and don't deploy, change production hosts or the
operator's Tart, or commit unless asked.

## Source and scope

- **Pinned in this repo:** `minimumVersion` in
  `apps/host/src/platform/tart/tart.ts` is a floor: `supported` accepts any
  `major.minor.patch` at or above it, and startup refuses the rest.
  `requirements.test.ts` fails until README states it. Why the floor is where
  it is lives in this skill, below, and in the commit that moved it. The tested
  release also appears in README (install table, the `runtime.tart.binary` setting)
  and the tests (`apps/host/tests/platform/tart/tart.test.ts`, whose fake
  `tart` answers as the tested release; `config.test.ts`):
  `git grep -n '2\.41'`.
- **Companions**, re-checked only when they change: Softnet 0.25.0 (README;
  the latest `cirruslabs/softnet` release, read at
  `~/.cache/checkouts/github.com/openai/softnet` as Tart's source is) and
  tart-guest-agent at least 0.15.0 (inside the image). A Softnet bump re-checks "Softnet and the network" below on a VM run with the target
  installed SUID root in a private directory put first on the check's `PATH`,
  which only the operator can do: `sudo install -o root -g wheel -m 4755
  <softnet> ~/.cache/bump-tart/bin/softnet`.
- **The base**, `macos` in README, moves at every bump. It is now
  Cirrus's Xcode image on macOS 27 (Golden Gate), tag `27.2`, Xcode 27.2,
  uploaded 2026-10-31, an ASIF disk:

      ghcr.io/cirruslabs/macos-golden-gate-xcode@sha256:d7641b1d985fd53fbac071c663bf249007b9b387e16b7d576144588acb1d93f9

  Cirrus builds it on `macos-golden-gate-base` (`14f4fc32…`, 2026-10-31). The
  claims about the base below were checked on this image, on a VM, at Tart
  2.41.1 on a macOS 27.2 host.
- **Target:** the latest stable published `openai/tart` release (the repository
  moved from `cirruslabs/tart`, which redirects; its release
  metadata, such as `gh release view --repo openai/tart`), unless the user
  names one. Not upstream main or Homebrew's version. Record old and new tags
  and commits.
- **Base target:** Cirrus's Xcode image for the newest macOS, at its highest
  stable tag, unless the user names one. The macOS lines are the
  `templates/vanilla-<codename>.pkr.hcl` files in
  cirruslabs/macos-image-templates, and the newest is the one whose `from_ipsw`
  names the highest macOS version; its image is
  `ghcr.io/cirruslabs/macos-<codename>-xcode`, whose tags are Xcode versions, so
  the macOS version never shows in a tag: `macos-tahoe-xcode:27` is Xcode 27 on
  macOS 26. The registry answers anonymously:

      tok=$(curl -s 'https://ghcr.io/token?scope=repository:cirruslabs/macos-<codename>-xcode:pull' | sed 's/.*"token":"\([^"]*\)".*/\1/')
      curl -s -H "Authorization: Bearer $tok" https://ghcr.io/v2/cirruslabs/macos-<codename>-xcode/tags/list
      curl -sI -H "Authorization: Bearer $tok" -H 'Accept: application/vnd.oci.image.manifest.v1+json' https://ghcr.io/v2/cirruslabs/macos-<codename>-xcode/manifests/<tag>

  A stable tag is `major.minor[.patch]`; skip `-beta` and `-rc`. The HEAD's
  `docker-content-digest` is the digest to pin; the manifest's
  `org.cirruslabs.tart.upload-time` annotation is the upload date, and its
  config blob's `org.cirruslabs.tart.disk.format` label the disk format. Its
  `org.cirruslabs.tart.uncompressed-disk-size` is the disk file's length
  (`pushDiskLayers`, VMDirectory+OCI.swift), which for an ASIF image is what
  it holds, not its capacity: read the capacity from `tart list`'s `Disk` after
  the pull. Pull the image into a private `TART_HOME`, clone and boot a VM from
  it with `program`'s flags, and re-check "The Cirrus base" and every claim
  below that names the base on it; delete the VM after, and report the private
  home's size. Record old and new digests.
- **Source:** a read-only cache at `~/.cache/checkouts/github.com/openai/tart`.
  Fetch missing tags (no `v` prefix, such as `2.41.1`); read with
  `git show <tag>:Sources/tart/<path>`. Never edit, reset or switch it. Run
  tests on a private install of the target, never by upgrading the operator's.
- **Notation:** a citation is a path under `Sources/tart/` at the tested
  release, 2.41.1, and the identifier beside it (a type, function, case or
  message) finds the code: `git grep -n <identifier> <tag> --
  Sources/tart/<path>`. Code comments cite a permalink at the tested release,
  as `// https://github.com/openai/tart/blob/2.41.1/Sources/tart/<path>#L<line>`:
  `git grep -n 'github.com/openai/tart/blob/'`.
- Read the release notes and the full changed-file list, then each claim's file.

## Claims to re-check

Each: what Tart does, where, and what of ours depends on it.

**Why the floor is 2.41.1** (`minimumVersion`)

- `tart list` skips a VM deleted between enumerating the Tart home and reading
  its metadata, where before it failed outright (`isFileNotFound` in
  `compactMap`, Commands/List.swift; fixed in 2.41.1). Ours: nothing
  orders a machine's `tart list` (`state`, `halted`, `observe`, `admit`,
  `capacity`) against another machine's or a checkpoint's `tart delete`, so
  below 2.41.1 a stop, start, fork or capture racing a delete failed `Internal`
  and a recheck read every machine `unknown`.

- Clone refuses an existing destination unless `--overwrite`
  (`rejectExistingDestination`, Commands/Clone.swift). Ours:
  native names carry the row's instance, so a clone never meets one, and
  `--overwrite` is never passed.
- Delete's exit codes: `VMDoesNotExist` and `VMNotRunning` exit 2, anything else
  1 (`RuntimeError`'s `exitCode`, VMStorageHelper.swift); a running
  VM exits 1 from 2.40.0.
  Ours: delete treats 2 as gone, and on 1 forces the VM off
  (`tart stop --timeout 0`) and deletes again.
- One control-socket accept error no longer disables `tart exec` until restart
  (`ControlSocketAcceptErrorHandler`, ControlSocket.swift), and
  `tart list` no longer fails on running VMs.

**Clone, names and sizes**

- Clone builds in a temp directory (`VMDirectory.temporary`) under a lock
  (`FileLock`), then moves it into place; interrupted clones are
  garbage-collected (`run` in Commands/Clone.swift;
  `runGarbageCollection` in Root.swift). It doesn't require a stopped source,
  only a stacked one must be stopped ("must be stopped before cloning"). Ours:
  no checks around clone; fork and capture of a running machine are refused by
  our own rule, before anything native, since a clone of a stopped disk is consistent
  and one of a running VM's disk is crash-consistent at best.
- Clone regenerates a colliding MAC, checking one Tart home only
  (`hasVMsWithMACAddress`, Commands/Clone.swift;
  `hasRunningMACCollision`, Commands/Run.swift). Ours: no `--random-mac`;
  `tart set --random-serial` once per clone.
- A local VM name only has to be free of `/` (`validate`,
  Commands/Clone.swift). Ours: `machineName` and `checkpointName`,
  `cbx-<host>-{m,c}-<name>-<inst>`.
- `tart set --disk-size` only grows a disk, in GB (10^9 bytes); a smaller size
  throws "new disk size … should be larger than the current disk size" for a
  raw disk and "New disk size … should be larger than the current disk size"
  for an ASIF one (`resizeRawDisk`, `resizeASIFDisk`, VMDirectory.swift), and
  a stacked disk grows only its writable overlay (`growWritableOverlay`,
  DiskImageStack.swift). A raw disk grows by truncating the file; an ASIF disk
  by `diskutil image resize --size <n>G` (`performASIFResize`), with
  `diskutil` found on `PATH`, and its current size is read with `diskutil
  image info --plist` (`Diskutil.imageInfo`, Diskutil.swift). Ours: `diskGb`
  rounds `diskGib` up, `shrinkRefusal` matches both texts and makes it
  `Unsizable`, and `searchPath` holds `/usr/sbin`, where `diskutil` is. The
  pinned base's disk is ASIF with a 140 GB capacity, which `diskutil` reports
  as 140000002048 bytes, so `--disk-size 140`, 130 GiB rounded up, is refused
  as a shrink too, and a `diskGib` below 131 is `Unsizable`; the file holds
  about 90 GB of it. Growing it one GB took 12.5 s on a VM, and `tart`, in
  `tart.ts`, runs a command under no deadline, so a `set` waits it out.
- `tart set` saves `--cpu` and `--memory` (MiB) to the VM's config before it
  resizes its disk (`run`, Commands/Set.swift), so a disk refusal leaves them
  set, and a `--disk-size` of a raw disk's own size changes nothing, where an
  ASIF disk's is refused, as `diskutil` rounds its size up to whole 512-byte
  units. `tart get
  --format json` gives `CPU`, `Memory` in MiB and `Disk` in whole GB, null when
  the disk's size can't be read (`VMInfo`, `run`, Commands/Get.swift), which
  for an ASIF disk is while its VM runs and holds the disk open (`try?
  vmDir.diskSizeBytes()`, Get.swift and List.swift). A
  darwin VM's vCPUs or memory below its minimum throw "… at minimum (requested
  N)" before the config is saved (`setCPU`, `setMemory`, VMConfig.swift).
  `--cpu` and `--disk-size` parse as `UInt16`, `--memory` as `UInt64` (`Set`).
  Ours: `growsLive` is false, so the core resizes only a stopped VM, after it
  refused a smaller disk; `resize` passes the vCPUs, memory and disk the
  request names, a create's `set` all three, and the `set` after a fork's or
  restore's clone those that differ from its source's (`sizeFlags`); `set`
  makes `minimumRefusal` `Unsizable`, for a create too; `sizable` refuses
  vCPUs or a disk in GB past `maximumFlag`; `sizes` and
  `decodeInfo` read the VM back after every resize and at each host's start,
  leaving out a null `Disk`, which `sizedBy` fills with the disk the row holds,
  so a running ASIF VM's read at a host's start keeps the row's disk; and
  `diskGibOf` floors the GB to the GiB `diskGb` rounded up from.
- The base's `tart-guest-agent --run-daemon`, a launch daemon run at load
  (`data/tart-guest-daemon.plist`, installed by `templates/base.pkr.hcl` in
  cirruslabs/macos-image-templates), implies `--resize-disk` and grows the
  APFS container into the disk's free space at each boot with `diskutil apfs
  resizeContainer` (`internal/command/root.go`,
  `internal/diskresizer/diskresizer.go` in cirruslabs/tart-guest-agent).
  Ours: preparation grows no filesystem; a disk a resize grew is the guest's
  from its next boot. Checked from source, not yet on a VM.
- `tart get` opens local VMs only (`VMStorageLocal().open`,
  Commands/Get.swift), not an OCI reference, and `tart list` reports no
  OS (`VMInfo`, Commands/List.swift). Ours: no check of `diskGib` against the
  base before the create; Tart's refusal at `tart set` is the check.

**State, stop and capacity**

- `tart list --format json` gives `Source`, `Name`, `Disk` (can be null),
  `Size`, `Accessed`, `Running` (deprecated, kept in JSON for compatibility,
  Formatter/Format.swift) and `State`: `running`, `suspended` or
  `stopped` (`VMDirectory.State`, VMDirectory.swift), from the VM's lock,
  which `tart run` holds, then whether `state.vzvmsave` exists (`state`,
  `stateURL`). It sees one Tart home only. Ours: `VmState`, `decodeList`,
  `stateOf` (suspended reads paused), the two-VM count, and
  `observe`'s `tart list`, bounded by the core's `stateReadWait` (9 s), past
  which every machine reads `unknown`; the two-VM count's `tart list` is
  bounded by the same, past which the boot fails, writing nothing. With one
  running ASIF VM and the cached base, `tart list --format json` took 0.9–1.6 s,
  `diskutil image info` behind each ASIF disk included.
- `tart stop` sends SIGINT to `tart run`, waits up to `--timeout` (default 30 s)
  for the lock to clear, then SIGKILLs it; a stopped VM exits 2 (`stopRunning`,
  Commands/Stop.swift). Its return doesn't mean the VM is gone:
  `tart run` can still be exiting. Ours: stop is
  the guest's `shutdown -h now`, then `tart stop --timeout 0` after
  `shutdownWait`, and both wait for `tart list` to read it stopped
  (`forcedStopWait`).
- `shutdown -h now` on a guest whose agent is still coming up waits for the
  agent, since the exec does. Ours: `shutdownWait`, a minute.
- Apple allows two running macOS VMs per Mac, system-wide. Tart catches
  `virtualMachineLimitExceeded` (Commands/Run.swift), prints
  "The number of VMs exceeds the system limit" (`VirtualMachineLimitExceeded`,
  VMStorageHelper.swift) and exits 1 (`Foundation.exit(1)` in Run.swift)
  within 0.3–0.6 s; under launchd the job just
  exits. Its hint lists the same home's VMs only. Ours: `vmLimit`, the count in
  `admit`, and `limitRefusal` read from the job's log as `Capacity`.

**Suspend and resume**

- `tart suspend` only sends SIGUSR1 to the VM's `tart run` and returns
  (`Suspend`, Commands/Suspend.swift), so its exit code says nothing of the
  save. `tart run`'s handler pauses the VM, saves it to `state.vzvmsave`,
  prints "snapshot created successfully! shutting down the VM..." and ends the
  run; a save that fails prints "Failed to suspend the VM: …" and exits 1,
  powering the VM off and possibly leaving a partial `state.vzvmsave`, and a VM
  run without `--suspendable` fails the same way (the SIGUSR1 handler in `run`,
  `validateSaveRestoreSupport`, Commands/Run.swift). `--suspendable` also
  drops the VM's audio and entropy devices and its non-Mac input devices
  (`suspendable`'s help, Commands/Run.swift). Ours: every job runs
  `--suspendable` (`program`), so every mac VM boots without those devices; a
  pause stops a VM whose loaded job's arguments lack it, as `stop` does, then,
  without interruption, waits `suspendWait` for `tart list` to read it not
  running and reads `saved` in the job's log, or runs `tart stop <vm>` to
  remove what it left of `state.vzvmsave` and fails; a log it can't read fails
  the pause and keeps the state.
- `tart run` of a VM with a `state.vzvmsave` turns on `--suspendable` itself,
  prints "restoring VM state from a snapshot...", removes the file only once
  the restore succeeds, and on a failed restore prints the error and exits 1
  (`run`, Commands/Run.swift). Ours: a start boots a paused VM's job as it
  boots a stopped one, its log emptied first.
- `tart stop` of a suspended VM removes its `state.vzvmsave` and exits 0,
  booting nothing (`stopSuspended`, Commands/Stop.swift). Ours: `stop` of a
  paused machine is `tart stop <vm>`, and Tart's `stop` trait is `discards`, so
  the core neither admits it nor checks its pin.
- Virtualization.framework seals saved state with a key in the operator's
  session keychain: a restore while the session is locked fails, printed by
  `tart run` as `Error Domain=VZErrorDomain Code=12 "The virtual machine
  failed to restore with error “permission denied”."`, macOS's English text;
  the first save, which creates the key, fails too, later saves work locked,
  and a root LaunchDaemon can't save at all (no keychain, -25291). macOS, not
  Tart, so re-check it on a macOS upgrade. Ours: every failed resume is
  `Internal`, its message saying a locked session refuses one, the saved state
  kept; README's mac Deploy says to make the first pause unlocked; `pin` is
  `undefined`, as a restore that fails keeps the saved state, so no pin guards
  a resume.

**Softnet and the network**

- `--net-softnet-block` implies `--net-softnet` (`netSoftnetBlock`,
  Commands/Run.swift). Tart finds `softnet` on `PATH`
  (`resolveBinaryPath`, Network/Softnet.swift, Utils.swift), and sets its SUID
  bit only from an interactive session (`isInteractiveSession` before
  `configureSUIDBitIfNeeded`, Run.swift), never under launchd. Ours:
  `softnet = "--net-softnet-block=@host"`, `searchPath` holds `/usr/local/bin`,
  and the operator installs Softnet SUID root beforehand.
- Tart runs `softnet --vm-fd 0 --vm-mac-address <mac> --block <rules>`
  (`Softnet.init`, Network/Softnet.swift; `userSpecifiedNetwork`, Run.swift),
  which Softnet 0.25.0 still takes for one VM beside its new `--control-fd`-only
  start that proxies up to five (`Args`, src/main.rs). Each `tart run` is its
  own Softnet process on its own vmnet network with a `/29`, and `@host` is
  that network's gateway (`Rules::new` is given `host.gateway_ip`,
  lib/proxy/mod.rs; `insert_filter`, lib/proxy/rules.rs). Ours: one VM per
  Softnet, so no machine shares a network with another.
- With no rule matched, Softnet lets a packet out only to a global address or
  the gateway (`is_global` and `gateway_ip` in `allowed_from_vm_ipv4`,
  lib/proxy/vm.rs), so private, link-local, loopback and shared ranges are
  blocked without a rule, another VM's `/29` among them; 0.25.0 turned
  vmnet's own isolation off (`enable_isolation: Some(false)`, lib/host.rs), so
  that fallback is the isolation. Blocking `@host` also blocks the gateway's
  DNS. 0.25.0's DNS zone, `<name>.internal`, answers only for VMs started with
  a name (`dns_server` in lib/manager.rs), which Tart never passes. Ours: setup
  sets public resolvers; guests can't reach any of the Mac's addresses.

**Exec, the control socket and the guest agent**

- The control socket is bound and dialled as the relative name `control.sock`
  after a change into the VM's directory (`changeCurrentDirectoryPath` and
  `controlSocketURL.relativePath`, ControlSocket.swift and
  Commands/Exec.swift), so a Tart home's path length doesn't matter.
- `tart exec -i` reads stdin into an unbounded stream (`stdinStream`,
  Commands/Exec.swift): a raw 1 GiB upload peaked at 2+ GiB RSS in the
  host's `tart`. A killed `tart exec` leaves the guest's command (and over the
  relay its `nc` and `sshd-session`) until its session next writes (the
  proxy in `executeThenClose`, ControlSocket.swift). Ours: bulk data goes
  over ssh through the relay (`tart exec -i <vm> nc 127.0.0.1 22`), whose
  window keeps it at about 20 MiB; the relay ends a connection by closing
  the exec's stdin.
- From 2.41.1 `tart exec` asks the guest agent for 64 KiB HTTP/2 windows
  (`targetWindowSize`, GuestAgentChannel.swift), so at most 64 KiB of
  guest output is in flight per stream, against virtio-vsock dropping whole
  blocks of fast output from macOS 12–15 guests (openai/tart#1347). Tahoe
  guests didn't lose any, and Golden Gate guests are unmeasured. Ours: the
  pinned base is a Golden Gate guest; the relay's guest-to-host direction
  (ssh downloads) runs under that window, and its throughput at 2.41.1 is
  unmeasured.
- An exec before the VM runs fails at once (exit 2); one sent while it boots
  blocks until the agent is up, or fails after about 30 s with
  `GRPCConnectionPoolError … is the Tart Guest Agent running?`. Alone a stock
  Tahoe guest answered 18.5–32.3 s after `tart run`, two booting together
  after about 61 and 93 s; a Golden Gate Xcode guest alone, 20.4–26.6 s, and
  its `shutdown -h now` had it stopped 9.8 s later. Ours: `bootWait` (3
  minutes) retrying every `probePause`.
- tart-guest-agent (0.15.0 on the base, installed from Homebrew's
  `openai/tools/tart-guest-agent` by `templates/base.pkr.hcl`) runs as a root
  LaunchDaemon and as a per-user LaunchAgent for the auto-login user `admin`,
  which serves exec;
  `admin` has `NOPASSWD: ALL`. `tart exec -i <vm> sudo -n /bin/bash -c <script>`
  passes exit codes, keeps stdout and stderr apart, runs as uid 0 with
  `HOME=/Users/admin`, no `LANG`, and a `PATH` of
  `/bin:/usr/bin:/usr/sbin:/usr/local/bin:/opt/homebrew/bin`, without `/sbin`,
  and sees end-of-input at once with stdin closed. Ours: `exec` adds `sudo -n`,
  `stop` calls `/sbin/shutdown` by its path, and the guest scripts set their
  own `PATH`.
- Registry credentials are looked up only on an auth challenge, and a failed
  lookup only prints a warning (`auth(response:)`, `lookupCredentials`,
  OCI/Registry.swift). Ours: no `HOME=<root>` for tart; the job
  gets the user's `HOME`.
- Ours: every tart call and every VM job runs with one environment
  (`environment` in `tart.ts`): a fixed
  `PATH` (`searchPath`, holding `/usr/local/bin` for Softnet but not
  `/opt/homebrew/bin`, whose Softnet isn't SUID root), the user's `HOME`, and the host's `TART_HOME` if set,
  so a job's `tart run` finds the VM the host made, in the host's Tart home.

**The Cirrus base** (re-check at every bump, on a VM made from the new base,
with the claims above that name the base: the guest agent's version, the boot
times, and the disk's capacity and format)

- Every clone carries the image's SSH host keys; launchd starts sshd per
  connection, so the next connection serves re-minted keys without a restart.
  Ours: preparation re-mints them.
- macOS refuses writes to `/dev/urandom` and reseeds on a write to
  `/dev/random`. Ours: preparation's seed write.
- There is no `/etc/environment` and no `pam_env`; ssh sessions read
  `/etc/zshenv`, which the base doesn't ship, and exec and `sudo -n bash` read
  neither.
- The Mac's application firewall, off on the base, prompts when on once per
  new binary and holds its connections until answered; an "Allow incoming
  connections" entry matches by signing identifier.
- The guest's resolver is the gateway, which `@host` blocks: on the stock base
  `dig @<gateway>` times out, `dig @1.1.1.1` answers, the gateway's ports 22
  and 8485, `10.0.0.1`, `100.64.0.1` and `192.168.1.1` refuse at once, and
  `1.1.1.1:443` connects. Checked under Softnet 0.24.1 and 0.25.0, the latter
  installed SUID root in a private directory: Tart ran it as `softnet --vm-fd 0
  --vm-mac-address <mac> --block @host`, and it ran on as the operator's user
  once set up.

## Verify

- Unit: `vp test` in `apps/host` (`platform/tart/tart.test.ts`, `platform/relay.test.ts`,
  `config.test.ts`), then `vp run --no-cache ready`. Change the fake's answers
  only to match Tart's real output at the target. `vp test` in `packages/sdk`
  holds README to the new base.
- On the base, in the private `TART_HOME`: `tart list`'s `Disk` of the cached
  image, for README's capacity and `diskGib` floor; a clone, `tart set
  --random-serial`, and `tart run` with `program`'s flags (`--no-graphics
  --suspendable --net-softnet-block=@host`), timing the first exec that
  answers; then over `tart exec -i <vm> sudo -n /bin/bash -c`, the guest
  agent's version, sshd's host keys, the `/dev/random` and `/dev/urandom`
  writes, `/etc/environment` and `/etc/zshenv`, the application firewall's
  state and `admin`'s sudoers entry; `tart list` and `tart get` while it runs,
  for `Disk` and how long they take with `diskutil` behind them; and, stopped,
  a `tart set --disk-size` a GB above the capacity, read back with `tart get`.

## After

- Raise `minimumVersion` only when the code comes to depend on something the
  target added or fixed: add that reason under "Why the floor is" and in the
  commit message, and the boundary
  versions to `tart.test.ts`'s `supported` cases. Otherwise the floor stays,
  and only the tested release moves (README, the fake's version).
- Set the tested release in Notation above. Move every Tart permalink to the
  target's tag and the line its code now sits on, edit a claim only where the
  target changed it, and add claims the new release introduced.
- Set the new base in README (the reference, its macOS and
  Xcode, its disk's format and capacity and the `diskGib` floor they give) and
  "The base" above, and move the claims the VM check changed.
- Tell the operator how to move: install the new release in its own versioned
  path, change `tart.binary`, restart the host. Every `start` writes the VM's
  job again, and a stopped job launchd still holds whose arguments aren't this
  host's is reloaded, so VMs move as they restart; keep the old install until
  no running VM's job names it. A paused machine resumes under the new Tart,
  or fails and keeps its saved state, which a stop discards; start or stop
  each paused machine before the move to keep that from happening.
- And how the base moves: `tart pull` the new reference as the host's user,
  into its Tart home, then set it as `bases.macos` in the host's config and
  restart the host.
  Machines and checkpoints made from the old base keep their disks. A template
  keeps cloning its current build, made from the old base, until
  `clankerbox template build NAME.yaml` runs again; `template get` shows each
  build's `image`. A create from the base, with no template, takes the new
  base at once. The old image stays in the Tart home's OCI cache until
  `tart delete` or `tart prune` removes it.
- Report the tag transition, exact executable provenance, the base transition
  (old and new digests, macOS, Xcode, disk format and capacity), the claims
  that changed and their fixes, the checks actually run, optional
  opportunities, and remaining runtime resources and retained disk separately.
