# Q: can clankerbox ship upstream smolvm unmodified? (review item 9)

Date: 2026-10-01. This was a read-only investigation: no VMs were started and nothing was built.

Citation forms:

- `S@<tag>:path:line` is upstream smolvm (`~/ws/pers/not-mine/smolvm`).
- `C:path:line` is this repository.
- `K:` is Linux 6.12.95 from the retained release corresponding-source tarball.
- `KFW@<commit>:` is libkrunfw.
- `L@2210fda7:` is the libkrun submodule.

Tags: `v1.19.0` = `572bb694` (the patch base), `v1.22.0` = `f40f42c3`. `origin/main` is `97635ac8`. It has no commits after v1.22.0 that touch any of the four patched files.

## Verdicts

`runtime.patch` has 4 files and 7 `@@` hunks. The plan's "hunks 1–4" count **files**, not `@@` hunks. Note that main.rs's third `@@` is also test-only, so "hunk 2 is test-only" is not the only test-only change.

| Plan label | `@@` hunks (C:scripts/release/inputs/runtime.patch) | Change | Applies at v1.22.0 | Verdict |
|---|---|---|---|---|
| **1** overlay | main.rs `@@ -1108` (:5-14), `@@ -1318` (:18-38) | The persistent-root overlay mounts with `index=off,redirect_dir=off,metacopy=off`. Upstream mounts `lowerdir=/,upperdir=…,workdir=…` with no options (S@v1.22.0:crates/smolvm-agent/src/main.rs:1338-1341). | Yes, offset +8. The code is byte-identical at 1.19.0 and 1.22.0. | **keep, then upstream.** Clankerbox needs it: see the ESTALE section. Upstream's own comment says the intent is "without index/redirect_dir" (main.rs:1329). It rests on a false premise: the lower is described as "initramfs (ramfs) … no file-handle support" (:1335), but upstream's code elsewhere says the lower is virtiofs (:659, :1143). |
| 1 (test) | main.rs `@@ -7486` (:42-61) | A unit test that asserts the option string. | Yes, offset +70. | Goes with hunk 1. Upstream it together with hunk 1. |
| **2** test-only | manager.rs `@@ -3627` (:70-105) | A regression test. A live, unacknowledged process keeps its PID/config markers through `stop()`, and a dead one is cleaned. | Yes, offset +14. | **drop.** It only asserts upstream behaviour, which is unconditional since 1.19 (C:scripts/release/inputs/smolvm-1.19.0-qualification.md:40-45, S@v1.22.0:src/agent/manager.rs:2878-2886). If anyone keeps it: at 1.22 the error string still matches, but the test now waits `AGENT_STOP_TIMEOUT` because of 12fb8a59 (manager.rs:2876-2891). |
| **3** fork state | state_probe.rs `@@ -118` (:114-126) | `has_frozen_fork_state` uses `fork::restart_blocking_dependent_clones` instead of `db.dependent_clones`. | Yes, exact. | **keep, then upstream.** This is required while RAM fork stays (see below). It is a one-line change, and upstream has not fixed it on 1.22.0 or main. |
| **4** stop ack | vm_common.rs `@@ -2369` (:131-140), `@@ -2408` (:144-153), `@@ -2422` (:157-164) | With `SMOLVM_STOP_REQUIRE_ACK=1`, stop refuses the Unreachable-zombie kill and the orphaned-boot-process kill. In the not-running case it runs `AgentManager::stop()` instead. | Yes, offset +23. | **drop**, together with the env var (C:internal/host/runtime.go:474-487). This confirms the plan (C:docs/plans/typescript-rewrite.md:277, C:docs/plans/design-audit.md:126-135). The hunk does nothing without the env var. At 1.22 upstream still hard-kills on Unreachable (S@v1.22.0:src/cli/vm_common.rs:2398) and the orphan (:2448), as the plan says. |

"Applies" means `git apply --check` against `git archive` of each tag: clean at v1.19.0, offsets only at v1.22.0, no fuzz. **It was not compiled at 1.22.0.** I only checked that the symbols the patch uses still exist with compatible signatures: `restart_blocking_dependent_clones` (S@v1.22.0:src/agent/fork.rs:688), `AgentManager::new(rootfs, storage, overlay)` (manager.rs:862), `StorageDisk::open_or_create_at` (src/storage.rs:543) and `process::process_start_time`.

