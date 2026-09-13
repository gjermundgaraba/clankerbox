# Real local Clankerbox — clean-break architecture and plan

Status: implemented, deployed and live-qualified. See
[the implementation record](real-local-development-implementation.md) for exact
artifacts, platform evidence and retained-state handling.

This document plans a replacement for the process-based `clankerbox dev`, and
the corresponding production transport refactor. It is not an implementation
report or permission to deploy, terminate workloads, or remove retained state.

Baseline reviewed through `4e0ff912e288d3f3c412b897c22d927b55faad7c`:

- `70ca52bf0232abc1498138509388f8e76a4c995b` removed terminal activity and
  foreground-process metadata, activity observation/hooks, `session.report`,
  `clankerbox-guest report` and automatic `CLANKERBOX_SESSION_ID` injection.
  The current guest wire protocol is revision **3**. Clankerdesk already adopted
  that revision and removed activity metadata in `7c4baca`.
- `4e0ff912e288d3f3c412b897c22d927b55faad7c` removed `/v1/events`, the
  `clankerbox events` command, SSE delivery and background change polling.
  Callers inspect/list resources and poll operation status instead.

These are completed source cleanups, not work to repeat or features to replace
with RPC equivalents. They do not establish live qualification of this plan.

## 1. Goal and agreed decisions

An integrating project installs Clankerbox, runs `clankerbox dev`, and gets a
private, real Clankerbox against which it can exercise machine and terminal
workflows. No Clankerbox source checkout or Go/Rust build toolchain is required.

Agreed scope:

- Co-location is a normal production topology, not a dev-only runtime.
- Qualify Apple Silicon/macOS and Linux/amd64 hosts in this implementation.
- Use smolvm to run Linux guests on both. Local macOS guests are not required.
- Expose the capabilities supported by the pinned engine/platform/profile;
  implement and qualify the corresponding adapter paths rather than imposing
  historical architecture restrictions or emulating missing engine features.
- Replace both Clankerbox-managed SSH hops. Operator/infrastructure SSH is not
  being retired.
- Use Connect RPC for public APIs and internal service communication, with
  generated Go and TypeScript bindings.
- Use a typed **bidirectional terminal attachment stream**. Do not ship a
  parallel unary-input terminal protocol or carry the old framing inside RPC.
- Keep Clankerdesk's browser-to-server WebSocket boundary. The required
  Clankerbox clients are the Go CLI and server-side Node/TypeScript consumers.
  Direct browser-to-Clankerbox integration is not a release requirement.
- Environments belong to projects/test suites and may coexist on one computer.
- Ctrl-C stops the foreground controller, retaining machines. Shutdown and
  destruction are explicit. Restart must not implicitly start stopped machines.
- Explicit, narrowly scoped first-run host setup is acceptable. Prefer a design
  that does not require privilege where possible; no silent system changes.
- Retire old process-based dev environments without migration. Leave their
  files untouched and document shutdown using the old binary before replacing it.

There are no remaining product-scope questions for this plan. Engineering
verification gates below must be resolved before dependent implementation or
support claims. A discovered engine limitation is evidence to report, not a
reason to silently substitute a different runtime or cold restoration.

## 2. Architecture

```text
Clankerdesk browser
    | existing application WebSocket
Clankerdesk Node server / other integrating application / clankerbox CLI
    | public Connect API
    v
Controller
    | private host Connect API
    v
Host service
    | authenticated private guest Connect API
    v
Guest daemon
    | PTY + Ghostty VT + retained output
    v
Shells and application processes

Host service -- engine adapter --> smolvm / Tart
                         |        trusted bootstrap execution
                         +------> guest daemon installation and identity binding
```

Dev assembles these real services. It does not substitute in-process calls,
fake resources, local shells, an alternate session daemon, or a fake host.
Remote and co-located deployments use the same RPC clients and handlers.

### Alternatives considered

