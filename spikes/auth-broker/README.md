# Auth broker feasibility experiments

Executed 2026-09-08 after committing existing work:

- Clankerbox `1de68df`: machine CLI workflows and host capacity reporting. Race tests, lint and Python unit tests passed before commit.
- personal-cloud `d794008`: controller/runtime deployment configuration and matching changesets. Unrelated working-tree changes were excluded.

## Findings

| Tool | Tested integration | Result |
| --- | --- | --- |
| [Codex 0.153.4](codex/REPORT.md) | Custom Responses endpoint, synthetic guest auth, real credential substituted outside VM | Real ChatGPT inference passed; local auth unchanged and real token absent from guest. Mock 401/refresh paths also passed. |
| [Claude Code 2.1.263](claude/REPORT.md) | Custom base URL plus OAuth-specific placeholder | Mock streaming passed with OAuth headers. API keys take precedence if both are supplied. Real Anthropic acceptance remains untested. |
| [Pi 0.85.1](pi/REPORT.md) | Async legacy provider extension obtains placeholder from mock broker | Mock streaming passed, no stored login. Documented newer provider exports were absent in this release. Inference 401 can still exit 0. |

Codex additionally passed synthetic authorization checks across actual machine fork and checkpoint restore: both copies used current external state, restoring an older snapshot did not roll that state back, and revoking the child left the parent authorized. Each turn started a new CLI process; resuming an already-running agent across a RAM fork remains untested. The generation change was a mock counter, not real OAuth rotation.

## Recommended implementation sequence

1. Add `internal/auth` to the existing controller with connection records, encrypted credential storage, machine bindings and account-scoped refresh serialization. Store the encryption key separately from database backups; do not return provider secrets from status endpoints.
2. Implement host-authenticated per-machine relays. Derive machine identity from host-controlled routing, not copied guest files or guest-supplied headers. The spike used independent SSH reverse tunnels; production transport is still to be built.
3. Start with the proven Codex HTTP Responses path. Keep real access and refresh tokens in the controller; inject credentials into allowlisted upstream requests and preserve streaming/cancellation. Perform refresh centrally before returning an authentication failure to the guest. Test model discovery and other supported auxiliary endpoints explicitly.
4. Add CLI connection/attachment/status/revocation UX. Keep provider account login separate from machine attachment. Make unsupported or expired connections actionable without displaying secrets. The login capture/import flows still need implementation and provider-specific validation.
5. Add Claude OAuth and API-key modes as explicit, separate adapters. Then add Pi through its working extension seam, initially providing a guest relay capability rather than a real provider token. Pin tested versions and inspect structured failure events.
6. Integrate machine lifecycle: allocate a new binding when forking/restoring, apply an explicit inheritance policy, and revoke on deletion. Test already-running agents, concurrent real refresh, revocation during streams, controller restart, encryption-key recovery and both host runtimes before broad rollout.

No production auth module was implemented by these experiments. No real Claude or Pi login/refresh was tested. The successful real Codex request used the existing account allowance; all other model responses and lifecycle credentials were synthetic. Detailed reports separate observed behavior from remaining assumptions. Scripts and sanitized evidence are retained here; real credentials and throwaway certificate keys are excluded.

Cleanup verified: all experiment VMs were deleted; both Codex lifecycle checkpoints have deleted status. Python syntax, shell syntax, evidence assertions and a redacted gitleaks scan passed. Experiment artifacts are left uncommitted for review.
