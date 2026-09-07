# Clankerbox

API-first coding machines with retained workspaces, concurrent Linux RAM forks,
and explicit recovery points. Applications use generic SSH and TCP connections;
Clankerbox does not bundle or manage applications, agents, panes or sessions.

Status as of **2026-09-07**: the Go/SQLite controller, host helpers and connection
CLI are implemented, with a private controller deployed for acceptance. Linux
retained lifecycle, SSH/SCP and automatic forwarding have
passed live checks; lifecycle and forwarding also pass through the deployed
private control path. macOS retained lifecycle and forwarding now pass with
Tart 2.36 / Softnet 0.23 and the macOS 26.6.2 / Xcode 26.6 profile. Native VNC
desktop interaction and local URL mapping have also passed.
Fork/checkpoint/restore APIs are implemented. Mac stopped-disk branching and two
independent checkpoint restores, and Linux live forks with independent retained
disks and SSH identities, pass live acceptance. Linux portable checkpoints also
pass two independent RAM-continuing restores after source deletion, followed by
checkpoint deletion and retained cold restarts. These are synthetic workload checks,
not a new real-agent or host-reboot qualification.
Controller-restart reconnection passes on both platforms without restarting guests.
This is **not yet a completed release or production-qualified
service**. See the [implementation execution record](docs/implementation-execution.md)
for current evidence and remaining acceptance work; the spike reports below
describe earlier runs. Herdr was an external transport experiment, not a product
dependency or release requirement.

## Goal and intended architecture

1. Run only the owner's agents and repositories. Machines may live for weeks;
   there is no TTL, maximum lease or automatic idle deletion.
2. Preserve workspaces across normal stop/start and control-plane outages.
   Deletion is explicit; operational workspace backups are outside the product API
   and separate from RAM checkpoints.
3. Support concurrent RAM forks for Linux coding sessions. macOS/Xcode machines
   need retained disks and disk branching, not equivalent RAM-fork capabilities.
4. Let callers choose an OS, architecture and capability profile. Do not silently
   substitute another machine type or cold boot when RAM restoration was requested.
5. Keep orchestration small and API-first, with explicit recovery and no HA/SLA
   requirement. These are intended product semantics, not long-duration guarantees
   established by short experiments.

| Location | Intended responsibility |
| --- | --- |
| Dedicated Linux VM in personal-cloud | Clankerbox API, durable operation/machine records, admission and recovery coordination |
| Hetzner bare metal, `clanker@203.0.113.10` | Linux host helper and forkable Linux machines; preferred candidate is the tested smolvm build |
| Extra Mac, `user@mac-workstation` | Mac host helper and Tart macOS/Xcode machines |

This repository owns service/helper code, image recipes, profiles and acceptance
tests. `/Users/example/ws/pers/personal-cloud` owns deployment, provisioning, secrets,
VPN/firewall policy and backup integration. Selective site-to-site WireGuard is
working for the private controller-to-Hetzner control path.
See [deployment and network design](docs/spikes/deployment-network.md).

## Current recommendation

**Prefer the tested, pinned smolvm build for Linux and Tart for macOS.** This is
an implementation direction, not a demonstrated overall win or production
qualification. Cocoon remains a strong alternative.

Smolvm provides both live RAM forks and native portable checkpoint artifacts in
a supported profile. Cocoon also passed independent recovery, but our adapter
must collect its full dependency bundle and preserve the expected absolute path
layout. That makes smolvm's recovery boundary attractive for Clankerbox.

The tradeoff is **runtime/profile ownership versus recovery-adapter ownership**:

| Candidate | What we would own | When it is attractive |
| --- | --- | --- |
| smolvm | Pinned CLI/libkrun/agent combination, tested libkrun correction, publication-sync patch, supported disk-backed guest profile and operation reconciliation | Agent-focused Linux machines with live forks and independently restorable checkpoints |
| Cocoon + Firecracker | Complete snapshot/dependency packaging and fixed-layout restoration; tested runtime binaries were unchanged | Conventional Ubuntu/systemd guests, reusable file-backed checkpoints, or a preference to avoid maintaining the smolvm runtime patch |

The successful smolvm portable profile, `ubuntu-bare-v1`, bundles Ubuntu userland
with the matching guest agent as init. Ordinary host-backed `--image` capture was
rejected; host mounts, forwarded resources and other unsupported profiles cannot
be assumed checkpointable. On the tested AMD host, portable restore also requires
an exact CPU fingerprint. See [recovery conclusions](spikes/recovery/RESULTS.md)
and [build/profile details](spikes/recovery/smolvm/README.md).

