# smolvm concurrent RAM-fork fix

**PASS on the tested Linux x86_64 CPU-only virtiofs/DAX path.** The source and
two children now pass all 14 shared RAM/PID/state-divergence checks. A subsequent
full run also passes controller continuity, dependent-source deletion refusal,
stop/start retention and recovery of explicitly synced disk state after VMM death.
No upstream commit, release or production deployment was made.

## Cause and change

The defect is in the bundled libkrun revision
`dbf5f235047333ac7b831b5a32497aa8c1d46663`, used by smolvm
`4e4b992593b42e27484c873b2c08feb69e832c4f`.

1. The forkable memory allocator assigned memory-file backing to ordinary RAM
   **and** device shared-memory windows. Virtiofs then replaced portions of its
   DAX window with mappings of actual files, without changing the allocator's
   recorded backing metadata.
2. The first continuing checkpoint remapped file-backed regions from their
   original backing files. For DAX that restored zero-filled backing over live
   executable bytes. The source subsequently reported `Exec format error`.
   Children worked because restore replays the saved filesystem mappings.
3. Keeping Linux device windows anonymous prevents that incorrect remap. A
   second checkpoint then exposed another issue: the eager copy worker tried
   to read whole device windows, including mappings beyond a file's end.
4. The patch excludes those device windows from forkable-source RAM copying;
   device restore remains responsible for reconstructing them. The generic
   copy routine for ordinary anonymous RAM keeps its existing behaviour.

[libkrun-dax-fork.patch](libkrun-dax-fork.patch) contains both changes and a
native regression test (three files, 76 insertions / 7 deletions). It is separate
from [retention.patch](retention.patch), which fixes disk/record retention in
smolvm itself. Apply each to its corresponding pinned repository, not both to
the smolvm tree. Root verified the exported libkrun patch matches the tested
working tree using a reverse-apply check.

## Executed evidence

| Evidence | Result |
| --- | --- |
| [Resident diagnostic](results/kvm/results-20260905-133335/resident-probe.json) | Source Python and BusyBox headers become zero immediately after checkpoint, **before child preparation**; container PID, inode and namespace identities remain unchanged. Both crun and direct namespace execution fail. |
| [Native baseline regression](results/libkrun-baseline-regression.log) | Expected failure: mapped ELF marker becomes all zeroes with original allocation behaviour. |
| [Patched native tests](results/libkrun-final-regressions.log) | New DAX regression plus 18 existing snapshot tests pass. |
| [First complete RAM acceptance](results/kvm/results-20260905-134705/acceptance.json) | All 14 shared checks pass. Later unsynced crash-recovery check fails; that original failed run remains preserved. |
| [Full synced lifecycle rerun](results/kvm/results-20260905-135732/result.json) | PASS after adding an explicit guest sync before the abrupt VMM-loss boundary. Same-run RAM acceptance and final cleanup also pass. |

The first crash-recovery check killed the VMM immediately after a guest
page-cache write; that write had not established durability. The revised
runner records the explicit sync boundary and tests **synced-disk recovery**.
It does not claim unsynced writes survive a crash, or that RAM survives VMM death.

The recorded native test is deliberately ignored in the normal mixed test
process because forkability is process-global. Run it in its dedicated process:

```sh
SMOLVM_FORKABLE=1 cargo test --locked -p krun-vmm --release --features blk,net \
  fork_continue_preserves_live_dax_file_mapping -- --ignored --test-threads=1
cargo test --locked -p krun-vmm --release --features blk,net \
  snapshot::tests -- --test-threads=1
```

[rebuild-linux.sh](rebuild-linux.sh) records the private staged build environment.
[diagnostic-control.patch](diagnostic-control.patch) is a temporary checkpoint
pause hook for diagnosis, **not part of the final runtime fix**. The final
tested CLI was rebuilt without that hook.

## Boundaries and retained state

The actual run used the host's existing `vm.unprivileged_userfaultfd=0`, selecting
eager materialization; no host policy was changed. Independent source review
found no blocker in the tested fresh forkable virtiofs/DAX path, but identified
these limitations:

- Old checkpoint manifests are **not migrated**. If an old manifest marks DAX
  as ordinary file-backed RAM, restoring it preserves that classification.
  Start with fresh patched VMs/checkpoints for this validation.
- vhost-user follows a different allocation path and is not fixed/validated by
  this result. GPU and other device-window modes are untested; the validated
  build is CPU-only with `blk,net` features.
- Userfaultfd-based lazy generations, macOS/Windows behaviour, portable RAM
  recovery, host reboot and general application crash consistency are not
  established by this test. Non-Linux allocation behaviour is unchanged.
- Real coding-agent session behaviour is a separate test; shared sentinel
  acceptance is not a substitute for it. The subsequent
  [real Codex/ChatGPT run](CODEX_RESULTS.md) now also passes active-tool RAM forks,
  independent concurrent coding/context turns and connection recovery.

The completed fix run removed its VMs, guardians, records and disk directories.
Private source/build/log inputs remain under
`/home/clanker/clankerbox-smolvm.Jf1bpB` (about 7.4 GiB at handoff), including an
original-library copy in `original-runtime/libkrun.so`. Later Codex runs have
their own resource and cleanup records. No existing user workspace was removed.
