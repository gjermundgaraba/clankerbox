# Storage, lineage and recovery spike

Status: **PASS** on the real Hetzner host, 2026-09-05. Both copy and XFS
reflink preserved independent descendant contents after deleting their ancestors.

Implemented file-level copy/reflink comparison with source → checkpoint → two
children → grandchild, independent writes, and deletion of ancestors. It checks
contents after all mutations/deletions, not merely successful clone commands.

```sh
python3 -m unittest discover -s spikes/storage-recovery -p 'test_*.py' -v
```

`storage.py --directory EXISTING_SCRATCH_PARENT --mode copy|reflink` writes only
under a new disposable subdirectory, tests 256 MiB files by default, and removes
its fixtures afterward. Linux reflink uses FICLONE and fails if unsupported;
there is no silent fallback to copy. Capacity is checked before allocation.

`run-host.sh` is an explicitly gated Linux root procedure, not a default local
test. It requires `CLANKER_HOST_SLOT=storage`, makes a private directory under
`/home/clanker`, runs the ext4 copy case, creates a new 4 GiB regular image file,
formats **only that image** as XFS/reflink, mounts it with nodev/nosuid/noexec,
runs the reflink case, unmounts and deletes the image. It retains two small JSON
reports. Failed unmount keeps the image rather than deleting mounted storage.
Never point a formatting operation at the existing root disk or another device.

Clone timings are one warm-cache raw-file trial, not VM fork latency. Per-file
allocated blocks include shared extents and must not be summed as physical cost.
The isolated XFS free-space delta is more meaningful than an ext4 host-wide delta
while other build work continues. Runtime pause, dirty RAM/PSS growth, application
flush and crash consistency require the actual runtime checks.

The existing `spikes/workspace-backup/roundtrip.py` was rerun successfully on
2026-09-05: dirty Git HEAD/index/worktree/untracked data, modes, symlink, SQLite
committed WAL export, manifest and full restic data verification survived restore
to a new worker directory. This used an encrypted local fixture repository with
disposable credentials. It did not test production REST/TLS accounts or an actual
forked guest's backup schedule. Do not confuse either backup or file-level lineage
checks with a VM's RAM checkpoint and runtime garbage-collection contract.

## Executed results

The 256 MiB file trial produced these measurements on the existing ext4 root
and a disposable 4 GiB XFS image. Other host work was concurrent.

| Measurement | ext4 copy | XFS reflink |
| --- | --- | --- |
| Four clone calls | 292.215–296.427 ms each | 0.394–1.061 ms each |
| Filesystem free-space decrease before fixture deletion | 1,342,177,280 bytes | 268,828,672 bytes |
| Independent writes and descendant survival | PASS | PASS |

This supports provisioning reflink-capable runtime storage; it does not establish
end-to-end VM pause time. The XFS trial used its own filesystem, while the ext4
free-space measurement could include unrelated host activity.

Reports remain at `/home/clanker/clankerbox-storage.hGbRSB/{ext4,xfs}.json`
(root-owned, 1,660 bytes total). The coordinator independently checked that only
those two reports remain: the test files, XFS mountpoint and 4 GiB image were
removed, with no matching mount or loop attachment. Private runner copies remain
at `/home/clanker/clankerbox-storage-tools.W7OeJa/`.
