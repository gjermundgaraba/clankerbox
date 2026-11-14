---
name: bump-tart
description: Qualify a new Tart release and Cirrus's newest macOS base for clankerbox's Tart host, re-checking every Tart claim the host relies on, and raise the floor when needed.
disable-model-invocation: true
---

# Bump Tart

clankerbox's Tart host runs the operator's versioned `tart` install, a release
from a floor to the release this skill last qualified, and makes its machines
from one Cirrus base. A bump
re-checks the claims below against Tart's source at the target release, not
just the tests: the host's code embodies each one. Every bump also moves the
base to Cirrus's newest image, even when Tart itself hasn't moved, and re-checks
the claims about the base on a VM made from it. Fix what broke, report optional
opportunities separately, and don't deploy, change production hosts or the
operator's Tart, or commit unless asked.

## Source and scope

- **Pinned in this repo:** `minimumVersion` in
  `apps/host/src/platform/tart/tart.ts` is a floor and `testedVersion` a
  ceiling, the release this skill last qualified: `supported` accepts a
  `major.minor.patch` between them, and startup refuses the rest, and a version
  that names no release, with one message naming the range `qualified` gives. The host reads Tart's VM
  directories and processes (State, stop and capacity, below), which no Tart
  release promises to keep, so a newer Tart is refused rather than misread,
  a machine read `missing` and lost among them. `requirements.test.ts` fails
  until README's install table and upgrade notes name that range. Why the floor is where
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

- `tart exec` asks the guest agent for 64 KiB HTTP/2 windows from 2.41.1
  (`targetWindowSize`, GuestAgentChannel.swift; see "Exec" below). Ours: every
  exec and the relay's ssh run over it. 2.41.1 also stopped `tart list`
  failing on a VM deleted while it lists (`isFileNotFound`, Commands/List.swift),
  which no longer matters here, as the host runs no `tart list` (below).
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
  (`ControlSocketAcceptErrorHandler`, ControlSocket.swift; from 2.40.1).

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
  `decodeInfo` read the VM back after every resize, and after a resize its
  host lost, leaving out a null `Disk`, which `sizedBy` fills with the disk the
  row holds; and
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