### Hunk 3 detail: why it matters for RAM fork

- **Start uses the narrow rule.** `prepare_for_launch` uses `restart_blocking_dependent_clones` (S@v1.22.0:src/agent/manager.rs:1828). That function ignores clones whose generation carries `source-continues-v1`, meaning live fork-and-continue generations that pivoted the source onto a new CoW top (S@v1.22.0:src/agent/fork.rs:658-690). So a source with retained live-fork descendants **may** cold-restart.
- **The state probe uses the broad rule.** `has_frozen_fork_state` returns early only when a retained snapshot still matches the *current* process (fork.rs:2755-2763 compares the PID and its start time). After a cold restart the PID has changed, so it falls through to `db.dependent_clones(name)`, which returns every clone (S@v1.22.0:src/agent/state_probe.rs:100-127).
- **What breaks:** the restarted source has a live PID and any descendant, even a stopped one, so `resolve_state` returns `Frozen` without probing (state_probe.rs:57-58).
  - `machine ls` and `status` report frozen (vm_common.rs:2940).
  - `machine stop` refuses with "fork base for N live clone(s)…" (vm_common.rs:2413-2422).
  - The host's wait for `Running` after start never succeeds.
- **The qualification test hits exactly this.** `tests/live_checkpoints.py` stops and restarts the Linux source while a child is retained, then continues (C:tests/live_checkpoints.py:174-180). The 1.19.0 qualification records why the hunk was retained (C:scripts/release/inputs/smolvm-1.19.0-qualification.md:49-51).
- The hunk makes the probe use the same lineage rule as start. Legacy frozen (non-continue) generations are still blocking, so the frozen guard stays strict where it is needed.

## ESTALE (hunk 1)

### Original scenario

The first Linux disposable machine was created 2026-09-06 (commit ab8d0eb, `docs/implementation-execution.md:88-95`, since removed). The record says: "Cold restart then exposed stale OverlayFS lower-file handles when the kernel enabled indexing by default. The guest agent now mounts the persistent root with `index=off,redirect_dir=off,metacopy=off`."

- The engine was smolvm v1.14.1 with the then product image: Ubuntu as `SMOLVM_AGENT_ROOTFS`, a bare VM, and the workload in the root overlay.
- The private evidence (`.work/linux-live.json`) no longer exists.
- The patch has been carried through 1.16.0 and 1.19.0 because "Upstream still mounts without them" (C:scripts/release/inputs/smolvm-1.19.0-qualification.md:47-48).
- No commit or document records which file failed. The mechanism below comes from the source code, not from retained logs.

### Mechanism

1. **The lower is virtiofs, not initramfs.** The host adds the rootfs directory as virtiofs tag `/dev/root` (S@v1.22.0:src/agent/launcher.rs:1038-1081). The agent overlays `lowerdir=/` (that virtiofs) with an upper on `/dev/vdb`, then pivots (S@v1.22.0:crates/smolvm-agent/src/main.rs:1133-1467). Clankerbox's image is that rootfs: `usr/sbin/init` is a symlink to `../local/bin/smolvm-agent` (C:images/stage-linux.py:107-112).
2. **The guest kernel defaults to index on.** The kernel config has `CONFIG_OVERLAY_FS_INDEX=y` and `CONFIG_OVERLAY_FS_REDIRECT_DIR=y`, and metacopy off. This is in KFW@6ec329e1 (1.19) and KFW@b8c9994d (1.22), at config-libkrunfw_x86_64:1642-1646 and config-libkrunfw_aarch64:2428-2433. A mount without options therefore gets `index=on,redirect_dir=on`.
3. **The kernel does not turn index off for virtiofs.** FUSE exports `fh_to_dentry`, so `ovl_can_decode_fh` is non-zero (K:fs/overlayfs/util.c:79-91), and index stays on (K:fs/overlayfs/super.c:395-402). Virtiofs has a null uuid. With index or redirect on, `ovl_allow_offline_changes()` is false, so the null-uuid lower is accepted for handle decoding (K:fs/overlayfs/super.c:884-917, overlayfs.h:646-650).
4. **Every copy-up stores the lower file handle** in `trusted.overlay.origin` (K:fs/overlayfs/copy_up.c:959-966). A copy-up is any in-place change to a lower file: chmod, chown, append, editing a file in place. A FUSE handle is `(nodeid, generation)` (K:fs/fuse/inode.c:1056-1073).
5. **libkrun's handles are only valid for one boot.** Nodeids are handed out sequentially per virtiofs session, in lookup order (L@2210fda7:src/devices/src/virtio/fs/inode_alloc.rs:13-28), and generation is always 0 (L@2210fda7:src/devices/src/virtio/fs/linux/passthrough.rs:1463). Only the root's nodeid (1) is stable, which is why the mount itself still passes "verify upper root origin" (K:fs/overlayfs/super.c:829).
6. **Failure:** with `index=on`, looking up a copied-up non-directory checks the stored origin against the lower file found by path (K:fs/overlayfs/namei.c:1153-1166). After a cold boot the nodeid differs, the check returns `-ESTALE`, and stat/open of that file fails with "Stale file handle". The kernel logs `failed to verify origin (…, err=-116)` (namei.c:562).
7. **Why all three options.** With `index=off` alone, `redirect_dir` still defaults on, so offline changes stay disallowed. Stale handles are then still *decoded*. Generation is 0 and nodeids are reused across boots, so a stale handle can silently resolve to a **different** lower inode of the same type (namei.c:420-462, fuse/inode.c:1009-1044). That gives wrong origin and inode information instead of an error. Only with index, redirect_dir and metacopy all off (and xino not forced) is the null-uuid lower marked `bad_uuid` (super.c:899, 933-944). Origin handles are then never decoded (namei.c:431-433).
   - Hardlinked lower files (nlink>1) are also indexed under `index=on`, with entries keyed by the same unstable handles (copy_up.c:950-957).