| Alternative | Why not the target |
| --- | --- |
| Extend the process-based dev runtime | Cannot exercise VM provisioning, bootstrap, isolation or engine recovery; keeps a second lifecycle implementation |
| Require local SSH | Reproduces today's remote launch boundary, but adds local sshd setup instead of making co-location natural |
| Local helper subprocess plus remote SSH launcher | Smaller initial change, but retains SSH/process plumbing and different host-launch paths; the chosen service model owns one protocol and explicit service lifetime |
| Embed the host core in the controller | Erases independent restart and accepted-work boundaries that integration tests need to exercise |
| Engine-native terminal exec stream | Could avoid a guest listener, but depends on each engine's long-lived duplex execution semantics; direct guest RPC gives one engine-independent session transport |
| Unary input plus server-streamed output | Browser-friendly, but ordered continuous input needs serial round trips or added sequencing; the required Node/Go clients can use bidi |
| Carry legacy frames inside Connect | Adds an RPC envelope without removing custom framing, request correlation or handwritten clients |

The selected design deliberately accepts persistent host-service and TLS
provisioning responsibilities in exchange for removing remote command execution
and SSH channel machinery. No protocol library removes those operational duties.

### Ownership

| Component | Owns | Does not own |
| --- | --- | --- |
| Controller | Public authentication, admission, machine/checkpoint/operation records, desired state, per-host dispatch, public routing | Engine subprocesses, PTYs, an alternative local runtime |
| Host service | Host journal, engine execution/reconciliation, guest preparation and identity, private endpoint resolution, guest access eligibility | Application workspaces, terminal rendering, public admission policy |
| Guest daemon | PTYs, shell processes, authoritative VT state, retained output, session records, attachment queues | VM lifecycle, controller operations, application-specific UI state |
| Dev launcher | Artifact provisioning, environment configuration, service launch/readiness, connection output, explicit teardown | A second implementation of machine lifecycle or recovery |

Keep controller and host journals: they protect different durable boundaries.
Do not add a third orchestration queue or persist a second copy of the terminal
output in either relay.

### Separate the three axes

1. **Placement** determines the host endpoint: co-located Unix socket or remote
   authenticated TLS endpoint.
2. **Host platform** determines supervision, host process handling, library
   loading, filesystem behavior and virtualization prerequisites.
3. **Engine and guest profile** determine native machine operations, image
   format, guest OS/architecture, bootstrap and recovery capabilities.

Current code selects launchd for Tart and systemd for smolvm. Replace this
coupling with host-platform supervision of explicit engine launch descriptions.
Do not grow a plugin framework: retain the two actual engines and two actual
host-platform implementations.

OS supervision owns retained VM process lifetimes, independent of controller
and host-service connections. Validate smolvm's detached process behavior under
launchd rather than merely translating the existing systemd unit to a plist.
Preserve the distinctions between ordinary start, first branch execution and
first RAM restore. Never replace an ambiguous live operation with `restart`.

## 3. RPC boundaries

Use explicit Protobuf service/message definitions, checked-in/generated bindings
with reproducible generation, and pinned Connect/codegen dependencies. One
supported schema, no old REST routes, SSH transport fallback, generic JSON
`Execute(op, args)` public interface, or legacy-frame RPC envelope.

Generated wire models need not become the SQLite storage format. Separate wire
changes from persisted resource changes so a transport refactor does not
unnecessarily invalidate real machine/checkpoint records.

### Public machine API

Provide typed methods for discovery, create/start/stop/delete, fork,
checkpoint capture/list/get/delete/restore, machine list/get, labels and
operation inspection. Preserve existing resource semantics and stable IDs.

- Machine/checkpoint lifecycle mutations return a durable operation, not a
  connection-bound task. Preserve caller idempotency keys, conflicting-input
  rejection and bounded CLI waiting. A timed-out wait must not resubmit a mutation.
- Label updates remain synchronous controller-local writes and return the updated
  machine. They create no operation record and require no host work or polling.
- Preserve unsupported/prerequisite/capacity/unavailable distinctions as typed
  error details, alongside standard RPC status codes.
- Keep resource reads and operation-status polling. Bounded CLI waits poll the
  typed operation method.
- Keep authorization at the controller. Applications do not receive host or
  guest credentials or arbitrary network-relay access.

### Private host API

The host becomes a persistent service using the existing host core and journal.
It exposes typed operation submission/status/inspection, host description, and
machine-routed session RPCs. Method names are finalized with the schema, not
introduced as an additional public SDK surface.