- `tart list` and `tart get` read each VM's disk size, which for an ASIF disk
  is a `diskutil image info` (`diskSizeBytes`, VMDirectory.swift; `VMInfo` in
  Commands/List.swift and Commands/Get.swift), and `tart list` builds every
  row before it prints, `-q` too. So a list costs about 0.7 s per stopped VM
  in the home, and a get 0.7 s for one stopped VM. Measured at 2.41.1 on a
  macOS 27.2 Mac with one running VM and the rest stopped clones of the base,
  medians of 3 to 5 runs:

  | Read | 3 local VMs | 13 | 23 |
  | --- | ---: | ---: | ---: |
  | `tart list --source local --format json` | 1.5 s | 9.4 s | 18.0 s |
  | `tart list --source local -q` | 1.5 s | 9.5 s | 17.0 s |
  | `tart get <stopped VM> --format json` | 0.76 s | 0.67 s | 0.83 s |
  | `tart get <running VM> --format json` | 65 ms | 64 ms | 65 ms |
  | `diskutil image info --plist <stopped disk>` | 0.65 s | 0.75 s | 0.78 s |
  | `launchctl print gui/<uid>/<job>` | 4 ms | 5 ms | 5 ms |
  | `ps -axo pid=,ucomm=,args=` | 19 ms | 21 ms | 20 ms |
  | a VM directory's entries, read in Node | < 0.1 ms | < 0.1 ms | < 0.1 ms |

  Ours: the host runs no `tart list`, and `tart get` only in `sizes`. It reads
  a VM as Tart's `state` does (VMDirectory.swift): a VM at all when its
  directory under the home's `vms/` (`VMStorageLocal`'s `baseURL`) holds the
  files `initialized` asks for (`layout`), running while a `tart run` holds the
  lock on its `config.json` (`running`, PIDLock.swift), then paused when
  `state.vzvmsave` exists (`stateURL`). `Home.look` reads the directory, and
  `locks.ts` asks who holds each VM's lock with `fcntl(F_GETLK)`, as Tart's
  `PIDLock.pid` does, through macOS's `/usr/bin/perl`, since Node has no
  `fcntl`: one Perl for every VM a read asks about, packing `struct flock` as
  macOS's `sys/fcntl.h` lays it out (`off_t l_start, l_len; pid_t l_pid; short
  l_type, l_whence`, `pack('q q l s s')`). A read whose Perl fails, or answers
  for fewer VMs than it asked, fails `Internal`, never reading a VM stopped.
  Measured on macOS 27.2 with 2.41.1, over a home of 23 VMs and one path that
  isn't a VM: one read of all 24 paths took 0.01 s, 10 of 10; the lock holder
  of a running VM was its job's pid; and a VM's lock read free throughout a
  `tart delete`, a `tart set --cpu`, a 4.75 s `tart set --disk-size` of a
  standalone disk and a `tart clone` of it, read 1 to 630 times while each ran.
  A VM runs while any process holds its lock, or while its launchd job starts
  it, a moment before its `tart run` takes the lock. `tart push`, a stacked
  export and `tart delete` take the lock on a stopped VM while they work
  (Commands/Push.swift, VMDirectory+Archive.swift, VMDirectory.swift's
  `delete`), so the host reads such a VM running for that time. Perl ships
  with macOS 27.2, `/usr/bin/perl` 5.34, though Apple has said a later macOS
  will drop it: check it on a macOS upgrade, with the struct's layout. Each
  read costs the same however many VMs the home holds, inside the core's
  `stateReadWait` (9 s).
- `launchctl print gui/<uid>/<label>` is macOS's, not a stable interface: the
  host reads its tab-indented `state = …` line and its `arguments = { … }`
  block. A print without them, or with a state not among those captured on
  macOS 27.2 (`apps/host/tests/platform/tart/launchctl/`, and `capturedOn` in
  `launchd.ts`), makes that VM alone read unknown, with a warning that names
  it and the remedy, a release qualified on that macOS, and fails a stop, a
  pause or a boot of it `Internal`, saying the same. The states: `not running` before a job's first run and after each, with
  `last exit code`, a number or `(never exited)`; `xpcproxy` while launchd
  starts a VM's job; `spawn scheduled` while it waits to respawn a job
  `KeepAlive` restarts, which runs no process, so the host reads it as exited;
  and `running`. The host's jobs have no `KeepAlive`, and on macOS 27.2 one
  never printed `spawn scheduled`: one whose run Apple's two-VM cap refused
  (exit 1) printed `not running` 0.3 s later, and one kickstarted while a hand
  run held the VM's lock (exit 2, its log `VM "<vm>" is already running!`,
  Commands/Run.swift) 0.55 s later, and launchd ran neither again in 300 s;
  the host reads the latter VM running, by its lock. A kickstart 1 s after a
  job's run ended blocked 9 s, until launchd's throttle of 10 s passed, and
  then ran it. A label launchd doesn't hold exits 113, as does a
  `launchctl kickstart` of it ("Could not find service"). Re-capture them on a
  macOS upgrade, from a job of a scratch VM written as the host writes it, run
  free, refused by the cap and kickstarted under a hand run, and from
  `/usr/bin/false` under `KeepAlive`, and compare.
- `ps -axo pid=,ucomm=,args=` pads a process's name, which may hold spaces, to
  16 characters, and shows another user's arguments: on macOS 27.2 an
  unprivileged `ps` showed root's and the system users' processes with theirs
  (no second human user to look at). The host reads it only for the two-VM
  count. Ours: `tartRuns` takes a process as a `tart run` when its arguments
  start with the host's binary and `run`, whatever the binary is named, or its
  name is `tart` and the argument after the first path ending in `tart`, or
  after the first word, is `run`. A process run through a link to Tart of
  another name shows the name `tart`: measured on macOS 27.2, `tart-2.41.1 run`
  through a link showed `ucomm` `tart` and held the VM's lock. So a run of
  another home through a copy of Tart's executable under another name, or a
  path with a space after a directory named `tart` or before a link of another
  name, isn't counted; a VM is one of its arguments, wherever it stands.
  Re-check on a macOS upgrade.
- A `diskutil image info` of a VM's disk as its `tart run` starts fails that
  start, with `VZErrorDomain Code=1 "The virtual machine failed to start."` in
  the job's log, 3 runs of 3 with a `tart get` loop of the same VM beside the
  boot; a `tart get` loop of another VM failed neither a start nor a
  `tart set --disk-size` grow, 3 of 3 each. Ours: no read opens a disk, so
  reads never wait on a disk opener; `sizes` reads a machine whose step or
  loop holds it, which no boot of its own runs beside. A `tart list` someone
  else runs over the host's Tart home opens every stopped VM's disk, the
  booting one's too, so it can still fail a boot: inferred from the above,
  not run.
- `tart stop` sends SIGINT to `tart run`, waits up to `--timeout` (default 30 s)
  for the lock to clear, then SIGKILLs it; a stopped VM exits 2 (`stopRunning`,
  Commands/Stop.swift). Its return doesn't mean the VM is gone:
  `tart run` can still be exiting. Ours: stop is
  the guest's `shutdown -h now`, then `tart stop --timeout 0` after
  `shutdownWait`, and both wait until no process holds the VM's lock and its
  job doesn't run (`halted`, `forcedStopWait`), failing the step past it; a job
  read not running 39 ms after a `tart stop --timeout 0` began.
- `shutdown -h now` on a guest whose agent is still coming up waits for the
  agent, since the exec does. Ours: `shutdownWait`, a minute.
- Apple allows two running macOS VMs per Mac, system-wide. Tart catches
  `virtualMachineLimitExceeded` (Commands/Run.swift), prints
  "The number of VMs exceeds the system limit" (`VirtualMachineLimitExceeded`,
  VMStorageHelper.swift) and exits 1 (`Foundation.exit(1)` in Run.swift)
  within 0.3–0.6 s; under launchd the job just
  exits, its log ending "The number of VMs exceeds the system limit (other
  running VMs: …)" (`fputs("\(error)\n", stderr)` in Run.swift). Its hint lists
  the same home's VMs only. Ours: `vmLimit`; `admit` and `capacity` count the
  machines the host is booting or whose lock a process holds, and every other
  `tart run` process on the Mac, of any Tart home or user (`tartRuns`, over
  `ps -axo pid=,ucomm=,args=`), so the operator's own VMs count; a Linux VM a Tart runs counts too, which Apple
  doesn't, and a macOS VM another program runs doesn't, which the kernel then
  refuses; `limitRefusal` reads that refusal from the job's log as
  `Capacity`.

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
  without interruption, waits `suspendWait` for its job to exit and reads
  `saved` in the job's log, or runs `tart stop <vm>` to
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
  proxy in `executeThenClose`, ControlSocket.swift): measured on 2.41.1, a
  silent command, one with a child and a writing loop's orphaned shell all
  ran on 15 s after the client was killed by KILL, TERM or INT. Ours:
  `guest.ts` ends a cut command through a second `tart exec`, which root's
  `ps -axEww` serves, showing every user's environment and a newline as
  `\012`: measured, it ended a silent command, a writing loop, a child, a
  `setpgrp` child, a nested `sudo`'s children, an orphan and a TERM trap in
  about 0.5 s, and one ignoring TERM by KILL; a `tart exec` sent beside a
  running one saw its command in 20 of 20 tries. On a Tart upgrade, cut an
  exec of `sleep 300` by killing its client and check that the end leaves
  none of its processes. Bulk data goes
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
  state and `admin`'s sudoers entry; `tart get` while it runs, for `Disk`;
  and, stopped, a `tart set --disk-size` a GB above the capacity, read back
  with `tart get`.
- When `VMDirectory.swift`'s `state`, `layout` or `PIDLock` changed, re-time
  the reads above against a private home padded with stopped clones of the
  base, and check that `Home.look` and `running` still read what `tart list`
  does, a VM run by hand outside its job included.

## After

- Set `testedVersion` to the target once every claim holds at it, with its
  boundary versions in `tart.test.ts`'s `supported` cases and README's
  install table. Raise `minimumVersion` only when the code comes to depend on
  something the target added or fixed: add that reason under "Why the floor is" and in the
  commit message, and the boundary
  versions to `tart.test.ts`'s `supported` cases. Otherwise the floor stays,
  and only the tested release moves (README, the fake's version).
- Set the tested release in Notation above. Move every Tart permalink to the
  target's tag and the line its code now sits on, edit a claim only where the
  target changed it, and add claims the new release introduced.
- Set the new base in README (the reference, its macOS and
  Xcode, its disk's format and capacity and the `diskGib` floor they give) and
  "The base" above, and move the claims the VM check changed.
- Tell the operator how to move: first to the clankerbox release whose
  `testedVersion` is the target, which still starts under the old Tart, then
  install the new Tart in its own versioned path, change `tart.binary`, restart
  the host. Every `start` writes the VM's
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
