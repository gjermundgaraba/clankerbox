# smolvm retained workspaces and concurrent RAM branches

Current state: **patched concurrent RAM acceptance and synced-disk lifecycle PASS**.
See [the executed RAM-fork fix](RAM_FIX.md) and
[the separate libkrun patch](libkrun-dax-fork.patch). This fixes the reproduced
Linux x86_64 virtiofs/DAX eager-fork failure; it is not an upstream merge or a
claim about all device modes or application-session continuity.

The initial result below was **KVM retention PASS; concurrent RAM acceptance FAIL**. Executed under
coordinator grant `smolvm-isolated-20260905` alongside other host activity. All
disposable VMMs, RAM guardians, VM records and owned disk directories are now
gone. No network objects, mounts, firewall rules, global settings or services
were changed. Private source/build/log artifacts remain in staging.

## Initial KVM results (2026-09-05 UTC, before the RAM-fork fix)

The standalone retained-workspace test passed on the real Linux KVM host. A
controller restart preserved the sentinel's guest PID and RAM-marker hash;
stop/start preserved its disk counter/label; pidfd-bound SIGKILL followed by
controller reconciliation retained the machine as stopped; cold start recovered
the same disk state. This is ordinary workspace recovery, **not RAM recovery
after death**. See [retention result](results/kvm/results-20260905-110347/result.json)
and [continuity evidence](results/kvm/results-20260905-110347/retention-continuity.json).

Concurrent RAM acceptance did **not** pass. The native eager
`FORK_CONTINUE` fallback creates children that can execute the inherited
sentinel and report its marker/PID, but the source then fails to execute both
`python3` and `/bin/sh` with `exec: Exec format error`. A bounded final run
reproduced this immediately after the **first** branch, before a second branch.
Its log records `kernel-fault userfaultfd unavailable; using materialized RAM
generation` and a successful `OK forked generation` response. No userfaultfd
sysctl was changed. The exact source/guest-exec failure remains unresolved; this
spike does not attribute it to a particular VMM memory or disk defect without
further evidence. All shared three-way inheritance/divergence checks must pass
before calling this a successful RAM fork.

| Run directory under `results/kvm/` | Actual outcome |
| --- | --- |
| `results-20260905-105646` | First failure preserved: children booted, but `/proc/PID/exe` inspection failed; **not a RAM-fork failure determination**. |
| `results-20260905-105825` | Branchable-child diagnostic allowed direct inspection; source guest exec failed after branching. |
| `results-20260905-110049` | Original ordinary-child configuration with authorized read-only sudo observer: three live VMM identities captured; source guest exec failed. |
| `results-20260905-110347` | One-VM retention, controller restart, explicit stop/start, verified VMM death and cold disk recovery **PASS**. |
| `results-20260905-110416` | Failure isolated to source exec immediately after its **first** materialized RAM branch. |

The initial visibility issue is consistent with upstream
`src/process.rs::harden_self`, which sets `PR_SET_DUMPABLE=0` for ordinary
non-CUDA children but exempts branchable VMMs. The final observer reads only
authorized staged process metadata (`exe`, `stat`, `status`, `cmdline`,
`smaps_rollup`), including actual UID and executable identity. It never reads
process memory or environment, and never signals anything. All VMMs still run
as `clanker:kvm`; only this explicitly authorized observer runs with sudo.

The final diagnostic initially produced orphan disks for the never-created
child-b: upstream `machine exec` constructs its manager/disks **before** reporting
`vm not found`. The failure artifact retains that failed cleanup audit. The
runner now skips guest diagnostics for absent records. A narrowly checked
supplemental cleanup removed only that run's matching name/hash directory,
after proving the private DB empty and the privileged staged-process inventory
empty. Final audits are in `results/kvm/final-cleanup.json` and
`results/kvm/final-process-audit.json`; the original evidence was not overwritten.

All timings are **under concurrent host activity**, not isolated performance.
Source pause, networking/quarantine, Docker, portable RAM recovery, real-agent
sessions, host reboot and source API-delete refusal remain **NOT RUN**. The
full RAM runner stops on the earlier source-exec failure before those dependent
steps. Python guest compilation in the full branch path likewise was not reached.