- Commit operation identity, input fingerprint and generation before effects.
- Execute accepted work under a host-owned lifetime, not the request context.
- A disconnected submission leaves an inspectable result or durable ambiguity.
- Repeated submission of the same operation cannot repeat an unsafe effect.
- Host restart reconciles recorded intent; it does not blindly rerun a fork or
  checkpoint capture whose outcome is unknown.
- Submission acknowledgement and final operation completion are distinct.
  Controller reservations remain held until the existing completion rules allow
  release. An accepted host request is not public operation success.
- Process shutdown remains bounded and journals unfinished work. Do not replace
  the existing recovery rules with indefinite detached goroutines.

Move ownership of the live guest connection/preparation registry to the host,
which already owns guest bootstrap and authoritative runtime endpoints. The
controller retains admission/routing checks and materializes guest status from
host observations. Do not maintain competing guest readiness registries.

Both controller and host validate their respective boundaries: public resource
eligibility at the controller; owned execution, accepted generation and actual
guest identity at the host. These checks protect different races/trust boundaries.

## 4. Terminal API and preserved semantics

Use unary session creation/listing/ending and guest description, plus a
bidirectional attachment RPC. Translate the current revision-3 session contract.
Session PID, command arguments and exit status remain ordinary lifecycle data,
distinct from the removed foreground-process observer.

Illustrative attachment shape:

```text
client -> Open(machine_id, session_id, resume_cursor?, expected_engine_digest)
server -> Opened(guest_identity, incarnation, mode, cut, session, bootstrap_size)
server -> SnapshotChunk* | retained Output* | final-view chunks

client -> Input(sequence, bytes) | Resize(sequence, cols, rows)
server -> Ack(sequence, accepted/refused, details)
server -> Output(next_offset, bytes) | Resized(offset, grid)
          | SessionExited(session) | Gap
```

This is a typed message union, not a generic RPC envelope inside RPC. One
attachment addresses one machine/session. Input sequence numbers correlate
acknowledgements within that attachment; they are not a claim of exactly-once
delivery or a reason to replay input after reconnect.

Required contracts:

- The guest is the only authority for session state, snapshot cuts and offsets.
- Create retains caller-chosen session identity, conflict checking and the retry
  horizon that prevents an old forgotten request from spawning another process.
- Open atomically selects snapshot/resume/final view and subscribes to the live
  tail. Never split snapshot retrieval and subscription into separate RPCs.
- Process incoming controls in stream order; HTTP/2 ordering is not preserved
  if handlers then dispatch each input/resize concurrently.
- Keep output, resize events, bootstrap chunks and session-exit events in
  the guest's defined order. Control acknowledgements must not invalidate the
  bootstrap-before-output invariant. These attachment-local messages are not
  the retired controller-wide change notifications.
- Accepted input means bounded writer admission, not confirmed shell execution.
  On acknowledgement loss, report uncertainty; do not automatically replay it.
- Cancelling/closing an attachment only detaches. Explicit EndSession ends the
  session independently of attachment lifetime.
- Backpressure is bounded at every relay and subscriber. A stalled viewer must
  not block PTY reads or accumulate unbounded relay queues. HTTP/2 flow control
  alone does not supply this product guarantee.
- A reconnect uses the last fully applied cursor. Partial snapshots never become
  committed terminal state. Preserve final-screen and unavailable-snapshot cases.
- Keep the Ghostty artifact digest handshake. Typed RPC compatibility does not
  make incompatible VT snapshots safe to decode.
- Specify integer mapping for offsets in generated TypeScript; test exact
  roundtrips and comparisons rather than silently converting large values to
  JavaScript numbers.

Use the same terminal messages and ordering semantics across public and private
RPC relays. The controller/host authenticate, gate, route and apply bounded
stream handling; they do not interpret terminal escape sequences or create VTs.

### Clankerdesk integration

Current path is browser WebSocket -> Clankerdesk server -> custom Clankerbox
HTTP upgrade/revision-3 protocol -> guest. Replace only the Clankerbox-facing
client and wire parser with generated Connect bindings and a thin terminal
adapter.

Keep intentionally:

- Workspace/machine allocation ownership and recovery.
- Server-side terminal mirror and committed resume cursor.
- Browser snapshot/fanout and viewer-specific backpressure.
- Credentials on the server, not in the browser.
- Existing browser WebSocket and application RPCs. They serve an application
  boundary and are not a compatibility shim for the retired Clankerbox protocol.