The original Orchard + Tart/Vetu proposal changed after the retention and RAM-fork
investigations. The inspected Orchard revisions had deletion/reconstruction paths
incompatible with retained workspaces; the Vetu tests proved useful VM lifecycle
operations, not the required concurrent RAM forks. CubeSandbox passed its scoped
tests but brought a full 14-unit native stack. See the
[runtime investigation](docs/concurrent-ram-forks.md). The earlier
[build plan](docs/historical-build-plan.md) is preserved as historical reference.
The [current release-one plan](docs/recommended-plan.md) records the agreed Go,
smolvm/Tart, capability-aware API and automatic connection/port-forwarding design.
It keeps operational file backups outside the product API.

## Spike history and evidence

These are separate test rounds with different pins and acceptance boundaries.
Older reports retain their original results and explicitly untested cases;
later follow-ups do not rewrite that evidence.

| Round | Question and result | Details |
| --- | --- | --- |
| Initial architecture, September 4 | Orchard lifecycle conflict reproduced in upstream-code tests with fake runtimes. Real Tart/Vetu lifecycle and local backup roundtrips passed; infrastructure inspected, not deployed. | [Orchard](docs/spikes/orchard-lifecycle.md), [Vetu](docs/spikes/vetu-runtime.md), [Tart](docs/spikes/tart-runtime.md), [backup](docs/spikes/workspace-backup.md) |
| Runtime capabilities, September 5 | Cocoon and Cube concurrent RAM forks passed. Smolvm's initial failure was reproduced and fixed in libkrun. Tart stopped-disk branches and recovery passed. | [Execution record](docs/spike-execution.md), [smolvm fix](spikes/smolvm/RAM_FIX.md), [Tart results](spikes/tart-checkpoints/RESULTS.md) |
| Real agents, September 5 | Cocoon, Cube and patched smolvm passed real Codex/ChatGPT active-tool forks, independent coding/context turns and connection recovery. | [Real-agent results](docs/real-agent-execution.md) |
| Controlled latency, September 5 | 320/320 measured trials passed across matched startup, fresh capture and concurrent fanout workloads. Persistence contracts differ between runtimes. | [Latency results](spikes/latency/RESULTS.md), [concurrency audit](spikes/latency/CONCURRENCY_AUDIT.md) |
| Recovery/lifecycle, September 6 | Both Linux candidates restored continuing RAM and flushed disk state without original processes. Newer smolvm portable artifacts and Cocoon's complete fixed-layout bundle passed independent-copy restoration. | [Recovery results](spikes/recovery/RESULTS.md), [independent supplemental review](spikes/recovery/shared/SUPPLEMENTAL_REVIEW.md) |

### Proven capabilities and boundaries

| Runtime | Executed result | Important boundary |
| --- | --- | --- |
| smolvm | Live siblings survived source death; portable artifacts restored twice with original processes/paths unavailable; descendant checkpoints, retained cold restart and malformed/incompatible artifact rejection passed. | Newer patched build and `ubuntu-bare-v1`; same compatible host, no reboot or new real-agent portable-restore test. Ancestor disk dependencies were retained during live lineage tests. |
| Cocoon + Firecracker | Concurrent RAM forks, direct-disk rollback, ancestor deletion and two independent copied-bundle restores passed. | Native import into a fresh store succeeded but clone rejected original absolute dependencies. The adapter supplies complete fixed-layout recovery, not arbitrary relocation. |
| Tart | Stopped-disk checkpoints preserved dirty Git/SQLite state; branches diverged, cold restarted and survived parent/checkpoint deletion with separate SSH identities. | One VM ran at a time. Cold-boot filesystem recovery, not RAM/process continuation or concurrent Mac RAM forks. |
| CubeSandbox | Nested-KVM RAM forks, controller continuity, guest C/Docker builds and separate real-agent acceptance passed. | Full native stack inside a disposable outer VM; not a comparable bare-metal performance or host-loss recovery result. |

Real-agent success required **resetting inherited transports and reconnecting**
while preserving Codex and its running tool/controller processes. It does not
prove that cloned remote TCP/TLS connections or long-running OAuth refresh are
safe. Those runs used an earlier smolvm build/profile, not the newer portable
recovery configuration. Temporary credential-bearing machines and copies were
removed after sanitized evidence collection.

Smolvm's interrupted-checkpoint test observed the source paused after the
checkpoint CLI was killed during SAVE staging. Explicit `RESUME` preserved RAM
and direct-disk state, and another capture succeeded. Automatic resume was not
observed before intervention; the retry artifact was saved, not restored in that
case. Clankerbox needs operation-aware reconciliation, not blind resumption of
every paused machine. Cocoon's equivalent interruption case was not tested.

