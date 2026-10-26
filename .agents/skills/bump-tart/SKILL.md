---
name: bump-tart
description: Qualify a new Tart release for clankerbox's Tart host, re-checking every Tart claim the host relies on, and raise the floor when needed.
disable-model-invocation: true
---

# Bump Tart

clankerbox's Tart host runs the operator's versioned `tart` install, any release
at or above a floor. A bump re-checks the claims below against Tart's source at
the target release, not just the tests: the host's code embodies each one. Fix
what broke, report optional opportunities separately, and don't deploy, change
production hosts or the operator's Tart, or commit unless asked.

## Source and scope

- **Pinned in this repo:** `requirements.tart.minimumVersion` in
  `packages/sdk/src/requirements.ts`, published for deploy tooling, is a
  floor: `supported` accepts any `major.minor.patch` at or above it, and startup
  refuses the rest. It carries no comment (no prose comments); why the floor
  is where it is lives in this skill, below, and in the commit that moved it. The tested
  release also appears in README (install table, the `tart.binary` example)
  and the tests
  (`packages/host/tests/platform/tart/tart.test.ts`, whose fake `tart` answers as the tested
  release; `config.test.ts`): `git grep -n '2\.41'`.
- **Companions** pinned beside it in `requirements`, re-checked only when
  they change: Softnet 0.24.1 (`softnet.checkedVersion`, README),
  tart-guest-agent at least 0.15.0 (inside the image), and the one mac base,
  `bases.mac.macos` (README), Cirrus's Xcode image, tag `27`, uploaded
  2026-09-22, with a 140 GB disk:

      ghcr.io/cirruslabs/macos-tahoe-xcode@sha256:71d9dc1d6c4614b7ecbb328753124912b43425fc8cf1c4085d7f352026df6601

  `requirements.test.ts` fails until README states each. The claims about the
  base below were checked on `macos-tahoe-base` (`87f3aa5c…`, 2026-10-04),
  which Cirrus builds the Xcode image on; they have not been re-checked on the
  Xcode image itself, which the operator's mac host ran under 0.24.
- **Target:** the latest stable published `openai/tart` release (the repository
  moved from `cirruslabs/tart`, which redirects; its release
  metadata, such as `gh release view --repo openai/tart`), unless the user
  names one. Not upstream main or Homebrew's version. Record old and new tags
  and commits.
- **Source:** a read-only cache at `~/.cache/checkouts/github.com/openai/tart`.
  Fetch missing tags (no `v` prefix, such as `2.41.1`); read with
  `git show <tag>:Sources/tart/<path>`. Never edit, reset or switch it. Run
  tests on a private install of the target, never by upgrading the operator's.
- **Notation:** a citation is a path under `Sources/tart/` at the tested
  release, 2.41.1, and the identifier beside it (a type, function, case or
  message) finds the code: `git grep -n <identifier> <tag> --
  Sources/tart/<path>`. Code comments cite the same way, as `// Source: tart
  <path> <identifier>`: `git grep -n 'Source: tart'`.
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
  throws "new disk size … should be larger than the current disk size" for raw
  and ASIF disks (`resizeRawDisk`, `resizeASIFDisk`,
  VMDirectory.swift), and a stacked disk grows only its writable
  overlay (`growWritableOverlay`, DiskImageStack.swift). Ours: `diskGb` rounds
  `diskGib` up, `shrinkRefusal` matches that text and makes it `Unsizable`.
  The pinned Xcode image has a 140 GB disk, so a `diskGib` below 130 is
  `Unsizable`.
