# Lifecycle performance

## Supported implementation

- Prepared images: account, binary and recursive permission work happen at image
  assembly; profile setup and capture run once per published revision, not at machine start. See [ADR 0008](adr/0008-runtime-built-profiles.md).
- Explicit bind/start/rebind intent: healthy retained authentication is read-only;
  cold starts and live identity renewal cannot be confused.
- Private copy-on-write rootfs materialization where available, without hardlinks.
- Controller submission wakes after commit, immediate queue draining, startup
  journal scan and deadline-driven unresolved reconciliation. Native effects
  remain serialized per host.

The host emits JSON `lifecycle timing` records with `operation`, `machine`,
`phase`, `duration_ms` and `succeeded`. Records never include native arguments,
stdin, output, certificates or error bodies. Phases include `image-materialize`,
`native-create/start/stop/delete/fork/capture/restore`, `guest-prepare`,
`guest-execution-ready`, `guest-image-check`, `guest-binding-install` and
`guest-authenticate`. Outer phases include inner durations; **do not sum them**.
Renewal outside a lifecycle operation has an empty operation ID.

A retained start first probes the manifest's last authenticated endpoint. If the
guest address changed across reboot, that probe can cost up to three seconds
before normal preparation and endpoint discovery proceed. Connection or identity
failures can return sooner; a healthy retained guest needs no native mutation.

## Repeatable benchmark

Use a **new disposable Linux environment** from the candidate bundle. It needs
capacity for the running source and one child. Publish the `linux-tools` recipe
before running the benchmark. Do not run against somebody else's
workloads or interpret a failed/ambiguous operation as permission to replay it.

```sh
go build -o bin/session-run ./tests/session-run
python3 tests/benchmark_lifecycle.py \
  --binary /candidate/clankerbox --config /disposable/environment/client.json \
  --session-runner "$PWD/bin/session-run" --host local --profile linux-tools \
  --samples 3 --result /new/private/results/benchmark.json
```

The benchmark creates unique machines, measures create, retained restart, fork,
checkpoint, restore and cleanup, and verifies guest identity after readiness.
It exclusively creates and atomically updates an evidence file, records accepted
operation/resource IDs before polling, and never retries uncertain mutations.
Success deletes its machines/checkpoints. Failure keeps evidence and any remaining
resources for explicit reconciliation. The caller owns environment teardown.

`controller_seconds` measures durable acceptance to final controller completion;
`client_seconds` includes submission and the 100 ms polling cadence. Environment
startup/bundle verification and additional identity probes are outside these
operation timings. Run the lifecycle/checkpoint and public-session acceptance
harnesses as well: a faster timing is not evidence of preserved sessions or disks.
Repeat on macOS/arm64 and Linux/amd64 using the same candidate input pins. The
benchmark specifically exercises RAM-capable Linux profiles, not Tart disk forks.

## Follow-up decisions

**Shared immutable lower root — not enabled.** The pinned engine/agent has
persistent overlay support, but readiness fallback can write through `/oldroot`
to the lower directory. Before sharing, move all boot markers and other mutable
runtime state out of the lower image, enforce read-only access, then qualify
concurrent boots, retained starts, source deletion, forks and independent restores
on both host platforms. Do not just point `SMOLVM_AGENT_ROOTFS` at the bundle.

**Operation concurrency — not enabled.** More capacity slots alone cannot
parallelize creation: the controller worker, host service worker and host mutation
lock serialize effects. A later replacement needs bounded scheduling over every
source/destination/checkpoint reservation and an audit of runtime-global caches,
port leases and supervisor state. It changes ADR 0003. Preserve the current safe
serialization until benchmarks justify that larger change and its crash tests.

**Template pools — no new product API.** Measure ordinary fork and restore first.
They already expose the needed primitive. Do not change `create` into a hidden
RAM clone or add a separate test-only lifecycle.

## Qualified comparison

The [prepared-image qualification report](../scripts/release/inputs/prepared-image-qualification.md)
records three-sample candidate/baseline measurements, acceptance checks, artifact
identities and evidence receipts on both host platforms. Its baseline uses the
same smolvm 1.16.0 runtime and compact templates, not the historical 0.4.0 runtime.
These measurements cover Linux guests. The separate
[Tart qualification report](../scripts/release/inputs/tart-prepared-qualification.md)
records fresh macOS image finalization, lifecycle/session/disk-checkpoint checks
and cleanup. Tart was qualified for correctness, not benchmarked against a baseline.
The subsequent [permission-correction qualification](../scripts/release/inputs/prepared-permissions-qualification.md)
covers the revised directory-mode contract and lifecycle regression checks on
Linux/KVM; it does not replace the original benchmark receipts.

Runtime profile qualification must report build time separately from create time. Measure create/start/stop during setup with spare CPU/RAM; setup releases lifecycle serialization. Preparation, export and validation may queue lifecycle work, and their delay must be reported separately. Historical reports above predate runtime profiles and do not qualify them.

See [runtime profile qualification](runtime-profile-qualification.md) for runtime-update and crash-recovery coverage, matched smolvm/Tart lifecycle
measurements, and current qualification limits.
