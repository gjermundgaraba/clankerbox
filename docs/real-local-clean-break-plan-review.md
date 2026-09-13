# Independent architecture review: `docs/real-local-clean-break-plan.md`

Reviewed against clankerbox `d4c5120` (working tree, read-only), clankerdesk `main`,
and personal-cloud `main`. All line references are to the current source. No code,
docs, configuration, or the plan were modified. No builds, installers, VM, network
or secret commands were run.

## Overall judgment

The plan targets real defects. Every headline defect I checked exists in the source:
the guest manager does not own its workloads at shutdown, the relay turns a clean
client EOF into an upstream cancellation, every guest lease is serialized behind the
native mutation mutex, controller→host and host→guest transports are rebuilt per
call, checkpoint deletion demands an equal live profile, host errors are classified
by substring, and release assembly reads mandatory inputs from spike and evidence
trees. The architectural decisions (keep controller/host/guest ownership, one
SessionService, serialized native effects, mandatory engine digest, no new
dependencies) are sound.

The plan is **not yet ready to implement as written**. It has four problems that
would change the resulting design, not just its wording:

1. **Admission scope is too narrow.** The plan decouples *guest leases* from the
   native lock but leaves *operation acceptance* (`SubmitOperation`) behind the
   same lock, so the "host busy" symptom already recorded in production persists.
2. **The private profile binding still carries host filesystem paths across the
   trust boundary, and the host executes the path the controller sends.** The plan
   removes capabilities but keeps this coupling; under a full reset it should go.
3. **The stream ordering requirement for ACKs is stronger than the product needs and
   creates the very machinery the plan wants to avoid.** The Desk never sends input
   during bootstrap, and letting ACKs interleave with bootstrap chunks removes the
   need for a separate bounded ACK queue.
4. **The reset section contradicts the runbooks it names as owners**, is imprecise
   about Desk stores, and is inaccurate about extension revisions carrying SDK
   behavior.

Beyond those, decision 5 (delete in-place dev upgrades) deletes more product
behavior than necessary; a stopped-environment bundle swap keeps VM disks with a
fraction of the current machinery. Several smaller gaps (release inputs read from
the evidence tree, no CI to satisfy "both platforms", lease-path certificate
renewal and authority creation, module naming) need one-line amendments.

With the amendments in the checklist at the end, the plan is ready to implement.

---

## Method and limits

I read the plan, the three repositories' guidance files (clankerbox has no
`AGENTS.md`; clankerdesk and personal-cloud do), the Clankerdesk product,
architecture and terminal docs, the Desk guest consumer, the personal-cloud
controller/runtime/Desk runbooks, and the clankerbox packages the plan touches:
`internal/guest/{session,daemon}`, `internal/host`, `internal/control`,
`internal/rpctransport`, `internal/rpcidentity`, `internal/rpcmodel`,
`internal/model`, `internal/dev`, `internal/client`, `cmd/*`, `protocol/`,
`scripts/release/`, `tests/`, and the `spikes/real-local-engine` tree.

The "validation response" whose IDs the disposition map cites is not in the
repository, so I did not re-audit those 42 items; I assessed the plan on its own
terms against the source. I could not verify live host state, and I did not run
tests.

---

## Findings

Findings are ordered by how much they change the design. "Blocking" means the
plan should be amended before implementation starts; "amend" means a wording or
scope fix; "local" means an implementation choice that can stay with the
implementer.

### F1. Acceptance is still coupled to the native lock (blocking)

**Claim.** The plan separates "the native execution lock from a short
admission/guest-registry lock" for guest leases, but `SubmitOperation` acceptance
also takes the native mutex and returns `ErrBusy` for the whole duration of any
running native effect on *any* machine.

**Evidence.**
- `internal/host/service.go:98-101` — `Submit` does `h.mu.TryLock()` and returns
  `ErrBusy`; `:106` runs `executeLocked(ctx, req, true)` (accept-only, journal
  writes) under it.
- `internal/host/host.go:429-431` — `Execute` holds the same `h.mu` plus the
  `.lock` flock across the entire native effect; `service.go:22` bounds one
  effect at six minutes.
