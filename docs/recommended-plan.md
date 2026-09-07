# Clankerbox release-one implementation plan

Updated September 7, 2026 after the owner approved pragmatic fork preparation.
This is an implementation plan, not a deployed service or a claim that all
acceptance tests have passed. The [README](../README.md) records spike evidence
and its limits. The [earlier plan](historical-build-plan.md) is historical.

## Agreed scope

- Release one covers Linux and macOS. Design and exercise the shared API against
  both early; capabilities differ rather than being silently emulated.
- Owner-only, API-first machines. Applications such as Herdr are independent
  consumers, not bundled dependencies or release gates. No application launchers,
  agents, panes or application sessions in the Clankerbox domain.
- Go controller and cross-platform helpers, SQLite, HTTP API and thin CLI. One
  active controller; no HA, queue service, plugin framework or custom hypervisor.
- Pinned smolvm for Linux, Tart for macOS. Maintain the smolvm fork at
  `/Users/example/ws/pers/not-mine/smolvm`; inspect and reconcile existing patches
  before editing. Record the exact CLI/libkrun/guest-agent/profile combination.
  Cocoon is not part of this implementation. Keep a small runtime boundary, not
  a speculative adapter framework.
- Machines can live for weeks. No TTL, maximum lease, automatic idle deletion
  or implicit replacement. Stop retains disk; start cold-boots that disk.
- Explicit recovery and pragmatic failure handling, not automated failover.
- File backups are operational infrastructure, not a Clankerbox product/API.
  Runtime checkpoints remain product features.

## Resources and identity

Three durable public resources:

| Resource | Contract |
| --- | --- |
| Machine | Specific VM with fixed OS, architecture, profile version and host assignment; mutable lifecycle and writable disk contents |
| Checkpoint | Immutable published RAM or stopped-disk capture, with compatibility metadata and storage dependencies |
| Operation | Durable asynchronous intent and outcome, including information needed to reconcile interrupted execution |

Hosts and versioned profiles are configured infrastructure with read-only
discovery. Initially a machine owns its disks and a conventional workspace
directory containing any number of repositories. No separate workspace API,
detachable volumes, shared writers or cross-OS moves.

Create assigns a new machine identity. Fork/branch assigns a new machine,
independent writable contents and SSH identity, with ancestry recorded.
User-authorized login public keys may be reused; guest SSH host keys are replaced
before publishing the child's connection target. Generalized credential rotation
and backup preparation hooks are deferred. Do not provision per-machine backup
jobs or credentials into forkable guests until independent operational ownership
is implemented outside the product API.
Restore creates a new machine, never overwrites an existing disk. Intentional
branching permits siblings; replacement recovery requires fencing or confirmation
that the old owner is stopped. It must not reuse the old SSH identity or retarget
existing connections. Application credentials can remain in captured state.
User-friendly names resolve to immutable IDs;
SSH trust and connection ownership use IDs, not reusable names alone.

Deleting a machine does not implicitly delete descendants or checkpoints.
Backing files are released only when no retained object depends on them.
Checkpoint deletion is explicit. External file-backup history is outside these
deletion operations. Uncertain inventory never authorizes deletion.

## Capabilities and API

| Capability | Linux / smolvm | macOS / Tart |
| --- | --- | --- |
| Retained-disk stop/start | Required | Required |
| Live RAM fork | Required on supported profile | Unsupported |
| Persistent RAM checkpoint | Required with explicit compatibility | Unsupported |
| Stopped-disk checkpoint/branch | Not initially promised | Required |
| SSH and automatic development TCP forwarding | Required | Required |
| VNC | Only if a profile provides it | Required for desktop profile |

These are release targets. Report capability separately from prerequisites:
machine state, host availability, resources and checkpoint compatibility.
Never silently substitute OS, architecture, smaller size or cold boot for RAM
restoration. Insufficient capacity is rejected initially, not queued.