Qualify Node's actual HTTP/2 transport and the deployed reverse proxy, including
duplex streaming, cancellation and timeouts. Do not use browser Fetch as a
stand-in or assume that ordinary unary HTTPS proves the streaming path.

## 5. Authentication, guest identity and copy boundaries

Connect supplies RPC mechanics, not authentication or provisioning.

- Public applications retain bearer authentication. Remote/public network
  endpoints use verified TLS. Local dev exposes only loopback; the initial
  local HTTP/2 endpoint may use loopback h2c, matching a supported co-located
  deployment configuration rather than disabling checks in dev code.
- Co-located controller/host traffic uses a private, same-user Unix endpoint.
  Remote host-control traffic uses mutually authenticated TLS with explicit
  controller/host identity. No ambient workstation trust or credentials.
- Guest endpoints are authenticated TLS services reachable only through the
  owned runtime path. Host/guest credentials are separate from public tokens.
- Generate guest credentials/bindings through the existing trusted engine exec
  bootstrap path, not by trusting a newly contacted network endpoint.
- Key authority and host credentials remain outside VM snapshots. Guest secrets
  can be captured, so every new child gets a fresh identity before access is
  published. Certificates bind the machine identity; TCP addresses do not.
- Credential expiry/renewal must allow retained workloads: rotate transport
  credentials without restarting the session manager. No assumption that dev
  or production machines are short-lived.

### Fork and RAM restore are the critical identity test

A copied daemon may retain the parent's certificate, machine binding, active
connections and incarnation in RAM. Rewriting a file or restarting the daemon
is not an acceptable identity fix: the former may leave old credentials active,
and the latter kills the very PTYs RAM restoration is meant to preserve.

The guest must support a local-only administrative rebind operation, invoked
through trusted engine execution. It atomically adopts the durable child
binding, replaces in-memory transport credentials, and closes inherited
transport connections without replacing PTYs, VT instances or the session
manager. The operation is idempotent for the intended machine identity.

Keep this endpoint separate from session methods and inaccessible using public
or ordinary session credentials. Start verifies the retained identity; it does
not create a new identity each time.

The host owns suspension around copy operations:

1. Record/respect the operation's durable reservation and refuse new attachments.
2. Drain existing terminal transports before capture/copy, without ending PTYs.
3. Execute the engine operation under the existing journal/reconciliation rules.
4. Bind/verify the child's private endpoint and fresh identity in memory and disk.
5. Publish access only after handshake and guest readiness succeed.
6. Reopen source access only when the recorded operation state permits it.

Outstanding input acknowledgements remain uncertain, not replayable. Controller
or host restart must not reopen a machine reserved by an unresolved operation.
RAM-restored session IDs/incarnations may be inherited; addressing always also
includes the immutable machine identity.

This preserves the existing pragmatic copy contract. It does not claim strict
first-packet network quarantine or automatic rotation of inherited application
credentials; those are separate product capabilities.

## 6. Engine support, artifacts and supervision

Current findings:

- The inspected smolvm 1.14.1 source supports Apple Silicon hosts with arm64
  Linux guests and includes macOS fork-and-continue and portable-checkpoint code.
- Clankerbox's current capability function and checkpoint prerequisite impose an
  amd64-only live-fork restriction. Host OS is missing from that decision.
- Current supervision, branch and restore code assumes Linux/systemd for smolvm.
- Guest builds currently omit Linux/arm64.
- Image scripts contain installation-specific accounts/paths and are not a
  distributable first-run installer.
- Existing smolvm source trees contain local patches. Record exact source and
  dependency provenance; do not replace them with an arbitrary upstream release.

Produce a verified release bundle with controller/host/guest binaries, engine
artifacts, matching guest agents/libraries, disk templates and Linux images for
both guest architectures. Include signed/entitled macOS executables and runtime
redistribution/license requirements. Immutable artifact identities are based on
content/build pins, not an installation path or mutable `latest` tag.

Profiles remain versioned and capability-aware. Resolve capabilities from the
pinned engine, host OS/architecture and supported guest/device profile. Keep
capability discovery separate from current machine state, resource availability
and checkpoint compatibility. No arbitrary operator feature toggles.