### Is it specific to clankerbox's Ubuntu lower?

The **mechanism is upstream's** and does not depend on Ubuntu. Any copy-up in the persistent root overlay over the stock Alpine agent rootfs stores a nodeid-based origin and should hit ESTALE on a later cold boot. Upstream bare-VM `machine exec` runs directly in that root (S@v1.22.0:crates/smolvm-agent/src/main.rs:7023-7035), so stock bare-VM users are exposed too. That is a prediction, not observed.

The **exposure is clankerbox's design**: clankerbox keeps the whole mutable OS and workspace in the root overlay, so ordinary package and file activity copies up lower files constantly.

Stock **OCI-image mode** avoids the problem for workload files. The container overlay explicitly sets `index=off` (S@v1.22.0:crates/smolvm-agent/src/storage.rs:4545, 4821, 4899), so a stale origin is ignored on lookup (K:fs/overlayfs/namei.c:472-489). It still keeps redirect_dir on, so the silent mis-decode in point 7 is possible there. Copy-ups by the agent itself into the root overlay remain exposed. Upstream has met virtiofs-lower ESTALE before: restored fork clones recycle the container when "its virtiofs lowerdirs are stale" (S@v1.22.0:crates/smolvm-agent/src/main.rs:4729-4738).

Between v1.19.0 and v1.22.0, `setup_persistent_rootfs` is unchanged (verified with diff). No commit mentions ESTALE, overlay or stale handles (`git log v1.19.0..v1.22.0 -i --grep`), and libkrunfw b8c9994d only adds live-resize options. **Nothing relevant was fixed upstream.**

### Minimal reproduction on the Linux test host (not run)

Run it as an owned work run with a teardown callback that stops and deletes `estale-*` VMs (AGENTS.md, `scripts/work_runs.py`). Isolate `HOME`/`XDG_*` under the run's scratch directory.

```sh
S=$WORK_RUN_SCRATCH/smolvm-1.22.0-linux-x86_64/smolvm   # upstream tarball, sha256 00d2f057…
export HOME=$WORK_RUN_SCRATCH/home XDG_DATA_HOME=$HOME/.local/share XDG_CACHE_HOME=$HOME/.cache XDG_CONFIG_HOME=$HOME/.config
# Disks >= the template sizes (20/10 GiB, sparse); smaller ones need host resize2fs at 1.22.
$S machine create --name estale-a --cpus 1 --mem 512 --storage 20 --overlay 10
$S machine start --name estale-a
# Boot 1: push nodeids high first, then copy up three lower files in place.
$S machine exec --name estale-a -- sh -c '
  cat /sys/module/overlay/parameters/index; grep " / " /proc/mounts
  ls -R /usr /lib >/dev/null 2>&1
  chmod 0600 /etc/motd; echo "# estale" >> /etc/profile; touch /etc/os-release; sync'
$S machine stop --name estale-a          # must report an acknowledged stop
$S machine start --name estale-a
# Boot 2: touch the targets first (low nodeids), then read the kernel log.
$S machine exec --name estale-a -- sh -c '
  stat /etc/motd; cat /etc/profile >/dev/null; stat /etc/os-release
  dmesg | grep -i overlayfs'
$S machine stop --name estale-a && $S machine delete --name estale-a --force
```

