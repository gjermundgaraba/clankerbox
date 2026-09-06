# Recommended build plan

Historical September 4 proposal. Superseded by the
[current release-one plan](recommended-plan.md). In particular, the workspace
resource, backup API integration and Vetu selection below are not current scope.

Recovery update (2026-09-06): [executed lifecycle tests](../spikes/recovery/RESULTS.md)
now support the newer pinned smolvm build for Linux live forks and portable RAM
checkpoints, with a supported disk-backed image profile and interrupted-operation
reconciliation. Cocoon is viable with a complete fixed-layout recovery bundle;
Tart remains the macOS path. The direct Vetu selection below is historical, not
the current recommendation. No production deployment has been performed.

Runtime-selection update (2026-09-05): this plan predates the explicit requirement
for concurrent Linux RAM forks. Its direct Vetu recommendation is no longer the
current runtime shortlist. Read the [RAM-fork investigation](concurrent-ram-forks.md)
before implementation; the retention, deployment and backup requirements below
remain relevant.

Status: proposed architecture following the September 4, 2026 spikes. No
production controller, VPN, worker service or backup integration has been
deployed. The experiments and their limits are recorded under [spikes](spikes/).

## Recommendation and decision

Build Clankerbox as a small API-first service controlling Tart and Vetu directly.
Run it on a dedicated Linux VM in personal-cloud. Use native host supervision
and retained VM disks. Do not put these workspaces under unmodified Orchard.

This changes the originally proposed Orchard topology and needs your agreement
before implementation. The reason is lifecycle correctness: Orchard worker
shutdown can delete disks, worker reconstruction does not adopt retained disks,
and failure recovery can create a new VM incarnation. A coherent retained-VM
fork spans at least seven areas, rather than a shutdown flag. See the
[Orchard reproduction](spikes/orchard-lifecycle.md).

| Approach | Assessment |
| --- | --- |
| Stock Orchard + wrapper | Reject for retained workspaces: a wrapper cannot make internal destructive recovery safe |
| Maintained Orchard fork | Viable engineering project, but owns API/schema, scheduling, disk ownership and both runtime reconstruction paths |
| Clankerbox + direct Tart/Vetu | Recommended: implement the required lifecycle once, using the existing runtimes and native supervisors |

Orchard should not also manage Clankerbox's retained disks. A second controller
with overlapping ownership would make recovery ambiguous.

## What the spikes established

| Investigation | Observed result | Important limit |
| --- | --- | --- |
| Orchard | Four upstream characterization tests passed on each of two pinned revisions, confirming incompatible lifecycle paths | Fake runtime exercises real controller/worker code; not a real-VM Orchard failure test |
| Mac/Tart | Real boot, guest exec, key SSH, same-disk stop/start, and launchd supervision surviving SSH exit passed | Existing logged-in user context; cold host boot and final network isolation untested |
| Linux/Vetu | Real amd64 boot, key SSH, Docker, systemd supervision, same-disk stop/start, and NoCloud public-key bootstrap passed | Prepared disposable image; strict first-contact host-key pinning and host reboot untested |
| Workspace backup | Encrypted local restic roundtrip preserved dirty Git state, modes/symlink and online SQLite export | REST/TLS/firewall integration and whole-workspace atomic consistency untested |
| Deployment/network | Existing VM, VPN, backup and monitoring patterns inspected; selective WireGuard design documented | No live VPN, controller or backup endpoint configuration changed |

## Product contract

1. **Explicit machine choice.** Request a versioned Linux/amd64 or macOS/arm64
   profile, resource size and SSH public keys. Never silently substitute OS,
   architecture or image. A capacity shortage is visible as waiting or rejected
   admission, not a smaller or different machine.
2. **Unlimited lifetime.** No TTL, maximum lease, scheduled recycling or automatic
   idle deletion. Stop retains the same machine and disk. Start resumes that
   disk. Updating an image affects new machines only.
3. **Workspace identity survives machine loss.** Keep a stable workspace ID and
   its backup repository separate from the VM incarnation. Initially one active
   machine owns a workspace; it may contain multiple repositories. Do not build
   shared multi-writer storage or automatic cross-OS workspace moves.
4. **Deletion is explicit.** Machine deletion requires an explicit destructive
   request and leaves backup history intact. Normal stop, service restart,
   connectivity loss and failed health checks cannot authorize deletion. Keep
   workspace backup history until explicit purge; retention must preserve a last
   good recovery point. No automatic deletion grace-period expiry is required.
5. **Herdr is a consumer.** Clankerbox exposes machines, operations, connections
   and recovery points. No panes, agents, sessions or Herdr-specific lifecycle.
   Guest tools can be installed in images and used through ordinary SSH.

