# Real local development implementation record

This is the implementation and qualification record for
[the agreed plan](real-local-development-plan.md). Release [0.2.1](https://github.com/gjermundgaraba/clankerbox/releases/tag/v0.2.1)
is published from signed commit `b7db763e729f26fe8654f6621b39868617f902b7`.
Both required installed dev platforms and the production Linux/Tart/Desk topology
passed qualification. Deployment, retained-state audit and managed SSH retirement
are complete; older candidate records below are historical qualification evidence.

## Implemented boundaries

The ordinary generated Connect MachineService and SessionService serve both
installed development and production clients. The controller retains public
admission, desired state, reservations and operation records. A separately
supervised HostService owns accepted execution, engine journals, root guest
bootstrap and authenticated guest access. GuestService wraps the authoritative
PTY/Ghostty session manager. Its typed bidirectional stream preserves ordered
input/resize acknowledgements, atomic snapshot/resume cuts, bounded chunks,
64-bit offsets, final views and slow-viewer isolation.

Host-held transport authority stays outside guest snapshots. Trusted native exec
rebinds copied guest identity without restarting its manager or live PTYs.
Workload sessions use an explicit unprivileged UID/GID; root-only daemon state,
keys and admin socket remain inaccessible to workloads.

`clankerbox dev` starts ordinary controller and host binaries from an adjacent
verified bundle. It publishes one connection manifest and derived CLI/Desk
configs, creates no seeded machine, and supports independent project roots.
Ctrl-C retains host/VM processes. Explicit stop/destroy use ordinary lifecycle
admission, journal accepted teardown operations and respect backing dependencies.
Compatible explicit bundle upgrades preserve engine/image/profile pins and live
VMs; incompatible pins are rejected.

Bundle format 2 authenticates files, literal relative symlinks, directories and
POSIX modes. Semantic runtime/image hashes include metadata and exclude install
paths. Generic Ubuntu/Node images contain no workstation identity or guest SSH
service. Compressed disk templates expand only in owned runtime caches. Release
assembly checks the qualified engine, agent and patch hashes, includes notices,
and produces self-contained archives with checksums. macOS development bundles use ad-hoc signatures; these are not Developer ID
notarized releases. The production Tart host uses a stable Apple-issued signing
identity, embedded usage description and an explicit per-user Local Network grant.

## Platform and transport evidence

| Target / topology | Qualified behavior | Status |
|---|---|---|
| macOS arm64 → smolvm Linux arm64 | Native retained lifecycle, RAM fork with independent memory/disks, portable RAM restore after source deletion, root/unprivileged boundary, real Desk terminal, live shell across controller/host replacement | Complete |
| Linux amd64 → smolvm Linux amd64 | Installed and production retained lifecycle, RAM fork/capture/two restores, independent cold disks, isolated environments and real Desk browser viewers | Complete |
| macOS arm64 → Tart macOS arm64 | Signed production host; public TLS sessions, retained cold disks, stopped disk fork, capture/source deletion/two restores, independent disks, explicit running-copy rejection and complete cleanup | Complete |
| Node/Go → HTTP/2 h2c, Unix and TLS | Full bidi before request EOF, 8 MiB chunked snapshots, offsets above 2^53, bounded slow reader, cancellation and negative trust/identity | Complete |
| Actual edge Caddy 2.11.4 → production controller/host/guest | Verified public TLS, 64 MiB bidi output, independent stalled-viewer disconnect, ordered controls, cancellation/resume and actual Desk browser/restarts | Complete |

The Linux real-browser test uses two Chromium contexts through the actual built
Desk Node server, an operator SSH byte-forward of the public loopback controller,
and the real installed controller → host → guest RPC path. It uses no VM or
session fixture. Both viewers retained shell PID 3118 through resize, reload,
Desk restart and controller restart, and exchanged fresh keyboard input and files.
The earlier macOS native-browser pass retained PID 2866 through Desk restart.

The complete Linux installed lifecycle/checkpoint suite passed, including RAM
fork, backing-dependency rejection, capture followed by source deletion, two
RAM-continuing restores with fresh machine IDs, checkpoint deletion, independent
restored disk contents through cold starts, and ordinary operation cleanup.
Its final checkpoint report contains 49 events and no pending operation.
The fresh macOS installed suite also passed without operator recovery: lifecycle,
RAM fork, capture/source deletion, two RAM restores, checkpoint deletion,
independent cold starts and final cleanup. Both restored instances continued
capture PID 2808 and its in-memory token. All five prior macOS qualification
environments and their owned native jobs were removed; unrelated VMs remain.
Operator SSH used to install artifacts or carry the loopback public bytes is
separate from the removed managed control hops.

A separate macOS live session retained PID 3254, its incarnation and shell
variable through host/controller replacement, RAM fork and portable restore after
the source VM was deleted. A post-restore supervision bug initially left the
restore unresolved; exact-ID operator reconciliation rebound the already-live
manager without replaying restore. The fresh complete acceptance run passed the corrected path.

Detailed evidence and executable commands live in
[engine qualification](../spikes/real-local-engine/README.md),
[RPC qualification](../spikes/real-local-rpc/README.md),
[guest qualification](../spikes/real-local-guest/README.md),
[proxy qualification](../spikes/real-local-proxy/README.md), and
[installed/Desk qualification](../spikes/real-local-installed/README.md).
Private evidence contains operational paths and is not a release payload.

## Validation and fixes found by real execution

The complete Go build, race suite and strict lint passed. Python harness tests,
reproducible protocol regeneration, generated SDK checks/build/tests and Desk's
Vite+ ready pipeline passed. The Desk pipeline includes 107 server tests and seven
browser tests; its fixture tests are distinct from the actual VM browser pass.
Actual TLS tests reject expired guest and host certificates; live rebind rejects
old machine identity and closes inherited attachments.

Real qualification caught and corrected missing host identity propagation,
macOS atomic file-open contention, Linux Unix-socket path limits, writes into
installed runtime templates, archive permission loss, and a Linux supervisor
command incorrectly issued after macOS RAM restore. Bundle metadata verification
now rejects the permission-loss case before VM creation. Cleanup additionally
exposed stopped-stop admission and accepted checkpoint-deletion recovery cases;
both fixes passed fresh complete native suites. Archive acceptance additionally
caught dotted-version filename collisions and Apple tar Unicode symlink
normalization; packaging now preserves complete platform filenames and literal
link bytes, with regression tests.

An early isolated Caddy test inadvertently wrote its test config to Caddy's
shared autosave and initiated storage maintenance. Autosave was atomically
restored from authoritative live configuration; live configuration and process
were unchanged. The storage-maintenance effects were not fully inventoried.
Subsequent tests disabled persistence and used separate storage, with unchanged
production config/autosave/process verified. See the proxy evidence for the
incident and repair; the initial test is not described as fully isolated.

## Source removals and companion repositories

Removed the process-backed local dev runtime and `_dev-guest`, managed SSH
transports and forced-command host entry script, guest SSH bootstrap, REST and
HTTP-upgrade routing, custom terminal framing, and handwritten wire clients.
Generated Go/TypeScript contracts replace cross-language framing definitions.
Activity/foreground/report metadata and controller events/SSE remain absent.
Controller/host journals, session semantics and operator SSH remain intentional.

Clankerdesk now consumes the exact generated SDK through Node HTTP/2 while
retaining workspace allocations, terminal mirrors, catalogs and browser
WebSockets. The vendored SDK archive is SHA256
`e0f0fb40a37ce599104183398348a848101ecbf81d12a2a955bbe426865f3591`.
The qualified apt inventories and complete installation dependency closures are
exact-pinned for both image architectures in `images/package-locks`; read-only
checks match the exported images and actual dpkg state.
New RPC dependencies and code generators are exact-pinned; Node is 26.8.2 and
pnpm is 12.4.1. The engine source commits, qualified patch and native binary
hashes are recorded in [engine pins](../spikes/real-local-engine/pins.json).

Personal-cloud contains role-specific TLS/service/firewall staging, verified
artifact staging, consistent SQLite backup helpers, exact-ID retained profile
migration, and typed validation commands. Live configs and services have moved to the generated RPC deployment;
public native lifecycle and browser checks passed. The active idle test machine and
unmanaged orphan were inventoried separately; the orphan is excluded from
migration. A nonterminal host operation targets that orphan, so the new host
configuration explicitly quarantines its exact ID before startup. The migration
guard checks its journal bytes, native PID start time and boot identity without
rewriting it. The pre-cutover Mac inventory contained only deleted machine records and no
nonterminal operations. Candidate3 artifacts and role credentials were staged
and independently verified on all four hosts, including Mac signatures.
The active machine's completed cold transition preserves IDs and disks
and makes no RAM-continuity claim. No production database or VM has been reset.

## Source size and delivery

Compared with the reviewed baseline, handwritten Go under `cmd` and `internal`
(excluding tests) grew from 12,976 to 17,090 lines (+4,114); tests in those trees
changed from 8,767 to 8,686 (-81). Generated Go adds 7,537 lines, generated
TypeScript 2,900, and Protobuf 441. The retired JSON wire definitions remove
544 lines. These counts intentionally exclude Python, documentation, spikes and
other test helpers; the architecture trades old transports for real supervision,
identity, packaging, and durable host service ownership.

The release is published. Production backups, fenced migration, live deployment
verification and retired transport cleanup are complete. Signed Clankerbox source
is pushed and Clankerdesk signed source/image CI passed. The canonical 1Password
Environment now works; the initially reported
missing UniFi key was a transient read result, not an absent key.
The isolated Tart system service passed after the user granted Local Network
access to the explicitly signed `org.clankerbox.host` executable. A system daemon
running as `gg` is not exempt from that permission: the earlier exemption claim
was incorrect. Host replacement preserved live sessions and the permission grant.
A fresh cold cycle exposed and then verified a bounded read-only guest-agent
readiness wait; no bootstrap mutation is retried by that wait. Tart restart,
resize/resume, retained disks, new cold incarnation and LOST old sessions passed.
The exact controller-to-Mac RPC firewall allow is installed. Both production
hosts, the retained Linux VM, public RPC ingress and Desk are now running. The
final installed Mac host required a separate Local Network grant; after that
grant, its original pending create reconciled successfully without a duplicate VM.
No qualification gap is represented as a deployed support claim.

Historical candidate archive hashes and final deployed revisions are recorded
separately below.

## Candidate archive pins

These are local, uncommitted-source qualification candidates, not published
releases. Both contain manifest format 2 and bundle version `0.2.0-rc.5`.

| Platform | Archive SHA256 |
|---|---|
| darwin-arm64 | `8f5d4029d03e28128166cd1bf5533e2a2ee565504026c1760a9821d4123e9c47` |
| linux-amd64 | `490671134bebca1cdbbd193abf0fccbc1802b34cf14a95382bc16e519d47c50e` |

The platform semantic runtime/image pins are unchanged from the complete
native suites. The macOS archive additionally declares binary PAX header
encoding so Apple tar preserves literal Unicode symlink targets. The checksum
files sit beside their archives in `.work/real-local-release/`.

The Linux rc5 archive passed a fresh private extraction and ordinary `dev`
startup with `PATH=/usr/bin:/bin` and no Go/Cargo/Rust toolchain available. Its
real lifecycle/session check retained dirty Git state, untracked files, modes and
symlinks across cold start, rejected access while stopped, and observed a new
guest incarnation. The final machine inventory was empty, `dev destroy`
succeeded, and the preexisting production host PID was unchanged. Evidence:
`.work/linux-rc5-consumer-smoke/evidence/`.

The corrected macOS rc5 archive likewise passed ordinary installed startup and
the complete lifecycle/session check (11 events, `passed`, `cleaned: true`),
using the archive's adjacent CLI/controller/host/guest/runtime/image payload.
It retained dirty Git, file/mode/symlink state through cold start and rejected
stopped-session access. The test-only session adapter was prebuilt separately;
no product toolchain ran during installation. Evidence:
`.work/real-local-release/mac-rc5-{consumer,lifecycle}.json`.

## Initial published release 0.2.0

Both final 0.2.0 archives passed checksum verification, clean extraction with no
warnings, adjacent-manifest validation, installed `dev` readiness with no Go/Rust
on PATH, empty initial inventory and complete environment/service cleanup.
The actual full lifecycle/checkpoint and browser contracts above qualify the
unchanged runtime/image identities. GNU archive headers preserve literal Unicode
links without Apple normalization or GNU tar PAX warnings.

| Platform | Published archive SHA256 |
|---|---|
| darwin-arm64 | `f4ab139fa8eab01e0a632a8b12d08b6f0e0c8ae9ae5121c3888e3f144e69c214` |
| linux-amd64 | `cca239bd0e83a126a6b649aa8bcf9db2aca41fa90a9805076a41c465d365a4a9` |

All eight uploaded assets matched local sizes and SHA256, including checksums
and corresponding libkrun/libkrunfw/kernel source archives. Final consumer evidence
is `.work/real-local-release/mac-shipping-consumer.json` and
`.work/linux-shipping-consumer-smoke/`. Clankerdesk's signed commit
`f7d566982209b5b6b04e41f1a8e7874ec1688375` passed quality and image CI; its
published container digest is
`sha256:e879e1fd7ab618d0e5d3b80cf72f2904ad0b4d7a0a56819308670440a3910d4d`.

## Completed production cutover — 2026-09-13

The public Clankerbox RPC route, controller and Desk are live. All four consistent SQLite backup sets passed integrity checks, with
separate verified controller/private-state and Desk ancillary archives. The exact
active VM was gracefully stopped and its complete sparse native store copied and
verified before native changes. Audit attempt: `rpc-20260913-cutover-final`.

The bounded controller and Linux-host metadata stamps added retained image pin
`498c31d409a93ab9a07fb2664650d4a2004f58a570d033d9a9e25cf95ef38f64` only to
machine `ad8cd000ed13c8996c30fe8a7eace330`, preserving other rows, operation
fingerprints and tombstones. That same machine/generation 3 now runs through
port 22202 → guest 7443. Managed guest SSH is retired; root daemon and
unprivileged UID/GID 32001 checks passed, including a second cold boot. Original
workspace directories remain empty. Native startup grew the existing disk files
in place to their declared 4/16 GiB sizes; original inodes and birth dates were
retained. This is disk retention and a controlled cold transition, not RAM or
byte-for-byte disk continuity.

The Linux host service is active and controller-to-host mTLS/HTTP2 description
and guest routing passed; missing client credentials and an untrusted server CA
were rejected. Orphan `3170fea0cfbb72c9d7bb74d5d75b940b` remains running,
quarantined and unchanged. Its live disks were deliberately not copied as a
purported consistent backup.

Mac candidate5 signed host, guest, profile pins and role credentials are promoted
with preimages saved. The user completed production system-service installation.
The listener required the explicit `https://` URI scheme; that correction is
backed up and audited. The installed `org.clankerbox.host` executable then required
a Local Network grant at its final path, `/Users/example/clankerbox/bin/clankerbox-host`.
The grant was verified by reconciling the same pending create operation and guest
TLS connection, without another create or VM. The production Tart lifecycle and
full supported disk fork/checkpoint/restore suite passed. All four owned test machines and their checkpoint were deleted;
the pre-existing seed configuration/disk/NVRAM inode, size, mode and mtime
match the preflight. Tart access metadata advanced normally during cloning.

Both host identities and public RPC routing passed. Desk image `f7d5669` is live,
and all pre-existing rows in its 13 SQLite databases matched the pre-release
snapshot. The public two-viewer browser/restart, streaming and complete Linux RAM
checkpoint checks passed. Exact inventoried managed host SSH retirement and the
final preserved-state audit passed. Operator access and the unrelated native
orphan are retained.

Do not restart the old controller/Desk against the new guest protocol as a
shortcut; rollback has an explicit post-migration boundary and requires the
matching backed-up state/configuration.

The operator's `clankerbox` command now resolves to the published immutable
macOS bundle under `~/.local/share/clankerbox/releases/v0.2.1/`. The previous CLI
and config are backed up outside the checkout under personal-cloud's operator
state. The new client defaults to `linux-dev-v3`; operator SSH keys are preserved.

## Final public topology acceptance

The production two-viewer browser test used public HTTPS at
`desk.example.internal` and the actual Desk Node → edge Caddy → controller → Linux
host → guest route. Shell PID 3155 and its file survived simultaneous input from
two Chromium contexts, resize, both viewer reloads, Desk restart and controller
restart without replacing the shell. The controller restart activated
`b7db763e729f26fe8654f6621b39868617f902b7`, binary SHA256
`e54787667dfd4a7b2079efe4720444b3a3909c1d0b9762d84b866f3cd8865aee`.
The patch derives public machine capabilities from the installed runtime, while
leaving historical profile snapshots and private operation bindings unchanged.
The retained machine no longer advertises the removed `ssh` capability.

The explicit public SessionService probe used Node 26.8.2 and disabled Connect
compression. Its healthy viewer received 67,108,914 bytes while the sibling
remained unread for 45 seconds. The stalled stream disconnected independently
with an HTTP/2 reset after 4,300,798 buffered bytes; this is a client-visible drain
measurement, not a claim about total proxy/server heap. Ordered resize/input
acknowledgements, cancellation/resume of PID 3116 with the same incarnation,
invalid-bearer rejection and explicit end all passed. The earlier probe used
compressible output and drained before the 30-second write-stall deadline; its
failure was corrected in the test fixture. The owned session is confirmed ended.
Evidence: `.work/production-public-session-revised.log` and
`.work/desk-production-cutover/two-viewers.json`.

The production Tart suite used ordinary public CLI/session calls. Running fork
and capture were rejected without a generation change; discovery exposes disk
branch/checkpoint capabilities and no live-fork/RAM-checkpoint capability.
Stopped fork preserved independent disks with fresh identity. Capture survived
source deletion, two restores published distinct identities and retained disk
state, checkpoint deletion did not break restored cold starts, and all owned
resources were deleted. The grant at the installed production path reconciled
the original accepted create, not a duplicate request. Evidence is under
`.work/real-local-engine/tart-gate/production-*.json`.

The production Linux `linux-dev-v3` suite passed all 49 checkpoint events with no
pending operation or cleanup error. Live fork continued PID 3065 and its in-memory
nonce, with a fresh guest machine identity and independent child disks. Capture
continued PID 3047 through two restores after deleting the source. Both restored
machines retained independent files through cold restart, and all four owned
machines plus checkpoint `01ff5e0c7eb41d7e62bc08dc132d8d66` were deleted. The
lifecycle prerequisite also retained staged/dirty Git contents, executable bits,
symlinks and untracked files, and rejected stopped-session access. The initial
local test adapter was stale and attempted REST; it was rebuilt from current
source, then the already-created disposable VM was resumed without another create.
Evidence: `.work/production-linux-lifecycle.json`,
`.work/production-linux-lifecycle-resume.log` and
`.work/production-linux-checkpoints.json`.

Desk's release retained every pre-existing row hash across all 13 SQLite databases.
The only additions belong to the named acceptance workspace: three extension pins,
one closed allocation and one ended terminal. Its VM was deleted. The note and
reference remain in workspace `e6236668-690a-40cd-a916-d29f1c6f5af6` as identified
acceptance evidence. The exact deployment pin is personal-cloud commit
`c5a46e6cc20c9bbc80fb9e5f36456022e0d216d8`; the generated upstream status probe is
`31dc480`, and the completed Desk operating record is `1835734`.
`make deploy:status` and Desk backup/export verification passed for
`/rpool/backups/apps/clankerdesk/20260913T090110Z`, including SQLite integrity.
This verifies the exported artifact; a separate restored-app startup was not run.
Consolidated evidence: `.work/desk-production-cutover/result.json`.

## Final release 0.2.1 and retirement audit

The signed `v0.2.1` tag points to
`b7db763e729f26fe8654f6621b39868617f902b7`. Both archives passed clean extraction
with no warnings, manifest verification, toolchain-free installed `dev` startup
and complete empty-environment cleanup. All eight published assets match verified
local sizes and SHA256, including the corresponding native source archives.
Runtime and image digests are unchanged from the qualified 0.2.0 bundles.

| Platform | Final archive SHA256 |
|---|---|
| darwin-arm64 | `2401459a31cc2a7b4f3c3d24959a532daf2320a14892f65a67e032174f1a0962` |
| linux-amd64 | `df52786ac3d6d347a3e4d050d3e97079ba42a00e8eb5f7dedd3bd15f94a6506a` |

The deployed controller is the exact Linux bundle controller, SHA256
`e54787667dfd4a7b2079efe4720444b3a3909c1d0b9762d84b866f3cd8865aee`.
Host/guest role binaries retain the qualified candidate5/a31ac754 pins; this
patch changes only controller public discovery. The production Mac host remains
Apple Development signed at its granted path, SHA256
`a66cd8d3235c09285a0d9f20b516b2961bd77e2196b4f3f1a60fe1ed7008e91f`.
The operator CLI now uses the immutable 0.2.1 macOS bundle; the prior bundle is
retained. Final publication and consumer evidence is in
`.work/real-local-release/patch-0.2.1/`.

After all native/browser gates passed, retirement removed exactly one forced
controller key line and the owned host-entry shim on each host. Every other
key byte was preserved and fresh operator SSH succeeded. The controller's four
retired SSH files were archived privately, and only their exact configuration
symlink was removed. UniFi's semantic diff removes only the old controller-to-Mac
SSH allow and its automatic return rule; RPC policy and other policy semantics,
networks and DNS are unchanged. Derived UniFi identifiers may be reused, so the
audit compares policy meaning rather than claiming unrelated identifier stability.

Final consistent snapshots verify every pre-cutover operation row (203 controller,
376 Linux host, 176 Mac host) and checkpoint row (6/10/4) byte-for-byte unchanged,
including fingerprints, idempotency records and tombstones. New acceptance records
are additional history. Retained machine `ad8cd000ed13c8996c30fe8a7eace330` remains
running at generation 3 with its exact migrated image pin. Quarantined orphan
`3170fea0cfbb72c9d7bb74d5d75b940b` retains native PID 437989, start ticks 17007911,
and both original raw journal hashes. Its pre-existing unresolved operation remains
quarantined; it was neither replayed nor erased. Public generated validation passed
after retirement. No required qualification gate remains open.

The final personal-cloud cutover and audit record is committed and pushed as
`c3246d1ab8e1f5e9d20359817207c9cd61ae8a81`, in
[`hosts/clankerbox-controller/README.md`](https://github.com/example/personal-cloud/blob/main/hosts/clankerbox-controller/README.md)
and its adjacent `rpc-cutover/README.md`. Only owned paths/hunks were committed;
unrelated user changes remain untouched. Final active capacity is the retained
Linux machine (2 CPU, 2048 MiB) and zero Mac test machines. Detailed final audit
logs are `.work/rpc-deployment-stage/candidate5/{linux,mac,controller}-final-retained-audit.log`
and `{linux,mac}-retired-access-complete.json`.