## Revisions and artifacts

Upstream is https://github.com/smol-machines/smolvm at
`4e4b992593b42e27484c873b2c08feb69e832c4f`. A fresh clone on 2026-09-05 verified
both HEAD and `origin/main` equal that audited revision. No upstream commits
were made. Private source lives in `.work/upstream/`.

1. `retention.patch`: complete proposed upstream change, including regressions
   and a test-only VM-cache override. Apply once to the pinned revision.
2. `regression-tests.patch`: tests/cache isolation only, for demonstrating the
   unmodified upstream bug. Do not apply it on top of `retention.patch`.
3. `check-local.sh`: separate baseline-failure and patched-pass Rust builds.
   Logs go to ignored `results/`; no VM launch and no user VM data access.
4. `prestage.sh` and `prepare-workload.sh`: private, checksum-verified Linux
   toolchain/runtime builds and OCI export. No global packages or Docker daemon.
5. `run-linux.py`: disposable KVM runner using `../acceptance/guest.py` and
   `evaluate.py`. Its required `--host-slot` records a coordinator grant; it is
   not permission to invent a grant or run while another spike owns the host.

The bundled VMM provenance pins libkrun
`dbf5f235047333ac7b831b5a32497aa8c1d46663` and libkrunfw
`55bb7c5273178826240b39e907475fb6011afd8e`. The Linux run uses the audited tree's
`lib/linux-x86_64`, not an installed runtime. The v1.13.1 release rootfs supplies
utilities; its agent is replaced with a static-musl build from the audited
source. This mixed rootfs/source combination still needs real KVM validation.

Private build tools: Rust 1.98.0, Zig 0.15.2, CMake 4.1.3, Ninja 1.13.1. Official
archive SHA-256 checks are enforced in `prestage.sh`. Cargo uses the committed
lockfile. The workload is Docker Official Image Python, linux/amd64, pinned to
`python@sha256:46ee549c88617e9bc8acb843a326f1a5c0fa5608d7f9703509efe6d53b55f318`.
`workload.sha256` also records the exported rootfs and acceptance script hashes.

## Root cause and cleanup audit

The upstream API startup path treats a stored PID's death as permission to
remove the VM record **and its entire data directory**. The existing upstream
unit test explicitly expects this destructive behavior. A normal crash of a
named, non-ephemeral machine therefore violates retained-workspace semantics.

The patch seeds startup retention with every **non-ephemeral** machine, in
addition to the existing stopped/live seeds. It follows fork ancestry to protect
dependent disks. Dead retained records become `Stopped` with both PID fields
cleared; they remain registered and their names cannot be reused. Intentional
delete and unreferenced ephemeral cleanup remain available.

| Caller/path audited at the pin | Finding and proposed handling |
| --- | --- |
| `src/cli/serve.rs` → `ApiState::load_persisted_machines` | Startup retained-name policy fixed; a DB deletion failure now leaves ephemeral disk data untouched. |
| Same startup → `reclaim_dangling_vm_dirs` | Runs immediately after reconciliation. Valid hashes now include referenced ancestry even when an ancestor row is absent. Unknown, unreferenced hash-shaped directories are still reclaimed; this is not recovery from total DB loss. |
| `machine` dispatch → bounded/unbounded `cleanup_orphaned_ephemeral_vms` | Persistent records were already excluded. Add descendant protection and reuse existing data-before-record deletion helper so failed filesystem removal stays retryable. |
| `_cleanup-ephemeral` watchdog; `AgentManager::cleanup_data_dir` | Add fail-closed dependent-clone checks. Existing strict PID verification and cleanup ordering remain. The latter's callers are ephemeral exit/error cleanup and failed, uncommitted clone rollback. |
| API/CLI explicit delete | Existing fork-source lock, clone checks, staged-mount sync and shutdown checks remain. API rechecks descendants after shutdown; CLI supports explicit child-first cascade. |
| `state_probe::recover_unreachable_machine`; API shutdown/start; manager stop/kill | These use `cleanup_dead_vm_runtime`, which removes CUDA runtime residue and drops retained RAM snapshots only without dependent clones. They do not remove ordinary workspace disks. |
| `agent/fork.rs` generation recovery/GC and clone rollback | Generation disks live in `d/`, separately from `s/` RAM snapshots. GC preserves referenced generations; rollback removes uncommitted child/generation artifacts. This patch leaves those algorithms unchanged. |