Ship the same guest daemon/protocol and supported image recipe family in dev and
production. A dev-specific host mount or engine configuration must not silently
disable checkpointability. Do not import the user's tools, home or credentials.

Retain Tart support in the production adapter. Although local macOS guests are
not required, the shared SSH removal changes their bootstrap/session path too;
qualify that path before deploying it to existing Mac infrastructure.

## 7. Dev environment lifecycle

Proposed minimal commands:

```sh
clankerbox dev --state-dir ENV_DIR
clankerbox --json dev --state-dir ENV_DIR --listen 127.0.0.1:0
clankerbox dev --state-dir ENV_DIR stop
clankerbox dev --state-dir ENV_DIR destroy
```

`dev` provisions verified cached assets, opens/creates an owned environment,
starts/reuses its host service, and launches the ordinary controller. It prints
connection information only after endpoint authentication, host description,
profile installation and runtime prerequisites are ready.

Start with an empty machine inventory: integrating projects create resources
through the ordinary API. Readiness of the environment is distinct from the
subsequent guest readiness of a created machine. Do not resurrect the special
seeded `local` machine.

Generate a generic connection manifest containing API origin, credential file
reference and usable default host/profile IDs. Generate the ordinary CLI config
and a Clankerdesk config fragment from it. Stdout is machine-readable in JSON
mode; progress and logs go to stderr. No machine ID or host workspace is assumed.

Ctrl-C stops/reaps the controller and closes its connections. The retained host
service can finish accepted operations and maintain inventory; machines keep
running under real supervision. Restart reuses the environment without starting
machines that the caller explicitly stopped.

`stop` orderly-stops owned machines and shuts down environment services,
preserving disks, checkpoints, identities and journals. `destroy` performs
dependency-aware deletion of owned resources and unregisters services before
removing environment state. It must fence new admissions during teardown.
Both work after the foreground controller has exited by starting/reusing the
normal control path; neither implements its own VM lifecycle algorithms.

Unresolved operations, an unreachable engine or an unverified owned resource
prevent destructive completion. Report exact remaining resources, preserve the
journal and allow recovery. No broad process kills, directory glob sweeps, TTLs,
idle cleanup or implicit deletion of descendants.

### Isolation and prerequisites

- Each environment owns its controller/host journals, credentials, mutable
  engine stores, logs and supervisor definitions.
- Immutable verified artifacts may share a cache. Cache collection must not
  remove artifacts referenced by retained machines/checkpoints/environments.
- Namespace supervisor identities; resolve cross-environment port allocation
  atomically. Current per-host bind-and-close probing is insufficient across
  independent environments. Engine-assigned ports/endpoint discovery are the
  preferred mechanism to investigate; otherwise select an explicit coordinated
  allocation design before implementation, not a best-effort retry fallback.
- Qualify socket path limits and choose valid default paths. Durable storage
  must not depend on temporary paths that disappear across reboot. If engine
  sockets need a separate short runtime directory, make its ownership and
  recreation explicit.
- Admission reservations remain scoped to the owning controller. Do not claim
  cross-environment global resource scheduling. Preflight and document actual
  RAM/CPU/disk requirements and test concurrent environments under safe budgets.
- Probe KVM permissions/systemd availability on Linux and Hypervisor.framework
  signing/launchd behavior on macOS. Fail with actionable setup instructions.
  Do not silently choose a process backend when virtualization is unavailable.

## 8. Clean-break inventory

### Already removed — keep absent

- Activity and foreground-process metadata/observation, activity hooks and
  `session.report` / `clankerbox-guest report` / injected `CLANKERBOX_SESSION_ID`.
- The controller events endpoint/CLI, SSE, change hub and background change
  polling. No RPC replacement or compatibility aliases for these surfaces.

### Delete

- The process backend in `internal/dev/transport.go`, detached `_dev-guest`, its
  admin socket and local operation journal. Replace the dev launcher, not wrap it.
- The `local` profile/runtime, singleton admission branch, `--workspace` flags
  on `dev` and `_dev-guest`, seeded-machine configuration and tests asserting
  those retired semantics.