- **Expected without the patch:** at least one `stat`/`cat` fails with `Stale file handle`, and dmesg shows `overlayfs: failed to verify origin (etc/…, err=-116)`.
- **Control:** repeat with `SMOLVM_AGENT_ROOTFS` set to a private copy of `agent-rootfs` whose `usr/local/bin/smolvm-agent` is the patched agent. Expect no errors and no dmesg lines.
- **Clankerbox case:** repeat both with a private copy of the clankerbox Ubuntu image as `SMOLVM_AGENT_ROOTFS`, using the upstream 1.22 agent and then the patched agent.
- **Nodeids:** they depend on lookup order, so a single file can collide by chance. Using three targets and the `ls -R` priming makes a false negative unlikely, but a negative result should be run twice.

## Release-pipeline delta vs. the upstream tarballs

Upstream v1.22.0 assets: darwin-arm64 `8e6f9d7a…`, linux-x86_64 `00d2f057…`, linux-arm64 and windows. Each matches `checksums.sha256` and the GitHub asset digest. There are no detached signatures.

I downloaded and listed the darwin tarball:

- `smolvm` (a bash wrapper that sets `DYLD/LD_LIBRARY_PATH` and `SMOLVM_AGENT_ROOTFS=./agent-rootfs`).
- `smolvm-bin`, ad-hoc signed with entitlements `hypervisor`, `cs.disable-library-validation` and `cs.allow-jit`. These are identical to S@v1.22.0:smolvm.entitlements, and it passes `codesign --verify --strict`.
- `lib/`: `libkrun.dylib`, `libkrunfw.5.dylib` plus a symlink, `libMoltenVK`, `libepoxy.0`, `libvirglrenderer.1`, all ad-hoc signed. MoltenVK, epoxy and virgl are byte-identical to clankerbox's 1.19 inventory. libkrun and libkrunfw are new: libkrun is 3285db74 and libkrunfw is b8c9994d.
- `agent-rootfs/` (Alpine 3.19, 48 MB, `sbin/init` symlinked to `/usr/local/bin/smolvm-agent`; the aarch64 agent is `d70d82e9…`).
- 20 GiB / 10 GiB padded templates (`.ext4.zst`), `checksums.txt` and `README.txt`.
- **No LICENSE or notice files.**

The linux-x86_64 tarball has the same layout, plus a containerd shim and k8s files. It also has no LICENSE and no `libkrun.provenance`. Its `smolvm-bin` and `libkrun.so` need GLIBC_2.34 at most, the same floor as clankerbox's build. Its x86_64 agent is `f140596c…`.

