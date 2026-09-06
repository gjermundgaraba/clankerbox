# Executed results — 2026-09-05

**PASS: required Tart stopped-disk checkpoint, independent branch, and recovery
checks executed on `user@mac-workstation`.** Runner exited 0. Six local safety
tests passed. No commits or changes outside this spike directory were made.

Actual host was `macbook-workstation`, macOS **26.6.2 (25G83)**, Tart **2.32.1**.
This OS version supersedes the earlier 26.6 inventory supplied to the worker.
Two initial SSH attempts timed out/refused; the next attempt connected normally,
before any remote mutation. No network or host settings were changed.

| Check | Result | Executed evidence |
| --- | --- | --- |
| Isolated public seed | PASS | Pinned cached public digest copied with APFS `clonefile`, then all Tart operations used marked private `TART_HOME` and disabled auto-prune. |
| Dirty workspace capture | PASS | Git `MM tracked.txt`, staged and unstaged diffs, untracked file, marker, and committed SQLite row restored exactly into the branch; SQLite integrity check returned `ok`. |
| Branch independence | PASS | Branch Git/marker/SQLite mutations differed; separately booted source and checkpoint still matched their original complete fixture. |
| Guest identities | PASS | Source MAC `16:48:ec:15:65:28`, IP `192.168.64.17`; branch MAC `2a:1b:6c:40:b5:ca`, IP `192.168.64.18`. Fresh host and client SSH keys differed; both SSH connections succeeded against host keys obtained through Tart exec and pinned before connection. |
| Retained branch disk | PASS | Guest-initiated clean shutdown, VMM exit 0, and cold restart retained the changed complete fixture. Boot-session UUID changed from `1DB8EC17-DD38-4865-9017-C6AF57213869` to `3B3C170D-5FF9-48A5-A52B-5C860A3FE2DF`. |
| Parent deletion | PASS | Explicitly deleted both stopped source and checkpoint. Child booted again and retained its changed Git/SQLite/marker state. |
| Cleanup and original inventory | PASS | All four owned images deleted; no owned VMM remained; disposable client keys/known-hosts removed. Original `.tart` filesystem inventory and config hashes matched exactly. Final independent process audit found no Tart process. |
| RAM suspend/resume | NOT RUN | Optional. No RAM-state continuity is claimed. |
| Backup restore / host reboot | NOT RUN | No existing backup script or backup endpoint was used; no host reboot performed. |

## Measured cost

Timings use Python's monotonic clock on the Mac host, one sample per operation.
These are warm-host observations, not a latency distribution or cold-host test.

| Operation | Observed duration |
| --- | --- |
| APFS copy of cached public image into isolated seed | 0.00062 s |
| Source → stopped checkpoint, including CPU/memory/identity configuration | 0.02456 s |
| Checkpoint → branch, including CPU/memory/identity configuration | 0.02586 s |
| Six cold guest boots to successful guest-agent probe | 19.408–20.333 s |
| Six guest-initiated shutdowns to VMM exit 0 | 5.440–6.223 s |
| Entire remote experiment including cleanup | Approximately 183.6 s |

Peak observed host free-space reduction was **2,446,524,416 bytes (2.28 GiB)**,
sampled every 0.5 seconds, below the 32 GiB abort threshold and 40 GiB budget.
Final immediate reduction was 308.77 MiB. Host-wide free-space changes include
unrelated activity and APFS delayed reclamation; these figures are a budget
observation, not exact per-VM physical allocation. One VM ran at a time, each
configured with 4 vCPU and 8192 MB memory.

## Evidence and reproduction

- [Runnable procedure](README.md) and [runner](checkpoints.py).
- [Structured commands, outputs and events](results/20260905-123958/results.json),
  [console log](results/20260905-123958/runtime.log), and
  [local safety tests](results/20260905-123958/local-tests.txt).
- [Inventory before](results/20260905-123958/inventory-before.json),
  [inventory after](results/20260905-123958/inventory-after.json), and
  [final remote audit](results/20260905-123958/final-remote-audit.txt).

Remote retained evidence is exactly
`/Users/example/clankerbox-tart-checkpoints.M67Mef/` (72 KiB): runner, ownership marker,
three VMM logs, structured results and inventories. No VM disks or disposable
SSH private keys remain there. No launchd jobs were created.

The checkpoint restores filesystem state by a **cold boot**. It does not resume
captured RAM or processes. Guest identity rotation occurs after boot, so this
does not demonstrate pre-egress quarantine, concurrent Mac RAM forks, crash
durability, or unattended FileVault/keychain recovery after host boot.
