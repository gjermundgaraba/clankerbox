# Claude Code broker probe

Run on 2026-09-08 in disposable `linux-dev-v2` VM `auth-exp-claude`, as fresh Linux user `authprobe` with its normal `/home/authprobe` home. No real credentials, login, user auth files, or provider inference were used. CLI and mock ran in a separate network namespace containing loopback only; no external interfaces/routes existed. An initial attempt to install a UID egress firewall failed because the VM kernel lacks the owner matcher; no CLI requests were run before switching to the network namespace.

## Version and provenance

Actual official `@anthropic-ai/claude-code@2.1.263`, installed from npm with the version pinned. `claude --version` returned `2.1.263 (Claude Code)`. Official [installation documentation](https://code.claude.com/docs/en/setup) identifies this npm package; current npm packaging installs a native binary. Registry metadata is recorded in `package-metadata.json`. The installed Linux x64 binary SHA256 was `26d020351e8112f4006790f3cfce43b4c9df0c1bb1d0e542364d64151b81d5ba`, matching the official HTTPS release manifest excerpt in `binary-manifest.json`. Manifest GPG signature verification was not performed.

## Observations

The harness invokes actual `claude auth status --json` and `claude -p 'Reply with MOCK_OK' --model claude-sonnet-4-6 --tools '' --max-turns 1 --output-format json`. It routes `ANTHROPIC_BASE_URL` to `http://127.0.0.1:18765` and records only request metadata, with credential values redacted before serialization. The response is a controlled Anthropic-format SSE stream. `results.json` contains the raw CLI results and redacted request headers.

| Credential environment | Actual inference header | OAuth beta present | Mock stream |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | `x-api-key` | No | `MOCK_OK`, exit 0 |
| `CLAUDE_CODE_OAUTH_TOKEN` | `Authorization: Bearer` | Yes | `MOCK_OK`, exit 0 |
| OAuth access token plus dummy refresh token and scopes | `Authorization: Bearer` | Yes | `MOCK_OK`, exit 0 |
| Both API key and OAuth access token | `x-api-key` | No | `MOCK_OK`, exit 0 |
| `ANTHROPIC_AUTH_TOKEN` | `Authorization: Bearer` | No | `MOCK_OK`, exit 0 |

All inference requests used `POST /v1/messages?beta=true` with `stream: true`. OAuth mode additionally sent `oauth-2025-04-20` and `extended-cache-ttl-2025-04-11` beta headers. Thus a custom base URL can retain the CLI's OAuth request mode when the OAuth-specific environment variable is used. Generic bearer auth is not equivalent to that mode.

`auth status` alone is insufficient to prove subscription semantics: with both credentials it reported `authMethod: oauth_token` and `apiKeySource: ANTHROPIC_API_KEY`, while the actual request used API-key mode. It also called generic `ANTHROPIC_AUTH_TOKEN` auth `oauth_token` without the OAuth inference beta. All cases reported `apiProvider: firstParty`, even though the endpoint was the local mock. These are CLI labels, not proof of entitlement or billing.

Adding dummy `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` and `CLAUDE_CODE_OAUTH_SCOPES` alongside the OAuth access token behaved identically: successful streaming on 200 and a single failed inference on 401, with no refresh request received by the mock. This does not establish whether any non-loopback refresh connection was attempted, since those cannot connect in this namespace.

The mock's controlled 401 response caused exit 1, `is_error: true`, `terminal_reason: api_error`, and `api_error_status: 401` in each basic credential case. The JSON `subtype` still read `success`, so callers should check exit status and `is_error`, not `subtype` alone. With retries explicitly bounded by `CLAUDE_CODE_MAX_RETRIES=0`, each case sent one inference request; this does not characterize default retry timing. An exploratory rerun without the retry override exceeded the 40-second per-process observation window for a case and was interrupted; its incomplete output is not included as a completed result. The final reproducible run restores the override and uses a 15-second process-group deadline.

## Implications and limits

A broker can receive OAuth-shaped requests using a dummy `CLAUDE_CODE_OAUTH_TOKEN` and a custom base URL. The mock proves request routing, header selection and SSE compatibility; it does **not** prove Anthropic will accept broker-substituted real credentials, subscription billing, provider policy compatibility, account limits, or the full interactive CLI feature set. No money was spent: the tiny `total_cost_usd` shown in mock outputs is the CLI's estimate from synthetic usage, not a provider charge.

Do not set `ANTHROPIC_API_KEY` when testing preservation of subscription/OAuth mode. Official [environment documentation](https://code.claude.com/docs/en/env-vars) confirms API keys take precedence in noninteractive mode and states that an environment OAuth access token is retained for the session; replacing an expired token requires generating another and restarting. It describes `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` plus scopes as provisioning inputs to `claude auth login`, not as automatic refresh of an environment access token. This experiment intentionally did not run login.

Reproduce with `sh spikes/auth-broker/claude/run.sh` from a machine with configured clankerbox access and a free `auth-exp-claude` name. The wrapper creates and deletes only that VM. The experiment VM was stopped and deleted after collecting results. The probe asserts that its network namespace differs from PID 1's before starting the CLI. It uses only fake literals; no HOME/CODEX_HOME overrides. Auto updates and nonessential traffic are disabled in addition to network isolation.

## Managed wrapper and tool roundtrip

`python3 spikes/auth-broker/claude/wrapper_probe.py` exercises the exact `clankerbox-claude` wrapper generated by `internal/host/auth.go` with the installed official macOS Claude Code binary. The recorded run used version 2.1.263. It uses a temporary HOME/config, fake credentials, and `sandbox-exec` to restrict networking to loopback and deny reads of the user's Claude configuration and keychain. It does not require or read a subscription token. Results are in `wrapper-results.json`; the probe uses port 18443 and will fail if another listener owns it.

The wrapper preserved subscription-shaped requests despite deliberately conflicting API-key and alternate-provider settings in both its inherited environment and the temporary user's settings file. It passes narrow `--settings` overrides, including an empty `apiKeyHelper`, and does not edit ordinary configuration files. Managed organization policy or explicit conflicting launch settings can still take precedence; the wrapper is configuration, not a guest security boundary.

The actual CLI accepted a streamed Bash tool call, executed `printf CLANKERBOX_TOOL_OK`, returned that tool's result in its second request, and completed with `MOCK_TOOL_ROUNDTRIP_OK`, exit 0. Both requests were `POST /v1/messages?beta=true`, carried the public OAuth placeholder in `Authorization`, omitted `x-api-key`, and retained the OAuth beta header. The temporary user's original settings file remained unchanged. This validates the launcher and native tool loop against a mock; it does not validate actual Anthropic entitlement, billing, live token acceptance, memory forks, or interactive account features. Synthetic cost estimates in the output are not provider charges.


## Real subscription validation after token import

Claude Code 2.1.263 with `claude-sonnet-4-6` completed real requests on Linux and
macOS through `clankerbox-claude` and the controller-held token. A Linux RAM fork
while the agent waited in Bash preserved both processes; the detached child was
explicitly attached, and both independently completed a second inference turn.
Both Linux process environments held only the OAuth placeholder; their known
credential caches were absent. These are targeted checks, not exhaustive memory
scans. The three disposable VMs were removed and shared connections retained.
See `linux-live-results.json` and `mac-live-results.json`. This supersedes the
earlier statement that real provider acceptance remained untested.