| What clankerbox does today | Where | Needed with unmodified upstream tarballs? |
|---|---|---|
| Builds the engine and the static musl agent from pinned source plus `runtime.patch` (Rust 1.98, Zig 0.16, `--locked`), and pins their hashes | C:scripts/release/inputs/pins.json, C:scripts/release/bundle.py:63-75 | **No build.** Pin the tarball sha256 and the extracted `smolvm-bin`/agent hashes instead. `bundle.py` must check those, not `runtime_patch_sha256`, and stop copying `runtime.patch` into the bundle (bundle.py:256). |
| Takes the agent from the build and copies it into the Ubuntu image as `usr/local/bin/smolvm-agent` with an `init` symlink | C:images/stage-linux.py:80-112, C:scripts/release/inputs/linux-amd64-image-sources.json | **Still needed**, but the source becomes the tarball's `agent-rootfs/usr/local/bin/smolvm-agent`. The agent must match the host (1.19+ refuses to stop without quiesced-shutdown). The image digest changes with it. |
| libkrun / libkrunfw: unmodified release bytes, linked against a private copy because smolvm's build.rs re-signs `libkrun.dylib` | C:scripts/release/README.md:23-27, C:scripts/release/inputs/smolvm-1.19.0-qualification.md:25-34 | **No.** With no build there is nothing to re-sign. Re-pin `runtime-artifacts.json` to the 1.22 bytes. `lib/libkrun.provenance` (Linux) is not in the tarball; it was provenance only. Drop it or fetch it from the tagged tree. |
| macOS signing: engine ad-hoc signed with upstream entitlements, verified; Go binaries ad-hoc signed | C:scripts/release/bundle.py:257-261 | **Not needed for the engine.** Upstream's signature and entitlements are the same, and the verify step keeps working. Ship `smolvm-bin` under clankerbox's engine name and set lib paths and `SMOLVM_AGENT_ROOTFS` directly, as today; a signature is not tied to the filename. Signing the Go binaries and the host (`build-mac-host.py`) is unchanged. |
| Compact 512 MiB templates (zero padding removed, `prepare-templates.py`) in the runtime inventory | C:scripts/release/inputs/README.md:27-33, C:scripts/release/prepare-templates.py | **Still needed unless profiles move to ≥20/10 GiB.** At 1.22, a request smaller than the template runs host `resize2fs` and *fails* if it is missing (S@v1.22.0:src/disk_utils.rs:110-119, 134-150). In 1.16 it only warned. Clankerbox's 1 GiB / 8 GiB profile is below 20/10 GiB. This is data, not a binary change: smolvm looks for templates in `~/.smolvm/` before the executable's directory (S@v1.22.0:crates/smolvm-pack/src/assets.rs:373-403), so clankerbox can keep placing its templates in each engine HOME. |
| Notices: smolvm LICENSE plus `source.json` (LICENSE/Cargo.lock digests), Rust/Go dependency notices (`notices.py` over `cargo metadata`), native notices for libkrun, libkrunfw (GPL-2.0/LGPL-2.1), MoltenVK, epoxy, virgl; `engine-pins.json` | C:scripts/release/notices.py, C:scripts/release/inputs/source.json, C:scripts/release/licenses/, C:scripts/release/README.md:178-205 | **Still needed, and more so:** the tarball ships no notices, so all redistribution duties stay with clankerbox. `notices.py` still needs the tagged source and `cargo metadata` (no compile). Corresponding source must now cover libkrunfw **b8c9994d** plus Linux 6.12.95 and libkrun 3285db74. Drop the "identify the local patch" duty. |
| Pins and qualification records; candidate identities | C:scripts/release/inputs/*.md | Still needed. The runtime digest and checkpoint identity change on any runtime change, as today. |
| Env `SMOLVM_STOP_REQUIRE_ACK=1` (hunk 4), `SMOLVM_DISABLE_READONLY_RESTORE=1` | C:internal/host/runtime.go:483 | The plan already drops both. Neither is a binary change. |

## Answer

**No, not today.** Hunks 2 and 4 can go now, but hunks 1 and 3 are load-bearing, and upstream 1.22.0 and main have neither.

- **Hunk 1** prevents the ESTALE failure that clankerbox's layout (the whole mutable OS in the virtiofs-lowered root overlay) triggers on cold restarts under the kernel's default `index=on`.
- **Hunk 3** keeps a cold-restarted fork source with retained descendants from being reported `Frozen` and refusing to stop. RAM fork depends on that.

Both are a few lines and fit upstream's stated intent, so the realistic path is to send both upstream and switch to unmodified binaries when a tagged release contains them. Apart from the patch, nothing else in the pipeline requires a rebuild. We would keep the compact templates in the engine HOME (or have e2fsprogs or ≥20/10 GiB disks), source the agent from the tarball, re-pin hashes, and carry all notices and corresponding source ourselves.

To know for sure, test on the Linux KVM host and on macOS:

1. Run the ESTALE reproduction above, first with the stock Alpine rootfs and then with the clankerbox Ubuntu rootfs, each with the unpatched and patched 1.22 agent.
2. Check hunk 3 on unpatched 1.22: live-fork a source, stop the child, cold-restart the source, and expect `Frozen` status and a refused stop. Then run the full `tests/live_checkpoints.py`.
3. Create a 1 GiB / 8 GiB machine with upstream templates on a host without e2fsprogs (expect failure), then with the compact templates in `~/.smolvm`.
4. After that, run the normal release qualification with the upstream tarball bytes.

Retained artifacts: none. The temporary download and patch-check directories under `.work/` were deleted.