- `control.SSHTransport`, guest SSH channels/key preparation, remote shell
  command construction and forced-command host entrypoint after RPC cutover.
- Clankerbox-owned guest sshd configuration/startup and SSH identity fields where
  replaced by explicit guest service identity. Do not retain misleading names.
- Remaining REST routing and HTTP upgrade/stream bridging after RPC callers move.
- Custom terminal framing/envelopes and handwritten Go/TypeScript frame clients.

### Collapse

- Guest link/preparation/suspension ownership into the host's single runtime
  access gate, with public controller gating retained at its own boundary.
- Handwritten cross-language wire definitions into generated RPC contracts.
- Runtime/host-platform conditionals into explicit engine launches and OS
  supervision, preserving engine-specific lifecycle behavior.
- Dev connection output into one generic manifest with derived consumer configs.

### Keep intentionally

- Controller and host durable journals, exact-generation/idempotency checks,
  ownership markers, locks, stopped-machine guards and backing-file references.
- Guest session manager, PTYs, Ghostty snapshots, rings, writer/subscriber limits,
  creation deduplication and the semantic conformance cases they protect.
- Session retention cleanup, operation reconciliation and guest readiness/link
  maintenance. These protect retained state and live connections; they are not
  the retired activity observer or controller change-detection poller.
- Incompatible-engine rejection and explicit ambiguous-operation recovery.
- Unit-test fake runtimes and fault injection. Tests need controllable failures;
  these are not alternate product execution paths.
- Clankerdesk's workspace allocations, terminal mirror and browser transport.
- Operator SSH, VPN/firewall safeguards and retained infrastructure secrets until
  a separately approved deployment inventory establishes exactly what can retire.

## 9. Implementation sequence and verification gates

### A. Prove the risky boundaries before broad rewrites

Use isolated test artifacts, not production deployment changes.

1. Exercise pinned smolvm on Apple Silicon and Linux/amd64: retained lifecycle,
   fork-and-continue, portable capture/restore, independent disks, source deletion
   subject to dependency rules, and retained cold restarts. Record actual engine
   support separately from adapter failures. Reconcile required existing patches.
2. Prove Go -> Go and Node -> Go typed Connect bidi streams, over local h2c,
   Unix sockets where applicable, and the intended TLS/reverse-proxy path.
   Exercise cancellation, slow readers and large chunked snapshots.
3. Put a real terminal manager behind the proposed guest RPC listener. Prove a
   RAM-restored/branched daemon can rebind identity and discard old connections
   while retaining PTYs, process state, VT and resume behavior. This is a hard
   gate before deleting the old guest transport.
4. Prove retained smolvm supervision on macOS, including branch and first restore;
   settle port ownership, socket placement and reproducible artifact layout.

If a gate fails, document the exact limitation and revise the design explicitly.
Do not leave a second supported terminal carrier or local emulator behind.

### B. Establish contracts and shared host-platform structure

- Add Protobuf definitions and reproducible Go/TypeScript generation.
- Define typed errors, operation acceptance, terminal message ordering, bounds,
  identity and capability description.
- Separate host platform from guest profile/runtime; add Linux/arm64 guest builds.
- Preserve domain/session algorithms and storage boundaries while changing DTOs.

### C. Implement the real host and guest services

- Convert host command entrypoint to persistent RPC service over the existing
  journal/core; implement accepted-work lifetime and restart reconciliation.
- Implement authenticated guest RPC, trusted bootstrap and idempotent live rebind.
- Move guest access gating/status/suspension to its final owner and route typed
  session RPCs. Test failed preparation and reply-loss recovery.
- Implement host TLS/Unix endpoint setup and platform-appropriate supervision.

### D. Cut over public APIs and actual callers together

- Replace controller HTTP handlers, client API transport and session attachment
  routes with generated RPC handlers/clients; keep CLI user-facing lifecycle
  behavior and exit/wait contracts.
- Update Clankerdesk's machine client and guest-terminal adapter. Remove its old
  framing parser; retain its application-facing models where they have distinct
  meaning rather than duplicating wire schemas.
- Port acceptance harnesses and fixtures, including `tests/session-run`, to the
  new generated/session clients. Use revision-3 semantics as the baseline;
  preserve lifecycle/terminal coverage and retired-surface assertions, not old
  framing bytes or obsolete command callers.
