# Q: ESTALE and fork state on unmodified upstream smolvm 1.22.0 (Linux/KVM)

Date: 2026-10-01. Host: the production Linux KVM host (`clanker@37.27.63.112`, Linux 7.0.0-34, amd64), used while its controller was down. Engine: upstream `smolvm-1.22.0-linux-x86_64.tar.gz`, used unmodified.

- The tarball's sha256 is `00d2f057c963ff950846d4059af87bdddb7edf707750cdab863cb0879d6b339e`, which matches the release's `checksums.sha256`.
- `smolvm-bin` is `05c89926…` and the bundled x86_64 agent is `f140596c…`.
- Guest kernel: libkrunfw 6.12.95. Agent rootfs: Alpine 3.19.0.

There were two work runs, each with one remote run directory:

- `estale-linux-e71a07f9c103` (remote `estale-e71a`): A and B with the procedure as written, then C.
- `estale-linux-prime2-a6d38ce3f1a8` (remote `estale-a6d3`): A and B with a corrected boot-2 procedure.

Upstream smolvm is cited as `S@v1.22.0:`. `K:` is Linux v6.12.95 `fs/overlayfs/`. Every VM had 1 vCPU and 512–1024 MiB, with at most 2 running at once.

## Verdicts

| Question | Verdict | Key evidence |
|---|---|---|
| **A**: does a bare VM on the stock Alpine agent rootfs hit ESTALE after a cold restart? | **YES, reproduced** (run 2, `a3`). Runs `a1`/`a2`, which followed the documented procedure, were negative because that procedure is inverted (see below). | Boot 2: `ls: /etc/nsswitch.conf: Stale file handle` and `ls: /etc/e2scrub.conf: Stale file handle`. dmesg shows `overlayfs: failed to get inode (-116)` 4×, and `overlayfs: invalid origin (etc/motd, ftype=8000, origin ftype=a000)` for 10 more targets. |
| **B**: does a stock `ubuntu:24.04` image machine hit it? | **NO.** 0 hits in 4 cold restarts (`b1`–`b4`): 6 copied-up files in run 1 and 28 in run 2, including the corrected procedure. | The container root overlay's lower is the image layers on ext4 (`/dev/vda`), not virtiofs. Stored origins are ext4 handles carrying the fs uuid. apt writes land only in the container upper. The agent root's upper (`/dev/vdb`) gets no copied-up lower files. |
| **C**: does unpatched 1.22 still need hunk 3? | **YES, confirmed.** | After a cold restart of a live-forked source with a retained stopped child, `status` returns `frozen`. `machine stop` is refused with "fork base for 1 live clone(s)", and `delete` is refused too. Stop works only after the child is **deleted**. |

What this means for unmodified upstream smolvm with stock OCI images:

- **Hunk 1 (overlay options) is not needed for workload files** in stock-image mode. It is still needed for anything that runs or writes in the bare-VM root, which is clankerbox's current layout.
- **Hunk 3 remains a blocker** unless clankerbox never cold-restarts a fork source while a child is retained (or deletes children first).

Details are at the end.

## The documented reproduction was inverted

`spikes/q-runtime-patch/RESULTS.md` ("Minimal reproduction") says boot 1 should prime nodeids with `ls -R` and then modify the targets, and boot 2 should "touch the targets first (low nodeids)". On 6.12.95 that produces a **false negative**, as `a1` and `a2` showed. Reading the kernel source explains why:

1. **A nodeid that is not live is silently ignored.**
   - The FUSE handle stored in `trusted.overlay.origin` is `(nodeid, generation=0)`, as point 4 below shows.
   - In boot 2, if that nodeid is not yet allocated, decoding returns `-ESTALE`.
   - Overlayfs treats that as "origin unknown" (K:namei.c:186-191), and `ovl_check_origin` turns the `-ESTALE` into success (K:namei.c:485). There is no error and no log line.
   - The only visible effect is that `st_ino` changes. In `a1`, `/etc/motd` was ino `46753601` (the lower's) in boot 1 and `393221` (the upper ext4's) in boot 2, and every target flipped the same way.
