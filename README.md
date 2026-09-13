# Clankerbox

API-first coding machines with retained workspaces, concurrent Linux RAM forks,
explicit recovery points, and guest-owned terminal sessions. Applications use the
bearer-authenticated session API. Clankerbox does not manage application credentials.

Applications and the CLI use generated `clankerbox.v1` Connect services. Private
host and guest RPC replace internal SSH and upgraded session framing. See
[terminal sessions](docs/terminal-sessions.md) and the
[generated SDK](protocol/README.md) for current consumer contracts. Historical
spike and execution records below retain their original qualification boundaries.

## Using machines

`clankerbox dev` manages a project-scoped environment with the real controller,
persistent host service and Linux VMs. Apple Silicon hosts use the supported
smolvm Linux/arm64 runtime; Linux/amd64 hosts use KVM. The control-plane services
run locally and guest terminals stay inside their VM. See
[local development](docs/local-development.md) for the installed runtime bundle,
project configuration, environment lifecycle and Clankerdesk target.

Create `~/.config/clankerbox/config.json` with your API origin and local files:

```json
{
  "url": "https://YOUR_CONTROLLER",
  "token_file": "token",
  "default_profile": "linux-dev-v3"
}
```

Config file paths resolve relative to the config directory; `~/` expands to your
home. Keep the bearer token file mode 0600. Optional `default_host` and
`default_profile` supply omitted flags; `--host` and `--profile` override them.
Without a host setting, create selects the sole host supporting the profile;
ambiguity requires an explicit `--host`. Explicit or configured hosts go directly
to the controller, which owns admission and returns previously accepted requests
before checking current host/profile eligibility.
No workstation SSH key, SSH agent, or client state directory is needed.

```sh
clankerbox profiles
clankerbox create dev
clankerbox stop dev
clankerbox start dev
clankerbox fork dev experiment
clankerbox checkpoint create dev
clankerbox restore CHECKPOINT_ID recovered
clankerbox sessions dev
clankerbox labels dev team=core purpose=review
```

Create/start/stop/delete/fork and checkpoint create/delete/restore wait for their
accepted operation, up to five minutes. `--timeout 10m` changes that positive
bound. Success prints the machine or checkpoint summary; deletes print the
completed operation. Failure, unresolved status, timeout or a lost operation read
returns nonzero with the known operation and resource IDs. A timed-out operation
may continue: inspect it before deciding to retry. Waiting never resubmits a
mutation. Stopped machines require an explicit `start`; connecting never wakes
them. Deletion requires a stopped machine. Runtime rules still apply: Tart macOS guest
forks/captures require a stopped source.

Resource flags can appear before or after positionals, for example
`create dev --profile mac-xcode-v3 --host mac`. Global flags precede the
command. For automation:

```sh
clankerbox --json create batch-dev --async --idempotency-key REQUEST_KEY
clankerbox --json operation OPERATION_ID
clankerbox --json inspect dev
clankerbox --json checkpoint create dev --async
```

`--json` prints structured resources, or the accepted operation with `--async`.
Without `--async`, JSON mutations return machines (create/start/stop/fork/restore),
a checkpoint (capture), or a completed operation (deletes). `operation` remains
available for diagnostics. Use Clankerdesk or another session-API consumer for
terminal interaction; `sessions` lists the retained sessions but is not an
interactive terminal client. There is no supported direct guest SSH/SCP, local
port forwarding, URL mapping or VNC client.

The binaries use urfave/cli for flag parsing
and generated help. `clankerbox` with no arguments shows root help; use
`clankerbox COMMAND --help` or `clankerbox help COMMAND` for command details.
Help never requires configuration or starts services. Names are positional:
`create NAME`, `fork SOURCE CHILD`, and `restore CHECKPOINT CHILD`.
Errors go to stderr as text, including with `--json`; that flag controls resource
output on stdout.

`clankerbox hosts` shows total, used and remaining CPU/RAM per host. Used
capacity means controller reservations, not live CPU utilization or resident
memory. Running, preparing and unknown machines reserve their pinned profile
sizes; stopped machines release capacity unless a start is queued. Deleted
machines are excluded. The command reads the same durable accounting used for
admission without contacting hosts. Remaining capacity can be negative if host
limits were reduced below existing reservations. `clankerbox hosts --json`
includes `used_cpu`, `used_ram_mib`, `remaining_cpu` and `remaining_ram_mib`
alongside configured totals `cpu` and `ram_mib`.

## Goal and intended architecture

1. Run only the owner's agents and repositories. Machines may live for weeks;
   there is no TTL, maximum lease or automatic idle deletion.
2. Preserve workspaces across normal stop/start and control-plane outages.
   Deletion is explicit; operational workspace backups are outside the product API
   and separate from RAM checkpoints.
3. Support concurrent RAM forks for Linux coding sessions on Linux/amd64 and
   Apple Silicon hosts. Tart macOS/Xcode guests retain their stopped-disk contract.
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

**Use the pinned smolvm runtime for Linux guests and Tart for macOS guests.** This is
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
smolvm/Tart and capability-aware API design (the connection/forwarding parts are historical).
It keeps operational file backups outside the product API.

## Spike history and evidence

These are separate test rounds with different pins and acceptance boundaries.
Older reports retain their original results and explicitly untested cases;
later follow-ups do not rewrite that evidence.

