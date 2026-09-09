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

## Using machines

Create `~/.config/clankerbox/config.json` with your API origin and local files:

```json
{
  "url": "https://YOUR_CONTROLLER",
  "token_file": "token",
  "identity_file": "~/.ssh/id_ed25519",
  "public_key_file": "~/.ssh/id_ed25519.pub",
  "default_profile": "linux-dev-v2",
  "state_dir": "~/.local/state/clankerbox"
}
```

Config file paths resolve relative to the config directory; `~/` expands to your
home. Keep token/private-key files mode 0600 and state directories mode 0700.
Optional `default_host`, `default_profile` and `public_key_file` supply omitted
flags. Explicit `--host`, `--profile` and `--key` override those defaults. Without
a public-key setting, the client uses `identity_file` plus `.pub` if that file
exists; it never guesses a public key from the SSH agent. Authentication can still
use your SSH agent when `identity_file` is omitted. Without a host setting, create
selects the sole host supporting the chosen profile; ambiguity or an incompatible
configured host requires an explicit `--host`.

```sh
clankerbox profiles
clankerbox create dev
clankerbox exec dev -- git --version
clankerbox ssh dev
clankerbox stop dev
clankerbox start dev
clankerbox fork dev experiment
clankerbox checkpoint create dev
clankerbox restore CHECKPOINT_ID recovered
clankerbox sessions dev
clankerbox labels dev team=core purpose=review
clankerbox events
```

Create/start/stop/delete/fork and checkpoint create/delete/restore wait for their
accepted operation, up to five minutes. `--timeout 10m` changes that positive
bound. Success prints the machine or checkpoint summary; deletes print the
completed operation. Failure, unresolved status, timeout or a lost operation read
returns nonzero with the known operation and resource IDs. A timed-out operation
may continue: inspect it before deciding to retry. Waiting never resubmits a
mutation. Stopped machines require an explicit `start`; connecting never wakes
them. Deletion requires a stopped machine. Runtime rules still apply: Mac
forks/captures require a stopped source.

Resource flags can appear before or after positionals, for example
`create dev --profile mac-xcode-v3 --host mac --key KEY.pub`. Global flags precede the
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
available for diagnostics. `exec MACHINE -- ARGV...` streams stdin/stdout/stderr,
requests no PTY, preserves literal arguments and returns the remote exit status.
Use `exec dev -- sh -c 'COMMAND'` when shell interpretation is intended.
`ssh MACHINE` opens an interactive shell. Raw exec/SSH/proxy streams are
unchanged by `--json`. `url` prints a plain URL; `--json url` prints the object.

Interactive `clankerbox ssh dev` holds automatic forwarding until SSH exits.
For standalone external SSH, SCP, Herdr or other TCP clients:

```sh
clankerbox ssh-config install
clankerbox connect dev                  # keep running while forwards are needed
# In another terminal:
ssh cb.dev
scp ./file cb.dev:workspace/
herdr --remote cb.dev                   # independently installed application
clankerbox ports dev
clankerbox url dev http://localhost:3000/
clankerbox connect dev --forward 127.0.0.1:5432
clankerbox vnc MAC_MACHINE --viewer
```

Aliases use the existing immutable-ID ProxyCommand transport. Ordinary external
SSH sessions need a separate `connect` for automatic local forwards. Each
`connect`, interactive CLI SSH, or VNC consumer keeps the shared owner alive for
its own lifetime; VNC exits when you stop its CLI command. Applications use the
reported local TCP addresses. All three binaries use urfave/cli for flag parsing
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

The machine CLI passed disposable Linux and Mac checks for default lifecycle
waiting, literal exec, interactive SSH forwarding and external SSH aliases.
Linux checks also covered standalone forwarding/SCP, async operations, timeout
recovery and checkpoint/restore; Mac checks covered stopped-source disk fork.
See the [execution record](docs/implementation-execution.md#machine-cli-acceptance)
for scope and limitations.

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

## Terminal sessions

Every prepared, running machine also carries `clankerbox-guest`, a session
daemon that owns terminal PTYs, the authoritative Ghostty VT state, and a
bounded output ring inside the guest, so a terminal survives every connection
drop, controller restart, and consumer restart. The controller keeps one SSH
link per ready machine using its own terminal key, which the guest accepts only
as the forced command `clankerbox-guest proxy`. Consumers reach the daemon
through `GET /v1/machines/{id}/sessions/stream` (HTTP upgrade
`clankerbox-session`), inspect `guest` status on the machine record, set
`labels`, and follow `GET /v1/events`. Deploy `bin/clankerbox-guest-linux-amd64`
and `bin/clankerbox-guest-darwin-arm64` under `<host root>/guest/` next to the
host helper; preparation installs the matching binary into each guest when its
digest differs. The protocol, contract, and failure matrix are in
[docs/terminal-sessions.md](docs/terminal-sessions.md). This feature has unit and
integration coverage with a fake guest sshd and a real daemon; it is not yet
live-qualified on the private controller.

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
6. Live-qualify terminal sessions: guest binary installation through the trusted
   exec channel on both platforms, the forced-command key line, link suspension
   across a fork, and consumer resume after a controller restart.

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

Managed coding-agent credentials and per-machine relays: [setup and usage](docs/managed-auth.md).