2. **The error needs a collision.**
   - In boot 2 the stored nodeid has to name a *different live* lower inode, which happens when that nodeid has been reused for another file in the new session.
   - If the colliding inode is a dir or symlink, the result is `invalid origin (…, ftype=8000, origin ftype=a000)` (K:namei.c:465). The origin is again ignored and the lookup succeeds.
   - If it is a regular file that the overlay already has in its inode cache, the lookup fails with `ESTALE`.
3. **The failure path is the inode hash, not origin verification.**
   - For a regular upper file there is no path-based lower lookup (`d->stop`, K:namei.c:280). So `ovl_verify_origin` at K:namei.c:1161 is never reached for it, and the kernel source itself says "There is no verification" (K:namei.c:1255-1260).
   - The decoded origin is installed as the lower (K:namei.c:1241), and the overlay inode is hashed by that lower inode (K:inode.c:1171-1199, "Otherwise, hash by lower inode for fsnotify").
   - If the boot-2 priming already instantiated that lower file as a pure-lower overlay inode, `ovl_verify_inode` fails, the lookup returns `-ESTALE` (K:inode.c:1251-1254), and the kernel logs **`failed to get inode (-116)`** (K:inode.c:1311).
   - The earlier spike predicted `failed to verify origin (…, err=-116)`. That message did not appear.
4. **The corrected procedure (`--prime2`).**
   - In boot 1, the targets' nodeids are assigned early, by the `/etc/*` scan. Then the targets are modified.
   - Boot 2 first runs `ls -laR /usr /lib /bin /sbin /var /opt /root /home /srv /mnt /media` (not `/etc`), which allocates nodeids in a different order and instantiates those inodes. Only then are the targets touched.
   - Also use many targets: every collision is a separate chance.

**Consequences for the patch analysis** (source reading only; the patched agent was not run here):

- The hash-by-lower path does not depend on `index`. So `index=off` alone would not prevent this failure:
  - with `redirect_dir` still on, offline changes are disallowed;
  - the null-uuid virtiofs lower is therefore still accepted for decoding (K:super.c:899);
  - stale handles are still decoded.
- What hunk 1 relies on is `index=off,redirect_dir=off,metacopy=off` *together*. Then the null-uuid lower is marked `bad_uuid` (K:super.c:899, 946) and origins are never decoded (K:namei.c:432-434).
- In the same way, the container overlay is safe because its lower is ext4, not because it sets `index=off`.

## A: bare VM, stock Alpine agent rootfs

These are the commands. The exact scripts are in `estale_remote.py` (`exp_a`, `pick_targets`, `modify_script`, `boot2_script`). The environment was `HOME=SMOLVM_DATA_DIR=<run>/scratch` (also `XDG_*`, `XDG_RUNTIME_DIR` and `TMPDIR` under scratch).

```sh
smolvm machine create --name clankerbox-rewrite-estale-a3 --cpus 1 --mem 1024 --storage 20 --overlay 10
smolvm machine start  --name clankerbox-rewrite-estale-a3                    # 23.6 s (first boot)
smolvm machine exec   --name … -- sh -c '<overlay params; /proc/mounts; dmesg>'
smolvm machine exec   --name … -- sh -c '<stat every /etc/* : picks targets>'
smolvm machine exec   --name … -- sh -c 'ls -R /usr /lib >/dev/null 2>&1; chmod 0600 /etc/motd;
    echo "# estale" >> /etc/profile; touch /etc/os-release; touch <15 more /etc files>; sync; …'
smolvm machine stop   --name …     # "Stopped machine: …" rc=0, then status --json state "stopped"
smolvm machine start  --name …     # 0.25 s, cold boot
smolvm machine exec   --name … -- sh -c '[a3 only: ls -laR /usr /lib /bin /sbin … >/dev/null;]
    for f in <targets> /etc/resolv.conf /etc/hostname /etc/hosts; do ls -lin "$f"; done; cat <3 primaries>; dmesg | grep …'
smolvm machine stop / delete --force
```

Targets:

- **Primary:** `/etc/motd` (chmod), `/etc/profile` (append) and `/etc/os-release` (touch). The last is a regular file in Alpine.
- **`a3` extras:** `shells inittab fstab issue alpine-release sysctl.conf securetty nsswitch.conf protocols services environment modules mke2fs.conf e2scrub.conf udhcpd.conf`.