- `internal/host/guest_rpc.go:87-90` — `leaseGuest` uses the same `h.mu.TryLock()`.
- Production symptom: personal-cloud `deployments/clankerdesk/README.md`
  ("Explicit terminal close initially received typed host-busy admission while a
  separate lifecycle test ran").

**Why it matters.** Even after per-machine lease fencing, a `stop` or `delete` on
machine A cannot be *accepted* while a `create` on C is copying an image. The
controller's queue then retries every five seconds (`internal/control/queue.go:187`,
`control.go:31`), and Desk close/retry flows see `unavailable`. Acceptance is
journal-only: `acceptLifecycle` (`host.go:802-841`) and `executeDerived`
(`checkpoint.go:103-156`) read/write SQLite; the only native call on the acceptance
path is a read-only inventory listing in `derivedSource` (`checkpoint.go:233`).

**Amendment.** State explicitly: *acceptance must never wait on a running native
effect.* Introduce the ordering: `Service.mu` → journal (SQLite, already a single
connection) → registry lock, and `native` (flock + mutex) → journal → registry.
`Submit` takes the journal path only; the single worker still executes effects in
journal order. `ErrBusy` should only be possible for concurrent *acceptances*, and
even that can be a short blocking wait rather than a TryLock. This is a small code
change but a different lock design from what the plan describes.

### F2. Per-machine fencing: keep the reservation set, but define its invariant and consider the simpler epoch form (amend)

**Claim.** The plan's "reconstruct reservations from unfinished journal records
before exposing guest RPCs after restart" is correct in principle but the plan
does not say why an in-memory reservation is needed at all (the journal already
refuses destination leases) or what invariant it maintains.

**Evidence.**
- `internal/host/guest.go:37-47` — `readyMachine` already refuses a lease when the
  machine's current-generation operation is not `succeeded`. That covers
  destinations after restart with no reconstruction.
- It does **not** cover *sources* of fork/capture: `resourceIdle`
  (`checkpoint.go:48-76`) is only consulted at acceptance, not at lease time.
- The race that needs an in-memory structure: lease reads journal (idle) →
  acceptance commits and calls `suspend` (`host.go:328-330`, `service.go:112`) →
  lease registers → escapes fencing. Today this is prevented only because both
  paths hold `h.mu` (the thing F1 and the plan remove).

**Amendment.** Write the invariant into the plan:

> Under the registry lock, `reserved ⊇ {machine_id, source_machine_id}` of every
> journal operation whose status is not `succeeded`/`failed`. It is updated after
> every journal commit that changes an operation's terminal status, and is
> initialized from `pending()` before the listener accepts connections. Lease
> registration checks it under the same lock; acceptance adds to it and cancels
> existing leases under the same lock.

Simpler alternative worth considering: a single `admissionEpoch uint64` under the
registry lock, incremented on every acceptance commit. A lease captures the epoch
before its journal check (`readyMachine` + a `resourceIdle` for the machine as
source), builds its client outside locks, and at registration refuses (retryable)
if the epoch moved. That needs no per-machine set and no startup reconstruction:
the journal is the only truth, and the false-rejection window is one lease build
during a rare acceptance. Either design is acceptable; the plan should pick one and
state the invariant. Also fold the source-side `resourceIdle` check into the lease
path, which the plan's "affected source/destination" wording implies but the
current lease path lacks.

### F3. The lease path hides mutations and expensive work; "required readiness checks" is undefined (blocking for the transport stage)

**Claim.** The plan says to reuse transports but "keep required native readiness
checks". The current lease path does far more than a readiness check, including a
native mutation and authority creation, and the plan does not say which of these
survive.

**Evidence** (`internal/host/guest_rpc.go`, all under the coarse lock today):
- `:91` `readyMachine` → `guest.go:48` `h.observation` → `runtime.Inspect`, a
  native subprocess (`runtime.go:133-167`) on **every** session RPC and reconnect.
- `:95` `rpcidentity.LoadOrCreate` re-opens the authority directory per call, and
  `rpcidentity/storage.go:38-58` **creates a new CA** if `authority.pem` is
  absent. A misconfigured root would silently mint a new authority from a lease.
- `:115-122` if the guest binding certificate is `Expiring`, the lease path calls
  `h.guests.suspend` and `h.runtime.Verify` — a native re-bootstrap of the guest
  binding, triggered by a terminal attach.
- `:100` `authority.HostCredentials` reads/renews the 30-day host client
  certificate (`rpcidentity/identity.go:129`) per call.
