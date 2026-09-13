# Real local development implementation record

This is the implementation and qualification record for
[the agreed plan](real-local-development-plan.md). Release [0.2.0](https://github.com/gjermundgaraba/clankerbox/releases/tag/v0.2.0)
is published from signed commit `a31ac754e0c81d0af3d75edef307fd5d26498e70`.
Production cutover remains in progress; older candidate records below are
qualification evidence.

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

| Target / topology | Qualified behavior | Remaining work |
|---|---|---|
| macOS arm64 → smolvm Linux arm64 | Native retained lifecycle, RAM fork with independent memory/disks, portable RAM restore after source deletion, root/unprivileged boundary, real Desk terminal, live shell across controller/host replacement | Complete |
| Linux amd64 → smolvm Linux amd64 | Native retained lifecycle/fork/capture/restore, two concurrent installed environments, dirty Git/files/modes retained across cold restart, two real Desk browser viewers | Complete |
| macOS arm64 → Tart macOS arm64 | Isolated copied seed, typed TLS guest/session route, unprivileged shell, resize/resume, cold disk retention and LOST old sessions | Production installation and public topology verification |
| Node/Go → HTTP/2 h2c, Unix and TLS | Full bidi before request EOF, 8 MiB chunked snapshots, offsets above 2^53, bounded slow reader, cancellation and negative trust/identity | Final production endpoint verification |
| Actual edge Caddy 2.11.4 → isolated HTTP/2 test upstream | Verified TLS frontend and bidi/chunk/cancellation/slow-reader gates | Final production controller/host/guest topology |

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
migration, and typed validation commands. Live configs and services remain on
the prior release until coordinated cutover. The active idle test machine and
unmanaged orphan were inventoried separately; the orphan is excluded from
migration. A nonterminal host operation targets that orphan, so the new host
configuration explicitly quarantines its exact ID before startup. The migration
guard checks its journal bytes, native PID start time and boot identity without
rewriting it. Production Mac inventory has only deleted machine records and no
nonterminal operations. Candidate3 artifacts and role credentials were staged
and independently verified on all four hosts, including Mac signatures.
The active machine's planned cold transition preserves IDs and disks
and makes no RAM-continuity claim. No production database or VM has been reset.

## Source size and remaining delivery

Compared with the reviewed baseline, handwritten Go under `cmd` and `internal`
(excluding tests) grew from 12,976 to 17,086 lines (+4,110); tests in those trees
changed from 8,767 to 8,669 (-98). Generated Go adds 7,537 lines, generated
TypeScript 2,900, and Protobuf 441. The retired JSON wire definitions remove
544 lines. These counts intentionally exclude Python, documentation, spikes and
other test helpers; the architecture trades old transports for real supervision,
identity, packaging, and durable host service ownership.

The release is published. Production backups, fenced migration and live deployment
verification are still in progress. Signed Clankerbox source is pushed and the Clankerdesk signed source/image CI
passed. The canonical 1Password Environment now works; the initially reported
missing UniFi key was a transient read result, not an absent key.
The isolated Tart system service passed after the user granted Local Network
access to the explicitly signed `org.clankerbox.host` executable. A system daemon
running as `gg` is not exempt from that permission: the earlier exemption claim
was incorrect. Host replacement preserved live sessions and the permission grant.
A fresh cold cycle exposed and then verified a bounded read-only guest-agent
readiness wait; no bootstrap mutation is retried by that wait. Tart restart,
resize/resume, retained disks, new cold incarnation and LOST old sessions passed.
The exact controller-to-Mac RPC firewall allow is installed; the Linux host and retained active VM are now migrated, while final Mac startup
and public/Desk admission are awaiting the administrator step.
No qualification gap is represented as a deployed support claim.

Candidate archive hashes and consumer extraction results are recorded separately
below. Deployed revisions and post-cutover results will be added only after the
actual coordinated deployment succeeds.

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

## Published release

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

## Production cutover in progress — 2026-09-13

The public Clankerbox route returns maintenance 503. The controller and Desk are
stopped. All four consistent SQLite backup sets passed integrity checks, with
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
with preimages saved. Its production system service is not yet installed. The
specific remaining administrator command is:

```sh
ssh -t mac-workstation 'sudo /Users/example/clankerbox-cutover/rpc-20260913-candidate5/finish-mac-cutover --install-and-start'
```

The wrapper removes only the empty qualification service, installs the pinned
production metadata, and starts it as `gg`. After that step: verify both host
identities, start the prepared controller, restore the verified RPC ingress,
deploy the pinned Desk image, run actual public session/lifecycle/checkpoint and
browser/restart acceptance, then retire only the inventoried managed host SSH
artifacts and record completion. Do not restart the old controller/Desk against
the new guest protocol as a shortcut; rollback has an explicit post-migration
boundary and requires the matching backed-up state/configuration.

The operator's `clankerbox` command now resolves to the published immutable
macOS bundle under `~/.local/share/clankerbox/releases/v0.2.0/`. The previous CLI
and config are backed up outside the checkout under personal-cloud's operator
state. The new client defaults to `linux-dev-v3`; operator SSH keys are preserved.