The versioned API supports discovery; machine create/list/inspect; start, orderly
stop and separate force-off; live fork; checkpoint create/list/inspect/delete;
restore to a new machine; explicit machine deletion; operation inspection; and
authenticated machine connections. CLI commands wrap these APIs. No file-backup
status, request-backup, backup-history purge or workspace-resource endpoints.

Mutations return operation IDs and accept idempotency keys. Persist intent before
host contact; reject key reuse with different input. Polling suffices initially.
Use distinct errors for unsupported capability, unmet prerequisite, capacity and
unavailable host. An interrupted operation may remain unresolved until host
inspection; do not label it failed and blindly retry its side effects.

## Connections: user experience and ownership

Illustrative commands (final spelling is not committed):

```sh
clankerbox ssh-config install
clankerbox connect dev-linux
herdr --remote cb.dev-linux
ssh cb.dev-linux
scp ./patch.diff cb.dev-linux:~/workspace/
clankerbox vnc dev-mac
```

The SSH config uses a Clankerbox ProxyCommand. The client authenticates to the
private Clankerbox API, which relays only the selected guest's SSH service via
the restricted host helper. Users never receive host-control keys or need guest
IP routing. Guest SSH authentication remains ordinary OpenSSH: caller private
keys stay local, and trusted provisioning establishes the expected guest host
key. Connecting does not implicitly start a stopped machine.

Resolve aliases once per connection acquisition and pin controller identity,
machine ID and login for reconnect and SSH trust. The API accepts
machine ID plus a fixed SSH service selector, not arbitrary addresses or ports;
the helper resolves only the prepared execution from trusted inventory.

`connect` maintains a local machine connection, discovers development listeners
and automatically forwards them to loopback on the user's computer. Prefer the
same local port; if occupied, allocate another and expose the actual mapping.
Do not silently connect to another local service. Run `connect` separately while
applications need forwarding; Clankerbox does not launch or manage them.
Multiple consumers should share a local connection owner; releasing one consumer
must not tear down another's tunnels. Keep this client-local, not a new durable
controller resource. Choose the smallest lifecycle implementation during the
connection milestone.

The local owner holds listening sockets across SSH outages and reports unavailable
mappings rather than releasing them. A mapping identifies one machine and guest
endpoint, not a particular server process. Keep a small allocation ledger so an
owner restart does not automatically reassign an issued endpoint to another
machine. Explicit reset/release abandons that reservation. Publish only after a
successful bind; expose exact numeric loopback addresses to avoid IPv4/IPv6
ambiguity. An occupied reserved endpoint fails visibly rather than silently
remapping. Use private local IPC and consumer handles; applications can retain
their own SSH masters, whose shutdown must not terminate the forwarding owner's
transport.

This prevents automatic Clankerbox retargeting, not arbitrary local port reuse:
after owner failure or explicit release, an unrelated process can bind that port.
Stale bare-localhost URLs are not guaranteed safe in that case. Stronger identity
for arbitrary TCP would require a different protocol/endpoint contract.

Use SSH forwarding channels initially for arbitrary TCP, including guest-loopback
listeners. HTTP, WebSockets/HMR, HTTPS bytes and VNC need no separate protocol
proxy. TLS trust remains the client's responsibility. No UDP, public preview
sharing, response rewriting or transparent preservation of existing TCP streams.
Applications hard-coding absolute localhost URLs may need configuration when
ports are remapped.

Discover listening sockets inside the guest rather than scraping terminal text.
Support Linux and Mac loopback/wildcard listeners and their address families.
Exclude infrastructure services such as SSH from automatic development exposure;
open VNC explicitly. Discovery is machine-scoped, never a way to connect to an
arbitrary host/LAN address. Define the minimal inclusion/exclusion policy and
listener-disappearance behavior in the connection milestone. Forwards bind only
to local loopback. Allow an explicit port mapping for discovery exceptions.