- `:153` `describe()` requires the guest's engine digest to equal the **host
  binary's** embedded engine (`vt.AssetSHA256`), which is why the host imports
  `internal/guest/vt` and therefore embeds the Ghostty wasm blob
  (`internal/guest/vt/assets.go:17`).

**Amendment.** Specify the lease path precisely:

- Authority and host credentials are loaded once at host start; a missing authority
  is a startup error, never created lazily.
- Guest binding renewal is a lifecycle event (rebind on start/fork/restore already
  exists: `host.go:706-710`, `checkpoint.go:352`), not a side effect of attach.
  Issue binding certificates for the authority's lifetime (10 years,
  `identity.go:64`) instead of 30 days (`identity.go:151`); the binding is already
  replaced on every generation change and RAM copy.
- Per-call readiness = journal check (ownership, prepared, current generation
  succeeded, not reserved as machine or source) + the TLS identity of the cached
  transport. Drop the per-call native `Inspect`; the persisted `Endpoint` is set
  by the operation that made the machine running. If a cached transport fails to
  dial, re-resolve the endpoint once via `Inspect` and retry, then fail.
- Remove the host-side engine digest comparison (the guest enforces the caller's
  `expected_engine_digest` at `daemon/service.go:247`) and the `vt` import from
  the host, which also removes the wasm asset from the host binary. This is what
  the plan's "use the client's own terminal-engine digest" already implies; say
  it explicitly.

Keep `describe()` only where its identity/incarnation output is used (InspectMachine's
guest status); the plan's wording already allows this.

### F4. ACK ordering: the requirement is stronger than needed and creates the machinery the plan forbids (blocking for stage 1 scope)

**Claim.** "The writer preserves Opened, complete prefix, then live events/acks
ordering" plus "Control acknowledgements are bounded" forces a second, separately
bounded ACK buffer per attachment. That buffer is unnecessary if ACKs may interleave
with bootstrap chunks, which is safe because an ACK carries no terminal state.

**Evidence.**
- Today controls are not read until the prefix drains
  (`daemon/service.go:351-355`); the test `TestResumePrefixPrecedesControls`
  (`daemon/service_test.go:151-224`) pins that behavior.
- The Desk rejects **any** non-chunk event during snapshot bootstrap and any
  non-output event during resume replay (`clankerdesk/apps/server/src/guest-terminal.ts:314-317`),
  so today's gate is what keeps the Desk consumer happy.
- But the Desk never sends input during bootstrap: input requires
  `guest.connected && session.status === "running"`
  (`clankerdesk/apps/server/src/terminals.ts:193-196`), and `running` is published
  only after a live bootstrap completes (`docs/terminal.md`). So the "slow viewer
  with an 8 MiB prefix types while the prefix drains" scenario cannot occur through
  the product path; it can only occur for a direct SDK/CLI client.
- The per-attachment sink queue is already bounded (`sinkQueueSize = 32`,
  `service.go:444`) and `put` applies backpressure only to that attachment's
  producers; output from input applied during the prefix is enqueued in the
  subscriber tail (`session.go:200-202`) and is delivered after the prefix by
  construction (`subscriber.go:98-127`).

**Amendment.** Replace the ordering requirement with:

> Opened first; bootstrap chunks (or resume prefix output) complete before any
> live output/resized/exited/gap event. `Ack` events may appear at any point after
> `Opened`, including between bootstrap chunks, because they carry no terminal
> state. One bounded per-attachment event queue carries chunks and acks in
> arrival order; a blocked viewer backpressures only its own control reader.

Then: delete the bootstrap gate in `receiveControls`, invert
`TestResumePrefixPrecedesControls` into "input during prefix is admitted and its
echo follows the prefix", and update Desk `dispatch` to exempt `ack` from the two
overtaking checks. This is a one-line Desk change in the same release, which the
plan already requires for the SDK. No separate ACK buffer, no ACK memory bound
beyond the existing queue.

### F5. Relay EOF parity: confirmed defect; define "already accepted events" (amend)

**Evidence.** `internal/rpctransport/relay.go:91-108` — `relayControls` runs
`defer cancel()`; a clean downstream `io.EOF` cancels the upstream context, so the
guest sees cancellation (`daemon/service.go:322-323`) and the relay returns the
cancellation error, whereas a direct guest attachment returns `nil` on EOF
(`service.go:326-328`). The controller relay (`control/session_rpc.go:107-127`)
inherits the same behavior through two hops.