Mounts and parameters were identical in every A boot:

```
overlay.index=Y  overlay.redirect_dir=Y  overlay.metacopy=N  overlay.xino_auto=N  overlay.redirect_always_follow=Y
/dev/root /oldroot virtiofs rw,relatime 0 0
/dev/vdb /oldroot/mnt/overlay ext4 rw,noatime 0 0
overlay / overlay rw,relatime,lowerdir=/,upperdir=/mnt/overlay/upper,workdir=/mnt/overlay/work,uuid=on 0 0   # boot 1
overlay / overlay rw,relatime,lowerdir=/,upperdir=/mnt/overlay/upper,workdir=/mnt/overlay/work 0 0           # boot 2+
```

- **`index=` is absent from `/proc/mounts`** because it equals the module default. The `index` parameter is Y.
- **Index is in effect:** `/oldroot/mnt/overlay/work/index` exists (`d---------`).
- **`uuid=on` disappears after boot 1** because of `uuid=auto`. The first mount of a fresh upper upgrades to `on` and stores `trusted.overlay.uuid`. Later mounts find the xattr and keep showing the default.
- After boot 1 the upper (`find /oldroot/mnt/overlay/upper`) holds `etc/<all 18 targets>`, `workspace` and `oldroot`.

Results:

| Run | Procedure | Boot-2 result | dmesg (overlay) |
|---|---|---|---|
| a1, a2 | as documented (targets first) | all `OK`, but `st_ino` flipped from lower to upper inode numbers | none |
| **a3** | `--prime2` | `FAIL /etc/nsswitch.conf: ls: /etc/nsswitch.conf: Stale file handle`, `FAIL /etc/e2scrub.conf: ls: /etc/e2scrub.conf: Stale file handle`; the other 16 `OK` (upper inode numbers) | see below |

dmesg after `a3`'s cold boot (`evidence/remote/evidence/dmesg-a3-boot2.txt`):

```
[    0.276015] overlayfs: invalid origin (etc/motd, ftype=8000, origin ftype=a000).
[    0.278610] overlayfs: invalid origin (etc/profile, ftype=8000, origin ftype=a000).
[    0.280998] overlayfs: invalid origin (etc/os-release, ftype=8000, origin ftype=a000).
… (same for shells, inittab, fstab, issue, alpine-release, sysctl.conf, securetty)
[    0.300378] overlayfs: failed to get inode (-116)
[    0.300444] overlayfs: failed to get inode (-116)
[    0.314767] overlayfs: failed to get inode (-116)
[    0.314823] overlayfs: failed to get inode (-116)
```

That is 2 of 18 targets failing hard, 10 decoded to a symlink (ignored), and 6 with no live nodeid (ignored). Each target was looked up once. From the source, the failure should persist for as long as the colliding inode stays cached, but that was not observed. The host-side console log (`console-a3-boot2.log`) does not contain kernel warnings (`quiet`), so in-guest `dmesg` was the source. Busybox has no `getfattr`, so A's origin xattrs were not dumped (see B for the format).

## B: stock `ubuntu:24.04` image machine

```sh
smolvm machine create --name clankerbox-rewrite-estale-b3 --image ubuntu:24.04 --cpus 1 --mem 1024 --storage 20 --overlay 10 --net
smolvm machine start  --name …     # 8.0 s including "Pulling image ubuntu:24.04... done."
# every exec below runs inside the image container (pid1 = /run/smolvm/init container-init, CapEff=000001ffffffffff)
smolvm machine exec --name … -- sh -c '<params; /proc/mounts; mount /dev/vda,/dev/vdb (mknod in /dev) under /run; list uppers>'
smolvm machine exec --name … -- sh -c 'date +%s >/run/estale-t0; ls -R /usr /lib …; chmod 0600 /etc/legal;
    echo "# estale" >> /etc/profile; touch /etc/os-release; touch <25 more /etc files>; sync'
smolvm machine exec --name … -- sh -c 'apt-get update -qq; apt-get install -y -qq --no-install-recommends attr'   # b1, b3
smolvm machine exec --name … -- sh -c '<find both uppers -newermt @t0; getfattr -m ^trusted.overlay>'
smolvm machine stop; smolvm machine start   # cold
smolvm machine exec --name … -- sh -c '[--prime2: ls -laR …;] ls -lin <targets>; cat …; dmesg | grep …'
```

