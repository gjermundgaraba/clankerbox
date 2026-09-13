# Explicit recovery of two resumed Mac guests

Both restore operations had successfully consumed RAM and started their retained VMMs. The host then invoked `daemon-reload` through launchctl, which failed before guest identity rebinding. This was a host supervision bug after RAM resume. The product fix skips that systemd-only step on macOS and never unloads the live launchd VM.

The qualification-only `restore-recovery` harness accepts only the two inventoried operation IDs. With the host service stopped and both lifetime/journal locks held, it checks the exact failure, machine identity, running native state and consumed pending marker. It calls native Initialize, which requires an existing RAM-child daemon and cannot substitute a cold manager. After successful TLS rebind it atomically completes the same operation and manifest using byte-for-byte compare guards. Original journal bytes remain under each root's `recovery-<operation>/` directory. No restore/create/start operation was replayed and no VMM restarted.

- A root `/Users/example/.cb/0ebbbbdc9872`, operation `8e82744106f78765f71205b30b286eb7`, machine `a17d162f1ded50511d5f8e5b1d756d7e`.
- C root `/Users/example/.cb/99bc0a3b4cb0`, operation `c51546e35098d843a4d534a6ad9cbd96`, machine `f49cf8ca221cbb017a4e4b12ed5a1625`.

C's typed controller probe confirms original shell PID3254, daemon incarnation `d145f4c5-11bb-4052-9e82-76d5be4b7f3f`, in-memory `RPC_TOKEN=mac-retained-20260912` and disk token `disk-retained`, after source deletion.

A's restored memory fixture is alive with PID2807 and token `2c3f65e11a0346969b1e08356226c2f0`, and captured disk value `source-A`. The original checkpoint report saved an earlier fixture before an explicit cold restart; it failed to persist the replacement fixture baseline at capture. Consequently A's recovered value cannot be compared to a recorded capture baseline. C provides the complete RAM continuity proof.

Both host services were restarted using the standalone updated `.work/real-local-engine/restore-recovery/clankerbox-host` and external qualification plists. Installed immutable bundles, historical content pins and original service.json files remain unchanged. The native VMs, checkpoints and controller state are retained for parent-owned cleanup. These recovery binaries/plists are qualification artifacts, not release packages.

## Cleanup completed

Both environments were subsequently destroyed through the public dev teardown workflow. Two additional qualification defects were fixed: the controller now treats freshly observed stopped Stop as a durable no-op, and the host accepted-work dispatcher no longer requires a nonexistent machine manifest for checkpoint deletion. The latter had left an accepted deletion with no effects; the fixed host resumed that same operation.

Old schema1 teardown fences prevented ordinary bundle upgrade. A qualification-only APFS copy `runtime-v4-recovery` retains all historical runtime/image pins and v3 CLI, replacing only host/controller binaries and their file hashes. Under exclusive environment, controller, host service and journal locks, an explicit inventoried adapter changed only the bundle pointer and service definition/config. No operation, generation, checkpoint, native data or teardown intent was reset. Both public `dev destroy` calls then succeeded.

Verified absent: host roots `0ebbbbdc9872` and `99bc0a3b4cb0`, both project `.clankerbox` directories, host launchd labels and every remaining native VM label. Original controller processes exited gracefully. Standalone recovery plists are unloaded. Bundles, logs and original journal-byte evidence remain outside the destroyed roots at `.work/real-local-engine/restore-recovery/`.