**Amendment.** Specify: on clean downstream EOF the relay calls `up.CloseRequest()`
and keeps forwarding `up.Receive()` until upstream EOF; cancellation and errors
keep the current cancel path. Define "already accepted events" as *events already
enqueued in the attachment's writer queue at the moment EOF is observed*; events
still in the subscriber tail are dropped, which preserves the documented
detach-on-EOF contract (`docs/terminal-sessions.md`, "closing a viewer only
detaches consumers") and avoids waiting for the shell. The plan's acceptance case
("direct, one-relay, two-relay parity") is the right test.

### F6. Guest manager shutdown: confirmed defect; the fix is smaller than the plan implies (amend, local)

**Evidence.**
- `internal/guest/session/manager.go:197-201` — `Close` stops only the retention
  ticker ("Sessions are not ended; the process exit ends them") and panics on a
  second call (`close(m.stop)`).
- Workloads are killed with SIGKILL by context cancellation
  (`session.go:118` `exec.CommandContext(opts.ctx, …)`), not gracefully.
- `waitLoop` (`session.go:205-234`) then calls `capture(s.term)` and `term.Close()`
  while `Server.Close` (`daemon/serve.go:163-190`) has already called
  `loader.Close`, so persistence and terminal use race daemon teardown.

**What the plan gets right.** Idempotent close, refuse new creates, join
`waitDone` for every live session before the loader/directory close, snapshot
under the manager lock and wait outside it.

**Simplification.** `Session.end()` (`session.go:397-425`) already implements the
escalation ladder (SIGHUP to the foreground group → SIGTERM → SIGKILL, each
bounded, then wait). `Manager.Close` can set a `closed` flag under `m.mu`, snapshot
`live`, call `end()` on each concurrently, and join `waitDone`. `Create` already
holds `m.mu` across the whole `spawn` (`manager.go:207-258`), so a `closed` check
at the top of `Create` linearizes "creation racing shutdown" with no additional
structure. The "unbounded shutdown wait" concern is only the final `<-s.waitDone`
after SIGKILL; a bound there is fine but it is a local choice, not a design point.
Also stop using `CommandContext` for the child (or set `cmd.Cancel`) so the daemon
context no longer SIGKILLs workloads behind the manager's back.

### F7. `ProfileBinding.image_path` couples the controller to host filesystem layout, and the host executes the sent path (blocking)

**Claim.** The plan removes capabilities from persisted/private identity but keeps
the private binding's image path. Under a full reset this is the coupling to remove;
it is also currently weaker than its own comment claims.

**Evidence.**
- `protocol/clankerbox/v1/host.proto` — `ProfileBinding { Profile profile; string image_path; }`
  with the comment "The host must validate this exact binding against its trusted
  installed profile."
- `internal/host/host.go:819` validates via `h.profile(req.Profile)` →
  `model.SameProfile` (`internal/model/model.go:109-118`), which **erases
  `ImagePath` from the comparison whenever the digests match**.
- `host.go:852` then stores the *request's* profile in the manifest, and the
  runtime uses `m.Profile.ImagePath` for `clone`/`cp -a`
  (`internal/host/runtime.go:176,196`, `checkpoint_runtime.go:367`).
- The controller's config therefore has to know each host's private image path
  (`model.Profile.ImagePath` is required by `Profile.Validate`, `model.go:84`),
  and `rpcmodel.ToProfileBinding` (`resources.go:74-76`) ships it.

**Amendment.** Add to "Remove capabilities from persisted profiles and private
runtime identity inputs": remove `image_path` from the wire and from the controller
profile model. The host resolves the installation path from its own `service.json`
profile by `id` + `image_digest`; the manifest stores the host's path, never the
caller's. `SameProfile` becomes a plain equality of the compatibility fields
(id, os, arch, runtime, cpu, ram, storage, overlay, image_digest) with no
normalization at all, which is what the plan's "remove equality normalization"
already wants. This also deletes `FromProfileBinding`'s path handling and the
legacy branch of `runtimePin` (`host/checkpoint.go:42-46`).

### F8. Error vocabulary: the plan keeps two vocabularies plus a mapping table (amend, simplification)

**Evidence.** Controller: `APIError{Code string, Status int}`
(`control/control.go:52-59`), mapped by `rpcError` using `Status == 503` as the
retryability signal (`control/rpc.go:20-25`). Host: substring classification
(`host/rpc.go:108-130`). Guest: `protocol.Error{Code string}` mapped by
`rpcmodel.ToError` (`rpcmodel/errors.go:53-55`). All three funnel into
`rpcmodel.Reason(code string)` (`errors.go:77-127`), a 25-case string switch.

**Amendment.** "Small domain error vocabulary" should mean **one Go error type
carrying the generated `v1.ErrorReason` enum, a message and `Retryable`**, used
by controller, host and guest domain code, so `Reason()`, `APIError.Status`, and
the substring switch all disappear and the RPC boundary only calls `StatusCode`.
Keep `sql.ErrNoRows` → `NOT_FOUND`, context errors → Connect canceled/deadline, and
everything else → `INTERNAL` without leaking messages, as the plan says.

### F9. Decision 5: deleting in-place upgrades is more than the simplification requires (design challenge)

**What exists.** `internal/dev/upgrade.go` (342 lines) reads the host SQLite
journal directly (`:96-144`, `:257-293`), takes the host's mutation flock
(`:233-252`), and inspects supervisor state (`:295-342`) so the host service can be
replaced **without stopping VMs**. Plus `restore`/`restoreUpgrade` in `dev.go:200-240`,
`upgrade_drain_test.go`, `TestCompatibleBundleUpgradePinsRuntimeImageAndProfile`, and
`docs/local-development.md` "Compatible service updates".

**Assessment.** The layering violation (dev depends on the host journal schema and
locks) and the live-swap machinery should go. But the plan replaces the *whole*
feature with destroy/recreate, which discards the VM's disk (installed tools,
cloned repositories) on every clankerbox release. The dev VM has no host mounts, so
that is real user data loss for a local dev tool.

