# Spike P4: smolvm as root on the Linux host (D11)

Date: 2026-10-01. Host: the production Linux KVM host (`clanker@37.27.63.112`, Linux 7.0.0-34, amd64, systemd 259), used with the user's approval for root mode (`sudo -n`). Engine: upstream `smolvm-1.22.0-linux-x86_64.tar.gz`, used unmodified.

- The tarball's sha256 is `00d2f057c963ff950846d4059af87bdddb7edf707750cdab863cb0879d6b339e`, which matches the release's `checksums.sha256`.
- `smolvm-bin` is `05c89926…` and the agent is `f140596c…`, the same as the ESTALE spike.

Work runs:

- **Local:** `.work/runs/p4-root-6c61ef7495e4`, with state `cleaned`/`succeeded`.
- **Remote:** `~/clankerbox-rewrite/runs/p4-root-6c6`.

Each VM had 1 vCPU and 1 GiB, with at most 2 running at once. Upstream source is cited as `S@1.22.0:`. Local evidence is `E:`, meaning `.work/runs/p4-root-6c61ef7495e4/evidence/remote/evidence/<file>`.

## Verdicts

| Q | Verdict | Key evidence |
|---|---|---|
| **Q1**: stock `ubuntu:24.04` as root with uid drop | **PASS**, with two deploy findings | <ul><li>The VMM runs as uid/gid `2000000`, with only the `kvm` (992) group, `CapEff=0` and `NoNewPrivs=1`.</li><li>The VM dir is `0700`, owned by `2000000`.</li><li>The agent rootfs is all world-readable (0 entries lack `o+r`) and the VM boots.</li><li>sshd was installed with `--no-install-recommends`, started under `exec --detach`, and `ssh root@127.0.0.2:18904` worked.</li><li>Guest canary: the virtiofs root still **mounts**, but create and mkdir in the agent rootfs get **EACCES**. Only the VM's own pre-created ready marker is writable.</li><li>Finding 1: smolvm `chmod o+x`'d `/home/clanker` (0750→0751).</li><li>Finding 2: a root `tar -x` leaves the engine and rootfs owned by uid **1001**.</li></ul> |
| **Q2**: fork and checkpoint as root | **PASS**: restore uses the copy-on-write disk top and read-only shared RAM | <ul><li>`branch` took 1.53 s; the child was ready in 52 ms on port 20377 (smolvm's range), ran as the **same uid** as its source (2000000), and ssh worked.</li><li>Checkpoint: 1.81 s, 190 MiB.</li><li>Both restores logged `memory.bin method="readonly_link"` and `disks/*/0 method="cow_top"`. Each restore's private disk is a 448 KiB `storage.qcow2` plus a 256 KiB `overlay.qcow2` over hard-linked, root-owned `0444` backings (link count 2).</li><li>The VMM maps `.restore-input/memory.bin (deleted)` privately.</li><li>The second restore took 0.08 s to create and 0.76 s to start.</li><li>Unprivileged run, same flow: `copy_or_link` memory (346 ms into a memfd) and `writable=true` disk copies, 213 MiB private per restore, 2.21 s create and 1.27 s start.</li></ul> |
| **Q3**: `SMOLVM_VM_USE_SCOPE=1` | **PASS**: it can replace the per-VM `systemd-run` supervisor in root mode | <ul><li>Each VMM, including a `machine branch` child, was adopted into its own `system.slice/smolvm-vm-<name>.scope` with caps.</li><li>Stopping the launching transient system unit (KillMode `control-group`, explicit or default) left the VM **alive and answering `exec`**.</li><li>Without the variable, the VMM sat in the unit's cgroup and was **killed** by the unit stop.</li><li>Root only. It does not apply to dev.</li></ul> |
| **Q4**: egress | **PASS** (observe only) | <ul><li>The image pull (seed builder) and in-guest `apt-get` worked as root; apt took 6.7 s.</li><li>Guest traffic leaves the host from the **VMM process as uid 2000000** (`ss -tnpe`).</li><li>No `clankerbox_wg_guard` rule matches it: the `skuid 1000` rules are no longer reached, and their counters stayed 0.</li><li>The deploy rule must match `meta skuid 2000000-101999999` (smolvm's range).</li><li>The floor used was `SMOLVM_EGRESS_FLOOR=strict`.</li></ul> |

## Setup and isolation

- **Root smolvm invocation:**
  ```
  sudo -n env -i PATH=… HOME=<scratch>/home-r SMOLVM_DATA_DIR=<scratch>/r XDG_{DATA,CACHE,CONFIG}_HOME=<scratch>/xdg-r/… \
    XDG_RUNTIME_DIR=<scratch>/xr-r TMPDIR=<scratch>/tmp-r SMOLVM_PUBLISH_ADDR=127.0.0.2 SMOLVM_EGRESS_FLOOR=strict \
    RUST_LOG=smolvm=info,smolvm_pack=info,smolvm_network=info <scratch>/smolvm-1.22.0-linux-x86_64/smolvm …
  ```
  The unprivileged comparison used the same environment without sudo, with `SMOLVM_DATA_DIR=<scratch>/u`, a clanker-extracted copy of the release, and `HOME=<scratch>/home-u`.
- **Data roots are `scratch/r` and `scratch/u`, not `scratch/data`:**
  - smolvm turns `SMOLVM_DATA_DIR` into `HOME` and drops `XDG_*` (S@1.22.0:src/process.rs:1305-1345), so `HOME=<scratch>/home-*` has no effect.
  - Per-VM sockets live at `<data>/.cache/smolvm/vms/<hash16>/control.sock`. With a 3-hex run id and one-letter data roots, that path is exactly 107 bytes, the `sun_path` maximum.
- **Root release:** extracted with `sudo tar -xzf` into `<scratch>/smolvm-1.22.0-linux-x86_64`.
- **Ports:** host ports came from 10000–19999 with a bind probe on 127.0.0.2 and 127.0.0.1.
- **Throwaway ssh key and scratch `known_hosts`:** `ssh -F /dev/null -i <scratch>/k/id_ed25519 -o UserKnownHostsFile=<scratch>/k/known_hosts … root@127.0.0.2`.

**Egress floor values** (S@1.22.0:crates/smolvm-network/src/egress.rs:128-175):

- `strict`: blocks loopback, link-local/metadata, RFC1918, CGNAT, and IPv6 loopback/link-local/ULA.
- `metadata` (also `metadata-only`/`metadataonly`): blocks link-local only.
- `off` (also `none`): blocks nothing.
- Unset: smolvm infers the floor. `SMOLVM_PUBLISH_ADDR` set means strict; otherwise it is metadata+loopback.

**Used: `strict`.** It is what `serve` pins (S@1.22.0:src/cli/serve.rs:195-196), and it is the only safe value on a production host: it keeps guests off host loopback, the WireGuard network (10.203.112.0/24) and the LAN.

- Strict does **not** floor the host's own public address (37.27.63.112). The host's nft guard covers that (see Q4).
- Side effect: with `SMOLVM_PUBLISH_ADDR` set, **every** machine is forced onto virtio-net (S@1.22.0:src/network/launch.rs:172), including Q3's port-less machine.

## Q1: stock image as root, uid drop

Commands (E:q1q2.log):

```
smolvm machine create --name clankerbox-rewrite-p4-src --image ubuntu:24.04 --cpus 1 --mem 1024 --net --net-backend virtio-net -p 18904:22   # 0.02 s
smolvm machine start --name clankerbox-rewrite-p4-src --branchable    # 31.9 s, incl. "built image seed … elapsed_ms=14260" (cold)
smolvm machine exec … -- sh -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends openssh-server'   # 6.7 s
smolvm machine exec … -- sh -c 'ssh-keygen -A; mkdir -p /root/.ssh /run/sshd; <authorized_keys>'
smolvm machine exec … --detach -- sh -c 'exec /usr/sbin/sshd -D -e >>/var/log/sshd.out 2>&1'
ssh -p 18904 root@127.0.0.2 'echo SSH_OK …'            # rc 0, 0.38 s
```

**VMM process** (`ps`, `/proc/<pid>/status`):

```
PID 40373 PPID 1 PGID 40373 UID 2000000 GID 2000000 SUPGID 992  /proc/self/exe _boot-vm …/scratch/r/.cache/smolvm/vms/7489a3c65bdf9c17/boot-config.json
Uid: 2000000 ×4  Gid: 2000000 ×4  Groups: 992  CapPrm/CapEff: 0  NoNewPrivs: 1  Seccomp: 0
cgroup: 0::/user.slice/user-1000.slice/session-170.scope        # the ssh session that ran sudo (no scope mode)
```

- smolvm logs `per-VM uid isolation enabled uid=2000000`.
- The uid registry is `<data>/.cache/smolvm/uids/2000000 → 7489a3c65bdf9c17`, root-owned 0644 (S@1.22.0:src/process.rs:1405-1463, base and span at :1272-1276).
- `Seccomp: 0` is expected: only `serve` turns the seccomp filter on (S@1.22.0:src/cli/serve.rs:171).
- The VMM is reparented to PID 1 in its own process group (S@1.22.0:src/agent/manager.rs:2678). It still inherits the caller's cgroup, so this is not a supervisor.

**Ownership and permissions** (`ls -lan`, `stat` chain):

```
700 2000000:2000000  …/scratch/r/.cache/smolvm/vms/7489a3c65bdf9c17     storage.qcow2, overlay.qcow2, sockets, vm.lock, .vm-uid: 2000000, 0644
                       (root-owned inside it: agent.config.json, agent.pid, agent-startup-error.log, agent.ready socket)
755 0:0              …/vms, …/smolvm, …/.cache, …/scratch/r              (smolvm sets the data root 0755)
701 1000:1000        …/scratch, …/runs/p4-root-6c6, …/runs, ~/clankerbox-rewrite      (were 0700)
751 1000:1000        /home/clanker                                                      (was 0750)
image-seeds/        drwx--x--x root;  image-seeds/<key>/ drwx------ root
```

- The data dir is chowned to the VM uid and tightened to 0700. Each ancestor of the uid registry, the vms dir, the rootfs and the COW-base store gets others-execute through `ensure_traversable`, on every root boot (S@1.22.0:src/agent/manager.rs:2380-2413, src/process.rs:1628-1650).
- **That is how `/home/clanker` went 0750→0751.** It was recorded in the ledger beforehand and reverted at teardown; stat and getfacl matched after.
- **Deploy consequence (D11 "state out of /home/clanker"):** a root smolvm whose data root sits under a 0750 home silently widens that home. Put the data root under `/var/lib/…`.

**Agent rootfs: readable by the dropped uid.**

- The release's `agent-rootfs/`, extracted with `sudo tar`, has 922 entries, all owned by **1001:1001**. That is the CI `runner` uid from the tar headers; it has no passwd entry on this host.
- Modes are 0755/0644, and `find ! -perm -o+r` finds **0** entries. So the VMM's virtiofs server (uid 2000000) reads the whole tree through the "other" bits, and the agent boots: ready by marker in 604 ms.
- smolvm pre-creates a per-VM ready marker `.smolvm-ready.<hash16>` in the rootfs: `0600`, owned by 2000000 (S@1.22.0:src/agent/manager.rs:2415-2440).
- **Deploy finding:** a root install must use `tar --no-same-owner` or `chown -R root:`. Otherwise a future local uid 1001 would own the engine binary and the shared rootfs that root runs.
- **Caveat for the plan's "per-machine rootfs copy":** with today's model (Ubuntu as `SMOLVM_AGENT_ROOTFS`), any lower file without `o+r` becomes unreadable to the guest. That includes `/etc/shadow` (0640) and `/root` (0700), which a root `cp -a` keeps.
  - This was not tested here; only the stock Alpine agent rootfs, which is all world-readable, was tested.
  - If that layout survives, the per-machine copy must be chowned to the VM uid. smolvm does that only for the data dir, not for the rootfs.

**Guest canary (informational).** From inside the image container (E:q1q2.log, `canary`):

```
mount -t virtiofs /dev/root /mnt/vfs          → mount_rc=0 ("/dev/root /mnt/vfs virtiofs rw")
ls -lan /mnt/vfs                              → entries owned 1001:1001; .smolvm-ready.<hash> 2000000 0600
touch /mnt/vfs/CANARY-p4-root-6c6             → Permission denied (rc 1)
mkdir /mnt/vfs/tmp/CANARY-p4-root-6c6         → Permission denied (rc 1)
: >> /mnt/vfs/.smolvm-ready.<hash>            → opened for write (its own marker)
```

- The guest can still mount the shared agent rootfs, but under the uid drop it **cannot create files** there. On macOS unprivileged it could (`spikes/q-smolvm-stock`).
- Host check: no canary existed, and the cleanup `find` counted 0.
- A planned `: >> /mnt/vfs/sbin/init` test was **void**: `sbin/init` is an absolute symlink to `/usr/local/bin/smolvm-agent`. The guest resolved it inside its own container root, so a 0-byte file went into the container's own upper, and that machine was deleted.
- Writes to existing host files were therefore not exercised directly. They are 0644 and owned by 1001, so the capability-less uid 2000000 has no write permission by DAC, as the create/mkdir denials show.

**Published port:** `ss -ltnp` shows `127.0.0.2:18904` **and** `[::1]:18904` (`"libkrun VM"`, pid 40373). `nc -z 127.0.0.1 18904` fails.

- Any non-`0.0.0.0` publish address also gets a best-effort `[::1]` listener (S@1.22.0:crates/smolvm-network/src/tcp_listeners.rs:111-121).
- In production that means a host-local IPv6 loopback listener beside the tailnet address.

## Q2: RAM fork and checkpoint as root

```
smolvm machine branch --from clankerbox-rewrite-p4-src --name clankerbox-rewrite-p4-fork     # 1.53 s; child ready (ping) 52 ms
  "port 18904->22 (source) remapped to 20377->22 (child)"; "golden RAM checkpoint written … memfd pid 40373"
smolvm machine checkpoint --name clankerbox-rewrite-p4-src --output <scratch>/ck-r/src.checkpoint    # 1.81 s, 190 MiB, root 0600
smolvm machine create --name clankerbox-rewrite-p4-r1 --from <ckpt>        # 1.67 s (first: extracts into vms/_shared/<id>/)
smolvm machine update --name …-r1 --remove-port 18904:22 -p 12356:22       # restore recorded the source's port
smolvm machine start --name …-r1                                            # 0.77 s
(delete r1)  create r2 --from <ckpt> 0.08 s; update -> 14428; start 0.76 s
```

**Fork child:**

- uid **2000000**, the source's. A clone borrows its golden's uid so it can map the golden's memfd (S@1.22.0:src/process.rs:1564-1610, comment at :1592).
- Its own VM dir is 0700, owned by 2000000.
- Port 20377 from smolvm's fork range, listening on `127.0.0.2` and `[::1]`.
- ssh to 127.0.0.2:20377 worked with the inherited sshd, and the source's ssh still worked.

**Restores:**

- Each gets a fresh uid: r1 was 2000001, and r2 reused 2000001 after r1 was deleted.
- ssh worked on the swapped port.
- `boot_id` was identical across src, fork, r1 and r2, as on macOS.

**Install method and disk evidence.** Root restore r2 (RUST_LOG, `install_with`, S@1.22.0:src/portable_checkpoint.rs:4063-4170):

```
checkpoint payload installed asset="checkpoint/memory.bin" elapsed_ms=0 method="readonly_link"
checkpoint disk installed asset=checkpoint/disks/storage/0 elapsed_ms=0 method="cow_top"
checkpoint disk installed asset=checkpoint/disks/storage/{1,2,3} elapsed_ms=0 writable=false
checkpoint disk installed asset=checkpoint/disks/overlay/0 elapsed_ms=0 method="cow_top"
```

Unprivileged restore ur1, same flow:

```
checkpoint payload installed asset="checkpoint/memory.bin" elapsed_ms=346 method="copy_or_link"
checkpoint disk installed asset=checkpoint/disks/storage/0 elapsed_ms=153 writable=true
checkpoint disk installed asset=checkpoint/disks/storage/1 elapsed_ms=132 writable=false
checkpoint disk installed asset=checkpoint/disks/overlay/0 elapsed_ms=6 writable=true
```

| | Root (r1 / r2) | Unprivileged (ur1) |
|---|---|---|
| create `--from` | 1.67 s / **0.08 s** | 2.21 s |
| start | 0.77 s / 0.76 s | 1.27 s |
| memory install | `readonly_link`, 0 ms. The VMM maps `vms/<r>/.restore-input/memory.bin (deleted)` as `rw-p` (private CoW over a shared root-owned file). | `copy_or_link`, 346 ms. Mapped as `memfd:smolvm-guest-ram` (`rw-s`, private copy). |
| disk install | `cow_top`. Private writable tops: `storage.qcow2` 448 KiB and `overlay.qcow2` 256 KiB. The backings `.smolcheckpoint-*` are **hard links** (link count 2) to `vms/_shared/3ce80a7c/checkpoint/disks/*`, `0444 root` with an ACL. | `writable=true`. A private `storage.qcow2` (110 MiB) and a private copy of `.smolcheckpoint-storage-1.qcow2` (94 MiB), link count 1, owned 1000. |
| VM dir `du` (actual / apparent) | 186 / 30902 MiB, of which ~184 MiB is the shared hard links | 213 / 30928 MiB, all private |
| data root with one restore | 944 MiB (from 398) | 1126 MiB (from 340) |
| checkpoint file | 190 MiB, 1.81 s | 217 MiB, 1.42 s |

- **How strong the evidence is:** disk sharing is confirmed by inode (link count 2 to `_shared/`). RAM sharing rests on the log (`method="readonly_link"`, `elapsed_ms=0` for a 258 MiB-actual `memory.bin`, against 346 ms to copy it unprivileged) and on the `(deleted)` file mapping. The input link is unlinked once the VMM opens it, so no inode comparison was possible for RAM.
- **Isolation boundary:** a fork family shares one uid, so an escape from one `branch` clone lands in a uid that owns the source's and every sibling's data dir. Restores get a fresh uid (2000001), so the per-VM boundary holds for restore but not for `branch`.
- **Why only root gets this:**
  - `readonly_restore_supported` needs `vm_uid_drop_active()` (S@1.22.0:src/portable_checkpoint.rs:144-158, 160-210).
  - `share_service_owned_backing` returns false unless the uid drop is active and the extracted backing is root-owned and not group/other-writable (S@1.22.0:src/portable_checkpoint.rs:3785-3830).
  - Without a shared inode, `same_inode` fails and the disk becomes a private writable copy (:4115-4136).
- **Cost of the fast path:**
  - The extracted checkpoint in `vms/_shared/<id>/` stays after both restores are deleted: the data root was still 943 MiB. That cache is what made r2's create take 0.08 s.
  - Clankerbox's checkpoint-delete path needs to account for it.
- **Ledger item:** `stage_readonly_memory` calls `restore_tmpfs_root()`, which **creates `/dev/shm/smolvm-restore` (root, 0700)** as soon as euid is 0 (S@1.22.0:src/portable_checkpoint.rs:55-82, 177).
  - It was empty here, because this restore staged on disk, not tmpfs.
  - It was created outside the owned root, recorded in the ledger, and removed at teardown.
  - Production root mode will have it permanently. `SMOLVM_RESTORE_TMPFS=0` disables it.

## Q3: `SMOLVM_VM_USE_SCOPE=1` and host death

Simulated host:

```
sudo systemd-run --unit clankerbox-rewrite-p4-host-<n> --collect [--property KillMode=<km>] -- /bin/sh -c \
  'env -i <root env> [SMOLVM_VM_USE_SCOPE=1] <smolvm> machine start --name clankerbox-rewrite-p4-q3 [--branchable] >>log 2>&1; exec sleep infinity'
# wait for status running; inspect; then:
sudo systemctl stop clankerbox-rewrite-p4-host-<n>.service ; sleep 3 ; kill -0 <vmm>; machine status; machine exec -- echo EXEC_OK
```

| n | scope | KillMode | VMM cgroup before | after unit stop | `exec` |
|---|---|---|---|---|---|
| 1 | yes | control-group | `/system.slice/smolvm-vm-clankerbox-rewrite-p4-q3.scope` | **alive**, same scope, status running | `EXEC_OK` |
| 2 | yes | (default = `control-group`, per `systemctl show`) | same | **alive** | `EXEC_OK` |
| 3 | no | control-group | `/system.slice/clankerbox-rewrite-p4-host-3.service` | **killed**; status `stopped` | `not running` |
| 4 | no | (default) | `…host-4.service` | **killed** | `not running` |
| 5 | no | process | `…host-5.service` | alive, but left in the dead unit's cgroup (`ControlGroup` still set) | `EXEC_OK` |
| 6 | yes | control-group, `start --branchable` + `branch` | source `smolvm-vm-…-q3.scope`; **child `smolvm-vm-…-q3c.scope`** | both alive | both `EXEC_OK` |

- **What the unit's cgroup contained:** in scope mode only `sleep infinity`; without scope, `sleep` plus the uid-2000000 VMM. The unit logs show `adopted VM into systemd transient scope scope=smolvm-vm-clankerbox-rewrite-p4-q3.scope`.
- **Scope properties** are set from the VM size (S@1.22.0:src/agent/manager.rs:2715-2744):
  - `MemoryMax=1879048192` (1 GiB + 768 MiB overhead), `MemoryHigh=1677721600`, `CPUQuotaPerSecUSec=1s`, `TasksMax=1024`.
  - A branchable source with a retained generation grew to `MemoryMax=2952790016`.
- **The scope lifecycle needs no teardown:** after `machine stop` the scope disappeared. A forked child is launched through the same `start_via_subprocess` path, which explains its own scope.
- **Recovery after a killed VMM (scenarios 3 and 4):** `status` reported `stopped` (with the stale pid), `machine stop` returned rc 0 with "is not running", and the next scenario started the same machine normally. That is relevant to D5's "stop/delete cope with leftover native state".

**Conclusion.** In root mode, `SMOLVM_VM_USE_SCOPE=1` in the host's environment replaces the plan's per-VM `systemd-run --collect` supervisor. Every VMM, start or branch, lands in a PID1-owned scope that survives the host unit's stop under `control-group` kill, with resource caps the current jobs don't have.

Limits:

1. It needs euid 0, `/run/systemd/system` and `busctl` (S@1.22.0:src/systemd_scope.rs:117-130). Dev (unprivileged) still needs `systemd-run --user` jobs, so `Supervisor.launch` keeps both arms.
2. The scope name is `smolvm-vm-<machine name>` (S@1.22.0:src/systemd_scope.rs:151-165), with mode `fail` on collision. Machine names must therefore be unique **host-wide**, across every smolvm data root that uses scopes. A `failed` scope is reset and retried by smolvm (:171-201).
3. Restores (`create --from` + `start`) were not run under the scope flag. They take the same `start_via_subprocess` path (their logs show `boot: subprocess spawned`), but that is inferred, not tested.
4. The variable must be set on **every** smolvm invocation that launches a VM (`start`, `branch`, restore `start`). It is read in the CLI process (S@1.22.0:src/agent/manager.rs:2724). `serve` sets it itself (S@1.22.0:src/cli/serve.rs:157-158).

## Q4: egress (observe only)

- **Image pull worked as root.** With seeding, layers are pulled **inside a throwaway builder VM**, with only a manifest HEAD on the host by the root CLI (S@1.22.0:src/image_seed.rs:1-21). The log shows `built image seed … elapsed_ms=14260`.
- **apt in the guest worked:** 6.7 s.
- **Sampled sockets during apt** (`sudo ss -tnpe state established`, E:q1q2.json `egress_sockets_during_apt`):
  ```
  37.27.63.112:58300 185.125.190.82:80  users:(("libkrun VM",pid=40373,…)) uid:2000000 … cgroup:/user.slice/user-1000.slice/session-170.scope
  37.27.63.112:55154 91.189.92.22:80    users:(("libkrun VM",pid=40373,…)) uid:2000000
  ```
  Guest traffic is NATed in userspace by the VMM, so nft sees **`skuid` = the per-VM uid**, which is 2000000 here.
- **Read-only ruleset** (`sudo nft list ruleset`, E:nft-ruleset.txt), table `inet clankerbox_wg_guard`, chain `output`:
  ```
  meta skuid 1000 ip daddr != 127.0.0.0/8 fib daddr type local counter … reject with icmp port-unreachable
  meta skuid 1000 ip6 daddr != ::1 fib daddr type local counter … reject with icmpv6 port-unreachable
  oifname "wg-clankerbox" ct state established,related accept
  oifname "wg-clankerbox" counter drop
  ```
- **Which rules match the dropped uids:**
  - The two `skuid 1000` rules no longer match VM traffic. They block today's VMMs (running as `clanker`) from host-local non-loopback addresses (the public IP, the WG address `10.203.112.1:8444`). Their counters stayed 0 before and after.
  - Only the uid-independent `oifname "wg-clankerbox"` drop still applies.
  - smolvm's `strict` floor covers RFC1918 (including the WG /24), loopback and CGNAT, but **not the host's public address** (S@1.22.0:crates/smolvm-network/src/egress.rs:206-233).
  - So in root mode a guest could reach services bound on 37.27.63.112 unless the guard is changed. This was not probed.
- **Deploy change (phase 8):** replace `meta skuid 1000` with `meta skuid 2000000-101999999` in both rules, the full per-VM range `[VM_UID_BASE, VM_UID_BASE+VM_UID_SPAN)` (S@1.22.0:src/process.rs:1272-1276). Keep `skuid 1000` too if the host process itself should stay fenced; in root mode the host runs as uid 0.
  - A cgroup match is possible only with scope mode (`socket cgroupv2 level 2 "system.slice/smolvm-vm-…"` cannot wildcard), so the uid range is the simpler rule.
  - The root CLI's own traffic (manifest HEAD) is uid 0 and is matched by neither rule.
- **Anomaly, unexplained:** the **unprivileged** comparison's identical `apt-get update && install` took **305.5 s** (rc 0), against 6.7 s as root. It was a single sample with no socket sampling, and the nft counters stayed 0, so the guard did not cause it. The ~300 s looks like a connection timeout, not slow throughput, so do not read it as "root is 45x faster". It was not investigated further.

## Teardown, footprint and ledger

**No runtime resources remain.** Remote teardown (E:teardown-verified.json) found:

- both private inventories empty: no machines named `clankerbox-rewrite-p4-*`;
- no `clankerbox-rewrite-p4-*` or `smolvm-vm-clankerbox-rewrite-p4-*` unit;
- no process referencing the run's scratch (a root `/proc` scan of exe/cwd/cmdline/environ/fds).

The final check printed `no p4 processes`, `no uid>=2000000 processes`, an empty unit list and an empty `/dev/shm`. Scratch was removed with `sudo rm -rf --one-file-system` on the asserted exact path `…/runs/p4-root-6c6/scratch`, and `remote scratch absent` confirmed it.

**Production was untouched.** Before and after are identical:

- `clankerbox-host` PID 2301, started `Wed Sep 30 12:40:16 2026`. `systemctl --user show` gives `MainPID=2301`, `ExecMainStartTimestamp=Wed 2026-09-30 12:40:16 CEST` and `NRestarts=0`.
- Kernel threads 2149 and 2155 (`wg-clankerbox`), started `Wed Sep 30 12:40:15`.
- No `~/` file outside the owned root and `~/clankerbox` is newer than the run start.

**Snapshot of root locations** (`/var/lib/smolvm`, `/root/.local/share/smolvm`, `/root/.cache`, `/run/smolvm`, `/etc/systemd/system`, `/run/systemd/transient`, `/dev/shm`, `/tmp`, `/root`, `/var/tmp`, smolvm cgroups, `system.slice`, system units). The diff (E:snapshot-diff.json) shows only:

- the ssh login session's `session-*.scope` turnover in `/run/systemd/transient`;
- the mtime of `/dev/shm` (`smolvm-restore` was created and removed).

`/home/clanker`, `~/clankerbox-rewrite` and `runs/` are back to 750/700/700, with identical `getfacl`. The catch-all `find / /run /tmp /dev/shm -xdev -newer <start>` lists only production `/srv/clankers/hermes/data`, landscape, udev and logind session files. The journal has entries for the transient units.

**Ledger** (`~/clankerbox-rewrite/CLEANUP.md`, run `p4-root-6c6`). All four entries were added before acting, and all four are marked **REVERTED**:

1. `[dirmodes]`: smolvm `ensure_traversable` made `/home/clanker` 0751 and `~/clankerbox-rewrite` and `runs/` 0701. Reverted; stat and getfacl match.
2. `[units]`: transient system units `clankerbox-rewrite-p4-host-1…6.service` and scopes `smolvm-vm-clankerbox-rewrite-p4-q3{,c}.scope`. All gone.
3. `[shm]`: `/dev/shm/smolvm-restore` was created by this run and removed.
4. `[procs]`: root and uid-2000000/2000001 processes. None remain.

**Retained:**

- **Remote:** `~/clankerbox-rewrite/runs/p4-root-6c6/`, 588 KiB: manifest `cleaned`, `evidence/`, `state.json` and the uploaded `p4_remote.py`. `~/clankerbox-rewrite` is now 2.1 MiB in total, including earlier runs and `tools/`.
- **Local:** `.work/runs/p4-root-6c61ef7495e4/`, 696 KiB: driver and ssh logs, a copy of the remote evidence and of CLEANUP.md.
- **This directory:** two scripts and this file.
- None of these hold disk images, rootfs or checkpoints.

## Files

- `driver.py`: the local driver. It owns the WorkRun and registers teardown before the remote directory exists: (1) collect evidence, `finish` and the closing inventory; (2) remote teardown of VMs, units and processes. It runs `init`, `inventory before`, `setup`, `q1q2`, `unpriv` and `q3`.
- `p4_remote.py`: the remote half. Its commands are:
  - `init`: snapshot and ledger entries;
  - `inventory`;
  - `setup`: download, sha256 check, root and user extraction, socket budget, nft dump;
  - `q1q2`, `unpriv` and `q3`;
  - `teardown`;
  - `finish`: revert outside changes, exact-path `rm -rf`, after-snapshot and diff, ledger marking.
