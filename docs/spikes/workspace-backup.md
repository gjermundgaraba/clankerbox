# Workspace backup spike

Recommendation: reuse restic plus append-only rest-server, with one encrypted
repository and credential set per stable Clankerbox workspace ID. Back up hourly.
VMs can run for weeks; neither backup identity nor retention depends on VM ID or
a machine TTL. Keep the orchestration in a small controller record and a guest
backup command. No Herdr concepts or custom backup framework are needed.

## Evidence and boundary

`python3 spikes/workspace-backup/roundtrip.py` passed on 2026-09-04 with installed
restic 0.19.1 (darwin/arm64). It creates only fake data in a private temp directory,
initializes a local encrypted repository, snapshots it, runs `check --read-data`,
and restores into a differently named worker directory. It checks:

1. Git HEAD, staged index content, unstaged edits and untracked files.
2. File bytes, executable modes and a relative symlink.
3. SQLite online backup of committed WAL content while an uncommitted writer
   transaction exists; restored integrity and exclusion of that uncommitted row.
4. A workspace manifest and restoration independent of the original worker path.

Test snapshot: `0c8cd864f51b6fddf9e9b860eca37eb832d48ddb5014cd20c9597f3df4424860`.
The script prints its scratch directory and retains the fake repository and its
generated password there for inspection. It filters inherited RESTIC/GIT variables
and personal Git configuration. No real secrets, backups or personal-cloud
services were accessed or changed.

This proves content roundtrip, **not** REST transport, TLS, namespace isolation,
firewall enforcement, Linux ownership/xattrs, scheduler behavior or recovery after
a real worker crash. Those need a disposable Linux guest and a separate test
rest-server before rollout. The fixture is quiescent; it does not prove an atomic
snapshot of a running editor and its entire workspace.

## Reuse and access

The existing personal-cloud `backups/agent-files/README.md`, `profile.yaml`,
`bin/stage-agent-data`, `bin/maintenance`, `docs/storage-model.md`, and
`rest-server-agent-backup.service.j2` were read as reference. Reuse their TLS,
append-only, private repositories, online SQLite export and trusted maintenance
pattern. Do not share the Mac repository, password, client identity, or broad
Mac source selection with guests.

