# Spike Q: stock smolvm 1.22.0 instead of a clankerbox base (items 10, 5, 7)

Date: 2026-10-01. Upstream `smolvm-1.22.0-darwin-arm64.tar.gz` from the
`smol-machines/smolvm` v1.22.0 release. Its SHA256
(`8e6f9d7adf9ee87afe59f8c30d81da5be0c2546f53de7275e7eea2eb39d8f186`) was checked
against the release's `checksums.sha256`. The release wrapper and its bundled
agent rootfs were used as shipped. Guests: stock `ubuntu:24.04` (OpenSSH 9.6p1)
and `ubuntu:25.10` (OpenSSH 10.0p1). Each machine had 2 vCPU and 1–2 GiB, with at
most 3 running at once. Host: Apple Silicon Mac. Work run
`q-smolvm-stock-15d01b7084e4`.

## Verdicts

| Review item | Verdict |
| --- | --- |
| 10: stock agent rootfs + stock OCI image replaces our base | **PASS, with two defects to design around.** Creating `ubuntu:24.04` takes 0.04 s. First start takes 21.6 s with a cold image pull and 1.15 s once the image seed is cached. sshd installs over `exec`, runs under `exec --detach`, and is reachable through `-p` on both virtio-net and TSI. Packages persist across stop/start. Each machine's disk costs about 200 MiB instead of a 2.1 GiB lower copy. Defect 1: installing `systemd-resolved` (pulled in by `openssh-server`'s recommends) makes every later `machine start` fail. Defect 2: any machine can write the agent rootfs shared by **every** machine of the install. Verified on macOS with smolvm unprivileged; untested on Linux as root with the uid drop. |
| 5: "smolvm re-mints SSH host keys" | **PARTIAL.** On RAM fork **and** on checkpoint restore, smolvm re-mints the on-disk host keys, `/etc/machine-id` and the hostname, and fails closed if that fails. It does not re-mint on stop/start, on `machine create --from` a pack (pack machines carry the source's host key), or `boot_id`. On OpenSSH 10.0 a forked clone's RAM-inherited sshd kept serving the **old** key until restarted (fork tested; restore inferred). On 9.6 it happened to serve the new one. The old audit was wrong to say restore does not re-mint. |
| 7 / P6: `pack create --from-vm` as profile capture | **FAIL on fidelity**, PASS on mechanics. uid/gid, setuid/setgid and modes survive, but **every xattr is dropped**, including `security.capability` (file capabilities), `user.*` and `trusted.*`. The pack is **self-contained** (base and overlay flattened into one layer, not delta-on-base). Packing took 2.2 s and produced a 79 MiB sidecar plus a 42 MiB stub. |

## Isolation of HOME (deviation from "scratch")

smolvm resolves every path through `dirs::` on macOS. `SMOLVM_DATA_DIR` only
applies on Linux (S@1.22.0:src/process.rs:1305, a no-op at :1348), so moving
`HOME` is the only relocation available. Per-VM sockets live at
`$HOME/Library/Caches/smolvm/vms/<hash16>/agent.sock`
(S@1.22.0:src/agent/manager.rs:580-587, 905-913). The macOS `sun_path` limit is
104 bytes, and a `HOME` under the run's `scratch/` overflows it. `HOME` and
`TMPDIR` were therefore a private `/private/tmp/cbq-p276y67w`, as
scripts/WORK_RUNS.md prescribes for Tart. Its path is recorded in
`evidence/resources.json`, and `hold.py` registers its removal before VM
teardown. Nothing was written to `~/`.

## Item 10: stock image machine

### Commands (exact, from `evidence/step1.log`)

```sh
smolvm machine create --name clankerbox-rewrite-src --image ubuntu:24.04 --cpus 2 --mem 2048 \
  --net --net-backend virtio-net -p 30922:22                       # 0.04 s
smolvm machine start --name clankerbox-rewrite-src                  # 1.15 s (seed warm); 21.6 s cold pull (probe)
smolvm machine exec --name clankerbox-rewrite-src -- sh -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq &&
  apt-get install -y -qq --no-install-recommends openssh-server libcap2-bin attr'   # 11.5 s
smolvm machine exec --name clankerbox-rewrite-src -- sh -c 'ssh-keygen -A && mkdir -p /root/.ssh /run/sshd && ... authorized_keys'
smolvm machine exec --name clankerbox-rewrite-src --detach -- sh -c 'exec /usr/sbin/sshd -D -e >>/var/log/sshd.out 2>&1'
ssh -F /dev/null -i scratch/client_ed25519 -p 30922 -o UserKnownHostsFile=scratch/known_hosts root@127.0.0.1   # 0.26 s, OK
smolvm machine stop  --name clankerbox-rewrite-src                  # 0.38 s
smolvm machine start --name clankerbox-rewrite-src --branchable     # 0.49 s
```

### What the guest is

- **Every `machine exec` runs inside a crun container, not in the VM.**
  - In the container: `/proc/1/cmdline` = `/run/smolvm/init container-init`,
    `os-release` = Ubuntu 24.04.5, and `/` is an overlay with
    `lowerdir+=/storage/layers/<sha>` and
    `upperdir=/storage/overlays/persistent-<name>/upper`, both on `/dev/vda`
    (the per-VM `storage.raw`).
  - There is no `/oldroot` in the container.
  - It is fully privileged: `CapEff=000001ffffffffff`, identity `uid_map`, no
    user namespace (`evidence/step1-guest-fs.txt`).
  - Exec joins the main container at
    `persistent_overlay_rootfs` (S@1.22.0:crates/smolvm-agent/src/main.rs:6052-6053,
    crates/smolvm-agent/src/storage.rs:112-116).
- **Underneath, the VM root is the agent rootfs.**
  - It is an overlay whose lower is the virtiofs root and whose upper is
    `/dev/vdb` (per-VM `overlay.raw`). After `pivot_root` the old root sits at
    `/oldroot` (S@1.22.0:crates/smolvm-agent/src/main.rs:1119-1467).
  - The virtiofs root is the release's `agent-rootfs/` (48 MiB), passed by the
    wrapper as `SMOLVM_AGENT_ROOTFS`. It is added **read-write**
    (`add_virtiofs3(..., false)` at S@1.22.0:src/agent/launcher.rs:1049, 1069-1075),
    because the agent writes its ready marker there
    (S@1.22.0:crates/smolvm-agent/src/main.rs:659-661).
- **Shared writable lower: yes, worse than the old audit found.**
  - From inside the image container of an ordinary machine, `mount -t virtiofs
    /dev/root /mnt/vfs && touch /mnt/vfs/CANARY` wrote the file into the host's
    `release/.../agent-rootfs/`. This worked for the `src` machine and for a
    machine created from a pack (`evidence/isolation.log`, `probe.log`). The
    canaries were removed.
  - The stock model shares **one** writable agent rootfs across every machine of
    the install, not just across fork families. A root process in any guest can
    change the agent (including `/sbin/init`) that every later boot uses.
  - The *image* filesystem is private per VM. Layers and the container upper
    live on each VM's own `storage.raw`, cloned from a per-image seed. Forks
    CoW-clone those disks.
  - Scope: verified on macOS, where smolvm runs unprivileged and the VMM's
    virtiofs server runs as the user who owns `agent-rootfs/`. On Linux as root
    with the per-VM uid drop (the audit's production choice), a root-owned 0755
    rootfs may refuse the write. Untested there, and the old audit's `/oldroot`
    finding carries the same caveat.
  - Not tested, deliberately: modifying agent binaries, or `..` escapes from
    the share.
- **Identity in a stock image:** `/etc/machine-id` is empty and `/etc/hostname`
  is `localhost.localdomain`. smolvm sets `hostname(2)` to the machine name.
- **No init.** sshd survives as an `exec --detach` child of `container-init`.
  - After stop/start the package, host keys and `authorized_keys` persist.
  - `/run/sshd` (tmpfs) is gone and sshd is not running: ssh gets
    `kex_exchange_identification: Connection reset by peer` from the VMM's
    listener.
  - The stock mechanisms for restarting sshd are `machine create --init <cmd>`
    (runs on every start) or a workload command (`create -- <cmd>`). In
    clankerbox terms, the profile start command.

### Defect: systemd-resolved bricks restart

The first attempt installed `openssh-server` with recommends (36.9 s), which
pulled in `systemd-resolved`. Its postinst replaces `/etc/resolv.conf` with the
symlink `../run/systemd/resolve/stub-resolv.conf`. Every later start then failed
in 0.9 s:

```
Error: agent operation failed: start background CMD: agent operation failed: run container detached:
refresh persistent overlay resolver /storage/overlays/persistent-clankerbox-rewrite-src/upper/etc/resolv.conf:
No such file or directory (os error 2)
```

- **Cause:** on remount, the agent writes `resolv.conf` into the **upper dir**
  with `std::fs::write`, which follows the symlink to a path that does not exist
  in the upper (S@1.22.0:crates/smolvm-agent/src/storage.rs:3341, 3368-3378).
- **Evidence:** a read-only APFS clone of the disk, attached to a diagnostic
  machine, showed the symlink and `.resolv.conf.systemd-resolved.bak`
  (`diag_restart.py`, `evidence/diag-restart.log`).
- **Not a flush problem:** a plain `/etc` write survived stop/start.
- **No in-band repair:** the machine cannot start, so exec cannot fix it.
- **Implication:** profiles must not install `systemd-resolved` (use
  `--no-install-recommends`), or must replace the symlink with a regular file
  before the first stop. This is an upstream bug to report.

### Published ports

- **virtio-net:** `-p HOST:22` with `--net --net-backend virtio-net` works.
- **TSI:** `-p` alone (default TSI, no `--net`) also works. ssh succeeded and
  `lsof` shows the smolvm VMM listening on `127.0.0.1` and `::1`
  (`tsi.py`, `evidence/tsi.log`). Publishing a port implies network; create's
  own error text says so. apt worked although `agent.config.json` showed
  `"network": false`.
- **Use virtio-net anyway:** checkpoints with ports require it
  (S@1.22.0:src/portable_checkpoint.rs:3507-3509).
- **Status JSON omits host ports.** `machine status --json` and
  `machine ls --json` report only `"ports": 1` (a count). The host port is
  readable from `machine ls -v` (`Port: 30922 -> 22`), from `agent.config.json`
  in `machine data-dir`, or from fork's stderr.
- **Status JSON misreports branchability.** After `start --branchable` it showed
  `"branchable": false` / `"forkable": false`, while the VM's `agent.config.json`
  had `"forkable": true` and `machine branch` worked.

### Disk (du, sparse files)

| Item | Size | Scope |
| --- | --- | --- |
| `storage.raw` (image layers + container upper incl. openssh) | 204 MiB | per machine |
| `overlay.raw` (agent-root upper) | 2.3 MiB | per machine |
| `image-seeds/<sha>/storage.raw` (pulled ubuntu:24.04) | 113 MiB | per image, shared |
| `agent-rootfs/` | 48 MiB | per install, shared (writable!) |

`storage.raw` is seeded from the image seed (`storage.seed`). On APFS that is likely a clone, so `du` counts shared blocks twice: the real per-machine increment is closer to 90 MiB over the shared 113 MiB seed.

Compare: today's base is a 2.1 GiB lower copied per machine.

## Item 5: host-key re-mint (`step2.py`, `step2b.py`, `evidence/step2*.json`)

Fingerprints are ed25519. "Served" is `ssh-keyscan` through the machine's
published port. "Disk" is `/etc/ssh/ssh_host_ed25519_key.pub` inside the guest.

| Machine (ubuntu:24.04, OpenSSH 9.6p1) | Port | Served | Disk | machine-id | /etc/hostname | sshd |
| --- | --- | --- | --- | --- | --- | --- |
| source | 30922 | `nT8Cxw…` | `nT8Cxw…` | empty | localhost.localdomain | pid 13 |
| fork1 (`machine branch`) | 25785 (remapped) | `8xAdnI…` | `8xAdnI…` | `a73de425…` | clankerbox-rewrite-fork1 | pid 13, inherited |
| restore1 | 30922 → clash → 21999 | `WjU2Rn…` | `WjU2Rn…` | `42480c76…` | clankerbox-rewrite-restore1 | pid 13, inherited |
| restore2 (same checkpoint) | 30922 → clash → 29969 | `ypZMDA…` | `ypZMDA…` | `b27325dd…` | clankerbox-rewrite-restore2 | pid 13, inherited |
| packed (`create --from` pack, step 3) | — | — | `nT8Cxw…` (**source's**) | empty | (hostname(2) = machine name) | — |

| Machine (ubuntu:25.10, OpenSSH 10.0p1) | Served | Disk |
| --- | --- | --- |
| source | `Au93D3…` | `Au93D3…` |
| fork (sshd pid 411 inherited) | **`Au93D3…` (source's)** | `d9AcHd…` (re-minted) |

- **Fork** (`machine branch --from SRC --name CHILD`, 0.78 s). Source continues;
  the port is remapped to a fresh one
  (`port 30922->22 (source) remapped to 25785->22 (child)`; allocator 20000–32000,
  S@1.22.0:src/agent/fork.rs:3770-3783, message at src/cli/vm_common.rs:987).
- **Checkpoint** (`machine checkpoint --name SRC --output scratch/ckpt/src.checkpoint`):
  1.0 s, 121 MiB file. Source keeps running with the same boot_id and sshd.
- **Restore.** `machine create --name R --from src.checkpoint` (1.2–1.4 s)
  records the checkpoint's host port verbatim.
  - `machine start` then fails fast (0.03 s) with
    `host port 30922 is already in use by running machine 'clankerbox-rewrite-src'`
    (S@1.22.0:src/cli/vm_common.rs:2255).
  - `machine update --name R --remove-port 30922:22 -p NEW:22` followed by
    `machine start` works (1.2–1.5 s), the same way for both restores.
- **`boot_id` is identical across source, fork and both restores**
  (`1ecc2350-…`). Kernel RAM state is not re-minted.
- **What smolvm re-mints, and when.** After the clone boots and before it is
  handed out, `rejuvenate_clone` runs a script through the agent
  (S@1.22.0:src/agent/fork.rs:3022-3197, 3219-3280). The script:
  - sets `hostname`, including the restored container's UTS namespace via `nsenter`;
  - writes `/etc/hostname`, `/etc/machine-id` (and `/var/lib/dbus/machine-id`
    if it is a regular file);
  - deletes and regenerates `/etc/ssh/ssh_host_*_key` with the image's own
    `ssh-keygen -A` under `chroot` into the container's merged rootfs;
  - clears cloud-init instance state, stirs `/dev/urandom` and, on Linux/KVM,
    re-stamps the clock.
  
  Keys are rotated only if host keys already exist. On image machines it
  writes through `/storage/overlays/persistent-<owner>/merged`.
- **Where it runs:**
  - on every fork (S@1.22.0:src/cli/vm_common.rs:1391-1398);
  - on live checkpoint restore, through `finalize_live_restore`
    (S@1.22.0:src/portable_checkpoint.rs:4280-4285, called at
    src/cli/vm_common.rs:1867), but not on `machine resume` of a paused
    checkpoint;
  - **not** on stop/start or on `create --from` a `.smolmachine` pack.
- **Fail-closed.** The script runs under `set -e`. Before deleting anything it
  checks that it can regenerate (`exit 42` if `ssh-keygen`/`chroot` are missing
  while keys exist; `exit 41` if the overlay is missing). It retries 3 times.
  On failure `fail_closed_on_rejuvenation` stops and removes the clone and the
  fork/restore command fails (S@1.22.0:src/agent/fork.rs:2991-2995, 3754-3764).
  Only the clock step is fail-soft.
- **RAM is out of scope by design** (doc comment at fork.rs:3241-3250). The
  OpenSSH result follows from that:
  - On 9.6p1 the inherited listener served the new disk key. This is
    consistent with 9.6 re-exec'ing per connection and loading host keys from
    disk in the child; not checked against OpenSSH source.
  - On 10.0p1 (`sshd-session` split) the fork's inherited listener served the
    source's key. This is consistent with the listener holding the keys in
    memory; it lasted until sshd was restarted.
  - Only fork was tested on 10.0. Restore runs the same rejuvenation over the
    same RAM-inherited sshd, so the same result is inferred.
  - Restart in step 2 (`pkill -x sshd` + `exec --detach sshd -D`) served the
    disk key in every case.

**Does the user's assumption hold?** Partly. smolvm does re-mint SSH host keys
on disk, on fork and on checkpoint restore, and fails closed if it can't. It does
not make a running sshd use them. With current OpenSSH (10.0 tested) a fork
serves the source's key until sshd restarts. It also does nothing for machines made from
a pack, which all share the packed machine's host keys. The plan still needs the
"after fork/restore: restart sshd" profile hook, plus a re-mint on first start
of pack-created machines. The re-mint itself can be dropped from it. Correction
to `docs/plans/design-audit.md` (not edited here): rejuvenation does run on
checkpoint restore at 1.22.0.

## Item 7 / P6: profile capture via `pack create --from-vm` (`step3.py`, `evidence/step3.*`)

In `src`, the following were set up, then the machine was stopped:
- `/srv/q/owned` (dir, `chown -R 1234:2345`, mode 2750) and its file;
- `xattr-file` with `user.q=hello` and `trusted.q=root-only`;
- `capbin` (`setcap cap_net_bind_service+ep`);
- `setuid` (mode 4755).

```sh
smolvm pack create --from-vm clankerbox-rewrite-src --output scratch/pack/profile    # 2.23 s
smolvm machine create --name clankerbox-rewrite-packed --from scratch/pack/profile.smolmachine --cpus 2 --mem 2048  # 4.0 s (extract)
smolvm machine start --name clankerbox-rewrite-packed                                 # 0.9 s
```

| Property | Source | From pack |
| --- | --- | --- |
| `owned` 1234:2345 2750, `inner` 1234:2345 644 | yes | **yes** |
| `setuid` 0:0 4755 | yes | **yes** |
| `user.q`, `trusted.q` on `xattr-file` | yes | **lost** |
| `security.capability` on `capbin` (`getcap`) | `cap_net_bind_service=ep` | **lost** |
| installed packages (openssh-server) | yes | yes |
| SSH host key | `nT8Cxw…` | `nT8Cxw…` (same) |

- **Why xattrs are lost.** The export flattens base layers and the container
  upper through an overlay and streams `tar -cf - -C <merged> .`
  (S@1.22.0:crates/smolvm-agent/src/main.rs:6634, driven by
  src/pack_export.rs:1296-1345). The agent rootfs's `/bin/tar` is a symlink to
  busybox, so no xattrs are written.
  - The layer tar on the host has no PAX xattr records for these files.
  - Ownership is in the tar headers, and on the macOS host it is kept in
    `user.containers.override_stat`.
- **Self-contained, not delta-on-base.** The pack is "ONE flattened layer"
  (S@1.22.0:src/pack_export.rs:10-16): the flattened tar was 171 MB, holding
  ubuntu plus the overlay.
  - The packed machine was created without `--net` and booted without pulling;
    its root is `lowerdir+=/packed_layers/<sha>` over its own upper.
  - Sizes: sidecar `profile.smolmachine` 79 MiB (zstd), stub executable 42 MiB
    (runtime libraries + agent rootfs).
  - The machine's data dir is 637 MiB (du): an extracted pack copy (layer tar,
    agent-rootfs tar and dir, a 188 MB case-sensitive sparseimage mounted under
    `pack/layers-cs`, a storage template). This is heavier per machine than a
    stock-image machine.
  - `pack create --from-vm` requires a stopped VM (S@1.22.0:src/cli/pack.rs:952-959).
- **Consequence.** Profile capture by pack loses the same things the tar path
  loses (file caps, xattrs) and adds a host-key duplication. The "pack keeps
  ownership" half of P6 passes; the xattr/capability half fails. A profile that
  needs capabilities must re-apply them in its start hook (e.g. `setcap` at first
  start), or capture must use a different path (for example a disk-image clone).

## Files

- `hold.py`: owns the work run, downloads and verifies the release, gives smolvm
  a private `HOME`, and handles teardown.
- `lib.py`: helpers; each command is logged with its wall time into evidence.
- `probe.py`, `step1.py`, `diag_restart.py`, `tsi.py`, `step2.py`, `step2b.py`,
  `step3.py`, `isolation.py`: the experiments, run in that order.

## Teardown

Teardown was requested with `touch <run>/teardown`. `hold.py` then did the
following:
- stopped and deleted the one machine left (`clankerbox-rewrite-src`; every
  other machine was deleted by the step scripts);
- confirmed `machine ls --json` was empty;
- confirmed no process referenced the private HOME or the run;
- removed `/private/tmp/cbq-p276y67w`.

Nothing landed in `~/`. `~/Library/Caches/smolvm`, `~/.smolvm`, `~/.cache/smolvm` and
`~/.local/share/smolvm` do not exist. `~/Library/Application Support/smolvm`
pre-dates the run (Aug/Sep) and has no file newer than its start.
`~/.ssh/known_hosts` has no `[127.0.0.1]:` entries (ssh used scratch files).

The run manifest ended `state: cleaned`, `outcome: succeeded`. Independent
checks afterwards found:
- no process matching `cbq-p276y67w|q-smolvm-stock`;
- no `/private/tmp/cbq-*`;
- no mount or `hdiutil` image (the pack's `layers-cs` sparseimage was detached
  when its machine was deleted).

The only `smolvm` processes still on the host belong to Clankerdesk
(`/private/tmp/clankerdesk-bundle.*`, `HOME=/Users/gg/.cb/...`); one of them
(PID 72029) was running before this spike started. Retained: 268 KiB of logs and
JSON in `.work/runs/q-smolvm-stock-15d01b7084e4/evidence/`. Scratch (release,
checkpoint, pack) was removed.