**Recommendation.** Keep "same runtime/image/profile digests → service code may
change" as a *stopped-environment* operation:

1. `dev stop` (existing, uses ordinary durable operations; refuses on any unsettled
   operation — `teardown.go:111-135`).
2. `dev --bundle NEW` on a stopped environment: if `runtime_digest`, `image_digest`
   and the profile fields match the retained manifest, rewrite `environment.json`
   and the unit definition, then start normally; otherwise refuse with the
   destroy/recreate message. "Stopped" is proven by acquiring the host root's
   `.service.lock` non-blocking (as `upgradeStoppedService` does at `:321`), no
   supervisor probing.

That is ~40 lines, deletes every drain/fence/journal path the plan wants gone, and
keeps disks. Sessions end because VMs stop, which the docs already state for
`dev stop`. If the user still prefers the immutable pin, that is a legitimate
product call; the plan should then say plainly that dev VM contents are disposable
on every release.

Two related gaps either way:

- **Teardown with a missing or relocated bundle.** `teardown` opens the
  environment with no bundle (`teardown.go:35`), so `restore` fails with "retained
  bundle changed; pass --bundle" (`dev.go:212-215`) if the pinned bundle directory
  moved or was deleted, and the environment cannot be stopped or destroyed. The plan
  says stop/destroy "ignore a caller's proposed replacement bundle"; it must instead
  say they *accept a same-digest bundle at any path* and refuse a different digest.
- **Resumable initialization.** Ownership intent is already written first
  (`environment.json`, `dev.go:159-190`) and the host root is created later
  (`prepareHostRoot`, `dev.go:326-347`). The non-resumable window is between
  `host.Open` and the `dev-owner.json` write, because `host.Open` refuses a
  non-empty root (`host.go:939-958`) so the marker cannot be written first.
  Simplest fix: drop `dev-owner.json` entirely. `environment.json` already names
  `HostRoot`, which is a deterministic hash of the canonical state path, and the
  host's own `.owner` marker already refuses foreign directories. Then `prepare()` is
  idempotent and any partial initialization resumes under the environment lock.

### F10. Reset section: contradictions, imprecision, and one inaccuracy (blocking for stage 5 wording)