- `tart set` saves `--cpu` and `--memory` (MiB) to the VM's config before it
  resizes its disk (`run`, Commands/Set.swift), so a disk refusal leaves them
  set, and a `--disk-size` of the disk's own size changes nothing. `tart get
  --format json` gives `CPU`, `Memory` in MiB and `Disk` in whole GB, null when
  the disk's size can't be read (`VMInfo`, `run`, Commands/Get.swift). A
  darwin VM's vCPUs or memory below its minimum throw "… at minimum (requested
  N)" before the config is saved (`setCPU`, `setMemory`, VMConfig.swift).
  Ours: `growsLive` is false, so the core resizes only a stopped VM, after it
  refused a smaller disk; `resize` passes the vCPUs, memory and disk the
  request names, and the `set` after a fork's or restore's clone those that
  differ from its source's (`sizeFlags`); `set` makes `minimumRefusal`
  `Unsizable`, for a create too; `sizable` refuses nothing; `sizes` and
  `decodeInfo` read the VM back after every resize and at each host's start,
  leaving out a null `Disk`, and `diskGibOf` floors the GB to the GiB
  `diskGb` rounded up from.
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
  bounded by the same, past which the boot fails, writing nothing.
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
  paused machine is `tart stop <vm>`, and `stopResumes` is false, so the core
  neither admits it nor checks its pin.
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
- Blocking `@host` also blocks the gateway's DNS. Softnet's default block list
  already holds six of the seven ranges the old host blocked (softnet's default
  block list in `lib/proxy/vm.rs`). Ours: setup sets public resolvers; guests
  can't reach any of the Mac's addresses.

**Exec, the control socket and the guest agent**

- The control socket is bound and dialled as the relative name `control.sock`
  after a change into the VM's directory (`changeCurrentDirectoryPath` and
  `controlSocketURL.relativePath`, ControlSocket.swift and
  Commands/Exec.swift), so a Tart home's path length doesn't matter.
- `tart exec -i` reads stdin into an unbounded stream (`stdinStream`,
  Commands/Exec.swift): a raw 1 GiB upload peaked at 2+ GiB RSS in the
  host's `tart`. A killed `tart exec` leaves the guest's command (and over the
  forwarder its `nc` and `sshd-session`) until its session next writes (the
  proxy in `executeThenClose`, ControlSocket.swift). Ours: bulk data goes
  over ssh through the forwarder (`tart exec -i <vm> nc 127.0.0.1 22`), whose
  window keeps it at about 20 MiB; the forwarder ends a connection by closing
  the exec's stdin.
- From 2.41.1 `tart exec` asks the guest agent for 64 KiB HTTP/2 windows
  (`targetWindowSize`, GuestAgentChannel.swift), so at most 64 KiB of
  guest output is in flight per stream, against virtio-vsock dropping whole
  blocks of fast output from macOS 12–15 guests (openai/tart#1347). Tahoe
  guests didn't lose any. Ours: the pinned base is a Tahoe guest; the forwarder's
  guest-to-host direction (ssh downloads) runs under that window, and its
  throughput at 2.41.1 is unmeasured.
- An exec before the VM runs fails at once (exit 2); one sent while it boots
  blocks until the agent is up, or fails after about 30 s with
  `GRPCConnectionPoolError … is the Tart Guest Agent running?`. Alone a stock
  Cirrus guest answered 18.5–32.3 s after `tart run`, two booting together
  after about 61 and 93 s. Ours: `bootWait` (3 minutes) retrying every
  `probePause`.
- tart-guest-agent (0.15.0 on `macos-tahoe-base`) runs as a root LaunchDaemon and as a
  per-user LaunchAgent for the auto-login user `admin`, which serves exec;
  `admin` has `NOPASSWD: ALL`. `tart exec -i <vm> sudo -n /bin/bash -c <script>`
  passes exit codes, keeps stdout and stderr apart, runs as uid 0 and sees
  end-of-input at once with stdin closed. Ours: `exec` adds `sudo -n`.
- Registry credentials are looked up only on an auth challenge, and a failed
  lookup only prints a warning (`auth(response:)`, `lookupCredentials`,
  OCI/Registry.swift). Ours: no `HOME=<root>` for tart; the job
  gets the user's `HOME`.
- Ours: every tart call and every VM job runs with one environment
  (`environment` in `tart.ts`): a fixed
  `PATH` (`searchPath`, holding `/usr/local/bin` for Softnet but not
  `/opt/homebrew/bin`, whose Softnet isn't SUID root), the user's `HOME`, and the host's `TART_HOME` if set,
  so a job's `tart run` finds the VM the host made, in the host's Tart home.

**The Cirrus base** (re-check when the base's digest changes, and on the Xcode
image before the next bump relies on them)

- Every clone carries the image's SSH host keys; launchd starts sshd per
  connection, so the next connection serves re-minted keys without a restart.
  Ours: preparation re-mints them.
- macOS refuses writes to `/dev/urandom` and reseeds on a write to
  `/dev/random`. Ours: preparation's seed write.
- There is no `/etc/environment` and no `pam_env`; ssh sessions read
  `/etc/zshenv`, exec and `sudo -n bash` read neither.
- The Mac's application firewall, when on, prompts once per new binary and
  holds its connections until answered; an "Allow incoming connections" entry
  matches by signing identifier.

## Verify

- Unit: `vp test` in `packages/host` (`platform/tart/tart.test.ts`, `platform/tart/forwarder.test.ts`,
  `config.test.ts`), then `vp run --no-cache ready`. Change the fake's answers
  only to match Tart's real output at the target.

## After

- Raise `minimumVersion` only when the code comes to depend on something the
  target added or fixed: add that reason under "Why the floor is" and in the
  commit message, and the boundary
  versions to `tart.test.ts`'s `supported` cases. Otherwise the floor stays,
  and only the tested release moves (README, the fake's version).
- Set the tested release in Notation above. Edit a claim or a `Source: tart`
  comment only where the target changed it: check each identifier still finds
  the code, and add claims the new release introduced.
- Tell the operator how to move: install the new release in its own versioned
  path, change `tart.binary`, restart the host. Every `start` writes the VM's
  job again, and a stopped job launchd still holds whose arguments aren't this
  host's is reloaded, so VMs move as they restart; keep the old install until
  no running VM's job names it. A paused machine resumes under the new Tart,
  or fails and keeps its saved state, which a stop discards; start or stop
  each paused machine before the move to keep that from happening.
- Report the tag transition, exact executable provenance, the claims that
  changed and their fixes, the checks actually run, optional opportunities, and
  remaining runtime resources and retained disk separately.