Targets:

- `/etc/motd` does not exist in the image. The chmod target was `/etc/legal`.
- `/etc/os-release` is a symlink to `../usr/lib/os-release`. The touch copied up `usr/lib/os-release`, and both paths were checked.
- `b3`/`b4` checked 29 paths: 3 primaries, `/usr/lib/os-release` and 25 more regular single-link `/etc` files. That is 28 copied-up files, because the `/etc/os-release` symlink itself is not copied up. Run 1 checked 7 paths, which is 6 copied-up files.
- `dmesg` works inside the privileged container.

**Mount lines** (container `/proc/mounts`, boot 1):

```
none / overlay rw,relatime,lowerdir+=/storage/layers/edd1ed89…,upperdir=/storage/overlays/persistent-clankerbox-rewrite-estale-b1/upper,workdir=/storage/overlays/persistent-clankerbox-rewrite-estale-b1/work,index=off,uuid=on 0 0
overlay /run/smolvm/init overlay ro,relatime,lowerdir=/,upperdir=/mnt/overlay/upper,workdir=/mnt/overlay/work,uuid=on 0 0
/dev/vda /storage/overlays/persistent-…/merged/workspace ext4 rw,noatime 0 0
```

- The container root is overlay #1. Its lower and upper are both on `/dev/vda` (`storage.raw`, ext4), and it is mounted with `index=off` explicitly.
- The agent's persistent root is visible only through the `/run/smolvm/init` bind. It is upstream's no-option mount: `lowerdir=/` (virtiofs) and upper on `/dev/vdb`, so it has default `index=on,redirect_dir=on`. Mounting `/dev/vdb` showed `work/index/` with `trusted.overlay.upper` set, which confirms index is in effect.

**Where writes land** (`b3`, after the edits and `apt-get install attr`):

- **Container upper** (`vda: overlays/persistent-<name>/upper`): 61 entries are newer than t0. They include `etc/<all targets>`, `usr/lib/os-release`, `usr/bin`, `usr/share/doc/attr` and `etc/resolv.conf`/`hosts` (written by the agent).
- **Agent root upper** (`vdb: upper/`): only the upper root, an opaque `oldroot/` and a `workspace` symlink, all from boot. **No copied-up lower files** were present after the package install or after the restart. Only `work/` and `work/work` were re-created at mount.
- **Stored handles show the difference:**
  - Container upper, ext4 handle: `etc/legal: trusted.overlay.origin=0x00fb1d0001a8a56d047a444821aae41aec5450f3b7520010001258f816`. That is len 0x1d, type 0x01 (ino32+gen), and the ext4 fs uuid `a8a56d04…`. The fid starts `52001000`; read little-endian, that is ino 1048658, exactly the inode `ls -lin` printed for `/etc/legal`.
  - Agent root upper, FUSE handle: `upper: trusted.overlay.origin=0x00fb2100810000000000000000000000000000000000000000010000000000000000`. That is len 0x21, type 0x81, a **null uuid** (16 zero bytes), and fid `00000000 01000000 00000000`, meaning nodeid 1 with generation 0. This is the per-session handle format that breaks in A. Nodeid 1 (the root) is the only stable one.

| Run | Copied-up files | Package probe | Boot-2 procedure | Result |
|---|---|---|---|---|
| b1 | 6 | yes | documented | all OK, no overlay dmesg |
| b2 | 6 | no | documented | all OK |
| b3 | 28 | yes | `--prime2` (6315 entries) | all OK, inode numbers unchanged across boots |
| b4 | 28 | no | `--prime2` | all OK |

In runs `b1` and `b2` the disk inspection failed, because `mknod` in `/run` (nodev) gave `Can't lookup blockdev`. Run 2 put the nodes in `/dev`.

## C: hunk 3 on unpatched 1.22.0 (bare VM, run 1)