- **Runbooks contradict the plan.** The plan names
  `personal-cloud/hosts/clankerbox-controller/README.md` as the owning instruction,
  but that runbook mandates *preserving* machine `ad8cd000…`, the quarantined orphan
  `3170fea0…`, and "Live retained paths: do not delete" for the
  `clankerbox-cutover` runtime and image directories
  (`hosts/clankerbox-runtime/README.md`, "Live retained paths"). The plan must say
  those clauses are superseded and must be rewritten in the same change, and must
  list the live paths as either replaced by the new bundles or explicitly kept
  (the Tart image `seed-macos26.6.2-xcode26.6` and Ubuntu base archives are
  "reusable image sources" and stay; the `clankerbox-cutover/*` staging
  directories are Clankerbox-owned and go).
- **Quarantine machinery exists only for the orphan.** `Config.QuarantinedMachineIDs`
  (`host.go:28`), `internal/host/quarantine.go`, and `quarantine_test.go` have no
  purpose after the reset. Add them to the deletion list.
- **Retained v2 profiles.** `linux-host.json` keeps v2 Linux profiles for the
  retained machine (runtime runbook). Decide: drop them with the machine.
- **Desk reset scope.** "Reset affected Desk workspaces/resource stores together" is
  ambiguous. The Desk data directory holds `catalog.sqlite`, `machines.sqlite`,
  `terminals.sqlite`, `library/library.sqlite`, and one canvas database per
  workspace generation (`deployments/clankerdesk/README.md`, "Backup and restore").
  A partial reset (allocations and terminals only) leaves canvas shapes that own
  deleted resources; the sync authority refuses raw resource deletion. The plan
  should name the documented **"Fresh deployment"** procedure (delete the data
  directory contents, keep `secrets`, redeploy) as the reset, and say so.
- **Extension revisions do not carry the SDK.** `@clankerbox/sdk` is a dependency of
  the Desk *server* (`apps/server/package.json`), not of extension packages;
  extensions call host capabilities. The sentence "Include any activated extension
  revisions that would reload old SDK behavior" is inaccurate. The post-deploy hook
  republishes built-in extensions on every deploy; a full data reset empties the
  library anyway. Rewrite as: "Deploy the Desk image whose server SDK matches the
  new contract; built-ins are republished by post-deploy."

### F11. Release inputs: the plan covers pins/patch but not the other out-of-tree reads (amend)

**Evidence** (`scripts/release/bundle.py`):
- `:45-50` pins and patch from `spikes/real-local-engine/` (covered by the plan).
- `:52` the amd64 agent hash comes from
  `spikes/real-local-engine/evidence/linux-image/sources.json` — an evidence tree.
- `:103-104` smolvm LICENSE files are globbed from `.work/real-local-engine/source`;
  `.work/` is gitignored, and a missing directory yields an **empty glob with no
  error**, i.e. a bundle without the engine's license.
- `:106-108` notices from `.work/real-local-release/notices`, gated only by
  directory existence, not by an expected inventory.

**Amendment.** Extend "release construction must not read mandatory inputs from a
historical evidence tree" to cover `sources.json`, the LICENSE glob and the notices
directory; make each an explicit enumerated input with a pinned hash or inventory,
fail before `go build`, and validate the output inventory (the plan already says
the last part).

### F12. "Both platforms" archive tests have no CI to run on (amend)

clankerbox has no `.github` directory; clankerdesk does. `make test` runs only
`go test -race ./...` (`Makefile`); the Python tests are documented in
`tests/README.md` but not wired in (the plan fixes that). "Archive tests cover …
extraction on both macOS and Linux" therefore needs to say *how* the Linux run is
produced (a make target executed on the Linux host during stage 4, recorded as
evidence) or it is an unverifiable claim.

### F13. Transport rotation: don't build what the process model doesn't need (amend, simplification)

- Controller→host: `hostClient` builds a new `http.Client`, reads certificate files
  and constructs TLS config on **every** call (`control/rpc_transport.go:23-38`,
  `:42-46`; `session_rpc.go:47,67`), including every inspect in a list. The
  controller loads its config once at startup (`cmd/clankerbox-server/main.go:82-84`).
  So "certificate rotation/configuration changes explicitly replace clients" should
  reduce to: transports live for the controller process; rotation is a restart. No
  replacement API.
- Host→guest: with F3's long-lived bindings, the only replacement triggers are
  rebind (generation change, fork, restore) and shutdown, which the plan already
  lists. The acceptance case "client reuse plus certificate renewal/expiry" should be
  rewritten as "rebind invalidates cached transports" unless renewal is kept.