The proposed patch is a bounded retention fix, not a production lifecycle
transaction redesign. Opportunistic ephemeral checks still use existing
best-effort lifecycle behavior; concurrent create/delete races and interrupted
DB commits need dedicated fault injection before production adoption. API
explicit deletion still removes the row before best-effort disk removal. An
unrelated database or wholesale DB loss must not be pointed at this runtime's
automatic directory sweep.

`cleanup_dead_vm_runtime` can discard a dead source's retained RAM checkpoint
when it has no descendants. Upstream ties this checkpoint to a VMM/memfd
identity. **Stopped disk retention does not establish durable RAM recovery**;
portable-checkpoint recovery after VMM death remains a separate test.

## Local checks and current evidence

Run from this directory:

```sh
./check-local.sh
```

| Check | Status / scope |
| --- | --- |
| Audited SHA equals fetched main | PASS, Git source inspection |
| Unpatched crashed persistent VM reproduction | PASS as an expected failing Rust test; `.work/baseline.log` and `results/baseline.log` show the failure. |
| Patched API-state suite | PASS, 15 native Rust tests; final isolated rerun in `results/state.log`. |
| Ephemeral filter/cap and protected ancestry | PASS, 2 native CLI Rust tests (`results/ephemeral.log`). |
| Failed deletion preserves record; watchdog cleanup invariants | PASS, 1 + 5 native CLI Rust tests (`results/delete.log`, `results/helper.log`). |
| macOS arm64 CLI/test compilation | PASS using bundled libkrun. Initial plain link failed because libkrun was not on the search path; `LIBKRUN_DIR` resolved it without installation. |
| Patched Linux x86_64 CLI compilation / `--version` | PASS in private staging. Static-musl guest agent also built successfully; two upstream time-type deprecation warnings. |
| Parent + two concurrent RAM children | FAIL: source cannot exec after the first branch; full common acceptance not completed. |
| Actual one-VM retained disk lifecycle | PASS: controller restart, stop/start, VMM death and cold disk recovery. |
| Python runner ownership/signal/socket safety | PASS: 3 discoverable local tests, also under `python3 -O`; no safety `assert` remains. |

The local runner gives the baseline and patched trees **separate Cargo output
directories**. Sharing one output directory reused the baseline executable and
produced four misleading patched-suite failures during runner development. The
runner was corrected; no such failed run is counted as a patched pass.

Unit tests use only temporary SQLite databases and a private
`SMOLVM_TEST_VM_CACHE_ROOT` (compiled under `cfg(test)` only). No HOME
override is used. The first Cargo invocation unintentionally used
the normal Cargo cache; it was stopped and all subsequent dependency/build
writes use `.work/cargo`. No package was globally installed.

## Executed host plan

**Staging directory:** `/home/clanker/clankerbox-smolvm.Jf1bpB`.
Private preparation was explicitly authorized; approximately 6.8 GiB is
allocated after the final synchronized builds, below its 40 GiB cap. Builds
use one Cargo job, affinity restricted to four CPUs, and a 4 GiB per-process
virtual-memory limit. No builds will overlap the actual VM run.

1. **Files and identities:** three disposable names
   `cb-smol-<UTC-run-time>-parent`, `...-child-a`, `...-child-b`. All source,
   toolchain, bundle, workload, acceptance copies, DB, cache, logs, sockets and
   cleanup artifacts remain below the staging directory. `XDG_DATA_HOME=d`,
   `XDG_CACHE_HOME=c`, `XDG_CONFIG_HOME=config`, `XDG_RUNTIME_DIR=r`, and
   `DOCKER_CONFIG=empty-docker`, all resolved beneath staging. HOME stays intact.
