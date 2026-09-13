# Real-local correctness, simplification, and clean reset

Status (2026-09-13): implemented, released and deployed.
[Release v0.3.0](https://github.com/gjermundgaraba/clankerbox/releases/tag/v0.3.0)
ships source `725122d`. Isolated and production qualification passed; the final
application is empty, with healthy services and reusable base images preserved.

`make test`, lint, and vet passed. Native smolvm qualification passed on macOS
arm64 and Linux amd64: lifecycle persistence, RAM forks, checkpoint capture,
source deletion, two restores with independent disks, SDK session checks,
same-bundle restart, and running/stopped bundle relocation. Final macOS checks
confirmed clean host/controller shutdown with an active terminal stream and the
same guest PTY after restart. Archive creation and extraction passed on both
platforms. Isolated qualification environments were destroyed after testing.

Baseline: clankerbox `d4c51205c6fc9c4b0cc5532e6a97bea6dcf312e6`.
Scope: clankerbox, the affected Clankerdesk integration, and personal-cloud
deployment/maintenance configuration.
[Independent Claude Code review](real-local-clean-break-plan-review.md) records
feedback on the earlier draft; the decisions below supersede that draft.

## Outcome and scope

Fix the verified lifecycle, streaming, admission, error-reporting, checkpoint,
and release defects. Consolidate duplicated contracts and mechanics, remove
obsolete state and upgrade paths, and deploy matching components from empty
application state. Prefer fewer maintained concepts and direct implementations;
code reduction is a useful result, not a reason to weaken a necessary invariant.

The user permits breaking compatibility and deleting all existing Clankerbox VMs,
disks, checkpoints, dev environments, and affected production application data.
Reset the whole Clankerdesk data directory as well. No preserved workloads,
application-data backups, migrations, legacy parsers, adoption shims, or
mixed-version deployment are required for this release.

Reset is limited to inventoried Clankerbox/Clankerdesk resources. Keep unrelated
applications and VMs, shared infrastructure, source repositories, deployment
configuration, secrets, signing identities, and reusable base images. Existing
preservation clauses for the historical retained machine and orphan are superseded
for this reset and must be updated in the owning runbooks.

Ordinary future durability remains required: same-bundle stop/start, live PTYs
across controller/host/Desk restart, atomic guest rebind, operation deduplication,
unresolved-operation recovery, backing dependencies, and explicit deletion.

## Architecture decisions

| Responsibility | Target |
| --- | --- |
| Controller | Public admission, desired state, durable operation queue, one serial reconciliation worker per host |
| Host | Native execution and its journal; private image/runtime resolution; per-machine guest admission and binding lifecycle |
| Guest | PTYs, terminal state, ordered control admission, snapshots/resume, final session records |
| Session RPC | One SessionService schema mounted independently on controller, host, and guest listeners |
| Transport | Shared mechanics with endpoint-owned authorization; clients owned by actual service/binding lifetimes |
| Profiles | Portable compatibility fields; host-local installation details; derived public capabilities |
| Dev | One immutable bundle identity per environment; ordinary product services; explicit destroy/recreate for bundle changes |
| Deployment | One consistent release after a complete application reset; no retained-state cutover machinery |

Keep serialized host mutation execution and acceptance. Making concurrent native
operation acceptance a new guarantee is outside scope: the controller already
dispatches one operation at a time per host and waits for its outcome. The guest
admission fix must make unrelated session calls responsive independently of that
serialization. Publicly accepted work remains durable in the controller queue.

No new dependency is expected. For any dependency actually added or bumped, verify
the latest compatible upstream/registry release at implementation time and pin
the resolved version and lockfiles. Qualify changes affecting engine or terminal
snapshot compatibility; do not substitute an unqualified engine merely to update it.

## 1. Correct guest shutdown and stream behavior

### Manager lifetime

- Make Close idempotent and refuse new creation once closing begins. The existing
  manager mutex can linearize creation and shutdown.
- Reuse session termination/escalation; terminate sessions concurrently, then join
  every goroutine that can access terminal state or persist a session record.
  Include sessions finishing while Close takes its snapshot, not only entries
  still considered running.
- Wait outside locks required by exit processing. Keep the loader and state
  directory alive until final capture, record persistence, and goroutine completion.
- Separate request/daemon signal cancellation from the resources needed for final
  session capture. The subprocess context must not bypass the manager's shutdown
  ordering. Guest identity rebind continues to retain the manager and live PTYs.
- Use the existing service/supervisor shutdown bound. If shutdown cannot finish,
  report failure and allow process termination; never report clean completion or
  free resources while background writers still use them.

### Attachment contract

Use one control reader, one response writer, and one bounded event queue per
attachment. Controls may be admitted while an immutable prefix is being sent.

The wire contract is:

1. Opened is first.
2. ACKs may appear after Opened, including between bootstrap chunks or resume
   prefix output. ACKs acknowledge bounded control admission, not shell execution.
3. Snapshot/view chunks or resume prefix output finish before live terminal-state
   events. Output generated by newly admitted input remains in the live tail until
   the prefix finishes.
4. Input and resize controls retain their sequence ordering. Rejecting or losing
   an acknowledgement never causes automatic input replay.

A full queue backpressures that attachment's producers. Retain bounded subscriber
tails and slow-viewer disconnection; do not add a second ACK buffer. Do not promise
unlimited input admission from a viewer that never reads responses.

Update the Go/TypeScript contract and Desk dispatcher together. Keep Desk's
existing input-disabled-until-ready UI policy; use a direct SDK client to verify
input admission during bootstrap.

On clean request EOF, stop admitting further controls, establish a finite drain
boundary for responses already queued to the writer, and detach after those
responses. Do not wait for the shell or drain an unbounded live tail. The relay
closes the upstream request direction and continues receiving until clean upstream
completion. Errors and explicit cancellation cancel the attachment. Direct,
one-relay, and two-relay paths must have equivalent completion semantics.

Keep the guest identity lock as the linearization point between rebind and an
authorized effect. Preserve short EndSession admission followed by its longer wait
outside that lock. Remove critical-section work only when the same ordering is
demonstrably preserved.

## 2. Separate guest admission from native effects

Use a per-machine reservation/binding registry with a short admission mutex. The
native execution mutex/flock remains the owner of serialized native effects.

- Nonterminal or unresolved operations reserve every affected machine and source.
  Fork/capture source reservations matter even when the source's own generation
  record still says succeeded.
- Update reservation/epoch state with the journal transitions that establish or
  release the reservation. Coordinate acceptance and final lease registration
  under the same admission mutex: no lease can register through a gap between
  successful acceptance and publication of its reservation.
- Cancel existing leases for affected resources and prevent new ones. Keep
  unrelated leases alive and allow unrelated new session RPCs.
- Reconstruct reservations from durable nonterminal work before opening listeners.
  Failed/completed operations release admission only when their resulting machine
  state is safe; unresolved work remains fenced.
- Perform native inspection, credential work, and network operations outside the
  short admission mutex. Capture the machine binding epoch before preparation and
  recheck epoch/reservation/current generation when registering the lease.
- Use one consistent acquisition order: native ownership when needed, then short
  admission, then short journal transactions. Never acquire native ownership or
  wait for native effects while holding admission. Ensure no database transaction
  spans a native call and no transaction calls back into admission in reverse order.

Treat the registry as an in-memory admission index, not another durable journal
or scheduler. Avoid a host-global epoch that makes an unrelated mutation reject
an otherwise valid attachment.

Acceptance tests must hold a native effect on C while creating, listing, ending,
and attaching sessions on A/B. Test acceptance racing lease construction,
source/destination fencing, completion, and restart with unresolved work.

## 3. Consolidate RPC, transport, and profile boundaries

### One session service

Remove GuestService and the five session methods from HostService. Mount the
same generated SessionService independently at all three endpoints:

- Controller: public authentication and machine routing.
- Host: authenticated controller identity and owned-machine admission.
- Guest: authenticated host/machine identity and rebind fencing.

MachineService and host administration remain separate. Share DTOs and forwarding
mechanics; keep endpoint-specific authorization local. The browser continues
using Desk's existing terminal mirror protocol and receives no private credential.

Regenerate Go and TypeScript, replace the vendored Desk SDK, update all Node/Go
callers and handler registrations, and remove retired methods/exports. Do not
dual-serve old contracts.

The guest enforces the consuming client's expected terminal-engine digest. Remove
host-side renderer/digest dependencies that only duplicate this check. Retain
DescribeGuest where its identity/incarnation/status data is needed; do not add a
discovery round-trip merely to echo the server's own digest.

### Transport lifetime

Consolidate peer-credential checks, limits, redirect policy, TLS construction
mechanics, and stream forwarding in the existing transport/identity packages.
Keep local guest administration and trust policies with their owners; avoid a
general server factory with protocol/authentication mode switches.

- Controller-to-host clients live for the controller process, keyed by configured
  host. Configuration and externally managed TLS credential replacement take
  effect on service restart; there is no hot-reload or cache-refresh API.
- Load the host's guest authority once. Create it only during explicit fresh host
  initialization. Missing authority alongside existing bindings is an error, not
  a reason to mint a replacement CA from an attach request.
- Keep guest clients with their verified machine binding and credential identity.
  Binding replacement invalidates their leases/transport. Reuse HTTP connections;
  release a request without closing the shared transport's idle connections.
  Service shutdown disposes all owned transports. No generic pool or reference
  counting framework is required.
- Preserve bounded certificate lifetimes and renewal. Check expiry before acquiring
  a lease; coordinate required guest rebind/renewal with the existing serialized
  native owner, fence that machine, persist/install its replacement binding, and
  publish a new epoch/client only after successful completion. Renewal must use
  the host lifetime, so caller cancellation cannot leave half-applied binding work
  presented as ready. Concurrent requests must not start duplicate renewals.
  Keep this one host-owned renewal path; do not add public RPCs or an independent
  background scheduler for it.
- Host-client certificate renewal also replaces the corresponding cached
  transports. Keep static deployment PKI and host-issued guest PKI lifecycles
  distinct. Expired/wrong identities fail closed.
- Retain native ownership/readiness verification unless a concrete replacement
  establishes the same fact. A cached endpoint and valid TLS identity alone are
  not proof that the current native machine is in the expected state.
- Do not retry an uncertain session mutation as part of endpoint/cache recovery.
  Preserve request-level token-file rereading where token rotation is supported.

Test connection reuse, renewal, expiry, rebind, endpoint changes, cancellation
during renewal, service restart, and wrong-role/machine rejection. Keep renewal
coordination small and within the existing host lifetime and reservation model.

### Portable profiles and host-local paths

Separate portable profile compatibility fields from host installation details.
The portable value includes ID, OS, architecture, runtime, CPU/RAM, disk sizes,
and image digest. Runtime artifact identity remains content-based.

Remove filesystem image paths from the controller profile and private RPC input.
Resolve them from host configuration using the requested portable identity and
digest, verify the full compatibility fields, and execute with the host-resolved
binding. Never persist or execute a caller-supplied filesystem path.

Remove persisted capabilities; derive them when converting a public profile.
Delete capability stripping, equality normalization, path-based pin fallback,
and public machine conversion overrides. Equality compares the portable value
directly. Keep runtime-local locations out of content identity.

Keep captured runtime/artifact ownership for checkpoint deletion. A later CPU/RAM
profile edit must not prevent deleting an owned Tart checkpoint. Continue checking
backing dependencies and native artifact ownership. Fork/restore compatibility
remains stricter and separate from deletion.

## 4. Correct errors and simplify the CLI

Introduce one shared typed domain error representation with a finite reason,
message, and retryable property. Construct it at the point the reason is known.
Remove host substring classification, controller HTTP-status fields, and redundant
string error vocabularies. Keep one explicit Connect translation at the RPC
boundary; domain code need not depend on Connect handlers or clients.

Distinguish missing rows from database failures and cancellation. Preserve
structured caller errors; log unexpected internal causes and return an appropriate
internal error. Preserve the distinction between admission rejection and a
durably accepted operation that later fails.

After an operation wait succeeds, use the parent context and ordinary bounded
read timeout for its summary. Parent cancellation still applies. On a failed
summary read, report the known successful operation/resource identity accurately.

Give checkpoint commands direct handlers and accurate help. Remove duplicated
redirect mechanics while retaining rotating token behavior and validation at
genuinely different boundaries. Remove the optional-file variadic and mTLS-only
repeated certificate parsing.

## 5. Simplify dev to one bundle and resumable ownership

Delete in-place bundle upgrades: `internal/dev/upgrade.go`, upgrade intents,
compatibility branches, private host SQL access, upgrade-only drain/fence logic,
migration guidance, and tests solely for that feature. Keep checks used by
ordinary stop/destroy and native process ownership.

A different bundle requires explicit destroy/recreate. Document that dev VM
contents are disposable when changing releases. Never delete automatically on
a bundle mismatch, and do not add a stopped-environment version-swap path.

Treat the bundle location as a locator and its verified content digest as identity.
Support `--bundle` on teardown for an identical bundle at another path. Repair
derived config/supervisor paths under environment/service ownership when necessary;
this is same-artifact location repair, not permission to change executable content.
Test both running and stopped host services after the old bundle directory is gone.
If no matching artifact is available, report exactly what is needed; do not execute
an arbitrary newer bundle against the environment.

Keep one authoritative binding between environment, namespace, and owned host
root. An application-level owner marker alone does not prove environment ownership.
Make initialization idempotent under the environment lock, including interruption
between creating host state and completing its environment-bound ownership marker.
Collapse redundant markers only if the surviving proof rejects foreign roots.

Ordinary stop/destroy resumes via durable product operations and exact supervisor
ownership. Keep isolated environments, documented connection.json/CLI/Desk configs,
and same-bundle service restart with live VMs. Remove old-format environments
operationally during reset; new code supports one current format without migrations.

## 6. Release inputs, tests, and repository cleanup

### Release ownership and integrity

Use `scripts/release/inputs/` for tracked engine pins, runtime.patch, and the
release-consumed agent/source provenance currently under spikes/evidence. Update
every build, image staging, qualification, and documentation reference.

Make source licenses and collected dependency notices explicit builder inputs.
Enumerate required files and provenance/inventory and validate them before builds.
No silent LICENSE glob, undocumented .work dependency, or directory-exists-only
notice check. Validate the resulting release inventory as well.

Verify privately staged bundle contents once at the publication boundary and
retain path/ownership checks around atomic rename. Remove a second identical
full hash only when no intervening mutation is possible. Keep manifest metadata,
permissions, symlink safety, content digests, and image pin verification.

### Delete or consolidate

- Remove runtime-cache adoption, legacy pins, obsolete migration tests, unused
  protocol members, unused server members, SSH fixtures, test-only production
  constants, placeholder imports, redundant returns, and ineffective GNU PAX
  assignments. Keep used daemon Options/paths and checked integer conversions.
- Remove duplicate post-accept suspension/read work. Retain queue guards or
  repeated validation only when they protect distinct entry points/transformed
  input; keep their purpose evident.
- Remove test-only Connect packages from SDK runtime dependencies after checking
  generated and exported imports. Applications declare their runtime dependencies.
- Remove goconst/mnd/testpackage enforcement and golines-driven wrapping; keep Go
  formatting/import ordering and meaningful correctness/security checks. Relax
  other shape-only lint thresholds where they force artificial helper extraction.
  Delete resulting lint artifacts; retain justified process-lifetime handling.
- Promote valuable native checks into maintained acceptance tests before removing
  duplicated spike daemons/protocols. Remove spent cold-cutover, prod-cold-bootstrap,
  and restore-recovery programs once their useful checks are covered. Keep
  tart-gate as qualification until its replacement exists. Fix its stale probe
  fallback and track any drivers for retained gates. Build outputs belong in .work,
  not source directories; correct unanchored ignores.
- Archive useful qualification records. Keep the original implementation report
  historical; update the old plan's stale current findings. Current README,
  terminal, and dev documentation describe current behavior/version. Keep deployment
  topology and reset/update instructions in personal-cloud.

### Checks

Add the Python image/release/harness tests to `make test`. Keep current
authentication, public-field privacy, exact uint64, and lifecycle-contract tests;
remove only tests tied solely to deleted implementations. Restore meaningful host
ambiguity, token-path, and formatted resource-output coverage. Keep the existing
Python-to-Go canonical inventory agreement test.

Run Go build/vet/race/lint, SDK generation/build/schema tests, and Clankerdesk's
existing Vite+ checks/tests/build; follow its repository guidance, without a second
toolchain. Verify generation produces no unexplained diff.

Run Python archive-header checks on Linux even when Apple-tar-specific cases skip.
Run actual archive creation/extraction and metadata checks on both a Linux amd64
host and macOS arm64 host, recording commands and platform versions. Do not assume
an unconfigured CI matrix will provide these checks.

## Implementation order and ownership

| Stage | Main files/responsibility | Exit condition |
| --- | --- | --- |
| 1. Failure-path fixes | guest/session, daemon lifetime, relay EOF, client summary, domain errors, checkpoint deletion | Focused regressions and race tests pass |
| 2. Shared contracts | protos/generated code, rpcmodel profiles/errors, host-local image resolution, shared SessionService, Desk SDK/dispatcher and ACK ordering | All callers build together; auth, bootstrap, and schema tests pass |
| 3. Admission and clients | host service/guest registry, transport/identity lifetime and renewal | Unrelated-machine responsiveness; reservation/rebind/renewal races and restart tests pass |
| 4. Dev and removal | dev bundle/ownership/supervision, runtime cache/pins, obsolete compatibility paths | Fresh init, interrupted init/teardown, locator repair, isolation, same-bundle restart pass |
| 5. Packaging and cleanup | release inputs/scripts, lint, dead code, CLI, tests/spikes/docs; personal-cloud definitions | Full local checks and archive tests on both platforms pass |
| 6. Fresh deployment | personal-cloud reset/install, matching Desk deployment, real clients | Empty-state inventory, native acceptance, manual UI verification, final operating record |

Keep commits buildable within that order; pair schema and consumer changes.
ACK-ordering behavior changes with the Desk consumer in stage 2, not before it.
Do not deploy partial stages. Implement modules in the existing repositories;
introduce a package only for a real responsibility boundary, not a forwarding layer.

Regression evidence must cover close/create/exit races, finite EOF draining,
bounded input during an 8 MiB prefix through a direct SDK client, independent
viewers, unrelated-machine session operations during a long mutation, source and
destination fencing, failed/ambiguous operations, certificate renewal/expiry,
profile-edit checkpoint deletion, deadline-boundary summaries, and interrupted
dev lifecycle/identical-bundle relocation. Use synchronization to expose races;
avoid timing-only assertions and tests that merely mirror new helpers.

## Reset and deployment

Use current personal-cloud controller/runtime and Desk runbooks for topology,
service identities, secret handling, and deployment commands. Replace their
historical preservation requirements and obsolete profiles/guards as part of
this change. Do not run archived migration scripts or require orphan-preservation
checks before the authorized reset.

1. **Qualify and stage.** Build complete new bundles/images for macOS arm64 and
   Linux amd64, including the macOS guest where required. Qualify with isolated
   empty environments. Stage matching server/host/guest, CLI, SDK/Desk, and service
   definitions before stopping production. Verify release hashes, notices, modes,
   signatures, and candidate network behavior.
2. **Inventory deletion scope.** List exact native VM identifiers, supervisors,
   guest/checkpoint/backing disks, host/controller journals and caches, dev and
   qualification roots, Desk data, and retired cutover directories. Include
   abandoned/quarantined Clankerbox resources, not just public API listings. Mark
   reusable Tart seeds/base images and unrelated workloads as exclusions. Preserve
   any old tools needed for native cleanup until their resources are removed.
3. **Stop creators.** Fence relevant ingress; stop Desk workers, controller, and
   host services and disable their restart mechanisms for the reset. Verify that
   no background reconciler or job can recreate deleted application resources.
4. **Remove application resources.** Stop/remove the inventoried native VMs through
   owning engine/supervisor tools, then delete their owned disks, checkpoints,
   caches, and journals. Remove obsolete cutover directories after their tools and
   runtime files are no longer in use. Check backing relationships before shared
   path removal. Use Desk's documented Fresh deployment procedure for the whole
   data directory and deployment bundles, retaining secrets. This resets catalogs,
   allocations, terminals, canvases, and the extension library consistently.
5. **Retire preservation scaffolding.** Drop the historical retained profiles and
   orphan-specific retained_guard/backup-runner integration and tests. Remove the
   explicit configured operator-quarantine feature with its retired use case;
   keep ordinary unresolved-operation and unknown-native-state protections.
   Preserve future backup consistency checks. Update canonical service configs
   and runbooks so no deleted machine/path is required.
6. **Install fresh services.** Confirm empty native/application inventories.
   Install/start the new hosts and controller with current-format empty state.
   Initialize guest trust through the explicit fresh-host path. Deploy the Desk
   server image with the matching SDK; its normal post-deploy hook republishes
   built-in extensions. Verify macOS signing and Local Network access at the final
   executable identity/path before restoring ingress; isolated qualification does
   not by itself establish the production permission grant.
7. **Verify actual behavior.** Exercise Linux amd64 and macOS arm64 smolvm:
   stop/start, RAM fork, capture/source deletion/two restores, independent restored
   disks, checkpoint deletion, and cleanup. Exercise Tart cold lifecycle, stopped
   fork/capture/restore, profile-edit deletion, and running-copy rejection. Test
   public bidi RPC and negative identity cases through actual ingress.
8. **Verify Desk manually.** Use two actual browser viewers for terminal creation,
   typing, resize, reconnect/resume, and shape-owned cleanup. Restart Desk,
   controller, and host while a guest shell remains alive, then verify the same
   session. Check unrelated-machine responsiveness during mutation. Use the
   maintained SDK harness for explicit stalled-reader and pre-bootstrap-input
   scenarios that Desk's UI does not expose. Inspect browser/server errors and
   native inventories, not only HTTP health.
9. **Finish cleanly.** Remove test resources; confirm no unresolved operations,
   leaked jobs/disks, or stale Desk allocations. Leave the application empty.
   Record exact deployed commits/artifacts and results in personal-cloud and run
   affected deployment checks. If qualification fails, keep admission closed,
   correct the candidate, and redeploy from empty state. A rollback also uses a
   consistent release with a separate reset, never incompatible journal restoration.

Read only required keys from the canonical 1Password Environment using its owning
workflow; never log or commit values. Preserve existing network boundaries and
signing identities. If sudo or macOS privacy interaction is required, report the
exact action and continue independent work; do not infer approval from elapsed
time or repeatedly request authorization already granted.

## Review disposition and completion

The independent review informed the shared schema, host-owned image binding,
ACK interleaving, precise EOF behavior, authority initialization, explicit Desk
reset, and release-input/test ownership above.

We deliberately do not adopt concurrent host mutation acceptance, a global
admission epoch, ten-year leaf certificates, transparent mutation retry, removal
of native ownership checks based only on TLS, unconditional ownership-marker
deletion, or a stopped-environment version upgrade. These expand behavior or
weaken an invariant without being necessary to fix the verified issues.

The original 42 findings are covered by the work above: actual correctness and
recovery defects are fixed; verified dead/duplicated code is removed; subjective
cleanup is included where it reduces maintained concepts. Identity linearization,
decoder compatibility, useful historical evidence, live-contract tests, and
ordinary crash/ownership protections remain intentional.

Complete means all stages pass, the matching new deployment works through real
clients, and current docs/operating records match it. Report remaining failures
explicitly and include handwritten/generated code and dependency deltas. A green
unit suite, smaller diff, or healthy HTTP endpoint alone does not establish
completion. The completed validation and deployed artifacts are recorded below.


## Completion record — 2026-09-13

The clean-break implementation shipped as v0.3.0. Both release archives passed
exact file/mode/link inventory and notice checks. The installed Linux and signed
Mac host/guest binaries matched the qualified artifacts, including hashes read
inside real production guests. Local CLI installation uses the published bundle.

- Go race tests, vet, lint, Python release/image tests, SDK generation/build/tests,
  Desk quality/build/browser tests and personal-cloud validation passed.
- Linux and macOS smolvm passed the full RAM lifecycle/fork/checkpoint matrix,
  independent restored disk checks, active-stream shutdown and dev bundle relocation.
  Production Linux and Tart passed lifecycle/session/isolation and full checkpoint
  acceptance. Tart additionally passed running-copy rejection and checkpoint
  deletion after a profile edit. The exact production profile was restored.
- The final signed Mac system LaunchDaemon reached Tart guests from its production
  executable path; no additional Local Network permission was needed after installation.
- Two Desk browser viewers kept the same guest shell and file through resize,
  reload and Desk/controller/Linux-host restarts. Unrelated guest RPC remained
  responsive during native mutation. Terminal closure was verified in the browser;
  the normal shape API completed machine closure after browser automation stalled
  on its confirmation. All test resources were removed and Desk reset to empty.
- Final public/native inventories were empty, with no unfinished or failed
  controller/host operations. Deployment health, access restrictions and the
  first post-release backup export/SQLite verification passed. Source checkouts,
  reusable bases, PKI and unrelated infrastructure were retained.

Production source is `725122d`; `c9d4fe8` subsequently corrected only the SDK
qualification harness to inspect inherited environment keys before Apple's Python
launcher adds developer-tool variables. No product binary or allowed key set changed.
Clankerdesk source is `466ed41`; its immutable image was deployed by personal-cloud
`def78ac`. Exact deployed hashes and operating results live in personal-cloud's
controller/runtime and Desk runbooks.

Rename-aware implementation deltas through `c9d4fe8` are 2,268 fewer handwritten
source lines (including release tools and removed spike programs), 3,788 fewer
generated lines, and 1,207 additional test/harness lines. Product source alone grew
90 lines; the overall Clankerbox change removed 4,219 lines. Desk added 178 lines,
154 of them tests. Archive moves are not counted as source deletions. No new
external dependencies were added; Connect moved from SDK runtime to development
dependencies, and obsolete spike dependency graphs were removed.
