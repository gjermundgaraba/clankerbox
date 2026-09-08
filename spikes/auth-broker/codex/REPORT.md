# Codex controller auth feasibility probe

Run 2026-09-08 using actual `@openai/codex@0.153.4` (`codex-cli 0.153.4`) in disposable Linux VM `auth-exp-codex`, as isolated user `authprobe`.

## Protocol tests

`mock-results.json` records five cases in a loopback-only network namespace. All credentials were synthetic. A custom Responses provider used `requires_openai_auth = true`, `supports_websockets = false`, and a local `chatgpt_base_url`.

| Case | Result |
| --- | --- |
| API key + streamed response | Marker received, exit 0 |
| API key + 401 | Turn failed, exit 1 |
| ChatGPT-shaped cache + streamed response | Marker received, account header retained, exit 0 |
| ChatGPT-shaped cache + 401, refresh blocked | Attempted auth.openai.com refresh; turn failed, exit 1 |
| ChatGPT-shaped cache + first 401, mock refresh succeeds | One mock OAuth refresh, Responses retry succeeds, exit 0 |

The last case intercepts HTTPS using a throwaway local CA inside the isolated VM. It proves the CLI refresh path, not real provider refresh or controller refresh serialization. Real credentials and real CA trust settings were not involved. Codex also makes model, plugin and MCP requests; minimal mock replies cause diagnostic errors on those auxiliary paths without preventing the successful inference turn. The tests cover HTTP SSE, not WebSockets or all interactive features.

Reproduce the mock cases with `sh spikes/auth-broker/codex/run.sh`. This creates and deletes the named VM and requires an unused name. The Python probe is intended only for that disposable user and network namespace.

## Live provider smoke test

`live-results.json` records one successful real ChatGPT Codex inference through a temporary laptop proxy using the configured `gpt-6-astra` model. The VM held a synthetic ChatGPT auth cache. The proxy read the existing laptop access token and account ID into memory, substituted those headers, and forwarded only Responses requests to `https://chatgpt.com/backend-api/codex/responses` using normal TLS verification. The real access token never entered the guest; no refresh was attempted, and the laptop auth file was byte-for-byte unchanged.

Two earlier requests returned 400 before the successful request: a test-harness Content-Type handling bug, then a model unavailable to the account. The final evidence captures the successful run only. The successful request used the real account's allowance; this was not a zero-spend mock.

`live_proxy.py` is an explicit live-test harness, not part of the default runner. It requires the prepared disposable VM, a populated Clankerbox SSH config, and temporary loopback reverse forwarding (`AllowTcpForwarding yes`, `PermitListen 127.0.0.1:18080`) in that VM. It reads the local active model and existing access token and refuses to refresh. It does not implement login UX or a production broker. The reverse tunnel is torn down in `finally`.

## Lifecycle scope

`lifecycle_proxy.py --source-id ID` uses the prepared `auth-exp-codex` VM, verifies its ID, forks it and restores a checkpoint, and runs fresh real CLI processes against synthetic streams through independently bound SSH relays. It temporarily enables loopback forwarding on these disposable machines. External credential generation is a counter in laptop memory, not an actual token exchange. Child/checkpoint cleanup is automatic; the source VM remains the caller's responsibility.

This can test that requests from copied guest state reach current external authorization and that one machine can be denied independently. It cannot establish continuation of the same running agent across a RAM fork, real provider refresh races, production host identity enforcement, or provider concurrency limits.

The completed lifecycle run passed all six turns/decisions: parent before rotation, concurrent parent and fork after generation changed to 2, old-checkpoint restore observing generation 2, revoked child failing with exit 1, and parent remaining authorized. See `lifecycle-results.json`. The first attempt stopped at cloned-VM SSH forwarding policy; the final harness enables loopback forwarding on each test machine before binding its relay.