2. **Privileges:** execute as UID `clanker`, effective group `kvm` for this
   process only. Current `clanker` groups lack `/dev/kvm` access. Use the exact
   `sudo -u clanker -g kvm` invocation below; no root VMM, group membership edits,
   chmod of `/dev/kvm`, UID allocation, sysctl, mounts or system services.
   The later explicit grant also authorizes `observe-linux.py` via read-only
   sudo for verified disposable PIDs and staged-binary cleanup inventory.
3. **Network:** no `--net`, host volumes, `-p`, CNI, bridges, TAPs, netns, nft or
   iptables objects. Management uses each VM's private Unix/vsock socket; the
   controller listens only on `<stage>/r/api.sock`. Image download/export is
   completed beforehand on the host using an empty Docker config. No public
   management port or guest external traffic is requested. Host
   `vm.unprivileged_userfaultfd=0` selects upstream's eager `FORK_CONTINUE` RAM
   generation fallback; no sysctl change is needed.
4. **Budget:** 3 × 2 vCPUs and 1024 MiB guest RAM, sequential branch launches;
   reserve 8 GiB total runtime RAM including VMM/agent/checkpoint overhead and
   up to 32 GiB total staging allocation, with a hard operational ceiling of
   40 GiB. Source disks request 4 GiB storage + 1 GiB overlay; children use
   independent writable qcow2 overlays on ext4. Stop on resource errors.
5. **Cleanup:** runner terminates only its own controller handle and deletes
   its uniquely named children before the source, even on failure. It retains
   command logs, evidence and cleanup status. If deletion fails, it lists
   remaining names for coordinator follow-up and must not claim a clean host.
   Remove the entire staging directory only after evidence is copied out and
   its three VM records/processes and any snapshot guardians are confirmed gone.
   No existing VM, existing network, unrelated file or service is a cleanup target.

The granted command is (reuse the grant only while coordinator authorization
remains active):

```sh
sudo -n -u clanker -g kvm -- python3 \
  /home/clanker/clankerbox-smolvm.Jf1bpB/run-linux.py \
  --stage /home/clanker/clankerbox-smolvm.Jf1bpB \
  --acceptance /home/clanker/clankerbox-smolvm.Jf1bpB/acceptance \
  --host-slot smolvm-isolated-20260905
```

The runner starts the shared RAM-only sentinel once, makes two sequential
single-child RAM branches while leaving the source running, verifies three
distinct live VMM PIDs, and calls the common evaluator. It mutates parent by
10, child-a by 100 and child-b by 1000; all final reads occur after all writes.
Sequential branch calls avoid smolvm's optional batch rendezvous protocol; the
three resulting guests must run concurrently with the same inherited guest PID
and marker. The two branches can originate from different capture timestamps.
It now also checks the parent immediately after each branch, so the known
source failure stops the run at the first affected boundary. Add
`--retention-only` to execute the independent one-VM lifecycle test.

It then checks source-delete rejection, controller restart with continuing
guest processes, explicit child stop/start with retained disk, and a pidfd-bound
SIGKILL of child-b while the controller is stopped. Restarted reconciliation
must retain child-b as stopped and a cold start must recover its disk. The
sentinel is deliberately not restarted to fake RAM continuity after cold start.

Branch-to-exec latency is measured separately per child. Source pause remains
`null`, because a complete branch call is not a pause measurement. Command/debug
logs retain upstream checkpoint timing but it is not relabeled as pure pause.
Real Docker/build workloads beyond Python compilation, named guest networking,
quarantine, actual coding-agent sessions, capacity/mismatch/fork-interruption
faults, portable RAM recovery and host reboot are **NOT RUN** by this bounded
runner. Those limitations remain visible even if its executed assertions pass.

Final staged binary SHA-256 values (also in `<stage>/built.sha256`):

```text
03954f0e4f90029e3d83e48614f31a65fb4ea87ab6162e9b1193c57b4cf337f5  smolvm (Linux x86_64 debug)
06ca71089f5103ff3a7cf73bcfc8b4346150f1607127bf28d0b286b75f1cf93b  smolvm-agent (Linux x86_64 static musl)
```
