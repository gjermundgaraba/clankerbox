# Application-neutral cutover

The managed-auth subsystem and application-specific activity detection were
removed as a clean break on 2026-09-11. This is not a disabled feature or a
migration path. Applications run with credentials and configuration supplied
by their users, outside Clankerbox's provider-agnostic machine/session API.
Credentials configured inside a guest may be captured in its disk or RAM
snapshots. Treat those snapshots/backups as sensitive; Clankerbox no longer
provides external credential storage or centralized provider revocation.

The later wire-revision-3 cutover also removed generic activity reporting and
foreground-process metadata. References to hooks below describe the historical
verification run, not the current API.

## Removal inventory

- Deleted the credential broker, its encrypted store, all three production
  provider adapters, refresh logic, API/CLI operations, SSH relays, and tests.
- Deleted host auth preparation, launchers, GitHub Git/shell configuration,
  server encryption-key configuration, and the machine `auth_relay` view.
- Removed all 17 agent-command heuristics, the two launcher aliases, and their
  output-timing state.
- Removed the auth-broker experiments (including experimental Pi support),
  the real-agent workload harness, provider-specific Cocoon/Cube/smolvm
  experiments and evidence, and their setup/validation documents.
- Updated the spike runner and retained documentation/fixture references.

Shared guest-link eligibility, the SSH stream adapter, guest preparation, and
OS-user constants were moved/renamed directly. Guest-link suspension before
memory copies, operation recovery, API bearer authentication, pinned SSH
identities, file permissions, ordinary Git, and application-neutral runtime
experiments remain supported.

The unrelated protected VM named `codex-macos-tahoe-xcodegen-base` remains named
in historical inventories and an ownership-rejection test: it is not a product
integration and must not become an accidental cleanup target. GitHub dependency
and upstream source URLs likewise remain. The pre-existing untracked
`docs/architecture-overview.html` was not edited.

## Deployment cutover

The matching service unit, provisioning playbook and operating record live in
`personal-cloud/hosts/clankerbox-controller/`.

The user explicitly authorized deleting the old `test-machine` VM, ending its
shell, discarding its files, and rebuilding controller state. No other existing
workload was selected for deletion. The old VM's runtime files were verified
absent. All eight pre-cutover checkpoint records already had deleted status.

The controller and both runtime helpers/guest binaries were replaced together.
Only the controller database was rebuilt; normal API/control/terminal keys,
network policy, host ownership journals, and clean profile seeds were retained.
Fresh Linux and macOS guests were audited for retired launchers, Git/shell
routing, relay keys, Unix sockets, and TCP listeners; none remained.

The broker key and its operator recovery copy were removed. Ten auth-bearing
controller database backups and their SQLite companions were retired after
replacement validation. Unrelated recovery artifacts and ordinary local provider
logins were not removed. This is filesystem retirement, not a secure-erasure or
upstream token-revocation claim. Old auth-bearing deployments are not supported
rollback inputs.

The replacement `test-machine` has ID
`ad8cd000ed13c8996c30fe8a7eace330`; its prior workspace label was restored.
Clankerdesk's old machine binding must be reselected; the original machine ID
was not reused.

## Verification

- `make build`, `make test` (race detector), and `make lint`: passed.
- Product Python tests: 5 passed; retained spike runner: all 12 suites passed
  in normal and optimized Python.
- Host-entry shell syntax/ShellCheck, Ansible provisioning syntax, local link
  checks, and both repositories' diff checks: passed.
- Controller infrastructure checks: service, firewall/sshd configuration,
  WireGuard handshake, and file ownership/permissions passed.
- Removed API routes returned 404 with valid authentication; ordinary requests
  without bearer authentication still returned 401. The fresh database contains
  only `machines`, `operations`, and `checkpoints`; responses omit `auth_relay`.
- Linux and macOS: create, stop/start, retained dirty Git state and SSH identity,
  SSH refusal while stopped, terminal snapshot/resume, generic activity hooks,
  and process-exit override passed.
- Linux forwarding: independent consumers, stable listener churn, preserved
  URLs and controller stop/start recovery passed.

- Linux: live fork, independent cold-restarted disks, source-dependency deletion
  refusal, RAM checkpoint, two independent restores retaining the captured
  process, and guest-link recovery after copies/restarts passed.
- macOS: stopped-disk fork, independent cold-restarted disks, checkpoint and two
  independent restores with distinct SSH identities and ready guest links passed.

The first Mac fork-child stop briefly reported host-mutation lock contention.
The controller completed the **same accepted operation** about 12 seconds later.
The conservative harness stopped on the intermediate unresolved status; after
inspection, the remaining checks were resumed without resubmitting that mutation.
The initial failed harness report and successful continuation are both retained.
No production retry or compatibility mechanism was added.

All qualification machines and checkpoints were deleted after verification.
Fresh Linux/macOS smoke tests against the final helper artifacts repeated guest
preparation/audits, terminal resume/hooks/end, and stop/delete successfully.
Only the replacement `test-machine` remains running; it has a ready guest link
and no test terminal sessions. Uploaded staging files were removed. Installed
artifact hashes and checks are recorded in the deployment runbook.
Private operation-level evidence is in `.work/clean-break-20260911/`; it contains
no provider credential payloads.
