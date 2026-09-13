# Retained deployment state: cutover preparation

Read-only inventory on 2026-09-12 used strict-host-key operator SSH and SQLite
`mode=ro`; it did not read token values, mutate workloads, or create backups.
Repeat immediately before cutover because this is a point-in-time observation.

Controller `/var/lib/clankerbox/controller.db` retains running Linux machine
`ad8cd000ed13c8996c30fe8a7eace330`, `test-machine`, profile `linux-dev-v2`,
generation 3. All 203 operations succeeded. All six checkpoint records are
deleted tombstones. Preserve these records, including tombstones and idempotency
history; they are not empty storage.

Desk `/data/personal-cloud/clankerdesk/data` retains four allocation rows, eight
terminal rows and five workspace-machine mappings. Workspace
`be221b00-9162-467c-85ab-8873f4821c0e` references the running machine. Historical
rows reference deleted qualification machines. Catalogs must not be reset.

## Bounded cutover procedure

1. Fence consumer creation and controller admissions, inventory current machines,
   sessions, checkpoints, pending operations, host journal ownership and exact
   image/runtime pins. Reconcile pending work before destructive or identity
   operations. Stop only services explicitly included in the concrete cutover.
2. Export the complete desk data under its existing stopped-container app-backup
   contract, including all SQLite WAL databases, canvases and extension library.
   This briefly interrupts desk and is not a read-only inventory command.
3. Stop the controller before replacing its binary and take a consistent SQLite
   backup, preserving configuration, guest identity authority and transport keys
   in a mode-0700 private audit directory. Use SQLite's backup API and verify the
   backup with `PRAGMA integrity_check`; do not copy only a live main DB file.
4. Preserve host journals, ownership records and immutable profile dependencies
   consistently with host acceptance stopped/fenced. Controller backup alone
   cannot restore host effects or guest state. Do not claim a whole-system
   point-in-time backup while those authorities can still mutate independently.
5. Record exact IDs, generations, artifact SHA-256 values, service definitions
   and backup paths in private evidence. Hash secret-bearing files only when
   needed; never print contents or copy them into source control.
6. Cut over mutually compatible controller, host, guest and desk artifacts.
   For the retained running guest, live identity adoption requires the proven
   rebind path; restarting the guest daemon loses PTYs and is not RAM-preserving
   migration. Do not restore stale controller DB copies over later host effects.
7. Verify authenticated machine/operation reads, exact retained identities,
   stopped guards, terminal resume, browser fanout/restart, and both runtime
   paths. Repeat infrastructure checks and the desk export/integrity check.
   Update both owning personal-cloud operating records with actual evidence.

Owning runbooks are `personal-cloud/hosts/clankerbox-controller/README.md`,
`personal-cloud/deployments/clankerdesk/README.md` and
`personal-cloud/backups/apps/`. Their ordinary release wrappers are authoritative;
this inventory is not permission to execute a reset or restore old state.