| Round | Question and result | Details |
| --- | --- | --- |
| Initial architecture, September 4 | Orchard lifecycle conflict reproduced in upstream-code tests with fake runtimes. Real Tart/Vetu lifecycle and local backup roundtrips passed; infrastructure inspected, not deployed. | [Orchard](docs/spikes/orchard-lifecycle.md), [Vetu](docs/spikes/vetu-runtime.md), [Tart](docs/spikes/tart-runtime.md), [backup](docs/spikes/workspace-backup.md) |
| Runtime capabilities, September 5 | Cocoon and Cube concurrent RAM forks passed. Smolvm's initial failure was reproduced and fixed in libkrun. Tart stopped-disk branches and recovery passed. | [Execution record](docs/spike-execution.md), [smolvm fix](spikes/smolvm/RAM_FIX.md), [Tart results](spikes/tart-checkpoints/RESULTS.md) |
| Controlled latency, September 5 | 320/320 measured trials passed across matched startup, fresh capture and concurrent fanout workloads. Persistence contracts differ between runtimes. | [Latency results](spikes/latency/RESULTS.md), [concurrency audit](spikes/latency/CONCURRENCY_AUDIT.md) |
| Recovery/lifecycle, September 6 | Both Linux candidates restored continuing RAM and flushed disk state without original processes. Newer smolvm portable artifacts and Cocoon's complete fixed-layout bundle passed independent-copy restoration. | [Recovery results](spikes/recovery/RESULTS.md), [independent supplemental review](spikes/recovery/shared/SUPPLEMENTAL_REVIEW.md) |

### Proven capabilities and boundaries

| Runtime | Executed result | Important boundary |
| --- | --- | --- |
| smolvm | Live siblings survived source death; portable artifacts restored twice with original processes/paths unavailable; descendant checkpoints, retained cold restart and malformed/incompatible artifact rejection passed. | Newer patched build and `ubuntu-bare-v1`; same compatible host, no reboot or new real-agent portable-restore test. Ancestor disk dependencies were retained during live lineage tests. |
| Cocoon + Firecracker | Concurrent RAM forks, direct-disk rollback, ancestor deletion and two independent copied-bundle restores passed. | Native import into a fresh store succeeded but clone rejected original absolute dependencies. The adapter supplies complete fixed-layout recovery, not arbitrary relocation. |
| Tart | Stopped-disk checkpoints preserved dirty Git/SQLite state; branches diverged, cold restarted and survived parent/checkpoint deletion with separate SSH identities. | One VM ran at a time. Cold-boot filesystem recovery, not RAM/process continuation or concurrent Mac RAM forks. |
| CubeSandbox | Nested-KVM RAM forks, controller continuity, guest C/Docker builds passed. | Full native stack inside a disposable outer VM; not a comparable bare-metal performance or host-loss recovery result. |

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

## Terminal sessions

Prepared running machines carry `clankerbox-guest`, which owns PTYs, authoritative
Ghostty VT state and retained output. Public SessionService provides DescribeGuest,
CreateSession, ListSessions, EndSession and typed bidirectional AttachSession over
HTTP/2. The controller routes through the persistent private HostService, and the
host authenticates the machine-bound GuestService with mutual TLS. Workload UIDs
cannot read guest management credentials or invoke rebinding.

Generated Go and TypeScript bindings preserve `uint64` offsets exactly; Node uses
`bigint`. Atomic Opened metadata selects snapshot, resume, final view or unavailable
mode. Input ACKs express bounded admission; a lost ACK is never replayed. Closing
an attachment does not end its session. Public machine labels and readiness remain
available through MachineService. See [the session contract](docs/terminal-sessions.md)
and [the SDK package](protocol/README.md) for consumer migration and generation.

The isolated transport and real guest proofs document their exact boundaries;
source changes do not requalify a deployed release. Current deployment acceptance
must use the matching runtime bundle, guest image, engine digest and generated SDK.

## Remaining acceptance work

1. Exercise the actual agent/tool image and network reconnection on the supported
   smolvm portable profile. Earlier real-agent and fast-fork results do not certify
   this combined configuration.
2. Validate persistent host supervision and recovery across an explicitly scheduled
   host reboot. Process-independent restoration is not power-loss durability.
3. Test upgrade/CPU compatibility, realistic memory/disk pressure, long-running
   credential behavior and retention. No artificial lease limit follows from these gaps.
4. Exercise an isolated restored application startup. Private networking,
   restricted guest links and backup artifact verification are deployed; archive
   integrity checks alone do not establish restored application behavior.
5. Preserve separate contracts for retained disks, live forks and persistent RAM
   checkpoints. Track backing-file references before garbage collection; RAM/disk
   snapshots are secret-bearing even if file backups exclude credential files.
6. Requalify changed terminal and runtime behavior on both platforms before
   release; preserve the prior live results and their specific failure boundaries.

Retained lifecycle and session live acceptance have passed on both platforms.
Fork/checkpoint/restore APIs are implemented, with the platform-specific acceptance
limits recorded above and in the execution record. Broader operational failure
acceptance remains unfinished. Fork preparation replaces the machine-scoped RPC binding and gates
published access, not the child's first network traffic or inherited application
credentials; strict network quarantine and automatic ambiguous-operation recovery
are deliberately deferred.

## Verification, cleanup and reproduction

The historical recovery integration run passed all **12 local test suites**. Recovery
evidence was independently audited: 100 RAM-status replies, 70 direct-disk replies
and 10 exported binary paths, with no integrity findings. Five failed recovery-round
attempts remain recorded, including the native host-backed-image rejection.
Synthetic runtime evidence does not establish application-session continuity.

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


Clankerbox is application-neutral: install and authenticate guest tools yourself.
It does not import provider credentials, configure provider routing, or track
what applications are doing. See [terminal sessions](docs/terminal-sessions.md)
for the supported process lifecycle and terminal protocol.

The [application-neutral cutover](docs/application-neutral-cutover.md) records
removed surfaces, rebuild boundaries, and deployment verification.
