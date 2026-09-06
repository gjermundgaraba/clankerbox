# Orchard retained-lifecycle spike

**Recommendation: use a small Clankerbox supervisor over the Tart/Vetu CLIs for retained workspaces.** Orchard 0.56.1 and the inspected main commit both implement an ephemeral lifecycle that conflicts with weeks-long disk retention. Main has useful reconnection fixes, but does not implement durable worker reconstruction or stop/resume. A coherent fork is possible; it is a lifecycle feature spanning the controller, scheduler, and both runtime managers, not a cleanup flag.

Scope: one user, own repositories, no TTL, no production/host configuration changes. The future Controller VM can live in personal-cloud. Clankerbox owns VM identity and lifecycle, and knows no Herdr internals.

## Pinned evidence

Inspected and executed on 2026-09-04:

| Revision | Immutable commit | Outcome |
| --- | --- | --- |
| Orchard 0.56.1 | `1c241832f5710f68d395c91c414ca55afcb0468a` | All four characterization tests passed, confirming the incompatible behavior below |
| main at inspection | `95b12694501cd378c7801620c6d298b7828c1084` | Same four characterization tests passed; four selected upstream recovery/stop tests also passed |

These are tests of **actual upstream functions**, with an in-process fake runtime and HTTP server or transaction. Their passing result documents failure modes; it does not certify retention. No VM was booted. The original isolated source checkout is `/tmp/clankerbox-orchard.oLQwRl/orchard`; the executed reproducer checkout is `/tmp/clankerbox-orchard-repro.kWBp02/orchard`.

| Operation | Observed behavior on both revisions | Implication |
| --- | --- | --- |
| Worker `Close()` | Calls stop and delete for every tracked VM; even injected stop error does not prevent deletion or make Close fail | Normal worker termination is destructive to disks |
| New worker process, matching running disk and controller VM | Inventory sync issues `stop`; VM manager remains empty; FSM selects `lost-track` | No reconstruction of the existing VM; the later reconciliation reports failure |
| Successful controller inventory omits on-disk VM | Inventory sync issues `stop`, then `delete` | Missing record is interpreted as deletion authority |
| Controller returns HTTP 503 | Inventory sync returns error with zero runtime commands | An HTTP failure alone does not immediately delete a disk; this does not fix scheduler decisions during a worker-network partition |
| Worker last-seen exceeds timeout, `OnFailure` enabled | Health check marks failed; next eligible health check changes restart count 0→1, clears worker, changes disk name | A network outage can cause fresh incarnation scheduling and old disk cleanup on recovery |
| Stopped VM confirmed not running | Scheduler releases reservation; `PowerStateStopped.TerminalState()` is true | API forbids resume; removing the guard alone would skip the needed pinned-worker capacity admission |