Treat discovery as untrusted socket data, not destination instructions. Automatic
and explicit forwards dial only numeric guest loopback (`127.0.0.1` or `::1`);
wildcard listeners are reached via loopback. Configure sshd local TCP forwarding
with corresponding PermitOpen restrictions; disable unused reverse and Unix
socket forwarding. Shell users can run proxies, so these restrictions supplement,
not replace, external guest egress isolation. Application protocols carried over
SSH stdio need no SSH Unix socket forwarding.

VNC opens a local tunnel and optionally launches a native viewer; also offer
tunnel-only usage. Keep credentials out of URLs and logs.

The local client owns forwards and mappings. The controller owns authenticated
machine access. Guest/host plumbing provides reachability and listener discovery.
Applications own their sessions, presentation and click handling. They may use
ordinary SSH aliases and the generic `ports`, `url` and `open-url` interfaces.
Clankerbox maps guest-local URLs while preserving path/query/fragment and can
open them locally, but does not modify application protocols or intercept clicks.
The Herdr command above is an example of an independently installed SSH consumer;
its installation, builds and tests are not Clankerbox requirements.

Controller or network outages may disconnect relayed streams; guests continue.
Reconnect restores forwards, not old TCP connections. Applications implement
their own session reattachment; plain SSH shell persistence is not promised. Neither
fork nor RAM restore promises continuing external TCP/TLS connections or
exactly-once external side effects.

## Host lifecycle, images and recovery

Controller records include pinned profile, desired/observed state, observation
time, host, operation and checkpoint references. Helpers retain durable manifests,
operation generations and deletion tombstones. Serialize mutations per machine
and admission per host. Inspect exact runtime names after lost acknowledgements.
A restored controller DB enters reconciliation mode before accepting mutations;
do not replay stale intent over newer host facts.

Use persistent systemd/launchd supervision that honors desired state. Disable
restart before orderly stop; report unresponsive shutdown and offer separate
force-off. Supervision must not turn unexpected VM exit into an unannounced cold
boot. After crash/reboot, inventory retained resources and report explicit start
or restore choices. No automatic migration or recovery-point selection. Keep
FileVault enabled; Mac unlock/login may be an explicit host prerequisite.

Interrupted smolvm capture needs operation-aware reconciliation: the spike left
a source paused after killing SAVE. Identify the active operation and runtime
phase before resuming or publishing anything. Never resume every paused VM.
Define checkpoint success only after its complete artifact/dependency bundle is
durably published; incomplete staging must not appear restorable. Preserve
compatible runtime versions and record CPU/profile requirements. Local durable
checkpoints do not protect against loss of the host disk; off-host RAM replication
is not a release-one feature.

Build sanitized Linux development and Mac/Xcode images with required tools and
trusted identity bootstrap. The supported smolvm `ubuntu-bare-v1` uses its guest
agent as init: do not inherit the old systemd-in-guest design unexamined. Prove
the actual agent/tool workload on this profile, including required Docker use.

Fork/restore preparation persists the child identity before launch, installs fresh
SSH host keys using host randomness, and publishes a connection target only after
identity preparation succeeds. Reuse existing operation and manifest handling;
interrupted or unknown preparation remains unresolved for explicit operator
inspection, with no published connection target. Do not build automatic repair
or a separate multi-stage preparation protocol.

For this owner-only version, inherited processes may run and contact external
services before preparation completes. This is an accepted limitation, not a
claim that readiness gating isolates traffic. No first-instruction network
quarantine or guarantee against duplicated external effects is promised. Normal
guest isolation from hosts/private networks remains required. Reconnect transports
as needed; do not build generic TCP repair, application-specific reset machinery,
a secret broker or backup hooks.

RAM/disk checkpoints contain secrets despite file-backup exclusions. Protect
artifacts as machine-secret material. Application credentials and ancestor secrets
may remain recoverable from captured RAM; SSH key replacement does not sanitize
it. Account for retained disks, checkpoint dependencies and clone growth under
resource pressure, not just initial copy-on-write allocation.

## Deployment and operational backups

