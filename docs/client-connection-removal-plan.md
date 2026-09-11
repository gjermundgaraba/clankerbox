# Client connection removal — clean-break plan

Status: implemented, deployed and live-qualified on 2026-09-11.

The follow-up implementation request authorizes deployment of both applications
and manual validation. Existing workloads and infrastructure remain preserved;
only newly created acceptance machines/checkpoints were workload cleanup targets.

Implementation note: the current Clankerdesk checkout now owns durable create
allocations and no longer exposes the earlier fork workflow. The key field was
removed from its persisted request schema and creation defaults; allocation
recovery remains intact. The predecessor image had no machines.sqlite catalog.

## Agreed scope

- Retire `ssh`, `proxy`, `exec`, `vnc`, `ssh-config install`, `connect`,
  `ports`, `url`, `open-url`, and the hidden forwarding `_owner` command.
- Retire the public raw SSH API and user SSH-key provisioning. Do not replace
  these features with a different client transport or a new exec command.
- Preserve machine lifecycle, checkpoints/forks/restores, sessions, labels,
  events, and local development. Terminal interaction remains through the
  existing guest-session API and Clankerdesk.
- Include matching Clankerdesk changes and a personal-cloud deployment audit.
- Development state is disposable; no compatibility wrappers, deprecated
  stubs, migrations, dual schemas, or automatic legacy-state cleanup.
- The original planning request did not authorize deployment, terminating
  processes, deleting VMs/checkpoints, or editing personal SSH configuration.
  The follow-up authorizes the coordinated deployment and disposable live tests.
  Existing operating records describe deployed infrastructure; inventory it before
  any cutover.

No unresolved product-scope questions remain.

## Companion-repository inspection at planning time

### Clankerdesk

`../clankerdesk/packages/api/src/clankerbox.ts` requires a nonempty
`MachineDefaults.sshPublicKeys`. `apps/server/src/machines.ts` forwards those
public keys as `ssh_public_keys` on create and fork. They provision ordinary
guest SSH login access; they do not authenticate Clankerdesk's terminal
connections. Fork currently calls `defaults()` solely to obtain these keys.

`apps/server/src/clankerbox.ts` connects terminals through
`/v1/machines/{id}/sessions/stream` with `clankerbox-session` and the controller
bearer token. Its machine view does not consume guest SSH user/host-key fields.
The inspected source has no raw `/ssh` or retired CLI-command dependency.
Fixtures assert the old request bodies, and `docs/terminal.md` documents the
key configuration. Remove this requirement and pass-through, not terminal
transport or bearer credentials.

### Personal-cloud

`../personal-cloud/hosts/clankerbox-controller/ssh_config` and `provision.yml`
configure a controller-only SSH identity and pinned known hosts for the Linux
and Mac runtime hosts. These are internal control-plane credentials, not
workstation login keys. Keep them, OpenSSH, the forced-command host wrapper,
and the controller's separate guest terminal key. The operating README contains
historical forwarding qualification results; distinguish those historical
claims from current supported features and updated acceptance procedures.

## Removal inventory

### Delete

- Command registrations, handlers, flags (`--forward`, `--viewer`, lifecycle
  `--key`), raw exec argument parsing, SSH process exit-status handling, viewer
  launching, SSH aliases, generated known-hosts/config writers, and forwarding
  output formats.
- `internal/client/ssh.go`, `trust.go`, `owner.go`, `ipc.go`, `process.go`,
  `storage.go`, and `stream.go`, plus dedicated obsolete tests. Their production
  callers all belong to the retired connection stack.
- Forward endpoint discovery/parsing and URL rewriting in
  `internal/client/endpoints.go`, after moving its still-used API port validator
  and HTTPS constant into API code. Do not weaken API-origin validation.
- `API.Upgrade`, its buffered connection and raw TCP/TLS upgrade helpers in
  `internal/client/api.go`; the ordinary HTTP API client stays.
- Client `identity_file`, `public_key_file`, and forwarding `state_dir` config;
  remove `Config.Path` if it has no remaining production consumer. Update test
  fixtures to own their config paths rather than retaining fields for tests.