```
$ smolvm machine create --name clankerbox-rewrite-estale-c-src --cpus 1 --mem 512 --storage 20 --overlay 10
$ smolvm machine start --name clankerbox-rewrite-estale-c-src --branchable
Machine 'clankerbox-rewrite-estale-c-src' running (PID: 34743)
$ smolvm machine branch --from clankerbox-rewrite-estale-c-src --name clankerbox-rewrite-estale-c-child
Branched 'clankerbox-rewrite-estale-c-src' -> 'clankerbox-rewrite-estale-c-child'. Source continues running.
  status: src running (pid 34743), child running (parent_machine = c-src)
$ smolvm machine stop --name clankerbox-rewrite-estale-c-child        # rc 0, kept
  status: src running, child stopped
$ smolvm machine stop --name clankerbox-rewrite-estale-c-src          # rc 0 — before the restart stop works
$ smolvm machine start --name clankerbox-rewrite-estale-c-src         # rc 0, PID 34826
$ smolvm machine status --name clankerbox-rewrite-estale-c-src
Machine 'clankerbox-rewrite-estale-c-src': frozen
$ smolvm machine ls
clankerbox-rewrite-estale-c-child stopped  1  512 MiB  0  0  20 GiB  10 GiB  clankerbox-rewrite-estale-c-src
clankerbox-rewrite-estale-c-src   frozen   1  512 MiB  0  0  20 GiB  10 GiB  -
$ smolvm machine stop --name clankerbox-rewrite-estale-c-src          # rc 1
Error: agent operation failed: stop: machine 'clankerbox-rewrite-estale-c-src' is the fork base for 1 live clone(s) (clankerbox-rewrite-estale-c-child); stop or delete the clones first
$ smolvm machine delete --name clankerbox-rewrite-estale-c-src --force  # rc 1
Error: agent operation failed: delete: machine 'clankerbox-rewrite-estale-c-src' is the fork base for 1 clone(s) (clankerbox-rewrite-estale-c-child); delete the clones first or use --cascade to remove them too
$ smolvm machine delete --name clankerbox-rewrite-estale-c-child --force   # rc 0
  status: src running (no longer frozen)
$ smolvm machine stop --name clankerbox-rewrite-estale-c-src          # rc 0
$ smolvm machine delete --name clankerbox-rewrite-estale-c-src --force  # rc 0
```

- **Result:** this is exactly the predicted hunk-3 failure. `status --json` gives `"state": "frozen"` with a live pid.
- **The refusal text is misleading:** it says "stop **or** delete the clones first", but the clone was already stopped. Only deleting it clears the state, because `db.dependent_clones` counts stopped clones (S@v1.22.0:src/agent/state_probe.rs:118-123).
- **Delete order matters:** the source cannot be deleted (even with `--force`) while a child exists; `--cascade` would remove the child. Child first, then source, works.
- **Side notes:**
  - `status --json` reports `"branchable": false` after `start --branchable`, as on macOS.
  - Every `delete` logs `WARN unable to lock UID registry; retaining assignment`. This is benign: the registry sits under the private data dir, and the uid drop is inactive when not root.

## What this means for shipping unmodified upstream smolvm

1. **Stock OCI images: hunk 1 is not needed for workload state.**
   - The container root overlay lowers are image layers on the machine's own ext4 disk, whose handles are stable across boots.
   - Package installs and edits land in the container upper on `/dev/vda`. 28 copied-up files survived cold restarts with a primed lookup order.
   - The virtiofs-backed, index-on agent root overlay received no copy-ups from workload activity.
2. **The residual exposure is the agent root.** Anything that copies up a lower file there is exposed on the next cold boot: the agent itself, a future agent change, or a privileged container that mounts `/dev/root` or `/dev/vdb` (`q-smolvm-stock` showed the container can mount the virtiofs root).
   - Today the upper holds only directories and a symlink, so the risk is latent.
   - Clankerbox should keep users out of the bare-VM root: no `exec` outside the image, and no bare-VM profiles.
