# TypeScript/Effect rewrite — plan

Status: planned and unblocked. clankerauth 0.11.0 ships offline-verifiable API keys
(requirements: `~/Documents/clankerauth-offline-api-keys-requirements.md`).
Clankerdesk's Effect rc.118 bump runs in parallel and is needed only by cut-over.

clankerbox is rewritten from scratch in TypeScript on Effect 4 as a clean break.
No persisted state is migrated: production is destroyed and redeployed at
cut-over. Clankerdesk (`/Users/gg/ws/pers/clankerdesk`), whose server uses
MachineService, SessionService and engine snapshots through
`@gjermundgaraba/clankerbox-sdk` 0.4.0, migrates to the new contract in the same
coordinated release. The other consumers are listed under
[Feature scope](#feature-scope). The Go code is
replaced in this branch and deleted before merge. There is never a release where
both implementations ship.

## Settled decisions

| Area | Decision |
| --- | --- |
| Scope | CLI, controller, host and guest daemon, plus all Python tooling (live harnesses, release bundling, image staging, `work_runs`). |
| Runtime | Node 26.x (latest patch), shipped as Node SEA single-executable binaries. |
| Effect | `effect` / `@effect/platform-node` `4.0.0-rc.118`, the latest rc. RPC, CLI, HTTP and sockets are top-level modules in this rc (`effect/rpc`, `effect/cli`, `effect/http`, `effect/socket`). The binary codec is `SchemaBinary` (`RpcSerialization.layerSchemaBinary`); rc.118 has no msgpack. |
| RC alignment | clankerbox, Clankerdesk and clankerauth-sdk all target `4.0.0-rc.118`; new versions of the other two are being published. The contract package is Effect-native, so two RC copies would break Schema identity at runtime. Move all three to a new RC together. |
| Contract | [effect-actions](https://github.com/gjermundgaraba/effect-actions) 0.8.0 for every unary call. HTTP input is closed: undeclared fields are refused. The terminal stream is Effect RPC ([D1](#decisions-and-open-items)): a streaming `attach` plus unary controls with one in flight per attachment, using SchemaBinary over WebSocket and exec stdio. `NodeHttpServer` wraps `node:http` with no HTTP/2 path, which rules out Connect. |
| Auth | clankerauth 0.11.0 offline API keys and JWTs on both the controller API and the host API, through `@gjermundgaraba/clankerauth-sdk` 0.11.0. `Resource.make` handles requests, with `admit` for socket upgrades; `Resource.watch` ends a live attach stream when its credential expires or is revoked. Keys are checked against a signed key list per resource: revocation takes effect in about a minute, and the last list stays valid for 24 hours during an issuer outage. Tests use the SDK's `/testing` fake issuer, and dev mode uses `clankerauth-dev`. Host→guest trust stays owned by the host (D2). |
| Deleted auth | Static bearer token file, ingress client-CA/peer-ID mode, controller→host client certificates (`tls_cert`/`tls_key`/`peer_id`, `controller_id`), Unix peer-credential checks. A remote host keeps a TLS server certificate, and the controller verifies it against the host's configured `tls_ca`. |
| State | SQLite through `node:sqlite`, one database per service. No migrations; old `controller.db`/`host.db` and guest images are discarded. |
| Production | `personal-cloud` runs 0.11.0 with a Linux smolvm host and a Mac Tart host. At cut-over, every 0.11.0 machine and checkpoint is destroyed, the TS release is deployed, and machines are recreated from profiles. The personal-cloud deploy config moves to clankerauth. |
| SDK | `packages/contract` (Schemas, the ActionHttpClient and the attach stream client) is published as the next major of `@gjermundgaraba/clankerbox-sdk`. It is versioned with the clankerbox binaries, so there is no separate `sdk-v*` tag and no pairing table. |
| MCP | None. |
| Tooling | vite-plus 1.0.0 (`vp`), pnpm 12, TypeScript 7, laid out like `/private/tmp/monorepo-example`. The lint setup (typeAware, typeCheck, anti-slop plugin) mirrors clankerauth. |

## Delivery

- **Branch:** everything is built on `rewrite-to-effect`, with one or more commits
  per phase, pushed as work lands. There is one PR, at cut-over. Commits carry no
  AI attribution trailers.
- **Review points:** after spikes S1–S5 (they gate D1, D2, D9, node-pty and
  snapshots), then at the end of each phase with a summary.
- **Live test machines:**
  - this Apple Silicon Mac: smolvm on macOS, and Tart
  - `ssh clanker@37.27.63.112`: Linux/amd64 with KVM, smolvm on Linux, and the
    linux-amd64 binary. This is the production personal-cloud Linux host. You've
    approved using it while its controller is down.
    - Work stays under `~/clankerbox-rewrite/`.
    - Never touch the production `~/clankerbox`, its `clankerbox-host.service` or
      its VMs.
    - Never restart `user@1000`.
- **Reusable VM seeds:** reused from the main checkout's `.work/inputs`
  (`smolvm-1.19.0-images`, `tart-2.38.0`, `tart-local`), always on private clones.
- **This plan:** deleted in the final commit before the cut-over merge.

### Test machine footprint and final cleanup

Everything the rewrite creates on a test machine is removed when the work ends.
This applies to both the Linux machine and this Mac. The rules:

- **One owned root per machine.**
  - Linux: `~/clankerbox-rewrite/`. The pre-existing `~/clankerbox` is not ours;
    never touch it.
  - Mac: this worktree's `.work/`.

  Runs, scratch, Node toolchains, SEA builds, bundles, VM clones and dev
  environments all live under that root. Nothing goes into shared locations such
  as a global npm prefix or `/usr/local`.
- **Every native resource is named and recorded.** Resources carry a
  `clankerbox-rewrite` prefix: systemd user units, launchd jobs, smolvm machines,
  Tart VMs and listening ports. Each one is recorded in its run's evidence, per
  AGENTS.md, and a run's teardown stops its resources before scratch is deleted.
- **Machine changes are kept in a ledger.** Every change outside the owned root
  goes into `CLEANUP.md` under that root. So far there is one: `clanker` was added
  to the `kvm` group on 2026-09-30. At the end, you decide whether each change is
  reverted.
- **Final cleanup, the last step of the whole effort:**
  1. Stop every recorded process, unit, job and VM.
  2. Confirm none remain, by name prefix and by the recorded IDs.
  3. Delete both owned roots and any seed clones.
  4. Walk the ledger with you.
  5. Report what was removed, and anything deliberately kept, with size and reason.

  Reusable seeds in the main checkout's `.work/inputs` are not ours to delete.

## Target layout

```
package.json            # vp scripts: ready = check + test + build
pnpm-workspace.yaml     # apps/*, packages/*, tools/*; catalog pins below
vite.config.ts          # lint/fmt/staged/run.cache, as in clankerauth
tsconfig.json
apps/
  clankerbox/           # the only binary: `clankerbox <cli…> | server | host | guest`
packages/
  contract/             # Schemas, ActionGroups (machine, profile, host, session), session RpcGroup, errors
  controller/           # admission, queue, capacity, profile catalog, host client, session relay
  host/                 # journal, lifecycle, runtimes (smolvm, tart), supervisor, builds, guest link
  guest/                # session manager, pty, pipe sessions, machine preparation
  terminal-core/        # published: pinned Ghostty VT WASM + wrapper, shared with Clankerdesk
  cli/                  # ActionCliClient commands + shell/sessions/dev
  state/                # private-dir rules, sqlite open, atomic replace, owner lock
tools/
  release/              # bundle, prepared images, notices, SEA build + signing (replaces scripts/release, images/*.py)
  work-runs/            # run/list/clean with Effect Scope teardown (replaces scripts/work_runs.py)
  oxlint/               # anti-slop copy
tests/live/             # gated live acceptance project (replaces tests/*.py, protocol/test/*)
images/                 # recipes and package locks (data only)
```

Catalog: effect, @effect/platform-node, @gjermundgaraba/effect-actions,
@gjermundgaraba/clankerauth-sdk, @gjermundgaraba/clankerauth-dev, node-pty,
typescript 7.0.2, vite-plus 1.0.0, @types/node 26.

**One multi-role binary per platform** replaces the four Go binaries. A SEA is
about 100 MB, so four of them per platform is too heavy. Targets:

- darwin-arm64: CLI, controller, host, and the Tart guest.
- linux-amd64: everything.
- linux-arm64: the Linux guest image built on Apple Silicon.

Units run `process.execPath host`. `clankerbox dev` runs the controller as an
in-process Layer, which removes `--ready-file` and the child-process probe loop.

## Feature scope

Rule: a feature with no real consumer is deleted.

The real consumers are:
- the clankerbox CLI, as used by the operator
- Clankerdesk
- the production personal-cloud deployment
- the `clankerbox-profiles` recipes
- clankercreds

Usage by tests, docs or harnesses alone doesn't count.

**Kept:**

| Area | Features |
| --- | --- |
| Lifecycle | create, start, stop, delete, fork (RAM forks), checkpoint capture/get/list/delete, restore, operation inspection, idempotency keys on every mutation |
| Runtimes | smolvm (Linux guests) and Tart (macOS guests), both in production |
| Profiles | publish (with `--wait`), build logs, cancel, profile and revision deletion, bases listing. Profile fields `id`, `host_id`, `base_id`, `cpu`, `ram_mib`, `storage_gib`, `overlay_gib`, plus `setup.sh` and `files/` |
| Machine preparation | `/etc/clankerbox/machine.json` (`env`, `start`) and `/var/lib/clankerbox/machine-id` |
| Sessions | create inside an attachment (`cwd`, argv, grid); PTY and pipe sessions; `end_on_detach`; sessions that outlive their attachment and are reattached later; EndSession; ListSessions; the final screen of ended sessions; session records kept across guest restarts, so unfinished sessions report LOST; engine snapshots on reattach; terminal colour profile and answered-query filtering |
| CLI | `shell` (`--cwd`, `--tty`, `--no-tty`, `-- cmd`); `sessions MACHINE [ID]`; `hosts`; `machines`; `checkpoint list`; `operation`; `--json`, `--async`, `--timeout`, `--idempotency-key` |
| Dev | `dev` with `--state-dir`, `--cpus`, `--ram-mib`, `--bundle`; `dev stop`; `dev destroy` |
| Host transport | remote hosts over TLS (server certificate plus clankerauth key) |

**Deleted:**
- **Response fields no consumer reads:**
  - Machine: `generation`, `accepted_generation`, `desired_state`, `prepared`, `observed_at`, `created_at`, `source_machine_id`, `checkpoint_id`
  - Operation: `generation`, `created_at`, `updated_at`
  - `GuestStatus`: `schema`, `incarnation`, `daemon_version`, `engine_digest`
  - public Checkpoint: `source_generation`, `created_at`, `runtime_pin`, `profile`. The public and host checkpoint messages become separate messages.
  - ProfileBuild: `upload_id`, `recipe`, `base`, `created_at`, `updated_at`
  - Profile listing: `base_id`, `storage_gib`, `overlay_gib`
  - sessions: `View.cursor`, `Session.pid`, `Session.end_on_detach`, `reply_overflow`
  - `GuestDescription`: `os`, `user`, `boot_id`, `max_sessions`
- **Error reasons never sent:** `UNAUTHENTICATED`, `PERMISSION_DENIED`. HTTP 401/403 carry authentication failures.
- **Labels (D6):** machine labels everywhere, and session labels (`shell --label`). The start-command session is marked by `start: true`.
- **Multiple live attachments per session.** Nobody attaches twice; a new Open evicts the previous attachment.
- **CLI:** the `guest` command (`GetMachine`'s `guest.status` is the readiness signal), `shell --env` (use `env KEY=v cmd`), `labels`, `profile init`, `profile revisions`, `profile publish --build-id` resume, `default_host` and `create --host`.
- **Host knobs:** `port_lease_root`, `dns`, `launchctl_path`, `launchd_domain`, `systemctl_path`.
- **Dev:** bundle relocation, sticky `--cpus`/`--ram-mib`, per-project default state-dir hashing, `--listen`.

## Simplification inventory

Four reviews (controller, host, guest, CLI/dev/tooling) produced the items
below. Each is labelled:

- **delete**: dead or compatibility-only; remove outright.
- **collapse**: two paths do one job; merge them.
- **keep**: load-bearing; the failure mode it prevents is named.

Product decisions are under [Decisions and open items](#decisions-and-open-items).

### Contract and wire

- **delete** `internal/rpcmodel` (~1.1k lines of proto↔model mapping). One Effect Schema per resource is both the domain type and the wire type.
- **collapse** the 22 `ErrorReason` values into about 7 tagged errors: Invalid, NotFound, Conflict{kind}, Precondition, Capacity, Unavailable, Internal. `retryable` is derived from the tag. Drop the unused `ErrorDetail.resource_id`/`operation_id` and all reserved fields. Clankerdesk branches on:
  - the refusal reasons that mean "not accepted" (`machine-recovery.ts:32-43`)
  - `not_found`, `prerequisite`, `not_running`, `expired`, `conflict`, `too_large` and `internal` (`terminals.ts:66-72,438-455`)
  - `engine_mismatch` (`guest-terminal.ts:105`)

  Each of those distinctions must survive as a tag or a `kind`, or be dropped together with Clankerdesk's branch.
- **collapse** the three CLI JSON encodings into one, the Schema encoding.
- **keep** the CLI's `{error:{message,code,reason,retryable}}` object and exit codes 255/130/128+n. Without them, scripts can't tell a CLI failure from a remote exit.
- **delete** `capabilities` string lists and branch on `runtime`. **keep** `Checkpoint.kind` (`ram | disk`), derived from the runtime, because Clankerdesk's UI reads it. Also delete `Branchable`, which always equals prepared && smolvm.
- **delete** duplicate identity fields: `Machine.profile`/`host` next to the pinned profile, `Checkpoint.host`, and `CreateMachine.host_id` (the profile pins the host). The CLI `default_host` goes with them.

### Controller

- **collapse** the three admission pipelines (Create, Mutate, Derive) into one `accept(action)` with a per-action `admit` and `plan`.
- **collapse** operation targets into real columns: `machine_id?`, `checkpoint_id?`, `source_id?`, `revision_id?`. This removes the fake machine a checkpoint deletion invents, the `json_extract` CASE, and reservation scans over every active request's JSON.
- **delete** `DesiredState`. Capacity becomes "not stopped, or has an active operation".
- **collapse** Unknown/ObservationStale/ObservationError/Prepared/Preparing into `observation: Option<{state, prepared, at}>` plus `lastError`.
- **keep** "an unknown machine stays reserved". Without it, Tart could be asked to start a third VM.
- **collapse** the profile, revision, build and upload tables into `builds` plus `profiles(name → build_id)`. A revision is a succeeded build, and the upload ID is the build ID. This deletes `ProfileRevision`/`ListProfileRevisions` and the `recipe_uploads` table, including its expiry, sweeper and claim checks.
- **collapse** the build worker into the wake-driven queue model: one status type and no 200 ms idle polling. **keep** a separate fiber for builds; they can run for an hour and would otherwise block lifecycle work.
- **delete** checkpoint tombstones, the `deleting`/`deleted` statuses, the restore-on-failure branch, and the unused list filters (`include_deleted`, labels).
- **delete** the stop-when-already-stopped special case (host stop is idempotent), the `Transport` type-assertion fallback, the `"inspect"` pseudo-action, and hand-written shutdown (replaced by Effect scopes).
- **collapse** checks on host responses: no checkpoint hash comparison and no operation-ID echo check, and the controller builds the checkpoint row from `{observation, runtimePin}`.
- **keep** the generation fence, because a late response would otherwise roll back newer state.
- **keep** recording completion even when the caller has cancelled, so cancellation can't lose an ambiguous result.
- **keep** the offline duplicate check, so retrying a completed request works while the host is down.
- **keep** the smolvm backing-store dependency check, because deleting a store root would corrupt its forks.
- **keep** the per-runtime source-state rule: smolvm forks a running VM, Tart copies a stopped disk.
- **keep** the revision reference fence and the Tart two-VM limit.
- **delete** labels (D6): the field, `SetLabels`, `clankerbox labels`, `--label`, the `ListMachines` filter, and the fork/restore/checkpoint inheritance rules.
- **collapse** name aliases: IDs everywhere, names resolved in one decoder, ID-shaped names forbidden.

### Host

- **collapse** the host work loop, `acceptOnly`, synthesized statuses, the second fingerprint check and three locks. They become one owner lock for the process lifetime, a `Semaphore(1)` for native mutations, and journal-then-fork-fiber. On startup, rows still in the `accepted` phase resume and the rest become `unresolved`.
- **keep** writing the phase before each native effect. Without it a RAM child gets cold-booted twice, or `create` adopts a foreign VM.
- **collapse** the "one exception" Linux branch-failure rule into a general rule for every native failure. The operation fails and tombstones only when the inventory has no child, the supervisor has no live process and the source is intact; otherwise it is unresolved.
- **keep** the proof behind that rule. Failing while a VMM might still be writing the shared store would corrupt the source's family.
- **collapse** re-inspection: each runtime operation returns a confirmed post-state, and lifecycle trusts it while it holds the mutation semaphore. Today a delete inspects four times and a start three.
- **collapse** the supervisor matrix into `Supervisor.launch(label, argv, env)` with two implementations:
  - Linux: `systemd-run --user`, with no unit files and no daemon-reload.
  - macOS: one plist renderer.

  **keep** one supervised job per VM, because a host restart would otherwise kill the VMs.
- **collapse** the three exec wrappers and two shells into one `Runtime.exec(machine, argv, stdio)` per runtime.
- **collapse** guest binary staging and the per-start `sha256sum` into a single digest in the runtime pin, checked once at build validation. The image is the only copy of the guest.
- **collapse** the guest-registry mirror into per-machine `FiberSet`s, interrupted when a reservation is taken. `InspectMachine` reports native state only.
- **collapse** the two-phase owner marker into one init: build in a temp directory, then rename.
- **delete** single-value knobs:
  - `DNS`, which also leaks into capture refusal and the checkpoint pin
  - `HostOS`, which comes from `process.platform`
  - optional `HostID`, `ControllerID`
  - host TLS client-certificate config (the host's server certificate stays)
  - `SystemdUser`/`LaunchdDomain`, and the `systemctl`/`launchctl` path knobs
- **delete** dead state: the `"inspect"` branch in `Execute`, the persisted `Manifest.endpoint`, the duplicate fork architecture check, and the requirement that `CancelProfileBuild` carry the full recipe (cancel by ID instead).
- **keep** discarding an interrupted capture, so partial RAM artifacts are never published.
- **keep** the separate validation VM, so an unbootable revision never goes live.
- **keep** build outcome separate from cleanup state, as one tagged union, so a transient cleanup failure doesn't discard validated work.
- **keep** symlink-confined rootfs extraction. Node has no `os.Root`, so reject any entry under a symlink the archive created.
- **keep** the checkpoint pin of runtime digest plus revision ID.

### Guest and sessions

- **collapse** PTY and pipe sessions into a tagged union: `{kind:"pty", cols, rows, endOnDetach} | {kind:"pipe"}`. This removes pipe special cases from about ten sites and double grid validation.
- **collapse** the final screen into a unary `getSession → {session, screen?}` backed by `screen.txt` written at exit. This deletes `View`/`ViewChunk`/`Opened.view` and the "absent vs empty view" rule, and the screen now survives a daemon restart.
- **delete** resume (D3): the output ring, resume cursors, incarnations, start offsets, `Opened.cut`/`start_offset` bookkeeping for resume and the UNAVAILABLE mode. Every reattach sends an engine snapshot; keep `expected_engine_digest`.
- **collapse** input offsets, `Ack` and control `sequence`s into backpressure (D1). There is one `Input` in flight per attachment, batched up to the session budget, and the guest holds the reply until the budget frees. Output uses a credit window.
- **delete** create idempotency: the 24 h horizon, 1 h skew and fingerprint. The only client never retries, so a known ID is a conflict.
- **delete** the `STARTING` status (write `running` before spawning), fsync on every resize and offset change, `reply_overflow`, `GuestDescription.user`, the `binding.json` fallback, unused `MaxSessions`/`RingSize`/`Paths.Log`/`Paths.PID`, and the ~220 lines of `protocol.Session` duplication.
- **collapse** the start-command machinery: it is `create(args, {attach: none})`, and an invalid `machine.json` writes an exited record whose screen is the error, with no fake `printf; exit 1` script.
- **delete** Go-only workarounds: the `Fd()` avoidance helpers, relay deadlines, the wazero construction mutex, and `guardedKill` with start times (a synchronous `reaped` flag in the exit callback replaces it).
- **keep** registering the subscriber before launch and the atomic cut. Without them, `echo hi` output is lost. In TS, reserve the session ID synchronously before any await.
- **keep** the 2 s idle drain after exit. Without it, `sh -c 'sleep 999 &'` never reports exit.
- **keep** one ordered writer with a separate reply budget. Without it, a DA/CPR reply can land inside a paste.
- **keep** the lossy tail plus Gap for PTY output. Without it, a slow attachment stalls the program. A Gap tells the client to reattach and take a fresh snapshot. Pipe sessions stay lossless.
- **keep** guest-owned `end_on_detach`, with ping on every hop. Without it, a killed CLI leaves its shell running.
- **keep** HUP → TERM → KILL end escalation.
- **keep** live query filtering and the terminal profile colours. Without them, TUIs see duplicate replies as typed garbage.

### CLI, dev and tooling

- **collapse** dev teardown: stop the controller, have the host stop every VM and confirm none remain, then remove the owned roots. This deletes the teardown journal, the one-use token and the private controller. **keep** the "confirm none remain" check, so disks are never deleted under running VMs.
- **collapse** dev auth into `@gjermundgaraba/clankerauth-dev`. This deletes token generation, token files, the 32-byte/0600 checks, the bearer readiness probe and `teardown-token`.
- **collapse** the two dev state roots into one. The default `--state-dir` is a fixed `~/.clankerbox/dev` rather than a per-project hash. The short runtime root is keyed by a hash of the state dir. **keep** the short path; macOS socket paths are limited.
- **delete** bundle relocation repair, because units point at `process.execPath` of a fixed install.
- **delete** the env `Version: 2`, `manifest_format: 3` and `clankerbox-prepared-v2` markers. **keep** the marker for operator Tart seeds, so an unprepared seed isn't booted.
- **collapse** the manifest to `{version, platform, runtimeDigest, imageDigest, files}`. **keep** full digest verification, so a RAM checkpoint never restores on a different engine or image.
- **collapse** the three guest binary copies to one, the one inside the image.
- **collapse** CLI flag drift into shared `--json/--async/--timeout/--idempotency-key` options:
  - `profile publish` waits by default, like lifecycle commands.
  - Delete the `profiles` alias of `profile list`, and `dev --listen`. Dev picks a port once and keeps it in its state, so the URL is stable across restarts.
  - Merge `client.json` and `connection.json`. Clankerdesk's real-clankerbox harness (the `ps` argv match, the `environment.json` keys, `connection.json`) migrates with the release; these aren't compatibility constraints.
- **collapse** duplicated pins (Ubuntu/Node/agent/Cargo.lock across `stage-linux.py`, `pins.json`, `source.json` and image sources) into one `release-inputs.json` keyed by platform. It includes the Node SEA base binaries.
- **delete** `prepare-templates.py` and `template-provenance.json`: a one-off v0.3.0 reproduction whose outputs are already pinned.
- **keep** `runtime.patch`, the engine pins and the LGPL/GPL notices, which are redistribution obligations. Add Node's LICENSE and pnpm dependency notices.
- **collapse** the live harnesses (3 Python harnesses, a benchmark and 3 Node scripts, chained through `--keep/--resume/--lifecycle-result`) into one gated `tests/live` project:
  - It owns its machines, with deterministic idempotency keys.
  - Delete the smolvm-1.16 `--trim-before-fork`/`--engine-vms` guards and the `real-vm.mjs` debug actions.
  - Delete the Python unit tests of harness helpers.
- **collapse** `work_runs.py` into `Effect.Scope` finalizers plus `run/list/clean`. **keep** `needs_teardown` and the refusal to clean a running run.
- **delete** historical docs: 6 qualification records (808 lines), `docs/runtime-profile-qualification.md`, `docs/plans/*` (this plan last, just before the merge) and the performance "qualified comparison". Move the requalification checklists into the bump skills.
- **collapse** ADRs into a fresh set that drops the superseded banners, with new ADRs for TS/Effect, clankerauth, SEA and the session transport.
- **collapse** CI into one vite-plus job plus a SEA build smoke test on 3 targets.

## Decisions and open items

- **D1. Terminal stream transport. Decided: Effect RPC with a credit-windowed `attach` stream** (spikes S3 and S3b, `spikes/s3-transport/RESULTS-stream.md`).

  Input offsets and acks exist because the guest *refuses* input when its bounded,
  per-session budget is full (`internal/guest/session/writer.go:79`). They are not
  there to fix ordering, since today's Connect stream is already ordered. Whatever
  replaces them must apply backpressure instead of refusing, on any transport. A
  session has at most one live attachment ([Feature scope](#feature-scope)).
  - **Chosen: Effect RPC with a credit window.**
    - **Output:** `attach` is a real server→client stream with **Effect's RPC stream
      acks turned off**, a one-line protocol override on client and server. The guest
      sends output only while it holds credit. The client grants one credit per
      consumed message with a fire-and-forget unary `Credit` call, so the socket
      reader never blocks and pings keep flowing. Memory is bounded at window × 512
      KiB.
    - **Why:** in rc.118 the client acks a chunk when it is queued, not when it is
      consumed (`RpcClient.ts:569-584`). A stalled consumer then blocks the only
      socket reader, and the hard-coded 5 s ping (`:1218-1239`) drops the
      connection. WebSocket-level pings are blocked the same way.
    - **Measured over 3 local hops, with a 60 s consumer stall:** the stream
      survived; Input and Resize were answered 59/59 times; a dead peer was detected
      in about 6 s. Throughput was 674/431/285 MiB/s at +0/4/12 ms round trip, versus
      391/83/38 with RPC acks.
    - **Input:** one unary `Input` in flight, batched up to the session's input
      budget (4 MiB for pipe sessions, 256 KiB for PTY sessions, the same as the Go
      guest). The guest holds each reply until the budget frees, so input is never
      refused and needs no offsets or sequence numbers. This measured 114–122 MiB/s
      at +4/12 ms. `Resize` and `CloseInput` are unary.
    - **Guard:** the contract package carries a test that pins this rc.118 behaviour
      (acks on offer, the fixed ping). Re-run it at every Effect bump.
    - **Built in:** interrupts, typed errors and SchemaBinary serialization, all on
      the same Effect HTTP server as effect-actions. The relays still need
      WebSocket keepalive (S3).
  - **Rejected, with evidence:**
    - long-poll `Read` (it is polling)
    - a large client buffer (memory is unbounded)
    - acks on take (the API doesn't allow it)
    - relying on WebSocket pings (the reader blocks them too)
  - **(b) Not needed: hand-written duplex frames** over a WebSocket and exec stdio,
    with a credit window. You own framing, credit in both directions, keepalive,
    half-close and error propagation. Effect's WebSocket writer ignores send
    backpressure, so credit must be end to end.
  - **(c) Not recommended: Connect with a local Effect adapter.** Proven HTTP/2 flow
    control, but it needs a second, HTTP/2 listener on the controller and on every
    host, plus `.proto` codegen: a second contract system.
- **D2. Host→guest trust. Decided:** carry the session stream over the runtime's
  own exec channel (`smolvm machine exec -i` / `tart exec -i` running
  `clankerbox guest connect` into a root-only Unix socket).
  - This deletes the host CA, per-epoch certificates, renewal, bindings, rebinding,
    the per-user port registry and the guest network listener. A RAM child inherits
    nothing that authenticates it.
  - Spike S3 confirmed it on smolvm (macOS and Linux) and on Tart:
    - echo round trips of 0.2–0.9 ms and bulk transfer of 70–250 MiB/s
    - idle streams survive 11+ minutes
    - streams survive a host-service restart and a RAM fork of their source
  - **One exec process per attachment.** The first call costs about 150–215 ms on
    smolvm and about 560 ms on Tart. A host restart drops attachments; guest
    sessions persist.
  - **New-machine call after every fork or restore.** A RAM child inherits the
    source's exec'd relays as live orphans. The host immediately tells the child's
    guest daemon it is a new machine, and the daemon closes every existing
    connection. This is the same trigger as machine preparation (ADR 0010).
  - **Tart:** `tart exec` runs as `admin`, so the relay into the root-only socket
    runs under `sudo -n` (the prepared image allows it).
- **D3. Reconnect catch-up for mirrors (Clankerdesk). Decided: snapshot only.**
  - **Chosen: snapshot only.** Delete resume, meaning the output ring, resume
    cursors, incarnations, start offsets and UNAVAILABLE retries. Every reconnect
    loads an engine snapshot. Keep `expected_engine_digest` and the Ghostty lockstep
    with Clankerdesk.
  - **Rejected: repaint from the Ghostty formatter.** A test against the pinned WASM
    broke three cases: an escape sequence split at the cut, a UTF-8 character split
    at the cut, and a reconnect inside an alternate-screen TUI. The formatter emits
    only the active screen, so the third case can't be fixed by configuration.
    Clankerdesk's `packages/terminal-core/tests/terminal.test.ts` already covers
    these cases.
- **D4. Dev host under launchd/systemd. Decided:** keep it, so VMs survive Ctrl-C
  and a closed terminal. It gets smaller through the `Supervisor.launch` collapse
  and the fixed install path.
- **D5. Operation "unresolved". Decided:** `pending | succeeded | failed` with
  `uncertain: true`. The controller stops resubmitting every 5 s, matching ADR 0001
  (inspect, don't retry). The reconcile hint goes away until a reconcile action exists.
- **D6. Labels. Decided: delete them.** Nothing in clankerbox reads labels. The
  list filter and `clankerbox labels` have no caller. Clankerdesk's one use, a
  workspace ownership check (`terminals.ts:558`), moves to its own allocations table.
- **D7. Host capacity. Decided:** it is configured on the controller today;
  keep it there, so admission works while a host is offline.
- **D8. smolvm store layout. Decided:** one layout on both OSes, with templates
  staged once per runtime digest at startup.
- **D9. macOS Local Network permission. Resolved by S4.**
  - Go needed it because the Mac host dialled Tart guests over vmnet; D2 removes
    that.
  - The only remaining local-network connection is the host reading clankerauth's
    key list, and only if the issuer resolves to a LAN address.
  - If it does, ship darwin as an `.app` wrapper; codesign binds its `Info.plist`.
    Embedding a plist into the Mach-O breaks dyld.
  - Check personal-cloud's route to the issuer in phase 9.

## Spikes (first, before building packages)

1. **S1. node-pty in a SEA** on all 3 targets.
   - Build the linux prebuilds, embed `pty.node` and `spawn-helper` as SEA assets,
     extract them to a root-only directory, `process.dlopen` the addon.
   - Use only node-pty's native `fork`, with our own reader and writer:
     `encoding:null`, bounded writes and byte counting. node-pty's writer queue
     has no bound and busy-loops on EAGAIN.
2. **S2. Ghostty VT WASM in Node.**
   - Compile once and instantiate per terminal.
   - Use a tiny wrapper module for the funcref table callback.
   - Recreate memory views after `grow`.
   - Snapshot round trip: a snapshot taken in Node restores exactly in
     Clankerdesk's engine, including the split-sequence, split-UTF-8 and
     alternate-screen cases.
3. **S3. Exec-channel transport (D1, D2):**
   - latency and throughput of Effect RPC (SchemaBinary) over `smolvm exec -i` and
     `tart exec -i`
   - how long a stream survives
   - behaviour across a RAM fork
   - pipe throughput with one control in flight across all three hops, measured
     with `tar -c src | clankerbox shell dev -- tar -x`
   - a new Open evicting the previous attachment of a session
4. **S4. SEA build and signing:**
   - macOS: strip the signature, re-sign with JIT entitlements, handle D9.
   - Confirm the glibc floor on the guest distros; the Go binary was static.
5. **S5. clankerauth offline keys:**
   - the controller and a host both verify one multi-resource key through `Resource.make`
   - WebSocket `admit` and `watch` on the attach stream
   - checked against the SDK's `/testing` fake issuer and `clankerauth-dev`

## Spike results

The spikes ran on 2026-09-30. The code and full notes are under `spikes/`, and are
deleted in the scaffold phase once folded in.

- **S1, node-pty in the SEA: pass** on darwin-arm64, linux-arm64 and linux-amd64.
  - `pty.node` (and `spawn-helper` on macOS) ship as SEA assets. At runtime they
    are extracted to a 0700 directory and loaded with `process.dlopen`.
  - Use only node-pty's native `fork` and `resize`. The JS wrapper forces
    TERM/PWD, decodes UTF-8 and has an unbounded write queue.
  - Reads use a read-only `tty.ReadStream`. Writes use `fs.writeSync` with an
    EAGAIN timer backoff, because a TTY write stream blocks the event loop. On
    Linux, EOF arrives as `EIO`.
  - The guest daemon must never be PID 1, because Node can't reap orphans. Verify
    each runtime's init in phase 3.
- **S2, Ghostty VT in Node: pass.**
  - One compile per process and one instance per terminal; about 7.4 MiB per
    terminal with full scrollback.
  - Replies are synchronous. The query filter and colour profile work.
  - Snapshots restore exactly into Clankerdesk's engine, including split escape
    sequences, split UTF-8 and the alternate screen.
  - Snapshots are up to about 3.5 MB, so the attach protocol sends them in chunks.
  - History can drift after a restore once scrollback evicts, so never compare
    snapshot bytes for equality.
  - Final screens keep the full scrollback, which you chose; that is up to about
    680 KB.
  - Guest memory never shrinks, so keep a per-guest session cap.
  - `erasableSyntaxOnly` stays on.
  - **Decided:** `packages/terminal-core` is published and shared with Clankerdesk,
    so the Ghostty lockstep holds by construction.
- **S3, exec-channel transport:** D2 passes (see D2). The relays need WebSocket
  ping and timeout on the controller and host hops, so a silently vanished client
  still fires `end_on_detach`. D1's RPC stream stalls under a slow consumer; see
  D1: a credit window fixes it, and long-poll was rejected.
- **S4, SEA build and signing: pass.**
  - `node --build-sea` builds all three targets from one machine, given each
    target's official Node binary. No postject is needed.
  - Binaries are about 144–151 MB, and start in about 42 ms.
  - darwin needs the hardened runtime with `allow-jit` and
    `disable-library-validation`, the latter for the extracted `pty.node`.
  - Linux guest images must ship glibc ≥ 2.34 (for `pty.node`), `libstdc++`,
    `libatomic` and `libgcc_s`. Ubuntu 26.04 has them.
  - Pin the Node archives by SHASUMS256.
- **S5, clankerauth 0.11.0: pass (10/10).**
  - A newly minted key is refused for up to about a minute, until the next
    key-list read. Dev mode and live tests mint keys before the services first
    read their list.
  - Revocation takes about a minute for requests and about two for a watched
    socket.
  - Dev mode embeds `startDisposableIssuer` in-process, with `dataDir` and a fixed
    port so keys survive restarts.
  - Tests use the SDK's `startFakeIssuer` with a `Clock` override.
  - Rate limiting belongs to clankerbox.

## Phases

Each phase ends with `vp run ready` green. The live tests run where hardware allows.

1. **Scaffold.** Root workspace, catalog, lint and CI. Scaffold the
   `apps/clankerbox` role dispatcher and the SEA build for 3 targets, with a
   hello-world per role.
2. **Contract.** Schemas, the tagged errors, the ActionGroups (machine, profile,
   host, session unary) and the session RpcGroup (D1).
3. **Guest.** Session manager, PTY and pipe sessions, VT and the query filter,
   machine preparation, and the stream endpoint. Tested in-process against real
   PTYs.
4. **Host.**
   - Journal, lifecycle, the smolvm and Tart runtimes, the supervisor, builds and
     checkpoints.
   - The guest link (D2).
   - The clankerauth resource.

   Unit tests use a fake runtime layer; the live tests use real VMs.
5. **Controller.** Admission, queue, capacity, profile catalog, the host client
   layer, the session relay and the clankerauth resource.
6. **CLI and dev.** ActionCliClient commands, `shell` and `sessions`, and `dev`
   with clankerauth-dev.
7. **Tooling.** `tools/release` (bundle, images, notices, SEA), `tools/work-runs`
   and `tests/live`. Rewrite AGENTS.md, `WORK_RUNS.md`, the README, docs and ADRs.
8. **Cut over.** Delete `cmd/`, `internal/`, `gen/`, `protocol/`, `go.mod`/`go.sum`,
   `.golangci.yml`, the Makefile, the Python tooling and the historical docs.
   Change `publish-sdk.yml` to publish `packages/contract` on release tags.
   Migrate Clankerdesk in the same coordinated release:
   - `clankerbox.ts`, `guest-terminal.ts` and `guest-mirror.ts` (snapshot-only reconnect)
   - the ownership check in `terminals.ts`, which moves from labels to its allocations table
   - checkpoint deletion (`checkpoints.ts:155`): `status === "deleted"` becomes `not_found`
   - operation status (`checkpoint-client.tsx:190`): `unresolved` becomes `failed` with `uncertain: true` (D5)
   - error-reason branches, updated to the tagged errors
   - the real-clankerbox harness, updated for the new dev mode and config files

   Run the full live acceptance suite on Apple Silicon (smolvm and Tart) and on
   Linux/amd64 with KVM, then merge.
9. **Redeploy production.** In personal-cloud: destroy the 0.11.0 machines and
   checkpoints on both hosts, deploy the TS release with clankerauth keys and host
   TLS server certificates, and republish the profiles (`linux-dev`, `mac-xcode`,
   `gg-linux-dev`).
10. **Clean up the test machines,** following
    [Test machine footprint and final cleanup](#test-machine-footprint-and-final-cleanup).

## Validation

- `vp check`, `vp run -r test` and `vp run -r build` on every change.
- SEA smoke tests on each target: every role starts, `--help` works, and the
  native addon loads.
- Live acceptance, which must cover:
  - create/start/stop/delete
  - RAM fork, and checkpoint capture/restore/delete
  - profile publish/cancel
  - `shell` interactive, piped (binary-safe) and `--tty`
  - `end_on_detach` on a killed CLI
  - host and controller restart keeping VMs and PTYs
  - `--json` error classification
- Clankerdesk's real-clankerbox suite passes against the TS release before merge.
- Every live run goes through the `work-runs` tool, following AGENTS.md teardown
  rules.