- `SSHPublicKeys` / `ssh_public_keys` from create/child inputs and the private
  controller/helper request; all key-file reads, defaults, validation and
  propagation supporting those fields.
- `GET /v1/machines/{id}/ssh`, its handler, and `clankerbox-stream` upgrade
  support. No redirect or tombstone endpoint; authenticated requests get 404.
- The public `ssh` runtime capability. Advertise existing session support
  consistently with local runtime profiles; update profile fixtures/docs.
- `internal/dev/dev.go`'s dummy `access.pub` generation and the obsolete fields
  emitted in `client.json`. The private half of that generated access key is
  already discarded; it exists to satisfy the old create-input requirement.
- `tests/live_connections.py` and `tests/test_live_connections.py`: their feature
  is retired, rather than ported to another forwarding implementation.

### Collapse

- Make the guest's supported SSH authentication path controller-terminal-only.
  Replace preservation/merging of arbitrary guest login keys with a single
  managed forced-command terminal-key path. Do not touch runtime-host or
  workstation `authorized_keys` files.
- Generate the final guest sshd policy in bootstrap: no TCP/Unix forwarding,
  agent forwarding, interactive SSH PTY, or SFTP support; retain the exec
  channels needed by `clankerbox-guest proxy` and its session capacity.
  Remove later config rewriting that exists only to raise `MaxSessions`.
- Rename/move shared controller stream bridging directly to session-appropriate
  names. `bridgeSSH`, `closeStream`, and `hasToken` currently also serve
  `guest_http.go`; deleting the raw route must not delete these behaviors.

### Keep intentionally

- `internal/control/ssh.go`, `ssh_guest.go`, `guest_link.go`, host `--connect`
  and `--guest-prepare`, `scripts/host-entry.sh`, and `clankerbox-guest proxy`.
  They carry controller-to-host operations and controller-to-guest sessions.
- Guest sshd, controller terminal-key installation, SSH host-key generation,
  pinning/verification, and machine/observation SSH identity and endpoint fields.
  Start preserves identity; fork/restore must establish a fresh child identity.
- Guest protocol, daemon, session process execution, and local dev SSH transport.
  SSH exec channels and runtime `tart exec` are not the retired CLI command.
- `golang.org/x/crypto` and public-key validation required by internal host-key
  and terminal-key paths. Simplify the validator to its actual single-key callers
  if multi-key collection handling becomes unused; do not delete key validation.
- Shared `internal/statefs`, state ownership checks, lifecycle journals,
  reconciliation, copy-time link suspension, cancellation, and readiness checks.
  These protect current operations, not retired compatibility paths.

## Implementation sequence

### 1. Remove the client feature surface and its dependency closure

Update `internal/client/commands.go`, `cli.go`, `api.go`, `lifecycle.go`,
`checkpoint.go`, `output.go`, and `cmd/clankerbox/main.go`. Delete the listed
connection files and tests; rewrite mixed CLI/API tests around retained commands.
Keep token-file resolution, verified HTTPS, loopback HTTP restrictions, request
authentication, lifecycle waiting/idempotency, and event streaming.

### 2. Complete the controller/host/schema break

Update `internal/model/model.go`, controller create/derive paths, host runtime
interfaces, bootstrap, child preparation, local dev setup, and their fakes/tests
together. Remove all supplied-login-key requirements and the raw API route.

**Critical bootstrap dependency:** `bootstrapScript` currently uses
`len(keys) != 0` to distinguish initialization from start-time verification.
Simply removing keys would skip ownership, host-key generation and child
identity installation. Replace this sentinel with explicit initialization and
verification entry points selected by the existing lifecycle phases. Preserve
reply-loss recovery and the handshake proving the child's new host key is live.

Initialize the managed authorization file without user keys; guest preparation
installs the controller's restricted key. Verify this sequence works before
declaring the guest ready, including after fork/restore and cold restart.

### 3. Update the actual external caller

In `../clankerdesk`:

- Remove `MachineDefaults.sshPublicKeys` from `packages/api/src/clankerbox.ts`.
- Remove request fields from `apps/server/src/clankerbox.ts` and their emission
  from `apps/server/src/machines.ts`.
- Remove fork's now-unnecessary dependency on machine defaults. Keep profile
  and host defaults for create and preserve workspace labels.
- Update `apps/server/tests/clankerbox-fixture.ts`, machine-service/config
  tests, and `docs/terminal.md`.
- Assert create/fork omit `ssh_public_keys`, configuration needs no login keys,
  and fork works without creation defaults. Existing terminal connection,
  snapshot/resume, session end, and machine workflow tests must still pass.

Land matching versions together: Clankerbox's strict JSON decoder will reject
the old key-bearing requests, so the old desk is not a supported intermediate.

### 4. Preserve acceptance coverage without resurrecting exec

`tests/live_lifecycle.py` and `tests/live_checkpoints.py` use `clankerbox exec`
for setup, workspace checks and RAM-process probes. Keep that coverage and
move their guest actions to the existing session API through a test-only
adapter using the guest protocol client. Do not add a supported exec CLI alias
or a new production endpoint to make the old tests pass.

The adapter must account for PTY output, session completion, bounded waits,
and cleanup. Preserve dirty-Git persistence, stopped-machine refusal, child
host-key separation, RAM continuity, independent restored disks, and deletion
guards. Update harness options/results that currently mention SSH or `--key`.

### 5. Sweep documentation, tooling and dependencies

Update `README.md`, `docs/module-contracts.md`, `docs/local-development.md`,
`docs/terminal-sessions.md`, and current architecture/operation references.
Mark historical plans/evidence as historical rather than rewriting past results.
Sweep tracked scripts, fixtures and spikes for actual retired command callers;
do not delete generic runtime experiments because they contain `ssh` or `exec`.

Audit `images/` packages such as `lsof`/`iproute2` against remaining image tests
and supported toolchain promises. Remove only requirements solely introduced
for retired discovery, not useful guest tooling merely because discovery used
it. Audit personal-cloud current deployment examples and validation commands;
keep its internal SSH and network/ownership safeguards.

Run `go mod tidy`, inspect the dependency delta, and retain packages used by
the session/control stack. Do not preserve empty modules or alias exports.

## Validation and completion criteria

- All retired commands are absent from help and fail as unknown commands,
  including `_owner` and `ssh-config`; no retired key flags remain.
- Authenticated raw SSH API requests return 404; bearer authentication still
  protects remaining endpoints. Old `ssh_public_keys` request bodies are
  rejected, while keyless create/fork/restore succeed.
- No client forwarding process, listener, trust ledger, generated SSH files,
  identity-file reads or SSH-agent dependency remains.
- Run targeted package tests while editing, then `make build`, `make test`
  (race detector), `make lint`, and
  `python3 -m unittest discover -s tests -p 'test_*.py'`.
- Run Clankerdesk's required checks/build/tests (its root `ready` pipeline),
  including machine workflows and retained terminal integration coverage.
- Validate changed shell/Ansible tooling as applicable and run diff/reference
  checks in every changed repository. Do not claim unchanged files were tested
  by a tool that was not run.
- Qualify Linux and macOS with fresh disposable machines: keyless lifecycle,
  ready guest link, terminal create/attach/resume/end, stopped-session refusal,
  host-key continuity/separation, and existing fork/checkpoint guarantees.
  Use local dev integration tests for non-hypervisor CI coverage; explicitly
  report live qualification as pending if deployment access is not exercised.
- Report the final deletion inventory, retained SSH uses, checks and actual
  line-count delta. The dedicated candidate files alone currently total about
  3,667 lines before retaining small helpers and adding replacement tests;
  this is an inventory size, not a promised net reduction.

## Operational boundary

No migration code or automatic workstation cleanup. If old generated SSH
Includes/owner processes exist, document explicit operator removal of only
Clankerbox-owned artifacts; never rewrite unrelated personal SSH settings.
Before any deployment, identify exactly which disposable machines/state may be
reset and coordinate controller, helpers and desk. Preserve infrastructure
credentials, ownership journals and unrelated machines unless separately
selected for retirement. Do not execute the old deployment record's cleanup
steps as part of implementing this source change.