### F14. Module and spike naming is ambiguous (amend)

"Remove the four completed one-shot migration/recovery modules" — the nested Go
modules under `spikes/real-local-engine/` are `cold-cutover`, `prod-cold-bootstrap`,
`restore-recovery`, and `tart-gate`. `tart-gate` is a qualification gate that
imports product packages via `replace clankerbox => ../../..` (its `go.mod`), i.e.
the "retained gate whose drivers must be tracked". Name the three migration
modules explicitly and treat `tart-gate` under the gate rule. Also: each of those
directories currently contains an untracked 19 MB compiled binary (git status shows
`spikes/real-local-engine/*/{cold-cutover,prod-cold-bootstrap,restore-recovery,tart-gate}`);
add `spikes/**/bin`-style ignores or move build outputs to `.work/`.

### F15. Lint: the shape-driving set is wider than the plan lists (local)

The plan names goconst/mnd/testpackage/golines. The config also enables `funlen`
(100 lines/50 statements), `cyclop`, `gocognit`, `nestif` and `dupl`
(`.golangci.yml`). Visible artifacts: `rpc_names.go` files holding fixture strings
(`internal/control/rpc_names_test.go`, `internal/client/rpc_names.go`) and the
create path split into five single-branch helpers
(`internal/host/host.go:572-682`). Whether to relax the complexity linters is an
implementer's call; the plan should just not forbid it.

### F16. Smaller confirmations (local; the plan's disposition is right)

- **Checkpoint deletion (D2).** `control/checkpoint.go:382-384` requires
  `SameProfile(configured, checkpoint.Profile)` for non-RAM deletion;
  `host/checkpoint.go:263-266` requires `h.profile(req.Profile)` and an equal
  `runtimePin`. Tart deletion needs the Tart runtime on the owning host, not the
  profile's CPU/RAM. Plan is right.
- **Summary read after wait (bug 7).** `internal/client/lifecycle.go:89-109` reuses
  the wait-bounded context for the follow-up `Checkpoint`/`Resolve` call. Plan is
  right and trivial.
- **`serve(... readyFiles ...string)`** (`cmd/clankerbox-server/main.go:144`) and
  the duplicated certificate parsing (`:102-133`) are exactly the "single-optional-file
  variadic" and "repeated mTLS-only certificate parsing". Local cleanup.
- **SDK dependencies.** `protocol/package.json` lists `@connectrpc/connect-node` as a
  runtime dependency; the generated package needs only `@bufbuild/protobuf` and
  `@connectrpc/connect`; the Desk server already owns its `connect-node`. Plan is
  right.
- **Identity rebind does not restart PTYs** — already true
  (`daemon/identity.go:81-118`); decision 6 is preserved, not new work.
- **Short acceptance / long wait for EndSession** — `acceptEnd`
  (`daemon/service.go:111-134`) already does this; keep.

---

## Decisions that should remain as written

- **Decision 1** (keep controller/host/guest ownership and durable journals). The
  journals are the crash-recovery and deduplication mechanism; nothing in a data
  reset changes that.
- **Decision 2** (one `SessionService` mounted on three listeners). The three
  services already have identical shapes (`session.proto`, `host.proto`); each
  listener keeps its own TLS/bearer policy (`control/rpc.go:301-315`,
  `host/server.go:33-46`, `daemon/identity.go:120-133`). Sharing the descriptor
  removes two generated handler/client sets and one relay type per hop. Keep
  `HostService` for `DescribeHost`/`SubmitOperation`/`GetHostOperation`/`InspectMachine`.
- **Decision 3** (native effects stay serialized; no concurrent scheduler). With F1
  and F2, serialization only affects effect latency, not acceptance or sessions.
  A per-machine native scheduler is not justified by the current defects.
- **Decision 4** (mandatory engine digest at the guest; identity effects fenced by
  the epoch lock). `withIdentity` (`daemon/identity.go:149-159`) is the correct
  linearization point; do not weaken it.
- **Decision 7** (no new dependencies). Nothing in this review needs one.
- **Domain error/Connect mapping at the boundary, typed details preserved** — with
  F8's single-vocabulary refinement.