This repository owns service/helper code, image recipes, profiles and acceptance
tests. `personal-cloud` owns controller VM deployment, provisioning, secrets,
private ingress, WireGuard/firewall policy and backup integration. Use the
[network investigation](spikes/deployment-network.md) as a starting point, not
as proof of deployed routes or permission to change shared infrastructure.

Require revocable API authentication even over VPN. Keep operator credentials out
of guests. Enforce guest denial of host services and private LANs outside guests,
including IPv6; SSH forwarding must not bypass that isolation. No host Docker
socket exposure. Reboots and deployment mutations require explicit authorization.

Hourly file backups remain an operational goal using existing tooling, without
controller scheduling or backup resources. Start with workspace files/Git and
explicit exclusions; select additional tool state only for concrete needs. No
whole-home or cross-file atomic consistency promise. Operational provisioning
must distinguish forked machines and replace inherited backup credentials before
enabling their backup jobs. Back up controller records independently. Define
retention, restore and freshness monitoring in `personal-cloud`; machine deletion
does not purge that history or wait for an integrated final-backup workflow.

## Implementation milestones and acceptance

1. **Shared contracts and skeleton.** Go service/CLI/helpers, SQLite resources,
   capabilities, errors and idempotent operations. Contract fixtures cover both
   platforms, incompatible requests and duplicate/lost acknowledgements.
2. **Retained lifecycle on both platforms.** Reproducible images, create/start/
   stop, manifests, supervision and trusted SSH identity. Dirty Git/untracked
   files survive stop/start; controller/helper restarts do not replace machines.
   Per the owner's implementation direction, networked fork preparation belongs
   to milestone 4, not a preliminary proof gating milestones 2–3. Ordinary guest
   isolation remains part of the live connection deployment.
3. **Complete connection workflow on both platforms.** ProxyCommand SSH/SCP,
   generic SSH stdio transport, automatic guest-loopback dev TCP forwarding and Mac
   VNC. Test dynamic listener arrival/removal, two machines on port 3000, occupied
   local ports, local URL opening with remapping, WebSocket/HMR, multiple consumers,
   reconnect and cleanup. Verify forwards are loopback-only and machine-scoped;
   exercise stopped/unavailable hosts and strict host-key verification.
   Reassign an alias during disconnection: existing connections stay pinned or
   fail. Exercise owner restart, occupied reserved endpoints and IPv4/IPv6.
   Attempt forbidden destinations via discovery, explicit and raw SSH forwarding.
4. **Forks, checkpoints and restore.** Actual Linux agent/tool workload on pinned
   portable profile; continuing processes with transport reset, independent child
   identity/disks and checkpoint restore without original processes. Mac stopped
   disk branches diverge. Test ancestor/checkpoint deletion dependencies,
   incompatible artifacts, interrupted capture and independent connection targets.
   Verify interrupted or uncertain preparation does not publish child access and
   leaves a visible unresolved operation for manual inspection. Restore the same checkpoint twice
   and verify independent disks, machine IDs and host keys. Early child traffic
   and inherited application credentials remain documented limitations; strict
   quarantine, generalized rotation and automatic interrupted-stage recovery are
   deferred.
5. **Private deployment and operational protection.** Authorized personal-cloud
   rollout; allowed/denied network paths, operational encrypted file backup/restore
   with dirty work, independent fork backup ownership and controller-DB recovery.
   Do not introduce a backup API to accomplish deployment acceptance.
6. **Failure acceptance and handoff.** Authorized host reboots, network loss,
   disk/memory pressure, interrupted operations, explicit deletion and stale DB
   recovery. Uncertainty never deletes/replaces disks or silently cold-boots a RAM
   restore. Document manual recovery and evidence limits; short tests do not prove
   weeks-long credential or retention behavior.

Bounded implementation decisions: exact endpoint/command spelling, minimal
listener policy and local connection ownership, real-agent fork preparation, and
operational backup selection. Resolve these within their milestones rather than
reopening runtime selection or adding speculative subsystems.