## Completion record — 2026-09-11

- Product removal: `f232ece678ac292f12cd5e9b74fce445a2e5933e`.
  Test-only HTTPS runner correction: `316e6fa` (HTTP/1.1 ALPN, including after
  the default transport has negotiated HTTP/2; regression test added).
- Clankerdesk: `fea997383189c4f2cd7e68a2f3eb44e97985ed1b`; personal-cloud
  Compose no longer provisions workstation keys. Release/image pin: `74b9a24`.
  Controller and both Linux/macOS helpers and guest artifacts were installed
  together. No database reset, workload rebuild, credential rotation, firewall
  change or personal SSH configuration edit was needed.
- An obsolete active `terminal` extension left by the preceding desk deployment
  conflicted with the combined `clankerbox` extension. The exact active library
  entry was manually deactivated while stopped, after backing up the catalog;
  existing workspace data and historical pinned revisions were preserved. There
  is no product migration, alias, fallback or automatic legacy-state deletion.
- `make build`, `make test` (race detector), `make lint`, four Python unit tests,
  local real-dev session command/output/exit checks, and the runner's focused
  race/HTTPS regression tests passed. Clankerdesk `vp run ready` passed (103
  server tests and seven browser tests); GitHub Quality and image CI passed.
- Live public-contract checks passed: all ten retired commands and connection
  flags fail; authenticated raw SSH returns 404, unauthenticated access 401;
  key-bearing provisioning requests return 400. Machine capabilities advertise
  sessions, not SSH.
- Linux and macOS keyless create/stop/start retained dirty Git state, modes,
  symlinks and machine identity; stopped sessions were refused. Both exercised
  session create/snapshot/input/reconnect/resume/activity/end. Fresh guests had
  exactly one restricted forced-command terminal key, no interactive SSH PTY,
  TCP/agent/X11 forwarding or SFTP subsystem, and MaxSessions 64.
- Linux live fork and two RAM-checkpoint restores preserved the in-memory token
  and PID. Mac stopped disk fork/checkpoint/restore passed. Both verified fresh
  child SSH identities, cold-restart identity stability and independent disks;
  Linux also verified the source deletion guard.
- Live browser validation created a machine and tethered terminal, sent real
  keyboard input from two browsers and input through MCP, saved a shared note,
  selected a wtf ticket, and restarted the desk container. Session PID 517,
  terminal screen, placement, note and ticket survived. Browser-confirmed machine
  closure removed its machine, terminal and tether. No browser page errors.
- All eight lifecycle/copy qualification machines and both checkpoints were
  deleted by their tests; the separate browser-created machine was also deleted.
  Existing `test-machine` (`ad8cd000ed13c8996c30fe8a7eace330`) remains running,
  guest-ready, with its original generation and host identity and no sessions.
- Infrastructure validation, deployment status (including outside-source denial),
  backup freshness and retained restore evidence checks passed. Fresh desk export
  `20260911T214511Z` passed archive/checksum and restored SQLite integrity checks,
  including its new machine-allocation catalog. This is artifact verification,
  not an isolated restored application startup.
- Unrelated canvas limitation observed: an overlapping terminal can intercept
  pointer events intended for another card. Moving the cards apart allowed the
  workflow; it is recorded in Clankerdesk's current limitations, not hidden by
  forced clicks. A transient controller timeout during simultaneous copy tests
  recovered via the existing explicit **Retry creation**, without reallocating.

Private evidence: `.work/client-removal-20260911/` and
`../clankerdesk/test-results/client-removal/`. Deployed hashes and recovery details
are in personal-cloud's controller and Clankerdesk operating records.

### Review qualification correction

The original live `stopped_session_rejected` result above exercised the runner's
local readiness guard, not the session endpoint. It does not establish live
server-side stopped-session enforcement. The harness now requires a direct
HTTP 409 `prerequisite` response; local controller and probe regression tests
cover that contract and reject unrelated failures. The corrected live check
has not yet been rerun against personal-cloud.