3. **Bare-VM mode with upstream 1.22.0 is broken after copy-up plus cold restart**, as A3 shows. Clankerbox's current design (Ubuntu as `SMOLVM_AGENT_ROOTFS`, the whole OS in the root overlay) therefore still needs hunk 1 or an equivalent.
   - The failure is probabilistic per file. In `a3`, 12 of 18 stale handles decoded to a live inode: 10 symlinks and 2 regular files. Alpine's busybox lower is unusually symlink-heavy. An Ubuntu lower has far more regular files, so more collisions would be hard `ESTALE`s.
   - Before failing, it silently changes `st_ino` of every copied-up file.
4. **Hunk 3 is still required** for RAM fork whenever a fork source is cold-restarted while any child (even a stopped one) is retained, as C shows. Without it, clankerbox would have to:
   - delete children before restarting a source, or
   - never stop or restart sources with descendants, or
   - accept a `frozen` source that cannot be stopped.

   Upstreaming the one-line change remains the clean path.

So: unmodified upstream is acceptable on the overlay axis **only if** clankerbox moves to stock OCI-image machines. It is not acceptable on the fork axis while RAM fork with restartable sources is in scope.

## Files

- `driver.py` is the local driver. It owns the local WorkRun and creates the remote run directory `~/clankerbox-rewrite/runs/estale-<4 hex>/`, using a short id because of the 108-byte socket budget (`published.sock` path = 107).
  - It registers teardown before the remote directory exists, in this order: (1) collect remote evidence, then delete remote scratch, only after (2) a verified VM teardown; and (2) stop and delete every machine in the private inventory, verify it is empty and that no process references scratch, then take the closing inventory.
  - It runs each experiment in one ssh session.
  - Run it as `python3 spikes/q-estale-linux/driver.py [documented|prime2]`.
- `estale_remote.py` is the remote half: init, inventory, setup (download plus sha256 check), `exp-a`/`exp-b`/`exp-c`, teardown and finish.
  - Every smolvm call gets `HOME=SMOLVM_DATA_DIR=<run>/scratch`, with `XDG_*`, `XDG_RUNTIME_DIR` and `TMPDIR` inside scratch.
  - SIGHUP, SIGTERM, SIGINT or a broken stdout pipe triggers teardown.

## Teardown and isolation

- **No VMs or processes remain.**
  - Both runs ended with `teardown verified: private inventory empty, no process references scratch`. This was checked by scanning `/proc/*/{exe,cwd,environ,fd}` for the run's scratch path. No process was ever signalled.
  - The final checks printed `remote scratch absent` and `no estale processes`.
  - An independent `ps`/`systemctl --user` afterwards shows no `smolvm`, `krun` or `estale` process.
- **Production was untouched.**
  - The pre-existing processes are identical before and after both runs, with the same PID and start time: `clankerbox-host` PID 2301 (started Wed Sep 30 12:40:16) and kernel threads 2149 and 2155 (`wg-clankerbox`).
  - The user units are unchanged: `clankerbox-host.service` is active/running, plus the two `wg-clankerbox` devices.
  - Note that `clankerbox-host.service` was running throughout, despite "controller down". This was recorded only, never touched.
- **Nothing was written outside the run.**
  - `find ~ -xdev -newer <run>/.start-marker -not -path '~/clankerbox-rewrite/*'` returned empty in both runs.
  - Production's default inventory `~/.cache/smolvm/vms/f0362567fd576109` keeps its Sep 7 mtimes.
  - No sudo, no systemd units and no published ports were used.
- **Remaining under `~/clankerbox-rewrite/` (1.5 MiB total):**
  - `runs/estale-e71a/` (736 KiB) and `runs/estale-a6d3/` (632 KiB): manifest `state: cleaned`, `evidence/`, `state.json` and the uploaded `estale_remote.py`. Scratch was deleted.
  - The pre-existing S3 runs and `tools/`, unchanged.
- **Local:**
  - `.work/runs/estale-linux-e71a07f9c103` (988 KiB) and `.work/runs/estale-linux-prime2-a6d38ce3f1a8` (852 KiB) hold driver and ssh logs plus a copy of the remote evidence. Both manifests read `cleaned`/`succeeded`.
  - This spike directory is 76 KiB (two scripts plus this file).
  - These are kept as the evidence behind this document. They contain no disk images or rootfs.