The destructive close is wired into the real worker command through `defer workerInstance.Close()`: [0.56.1 worker command](https://github.com/openai/orchard/blob/1c241832f5710f68d395c91c414ca55afcb0468a/internal/command/worker/run.go), [0.56.1 worker reconciliation](https://github.com/openai/orchard/blob/1c241832f5710f68d395c91c414ca55afcb0468a/internal/worker/worker.go), [main worker reconciliation](https://github.com/openai/orchard/blob/95b12694501cd378c7801620c6d298b7828c1084/internal/worker/worker.go).

Stop/resume and replacement decisions are visible in [0.56.1 API](https://github.com/openai/orchard/blob/1c241832f5710f68d395c91c414ca55afcb0468a/internal/controller/api_vms.go), [0.56.1 scheduler](https://github.com/openai/orchard/blob/1c241832f5710f68d395c91c414ca55afcb0468a/internal/controller/scheduler/scheduler.go), and [main scheduler](https://github.com/openai/orchard/blob/95b12694501cd378c7801620c6d298b7828c1084/internal/controller/scheduler/scheduler.go). API rejection is established by source inspection plus its actual terminal-state predicate; this spike did not send a complete authenticated update request through the API router.

## What main fixes—and what remains

Main adds [controller-session recovery, #466](https://github.com/openai/orchard/commit/6cdb1b7), [bounded runtime inventory initialization, #467](https://github.com/openai/orchard/commit/6cbee53), [wait before releasing capacity, #465](https://github.com/openai/orchard/commit/2da1589), and [Tart/Vetu stop completion, #472](https://github.com/openai/orchard/commit/9b8365e). It also addresses [resource subtraction underflow, #470](https://github.com/openai/orchard/commit/381a8bb).

The recovery path preserves already tracked active VMs through a session reconnect, and protects active VMs missing from the controller for **30 seconds**. The selected upstream tests confirm both preservation and deletion after this protection expires, plus deferred new admission while recovered VMs are unaccounted. This is useful session recovery inside a live worker process. A new process still has an empty VM manager, and ordinary Close still deletes. A network partition with the controller still running can still trigger the scheduler's failed/replacement path.

Increasing the offline timeout only postpones a failure decision. Disabling `OnFailure` avoids automatic replacement but does not add resume, worker reconstruction, or non-destructive shutdown. Suppressing Close deletion alone leaves the orphan cleanup and lost-track paths active. Neither is an acceptable retained lifecycle.

## Minimal coherent lifecycle contract

1. **Durable identity and ownership:** stable workspace UUID, disk name, worker machine identity, desired power state, explicit deletion tombstone. Disk placement survives stop. Never infer disk deletion from timeout, missing controller record, failed VM, or a changed restart counter. Unknown inventory is quarantined; missing owned disks produce errors, not replacement clones.
2. **Separate disconnection, process shutdown, and deletion:** disconnection preserves VM and disk; orderly worker shutdown waits for VM stop and keeps disks; deletion is an explicit durable request and acknowledged only after stop and delete succeed. Reconnection cannot convert a stale observation into deletion authority. Identity/generation checks fence stale requests.
3. **Reconstruct runtime tracking:** read durable ownership and inventory before advertising capacity. Verify the disk identity, reconstruct a stopped VM manager object without cloning/configuring from the image, then resume the existing disk. A simple first implementation may stop a surviving VM process and cold-start it under the new worker. This preserves disk data but interrupts guest processes; uninterrupted worker upgrades require a separate process-adoption/supervision design.
4. **Admit every resume on the owning worker:** reserve CPU, memory, and runtime VM slots before start; retain reservations while stopping or uncertain; release only after confirmed exit. A stopped retained disk uses storage but no running reservation. Unaccounted active inventory blocks new admission. Preserve disk affinity; moving to another host requires an explicit disk-transfer workflow.
5. **Keep failures visible and cleanup retryable:** startup/stop/delete failures leave durable state for retry or operator repair. Never turn a missing disk, ownership conflict, or command failure into success. Retrying a deletion tombstone after a crash is safe; retained disks have no age-based garbage collection.

## Executable policy prototype

`spikes/orchard-lifecycle/retained_model.py` is a small SQLite-backed policy model with a fake runtime. It exercises durable desired state and tombstones, shutdown versus outage, recovery with the same disk object and contents, stop failure, ownership errors, missing disks, unknown running inventory, and CPU/memory/slot admission. **Six tests pass.** The disk carries `uncommitted work`, survives stop/resume and reconstructed worker objects, and is removed only by explicit delete.

This is a policy prototype, **not an Orchard patch or usable VM supervisor**. It omits real runtime identity metadata, process adoption, crash injection between external commands and database commits, controller replication/authentication/generation fencing, disk creation, and storage quotas. It assumes one serialized local reconciliation owner. Its worker restart cold-restarts any surviving runtime process. These limits are deliberate: the upstream trace establishes that a correct patch is broader than this bounded spike. No retention claim is made about real Tart/Vetu disk behavior by these fake-runtime tests.

Reproduce from the repository root:

```sh
sh spikes/orchard-lifecycle/run-upstream.sh
python3 -B -m unittest discover -s spikes/orchard-lifecycle -p 'test_*.py' -v
```

The shell runner clones into a new temporary directory, checks out both immutable commits, copies only test files, and runs the characterization tests and four selected main tests. Go downloads dependencies/toolchains as needed; main requires Go 1.27. It leaves the checkout for inspection. Its fake runtime never calls host Tart/Vetu. Python uses only the standard library and temporary SQLite databases.

## Patch scope and recommendation

| Change area | Upstream components requiring changes |
| --- | --- |
| Retention contract and explicit deletion | VM schema, API update/delete/state semantics, durable store/tombstones |
| Outage and restart policy | Scheduler health check and replacement-incarnation logic |
| Resume admission and placement | Scheduler queue, worker resource accounting, pinned host selection |
| Worker lifecycle and inventory | Close, sync-on-disk, VM FSM, registration/recovery inventory ordering |
| Durable reconstruction and fencing | Local ownership/spec ledger, identity verification, stale-controller protection |
| Tart runtime | Split create/clone from attach-existing; reset monitoring/context safely; observe process exit |
| Vetu runtime | Equivalent reconstruction/start-existing and stop completion semantics |

Estimate, not measured implementation output: **roughly 10–15 production files and 15–25 focused tests**, likely **1–3 engineer-weeks** including real VM restart/outage/crash validation, assuming cold restart on worker upgrade is acceptable. Uninterrupted adoption expands the work. Every upstream change touching these seven areas needs re-review; budget approximately **0.5–2 days for a relevant upgrade** plus rerunning real VM retention checks. This is a maintained lifecycle fork, with data-loss-sensitive merge conflicts concentrated in actively changing code.

The useful reusable boundary is the **Tart/Vetu CLI**, which Orchard itself invokes for `clone`, `run`, `stop`, inventory, IP, and delete. Orchard's internal Go managers are not a standalone retained-management API: their constructors launch clone/configure/run, and importing `internal/` from Clankerbox is not supported. See [pinned Tart manager](https://github.com/openai/orchard/blob/95b12694501cd378c7801620c6d298b7828c1084/internal/worker/vmmanager/tart/tart.go) and [pinned Vetu manager](https://github.com/openai/orchard/blob/95b12694501cd378c7801620c6d298b7828c1084/internal/worker/vmmanager/vetu/vetu.go). Direct supervision still needs the five lifecycle requirements above, but avoids fighting Orchard's failed/replaced/deleted model.

Orchard can coexist with separately named retained VMs because its inventory parser skips names outside `orchard-`; see [pinned name parser](https://github.com/openai/orchard/blob/95b12694501cd378c7801620c6d298b7828c1084/internal/worker/ondiskname/ondiskname.go). That gives Orchard no management of those VMs and creates a separate resource-accounting problem if both launch guests on the same host. For this one-user retained workload, running Orchard with no managed retained VMs adds complexity without lifecycle value. Reserve Orchard for a future genuinely ephemeral pool, preferably on separate workers, if one appears.

**Next action:** implement the smallest direct supervisor slice on a disposable VM/disk: create once, stop/start the same disk, persist ownership, restart the supervisor, and verify an uncommitted file survives. Only then add the remote Controller VM transport. Herdr remains a guest workload, outside the VM lifecycle service.
