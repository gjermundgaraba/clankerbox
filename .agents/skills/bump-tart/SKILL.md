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
production hosts or the operator's Tart, or commit unless asked. A candidate
without the live run below is an **unqualified candidate**.

## Source and scope

- **Pinned in this repo:** `minimumVersion` in `packages/host/src/tart.ts` is a
  floor: `supported` accepts any `major.minor.patch` at or above it, and startup
  refuses the rest. Its comment lists why the floor is where it is. The tested
  release also appears in README (install table, the `tart.binary` example),
  `tests/live/README.md` and `tests/live/tart/driver.py`'s usage (its `--tart`,
  a release staged at `.work/inputs/tart-<version>/tart.app`),
  `scripts/WORK_RUNS.md` and the tests
  (`packages/host/tests/tart.test.ts`, whose fake `tart` answers as the tested
  release; `config.test.ts`): `git grep -n '2\.40'`.
- **Companions** pinned beside it, re-checked only when they change: Softnet
  0.24.0 (README, `tests/live/README.md`, the driver's SUID check),
  tart-guest-agent at least 0.15.0 (inside the image), and the Cirrus base the
  live seed holds, `latest`, its only tag, on 2026-10-04 (from the seed's
  `PROVENANCE`):

      ghcr.io/cirruslabs/macos-tahoe-base@sha256:87f3aa5ce21b5c876268f233bdfecf38b4c2a8116fe9bbb718e714cbae187377
- **Target:** the latest stable published `cirruslabs/tart` release (its release
  metadata, such as `gh release view --repo cirruslabs/tart`), unless the user
  names one. Not upstream main or Homebrew's version. Record old and new tags
  and commits.
- **Source:** a read-only cache at `~/.cache/checkouts/github.com/cirruslabs/tart`.
  Fetch missing tags (no `v` prefix, such as `2.40.1`); read with
  `git show <tag>:Sources/tart/<path>`. Never edit, reset or switch it. Run
  tests on a private install of the target, never by upgrading the operator's.
- **Notation:** `T@<tag>:path` is `Sources/tart/<path>` at that tag, and the
  identifier beside it (a type, function, case or message) finds the code:
  `git grep -n <identifier> <tag> -- Sources/tart/<path>`. `tart.ts`'s
  comments cite lines too (`T@<tag>:path:lines`); those move with each bump.
- Read the release notes and the full changed-file list, then each claim's file.

## Claims to re-check

Each: what Tart does, where, and what of ours depends on it.

**Why the floor is 2.40.1** (`minimumVersion`'s comment)

- Clone refuses an existing destination unless `--overwrite`
  (`rejectExistingDestination`, T@2.40.1:Commands/Clone.swift). Ours:
  native names carry the row's instance, so a clone never meets one, and
  `--overwrite` is never passed.
- Delete's exit codes: `VMDoesNotExist` and `VMNotRunning` exit 2, anything else
  1 (`RuntimeError`'s `exitCode`, T@2.40.1:VMStorageHelper.swift); a running
  VM exits 1 from 2.40.0.
  Ours: delete treats 2 as gone, and on 1 forces the VM off
  (`tart stop --timeout 0`) and deletes again.
- One control-socket accept error no longer disables `tart exec` until restart
  (`ControlSocketAcceptErrorHandler`, T@2.40.1:ControlSocket.swift), and
  `tart list` no longer fails on running VMs.

**Clone, names and sizes**

- Clone builds in a temp directory (`VMDirectory.temporary`) under a lock
  (`FileLock`), then moves it into place; interrupted clones are
  garbage-collected (`run` in T@2.40.1:Commands/Clone.swift;
  `runGarbageCollection` in Root.swift). It doesn't require a stopped source,
  only a stacked one must be stopped ("must be stopped before cloning"). Ours:
  no checks around clone; fork and capture of a running machine are refused by
  our own rule, after the claim, since a clone of a stopped disk is consistent
  and one of a running VM's disk is crash-consistent at best.
- Clone regenerates a colliding MAC, checking one Tart home only
  (`hasVMsWithMACAddress`, T@2.40.1:Commands/Clone.swift;
  `hasRunningMACCollision`, Commands/Run.swift). Ours: no `--random-mac`;
  `tart set --random-serial` once per clone.
- A local VM name only has to be free of `/` (`validate`,
  T@2.40.1:Commands/Clone.swift). Ours: `machineName` and `checkpointName`,
  `cbx-<host>-{m,c}-<name>-<inst>`.
- `tart set --disk-size` only grows a disk, in GB (10^9 bytes); a smaller size
  throws "new disk size … should be larger than the current disk size" for raw
  and ASIF disks (`resizeRawDisk`, `resizeASIFDisk`,
  T@2.40.1:VMDirectory.swift), and a stacked disk grows only its writable
  overlay (`growWritableOverlay`, DiskImageStack.swift). Ours: `diskGb` rounds
  `diskGib` up, `shrinkRefusal` matches that text and makes it `Precondition`.
  The pinned Cirrus base has a 50 GB raw disk.
- `tart get` opens local VMs only (`VMStorageLocal().open`,
  T@2.40.1:Commands/Get.swift), not an OCI reference, and `tart list` reports no
  OS (`VMInfo`, Commands/List.swift). Ours: no check of `diskGib` against the
  base before the claim; Tart's refusal at `tart set` is the check.

**State, stop and capacity**

- `tart list --format json` gives `Source`, `Name`, `Disk` (can be null),
  `Size`, `Accessed`, `Running` (deprecated, kept in JSON for compatibility,
  T@2.40.1:Formatter/Format.swift) and `State`: `running`, `suspended` or
  `stopped` (`VMDirectory.State`, VMDirectory.swift), from the VM's lock,
  which `tart run` holds. It sees one Tart home only. Ours: `VmState`,
  `decodeList`, `stateOf` (suspended reads stopped), the two-VM count, and
  `observe`'s `tart list`, bounded by the core's `stateReadWait` (8 s), past
  which every machine reads `unknown`; the two-VM count's `tart list` is
  bounded by the same, past which the boot fails, writing nothing.
- `tart stop` sends SIGINT to `tart run`, waits up to `--timeout` (default 30 s)
  for the lock to clear, then SIGKILLs it; a stopped VM exits 2 (`stopRunning`,
  T@2.40.1:Commands/Stop.swift). Its return doesn't mean the VM is gone: once
  `tart run` took about 32 s to exit after `tart stop` returned. Ours: stop is
  the guest's `shutdown -h now`, then `tart stop --timeout 0` after
  `shutdownWait`, and both wait for `tart list` to read it stopped
  (`forcedStopWait`).
- Stock Cirrus guests stopped 2.3–7.8 s after `shutdown -h now` on 2.40.1,
  and 25.6 s for one whose agent was still coming up, since the exec waits for
  the agent. Ours: `shutdownWait`, a minute.
- Apple allows two running macOS VMs per Mac, system-wide. Tart catches
  `virtualMachineLimitExceeded` (T@2.40.1:Commands/Run.swift), prints
  "The number of VMs exceeds the system limit" (`VirtualMachineLimitExceeded`,
  VMStorageHelper.swift) and exits 1 (`Foundation.exit(1)` in Run.swift)
  within 0.3–0.6 s; under launchd the job just
  exits. Its hint lists the same home's VMs only. Ours: `vmLimit`, the count in
  step 3, and `limitRefusal` read from the job's log as `Capacity`.

**Softnet and the network**

- `--net-softnet-block` implies `--net-softnet` (`netSoftnetBlock`,
  T@2.40.1:Commands/Run.swift). Tart finds `softnet` on `PATH`
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
  `controlSocketURL.relativePath`, T@2.40.1:ControlSocket.swift and
  Commands/Exec.swift), so a Tart home's path length doesn't matter.
  Ours: live runs put the home in their scratch (`scripts/WORK_RUNS.md`).
- `tart exec -i` reads stdin into an unbounded stream (`stdinStream`,
  T@2.40.1:Commands/Exec.swift): a raw 1 GiB upload peaked at 2+ GiB RSS in the
  host's `tart`. A killed `tart exec` leaves the guest's command (and over the
  forwarder its `nc` and `sshd-session`) until its session next writes (the
  proxy in `executeThenClose`, ControlSocket.swift). Ours: bulk data goes
  over ssh through the forwarder (`tart exec -i <vm> nc 127.0.0.1 22`), whose
  window keeps it at about 20 MiB; the forwarder ends a connection by closing
  the exec's stdin.
- An exec before the VM runs fails at once (exit 2); one sent while it boots
  blocks until the agent is up, or fails after about 30 s with
  `GRPCConnectionPoolError … is the Tart Guest Agent running?`. Alone a stock
  Cirrus guest answered 18.5–32.3 s after `tart run`, two booting together
  after about 61 and 93 s. Ours: `bootWait` (3 minutes) retrying every
  `probePause`.
- tart-guest-agent (0.15.0 on the base) runs as a root LaunchDaemon and as a
  per-user LaunchAgent for the auto-login user `admin`, which serves exec;
  `admin` has `NOPASSWD: ALL`. `tart exec -i <vm> sudo -n /bin/bash -c <script>`
  passes exit codes, keeps stdout and stderr apart, runs as uid 0 and sees
  end-of-input at once with stdin closed. Ours: `exec` adds `sudo -n`.
- Registry credentials are looked up only on an auth challenge, and a failed
  lookup only prints a warning (`auth(response:)`, `lookupCredentials`,
  T@2.40.1:OCI/Registry.swift). Ours: no `HOME=<root>` for tart; the job
  gets the user's `HOME`.
- Ours: every tart call and every VM job runs with one environment
  (`environment` in `tart.ts`, which README's Tart notes point to): a fixed
  `PATH` (`searchPath`, holding `/usr/local/bin` for Softnet and
  `/opt/homebrew/bin`), the user's `HOME`, and the host's `TART_HOME` if set,
  so a job's `tart run` finds the VM the host made, in the host's Tart home.

**The Cirrus base** (re-check when the base's digest changes)

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

- Unit: `vp test` in `packages/host` (`tart.test.ts`, `forwarder.test.ts`,
  `config.test.ts`), then `vp run --no-cache ready`. Change the fake's answers
  only to match Tart's real output at the target.
- Live: stage the target's release tarball, checksum verified, with its
  provenance, at `.work/inputs/tart-<version>/tart.app`, then run
  `pnpm live:tart --tart TART --seed SEED --address TAILNET_ADDRESS` with its
  `Contents/MacOS/tart` as `TART` (`tests/live/README.md` lists what it needs:
  the stock Cirrus seed, Softnet SUID root, no other macOS VM running). It
  covers create, stop, cold start, forks and `disk` checkpoints, the two-VM
  limit, Softnet's block of the host, a host restart and a crash, and
  placement over two hosts. It runs as a work run (`scripts/WORK_RUNS.md`);
  report what it leaves running and what it retains.

## After

- Raise `minimumVersion` only when the code comes to depend on something the
  target added or fixed: add that reason to its comment, and the boundary
  versions to `tart.test.ts`'s `supported` cases. Otherwise the floor stays,
  and only the tested release moves (README, `tests/live/README.md`, the
  fake's version).
- Move each `T@<old>` citation, in this skill and in `tart.ts`'s comments, to
  the new tag (`tart.ts`'s also to their current lines), check that each
  identifier still finds the code, and add claims the new release introduced.
- Tell the operator how to move: install the new release in its own versioned
  path, change `tart.binary`, restart the host. Every `start` writes the VM's
  job again, and a stopped job launchd still holds that names another `tart` is
  reloaded, so VMs move as they restart; keep the old install until no running
  VM's job names it.
- Report the tag transition, exact executable provenance, the claims that
  changed and their fixes, the checks actually run, optional opportunities, and
  remaining runtime resources and retained disk separately.
