# Smolvm process-independent recovery spike

Current implementation is a functional recovery harness, not a latency comparison.
It is pinned to smolvm `8a571dce742a15631315ee6b386e5bae8f5af7ea`, libkrun
`dbf5f235047333ac7b831b5a32497aa8c1d46663`, and the separately archived existing
libkrun working-tree patch. `provenance.json` records archive/diff hashes.
This is **not** the earlier latency pin.

## Scope and execution

Only `/home/clanker/clankerbox-recovery.AsnzhP/smolvm` is writable by this adapter.
VM execution requires the common authorization file to name `smolvm`, the common
nonblocking `execute.lock`, and the exact owned cgroup. The cgroup limits runtime
to 32 GiB, zero swap and CPUs 4–11. Guests are 2 GiB/2 vCPU, at most five owned
VMM/guardian processes; no external guest networking or credentials are enabled.
Preparation uses private toolchain/cache copies, CPUs 0–3, one build job and an
8 GiB address-space limit. No host-global configuration is changed.

1. Stage/build with `prepare.py` (already done or in progress; do not rerun snapshot/preparation over existing trees).
2. After an explicit slot grant, root runs `python3 run.py --helper prepare-cgroup`.
3. Run as clanker:kvm: `python3 run.py --grant recovery-20260906 --profile ubuntu-bare --label UNIQUE --case portable`.
4. Inspect `results/UNIQUE/report.json`; use `--case all` only after the portable path passes.
5. After the runner exits and all owned processes are absent, root runs `python3 run.py --helper close-cgroup`.

Helpers reject wrong executable, VMM argv/config subtree, UID, cgroup and PID birth.
Signals use pidfds after a second identity validation. Per-attempt commands and
failures are journaled; cleanup runs even on failed recovery. Raw VM/XDG state is
retained for audit, not deleted by a broad sweep.

## Evidence layout

`results/LABEL/` holds only commands, JSON evidence and reports. Large portable
artifacts are under `artifacts/LABEL/`; source/restorer XDG and image trees under
`x/SHORT-LABEL-HASH/` (short paths keep Linux Unix sockets under 108 bytes).
`failed-attempts.jsonl` is the cross-attempt failure journal.
`build.json`, `provenance.json`, `publication-fsync.patch`, `libkrun.patch` and
`build-commands.jsonl` are separate build/audit inputs.

The core case writes direct-disk A, captures live RAM+disk, then writes and fsyncs
source B. It hashes two copied artifacts, terminates all source VMM/guardian
processes, renames the complete source XDG/agent/image tree out of its old paths,
and restores twice into fresh isolated roots. The shared evaluator requires
saved RAM process identity, advancing heartbeat, direct-read disk A rather than B,
and final independent branch mutations observed after a common write barrier.

## Bounded changes and limits

`publication-fsync.patch` adds a Unix parent-directory fsync after successful
artifact publication, in addition to the upstream artifact-file fsync. It is
applied only to the private source. Static regression checks cover ordering;
functional success does not establish hardware power-loss behavior.

The portable contract is the current strict compatible CPU/runtime/device
profile on the same host. Arbitrary other-host CPU portability is not claimed.
The main result proves process independence, not recovery across an actual host
reboot. No host mounts, forwarded secrets or external guest NICs are included.
RAM is a continuing 64 MiB workload with PID/start/marker evidence; the separate
4 KiB file probe always uses Linux O_DIRECT and fails rather than falling back.
This does not prove arbitrary application transaction recovery.

## Explicit profile revision

Attempts `portable-01` and `portable-02` found harness-only observation issues
(transient boot config is unlinked; the kernel has an unaddressed dummy device).
Attempt `portable-03` then hit the native fail-closed profile boundary: current
portable capture rejects host-backed `--image` directories and archives.

The supported candidate `ubuntu-bare-v1` is therefore a **separate** profile,
prepared by `profile_inputs.py`. It copies the same pinned Ubuntu userland and
unchanged C/probe into a new bundled agent rootfs, adds the matching static agent
and retained runtime auxiliaries, and points its init entry to that agent. No
`--image` is used. Workload writable state is the native VM disk overlay, and
the native artifact includes the agent rootfs. The bare startup command uses
guest `setsid --fork` because bare VM command launch is synchronous; RAM restore
inherits the existing process and must not rerun the startup command.

`profiles/ubuntu-bare/profile.json` inventories all regular-file hashes, modes,
directories and symlink targets. The adapter verifies the entire tree before
starting, records its manifest hash and explicit profile, and has no fallback.
Original `runtime/agent-rootfs`, `build.json`, CLI and libkrun are unchanged.

Optional `all` cases exercise corrupted/truncated/incompatible artifacts with a
good retry, a restored descendant portable capture after ancestor process death,
and live volatile children after source SIGKILL. A fresh request against the dead
source is classified by actual result and RAM identity (rejection, cold new RAM,
or a retained generation), not assumed to fail. The second independent restore
is then cold restarted: fresh RAM identity must coexist with retained mutated
workspace and direct-disk state while original source paths remain hidden.
Ancestor disk paths remain present during live volatile descendant execution;
removing them is not silently conflated with ancestor process removal.

The separate `--case interrupted` kills only the exact checkpoint CLI after
observing native `memory.bin.partial`. It records native STATUS before any manual
RESUME. A paused VM requiring explicit reconciliation is reported as that
limitation, even if the subsequent resume and good checkpoint retry succeed.