Provision `ws-<opaque-id>` as a server username and repository namespace. Use a
different HTTP password and restic encryption password for every workspace;
initialize the verified-empty repository from the trusted provisioner. A guest
must never turn a connection/authentication error into `restic init`.
Rest-server `--private-repos` restricts the authenticated username's directory;
`--append-only` prevents replacement/deletion of repository backup objects.
Both capabilities are documented by [rest-server](https://github.com/restic/rest-server).

Allow guest egress to one backup gateway address and port, with validated TLS;
the gateway forwards only the designated backup service. Enforce denial of other
private/LAN/storage destinations outside the guest, including IPv6 and alternative
routes. Give guests no storage-node SSH, SMB/NFS mounts, maintenance credentials,
or storage-wide VPN. Apply per-workspace limits and overall dataset capacity
alerts: append-only clients can still exhaust their quota. This is a proposed
network boundary, not an assertion about the current network deployment.

Append-only is **not write-only**: a restic backup client needs repository reads
and can decrypt its own history. Root in a compromised guest can steal its own
workspace credentials; separate repositories contain that exposure. It cannot
be given cryptographically write-only restic backup access using these flags.
For recovery, a trusted helper reads the repository (or an authenticated GET-only
gateway) and restores into the replacement disk; a GET-only restic client uses
`--no-lock` since repository lock creation needs writes. Never hand a guest prune
access. Rotate the workspace HTTP credential and fence the lost worker before
granting the replacement access. Historical encryption-key exposure is not undone
by rotating HTTP credentials. Server/admin compromise and immutable offsite copies
remain outside the protection offered by append-only rest-server.

## What one backup contains

Use normalized roots `workspace/`, `selected-state/`, and `manifest.json`. Back
up `.git` including the index and objects, working files, untracked work, modes
and symlinks. Do not use Git status as the inclusion list or exclude everything
ignored by Git: ignored local work can matter. Keep caches/build output exclusions
explicit and visible. Prefer a self-contained clone; Git worktrees whose `.git`
file points outside the selected tree require their common Git directory too.
Reject or explicitly include external dependencies rather than claiming recovery
for a workspace whose symlinks/submodule/worktree state point off-volume.

Selected development state means explicitly chosen agent transcripts/history,
portable tool settings and required development DB exports. Rebuild packages,
containers, indexes and caches from the image/config. Exclude authentication
tokens, SSH keys, credential helpers, browser profiles and sockets; authenticate
again after restore. Repository-local secret files need an explicit selection
decision: whole-workspace backup does not automatically remove them. Keep runtime
credentials outside the backed-up tree. The selected-state allowlist is a small
versioned image contract, not a whole-home backup.

The ordinary hourly backup runs against live files and is best-effort across
concurrent writers. It does not pause agents or claim cross-file atomicity.

1. Acquire one workspace backup lock, also used by lifecycle operations, and
   export known databases. For SQLite use its
   [online backup API](https://www.sqlite.org/backup.html), then integrity-check
   the staged copy; never treat copying only the live `.db` as sufficient.
2. Include a manifest containing workspace ID, backup-run ID, image/config version,
   ownership IDs, schema version, selection version, export times and freshness.
   Postgres or other databases need their native dump/export; unsupported stores
   must not silently count as protected. Export failure makes the run degraded
   or failed, never a fresh complete recovery point. Preserve the previous good
   snapshot; optionally retain an explicitly dated last-good export.
3. Run restic with stable `--host ws-<id>` and a workspace/run tag, recording only
   successful complete snapshots as recovery points. Exit 3 (unreadable source
   files) is incomplete even if a snapshot exists. Do not log secrets.

For an optional explicit checkpoint requiring stronger consistency, quiesce the
relevant applications and export their databases, then stage a filesystem snapshot
and resume writers before backing up that read-only view. Without snapshot
support, hold the pause through backup. This is a generic application checkpoint
procedure, not mandatory hourly choreography or an agent-management requirement.
Any remaining active writers keep the checkpoint best-effort. A complete live
backup means all selected sources were read/exported successfully, not that they
represent a single atomic application transaction.

## Hourly scheduling and controller consistency

A systemd oneshot/timer in each Linux guest is enough: `OnCalendar=hourly`,
`Persistent=true`, `RandomizedDelaySec=5m`, with the single workspace lock. Use
launchd scheduling for macOS guests. The
controller tracks `last_attempt_at`, `last_success_at`, full `snapshot_id`,
`backup_run_id`, manifest/selection version and failure/degraded reason. The
hourly target means roughly an hour of work may be lost **when backups succeed**;
jitter, run duration and outages extend it. Alert after two missed hourly runs.
Do an initial backup and a final backup before an orderly stop/move when possible.
Do not power on a stopped guest merely to repeat an unchanged snapshot.

Restic and the controller DB are not one transaction. Assign the backup-run ID
before backup; write it in the snapshot manifest/tag. After success, the trusted
controller checks the snapshot exists and commits the success record. On lost
acknowledgement, reconcile snapshots by workspace/run ID instead of assuming
failure or creating a repository. Guest timestamps/status alone are not proof
against a compromised guest. Protect the controller's own database using an
online export and independently stored backup, so workspace ID → repository,
secret references, image/config and last known recovery point survive controller
loss. Secrets themselves stay in the independent secret store. The manifest lets
an operator recover if the controller record lags a completed backup.

## Deletion, retention and restore

Default: deleting a VM leaves workspace backup history intact. Deleting a
workspace tombstones its controller record and revokes the guest credential;
retain its last good recovery point until an explicit workspace purge. There is
no automatic grace-period expiry. This is a proposed product default, not
deployed behavior.

For active workspaces start with the existing policy: 24 hourly, 14 daily, 8 weekly,
12 monthly snapshots. Retention/prune runs only from trusted maintenance, with a
reviewed dry run. Group using stable workspace identity/tags, never transient VM
hostnames or unique run tags (`--group-by host` for a dedicated workspace repo).
Preserve the last good recovery point for active and tombstoned workspaces until
explicit purge, even when other snapshots expire under retention. See
[restic retention](https://restic.readthedocs.io/en/stable/060_forget.html).

1. Select a known complete snapshot by full ID and inspect export freshness.
   Fence/revoke the old guest before issuing any new writable access.
2. Provision a replacement from the recorded image/config with the same workspace
   ID and expected UID/GID. Restore into an empty scratch target, not over a live
   development session; independent VM naming is fine.
3. Check Git state, representative files/modes, manifest and DB integrity. Import
   selected DB exports before starting the owning tools. Reauthenticate tools.
4. Attach the restored workspace, enable its hourly timer and record a successful
   fresh backup. Publish it ready only after these checks.

Before production, settle the image's selected-state allowlist and confirm the
backup gateway route/ACLs in a disposable guest. Hourly cadence and the retention
and deletion defaults above allow implementation to proceed without designing a
new backup service.