## Service and host responsibilities

Use one controller process and SQLite, with an HTTP API and thin CLI client.
Go is a reasonable default for the service and cross-platform host helper:
standard HTTP/process facilities, one SQLite driver and the small transport
dependency needed for streaming. This is a proposed implementation choice, not
an existing codebase constraint. No Kubernetes, separate queue, plugin framework
or custom VM hypervisor is needed.

Expose the API only through private TLS ingress and require a revocable operator
API credential, stored hashed by the service. Keep it on authorized control
clients, never in guests. Do not assume the VPN authenticates individual API
requests. The existing clankerauth deployment documentation still carries a
placeholder image, so verify its live status before making it an authentication
dependency; a new identity-provider deployment is not required for this service.

The controller stores machine/workspace identities, pinned image/profile,
host assignment, desired state, last observed state/time, current operation,
SSH host identity and recovery-point references. Sensitive values stay in
protected runtime storage, not request logs or image metadata.

Long operations return an operation ID. Persist the intent and idempotency key
before contacting a host. Use a stable generated runtime name and reject reuse
of an idempotency key with different input. On an interrupted response, inspect
that exact VM and reconcile; do not clone again blindly. Serialize lifecycle
changes per machine and resource admission per host.

Keep the last accepted operation generation and deletion tombstones on the host
as well as in the controller. Reject stale commands. A restored controller DB
starts in recovery mode: reconcile host manifests before enabling mutations, so
an older backup cannot resurrect a deleted machine or replay obsolete intent.
Use a single active controller; do not add leader election or automatic failover.

Deploy a restricted SSH host helper on each host. Its commands accept validated
machine IDs and structured arguments, not arbitrary shell text. It owns only a
dedicated runtime home and native jobs. On Linux, narrowly authorize the required
KVM/network/supervisor operations. On macOS, use the validated user context and
document its login/keychain prerequisites. User clients never receive this
host-control private key.

| Operation | Required behavior |
| --- | --- |
| Create | Reserve resources, clone once, prepare identity, persist host manifest, supervise boot, verify guest readiness, enable backup |
| Start / stop | Operate on the same disk; explicitly disable restart supervision before stopping; stopped disks still consume storage |
| Controller restart or VPN loss | Existing guests continue under systemd/launchd; show host observation as unavailable/stale, do not replace guests |
| Host restart | Reconstruct inventory from durable manifests and disks; restore desired running jobs when host prerequisites are met |
| Host loss / workspace recovery | Explicit recovery into a new incarnation; fence or confirm the old owner stopped before allowing another writer |

Native jobs must honor desired state. `KeepAlive`/`Restart` can otherwise undo a
requested stop. Persist job definitions and intent for the real deployment;
transient jobs used by a spike do not prove host-reboot recovery.

An orderly stop should request guest OS shutdown through authenticated SSH or
the guest agent and wait for confirmed VM exit. The runtime stop command alone
was not proved to flush arbitrary applications. Record an unresponsive guest as
a failed/stuck stop; expose force-off as a separate explicit action. Disable
automatic restart before requesting guest shutdown.

Expose authenticated per-machine SSH/VNC forwarding through the API. A thin CLI
can act as an OpenSSH ProxyCommand. Resolve the guest address on the host and
restrict forwarding to the requested machine's approved ports. Pin the guest
SSH host key through trusted bootstrap; do not solve ephemeral addressing by
disabling host-key verification. Guests need no individually routed public IPs.

## Images, access and capacity

Keep image recipes and profiles here, pinned deployment digests in personal-cloud.
Build separate Linux development and macOS/Xcode images. Install the guest user,
SSH, development tools and backup prerequisites without operator credentials.
Generate per-instance host keys and inject caller public keys. Reusable default
passwords must not remain in the finished image or a ready machine.

Tart's tested guest agent provides a public-key bootstrap path. Vetu's stock
image disables cloud-init datasources. The Linux spike proved a prepared version
with NoCloud enabled: `vetu create` accepted the base disk plus a seed disk, and
cloud-init created a new user with the supplied public key and password login
disabled. Turn that preparation into a reproducible, sanitized image recipe;
the disposable candidate was not a production image build.