- **Delete path-based pin fallback, cache adoption, old-format tests**
  (`host/runtime_cache.go:44-171`, `checkpoint.go:42-46`,
  `control/pin_migration_test.go`, `dev.go:200` version check as the only
  discriminator). Correct under a full reset.
- **Release notices as enumerated mandatory inputs; one full verification at the
  publication boundary.** Correct.
- **Keep current-contract authentication/privacy/uint64/lifecycle tests;
  Python tests in `make test`; one documented complete check sequence.** Correct.
- **Operator prompts (sudo, signing, Local Network) reported, not worked around.**
  Correct and consistent with the personal-cloud guidance.

---

## Simplification opportunities (beyond the plan)

1. Host no longer imports `internal/guest/vt`; the host binary stops embedding the
   Ghostty wasm (F3).
2. `ProfileBinding.image_path`, `FromProfileBinding` path handling, controller-side
   `ImagePath`, and all `SameProfile` normalization go away (F7).
3. One error type carrying `v1.ErrorReason`; delete `rpcmodel.Reason`, `APIError`,
   and the substring switch (F8).
4. Single per-attachment event queue; no ACK buffer; delete the bootstrap gate (F4).
5. `Manager.Close` reuses `Session.end`; a `closed` flag under the existing manager
   lock covers create-vs-close (F6).
6. Admission epoch counter instead of a reconstructed reservation set, if the
   implementer prefers it (F2).
7. Authority/credentials loaded once; binding certificates for the authority's
   lifetime; no renewal on the lease path; no controller transport rotation API (F3, F13).
8. Drop `dev-owner.json`; `environment.json` plus the host's `.owner` marker already
   establish ownership (F9).
9. Delete `QuarantinedMachineIDs` and `quarantine.go` with the orphan (F10).
10. Stopped-environment bundle swap instead of either live upgrade or forced
    destroy (F9, if the user accepts the recommendation).

---

## Amendment checklist

Blocking (change the design text before stage 1/2 starts):

- [ ] F1: acceptance never waits on a running native effect; write the lock order
      `Service.mu → journal → registry` and `native → journal → registry`.
- [ ] F2: state the reservation invariant (or adopt the admission-epoch form);
      include source-side idle checks on the lease path.
- [ ] F3: define the lease path: startup-loaded authority, long-lived bindings,
      journal + TLS identity per call, endpoint re-resolve only on dial failure, no
      host-side engine digest, no `vt` import in the host.
- [ ] F4: ACKs may interleave with bootstrap; one bounded queue; Desk `dispatch`
      exempts `ack`; invert `TestResumePrefixPrecedesControls`.
- [ ] F7: remove `image_path` from the wire and controller model; host resolves the
      path; `SameProfile` becomes plain equality of compatibility fields.
- [ ] F10: state that the runbook preservation clauses are superseded and rewritten
      in the same change; list live paths kept/removed; name the Desk "Fresh
      deployment" procedure; correct the extension-revision sentence; delete
      quarantine config and v2 profiles.

Amend (wording/scope):

- [ ] F5: EOF → `CloseRequest` + drain; define "accepted events".
- [ ] F8: one typed error carrying `v1.ErrorReason`.
- [ ] F9: decide immutable pin vs stopped-swap and say what happens to VM disks;
      teardown accepts a same-digest bundle at any path; drop `dev-owner.json`.
- [ ] F11: enumerate `sources.json`, engine LICENSE files and notices as pinned inputs.
- [ ] F12: say how the Linux archive test run is produced without CI.
- [ ] F13: no controller transport rotation API; rebind is the only guest transport
      invalidation.
- [ ] F14: name the three migration modules; keep `tart-gate` under the gate rule;
      ignore spike build outputs.
- [ ] Acceptance list: the 8 MiB slow-viewer-with-input case must use a direct SDK
      client (the Desk cannot exercise it); "manager close racing create" is covered
      by the existing manager lock and needs a test, not a design.

Local (leave to the implementer): F6 details, F15 lint thresholds, F16 items.

---

## Readiness

After the blocking amendments (F1, F2, F3, F4, F7, F10) and the wording fixes
above, the plan is ready to implement. The stage order is sound; the only
re-sequencing implied by this review is that F7 (profile binding) belongs with
stage 2's schema change rather than stage 3, because it alters the private
`HostService` contract and must be regenerated with the session schema.