- Delete old routes, framing and managed SSH paths in the coordinated cutover.
  Intermediate development commits are not a supported mixed-version deployment.

### E. Package the project-owned dev appliance

- Publish verified, pinned binary/runtime/image bundles for both host targets.
- Implement cache/setup/preflight, owned environment configuration, ordinary
  service launch, readiness, manifests and stop/destroy.
- Replace old dev tests with executable tests against real VMs and public RPCs.
- Document first-run cost, cached startup, requirements, retained lifetimes,
  unsupported-host errors and explicit old-dev shutdown.

### F. Acceptance and deployment preparation

Run one end-to-end contract suite against both dev host platforms and the normal
deployment topology. Supported engine capabilities are required tests, not
silently skipped integration paths. Unsupported engine features have explicit
capability/error assertions.

Required evidence:

- Clean installed release with no checkout/toolchains -> ready endpoint ->
  actual integrating project creates a VM and uses terminals.
- Two concurrent isolated environments; no identity, port or cleanup collisions.
- Session create/open/input/resize/end, snapshots, resume, final views, artifact
  incompatibility, bounded paste and slow-consumer isolation.
- Retired activity/foreground/report and controller events surfaces remain absent
  from schemas, generated clients and CLI/help. Machine/operation polling and
  attachment-local resize/exit delivery continue to work without a change feed.
- Consumer, controller and host-service restart without killing guest sessions.
- Machine stop/start preserves disk and reports lost/noncontinuing sessions
  correctly; connecting never implicitly starts a machine.
- Engine-supported forks and checkpoint restores preserve the promised RAM/disk
  behavior, publish fresh identities and never accept the wrong guest endpoint.
- Disconnect after operation acceptance; restart/reconcile without duplicate
  effects, false completion or premature access reopening.
- Negative authentication, identity mismatch and expired/replaced credential tests.
- Stop/destroy after partial startup, interrupted lifecycle and controller loss;
  uncertain ownership prevents deletion.
- Clankerdesk's actual browser terminal through its server, including consumer
  restart and multiple viewers; no Clankerbox secret reaches the browser.
- The existing Tart production path with the replacement guest transport before
  any corresponding live production cutover is declared qualified.

Run targeted Go tests during implementation, then `make build`, `make test`
(race detector), `make lint`, Python acceptance harness unit tests, protocol
generation/conformance checks, generated SDK checks, and Clankerdesk's `ready`
pipeline. Add reproducible dedicated real-VM acceptance commands; ordinary
`make test` must not unexpectedly download images or boot expensive VMs.

## 10. Persisted state and deployment boundary

Old dev state is disposable by agreement; old workspace files are not automatic
cleanup targets. No old-dev compatibility daemon or migration is retained.

Production is different: repository records describe deployed services and
retained journals. Inspect actual machines, checkpoints, profiles, credentials,
pending operations, image pins and Clankerdesk allocations before a deployment
cutover. Preserve consistent backups and exact resource identities.

If wire/domain separation permits keeping existing journal formats, prefer that
over a storage rewrite. If real retained records require conversion or an
identity rebind, specify a bounded, explicit cutover procedure for the inventoried
state. Do not infer permission to reset it from the clean-break authorization,
and do not build generic migration scaffolding for hypothetical future state.

Update personal-cloud service definitions, TLS provisioning, network rules and
operating commands together with server/host/guest/Clankerdesk versions. Preserve
operator SSH and unrelated authorized keys. Remove only verified
Clankerbox-owned transport artifacts after the new deployment is qualified.

The earlier `client-connection-removal-plan.md` records a completed historical
cutover that intentionally retained internal SSH. This plan supersedes that
transport direction only when implemented; do not rewrite its historical evidence.

## 11. Completion report

Report shipped platform/capability matrix and exact artifact pins, actual tests
and their topology, unresolved qualification gaps, deletion inventory, source
line-count delta, companion-repository changes and deployment/state handling.

Completion means an installed integrating project exercises real controller,
host, engine, bootstrap and guest paths through the supported RPC APIs on both
required dev platforms. A passing fake-runtime suite, downloaded engine, or
working single terminal is not sufficient.