For a NoCloud-prepared Linux image, generate an instance-specific SSH host key in
the trusted provisioner and supply it through the protected seed's `ssh_keys`
configuration, alongside the caller's public key. The controller then knows the
server identity before first contact. This is supported by
[cloud-init's SSH module](https://github.com/canonical/cloud-init/blob/main/cloudinit/config/cc_ssh.py);
verify it with strict host-key checking in the image acceptance test. Treat the
seed as instance-secret material, never as part of a reusable published image.

Put agent/repository authentication outside the backed-up workspace and image.
The caller may inject/renew it through authenticated SSH. Clankerbox need not
become a general-purpose secret broker. It does own the narrow provisioning and
per-workspace backup credentials it requires. Restores require reauthentication.

Use resource profiles with configurable host budgets, leaving headroom for
existing Mac services. The Mac had roughly 210 GiB free and an existing cached
Xcode image, so image download/host cleanup is not a prerequisite for beginning
implementation. Account for APFS clone growth, retained stopped disks and image
cache usage, not just initial copy-on-write size. Do not promise more concurrent
macOS guests than hardware, host headroom and applicable licensing allow.

The Vetu multi-disk `create` path used for the NoCloud experiment copied the
20 GB logical base into roughly 19 GiB of allocated storage. Budget for that
per-instance cost; do not extrapolate cheap Tart/APFS clones to the Linux host.

Keep FileVault enabled. The recommended operational default is that an unexpected
cold Mac boot may need your unlock/login before macOS guests become available.
Show that as a host prerequisite in the API. No unattended cold-boot guarantee is
made; validate the exact production launch context and do an authorized reboot
exercise before documenting recovery as complete.

## Network and backup

Use the selective WireGuard design in the
[network investigation](spikes/deployment-network.md). The controller reaches
Hetzner SSH privately; guest backups have one explicitly allowed storage
destination. Mac control uses an explicit local inter-VLAN rule. Keep guest NAT
and enforce denials of host services and private networks outside the guest,
including IPv6. VPN connectivity is not permission to reach the whole home LAN.

Back up hourly with encrypted restic repositories, one per workspace, using the
existing append-only TLS rest-server pattern. Use systemd timers in Linux guests
and launchd scheduling in macOS guests. Keep a final-backup attempt before an
orderly stop and report failure; a force-stop is separate and explicit. Back up
the controller database using its online export mechanism as well.

Include the working tree, Git metadata, uncommitted/untracked work and explicitly
selected portable tool state. Exclude credentials and regenerable caches.
Export known SQLite stores with the online backup API. A normal live file backup
is best-effort across concurrent writers; do not claim a transactionally atomic
workspace snapshot. Stronger consistency needs an explicit quiesced checkpoint
or application-specific export, not a mandatory pause of every agent each hour.

Start with the existing retention pattern: 24 hourly, 14 daily, 8 weekly and
12 monthly snapshots, with pruning only from trusted maintenance. Preserve a
last good recovery point for retained/deleted workspaces until explicit purge.
Set capacity/freshness alerts; append-only access does not prevent quota
exhaustion. Each guest can read its own history, never another workspace's or
administrative prune credentials.

Hourly successful backups mean roughly an hour of possible loss if the host disk
is destroyed; outages, scheduling delay and failures extend that window. Retained
disks protect normal stop/start. Neither mechanism preserves running processes
after a host crash. See [backup evidence and restore procedure](spikes/workspace-backup.md).

## Build sequence and acceptance

1. **Implement retained lifecycle and identity.** Controller records, idempotent
   operations, restricted host helpers and persistent native jobs. Verify create,
   stop/start, lost acknowledgements, duplicate requests and controller restart
   all preserve the same disk. No automatic replacement on stale inventory.
2. **Prepare images and access.** Prove per-instance public-key bootstrap and
   host-key verification on both OSes. Add SSH/VNC connection plumbing, explicit
   profiles and admission. Test actual development workloads and Docker inside
   the Linux guest where required; no host Docker socket exposure.
3. **Deploy infrastructure through personal-cloud.** Dedicated VM, versioned
   services, WireGuard, exact firewall flows and separate backup accounts.
   Validate guest egress denials as well as successful access; do not treat a
   successful tunnel ping as the isolation test.
4. **Integrate hourly recovery.** Perform a real encrypted REST/TLS backup and
   restore into a replacement guest, including dirty Git state. Verify credential
   isolation, controller-DB recovery and freshness alerts. These were not proved
   by the local backup roundtrip alone.
5. **Exercise failures before handoff.** Controller and supervisor restarts,
   network interruption, host reboot, disk-full/provisioning failure and explicit
   deletion. Verify that uncertainty never deletes or replaces disks. Mac cold
   boot testing requires a scheduled opportunity because existing services and
   FileVault are present.

These are implementation dependencies and completion tests, not separate reduced
products or lease restrictions. The intended result includes weeks-long machines,
preserved workspaces and the small orchestration service from the outset.