### Latency snapshot

Medians on the Hetzner host with cached images, 4-GiB / 2-vCPU guests and local
guest-agent access, not SSH readiness. Fork rows use a 1-GiB initialized workload.
**These are older live-workflow measurements, not a durable-checkpoint comparison.**

| Operation | Cocoon | Patched smolvm |
| --- | ---: | ---: |
| Cached-image startup, 64-MiB workload | 2.307 s | 0.805 s |
| First fresh capture + one prepared child | 8.984 s | 1.917 s |
| Second fresh capture + another prepared child | 5.372 s | 5.406 s |
| One cooperative capture + four prepared children | 9.115 s | 2.352 s |

Cocoon writes file-backed RAM snapshots; the measured smolvm path uses volatile
memfd RAM generations. The faster first-fork numbers do not establish faster
persistent capture. The newer portable smolvm build/profile has no matched
latency study. Cocoon separately restored four workload-ready children from an
existing checkpoint in 0.971 s, excluding capture and later branch preparation;
that is a different timing boundary. See the [full measurements](spikes/latency/RESULTS.md)
for p95s, populated/dirty workloads, pins and pause-measurement limitations.

## Remaining acceptance work

1. Exercise the actual agent/tool image and network reconnection on the supported
   smolvm portable profile. Earlier real-agent and fast-fork results do not certify
   this combined configuration.
2. Validate persistent host supervision and recovery across an explicitly scheduled
   host reboot. Process-independent restoration is not power-loss durability.
3. Test upgrade/CPU compatibility, realistic memory/disk pressure, long-running
   credential behavior and retention. No artificial lease limit follows from these gaps.
4. Complete operational backup/restore integration. Private networking and
   per-machine SSH access/identity are now deployed; backup fixtures alone do
   not establish a deployed backup service.
5. Preserve separate contracts for retained disks, live forks and persistent RAM
   checkpoints. Track backing-file references before garbage collection; RAM/disk
   snapshots are secret-bearing even if file backups exclude credential files.

Retained lifecycle and connection live acceptance now pass on both platforms.
Fork/checkpoint/restore APIs are implemented, with the platform-specific acceptance
limits recorded above and in the execution record. Broader operational failure
acceptance remains unfinished. Fork preparation replaces SSH identity and gates
published access, not the child's first network traffic or inherited application
credentials; strict network quarantine and automatic ambiguous-operation recovery
are deliberately deferred.

## Verification, cleanup and reproduction

The historical recovery integration run passed all **12 local test suites**. Recovery
evidence was independently audited: 100 RAM-status replies, 70 direct-disk replies
and 10 exported binary paths, with no integrity findings. Five failed recovery-round
attempts remain recorded, including the native host-backed-image rejection.
Synthetic runtime evidence and real-agent evidence are intentionally separate.

The recovery round removed 29 exact disposable payload/cache targets accounting
for 54.59 GiB of allocated data after evidence export. Pinned binaries, reusable
images, source patches and small evidence remain; deleted synthetic RAM/disk
payloads cannot be reconstructed from metadata alone. The final host audit found
no owned runtime processes, listeners or cgroups, unchanged recorded networking
and sysctls, and closed execution grants. Earlier spike cleanup is documented in
each round; older reusable caches were not swept. No production service was deployed.

Run product checks from this repository (the historical spike fixture directories
are isolated by `spikes/go.mod` and are not packages in the product Go module):

```sh
make build
make test
make lint
```

`make test` enables the race detector. Lint uses golangci-lint **v2.13.2** and
the [Maratori config](https://github.com/maratori/golangci-lint-config), with
its exclusion presets and test/comment exclusions removed. `make lint-fix`
applies supported formatting and lint fixes; it still fails for unresolved findings.

The controller takes `--state-dir` and owns `controller.db` and `controller.lock`
inside that private directory. See [module contracts and state cutover](docs/module-contracts.md)
for the public testing boundaries, file-security requirements, and handling retained journals.

Run the separate historical spike checks:

```sh
python3 spikes/run-local.py
```

This command does not boot VMs or perform remote deployment. Cube's SDK fixture
tests require its private `.work/venv`; setup is documented in
[the Cube README](spikes/cube/README.md). Remote experiments have separate scoped
instructions and closed grants; inspect their README before attempting reproduction.
Private build trees, raw result directories, VM images and credentials do not
belong in source control. Durable Markdown reports link the detailed evidence
retained in this workspace.
