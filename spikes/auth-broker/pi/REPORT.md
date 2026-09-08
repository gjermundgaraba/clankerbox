# Pi auth-broker experiment

Executed 2026-09-08 with the actual `@earendil-works/pi-coding-agent@0.85.1`
CLI in disposable Clankerbox Linux VM `auth-exp-pi`
(`d333b1890a1b23cd2418fd465d93f567`, profile `linux-dev-v2`).
Node 26.8.1, npm 11.19.0. npm reported package integrity
`sha512-FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ==`.
The official [earendil-works/pi repository](https://github.com/earendil-works/pi)
identifies this package; npm repository metadata agrees.

## Result

**An async provider extension can obtain a dummy access credential from a broker
and run a successful streamed CLI turn without a stored provider login.**
This is a working extension seam, not an implemented production OAuth broker.

| Scenario | Observed result |
| --- | --- |
| Broker supplies placeholder, model endpoint streams SSE | HTTP `/credential` followed by `/v1/chat/completions`, `stream: true`, bearer placeholder; two content deltas complete `BROKER_STREAM_OK`; CLI exit 0 |
| Model endpoint rejects credential with HTTP 401 | Assistant message has `stopReason: error` and explicit 401 error; no automatic credential re-resolution observed; **CLI JSON mode still exits 0** |
| Broker credential endpoint rejects with HTTP 403 | Extension loading fails with broker error, provider remains unknown, CLI exits 1; no model request |

The fresh authprobe user's `~/.pi/agent/auth.json` remained `{}`. No refresh
token existed in the guest. The placeholder access credential did exist in
extension/process memory and in the dummy HTTP request. JSON-mode consumers
must inspect assistant error events rather than trusting exit status alone.

## Important compatibility finding

The current upstream and bundled `docs/custom-provider.md` advertise
`createProvider` / `openAICompletionsApi` from the package root. The installed
0.85.1 runtime did not export these functions (the first attempted native
provider failed with `openAICompletionsApi is not a function`; inspection also
found no root createProvider export). We therefore tested the documented
legacy `pi.registerProvider(name, config)` with an **async extension factory**.
Resolution occurs at extension startup, not on each request. This experiment
makes no claim that native `auth.resolve` works in this published version.
See [official provider docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md).

## Reproduction

Create the named VM with `clankerbox create auth-exp-pi --profile linux-dev-v2`.
Inside it, create an isolated user via `useradd -m -s /bin/bash authprobe`.
Install using `runuser -l authprobe -c 'npm install --ignore-scripts --prefix
/home/authprobe/pi-install @earendil-works/pi-coding-agent@0.85.1'`.
Copy these three scripts to `/home/authprobe/probe`, owned by authprobe, then
run `runuser -l authprobe -c 'bash /home/authprobe/probe/run-guest.sh'`.
The script starts/stops the loopback mock and records each scenario separately.
Collected outputs live in [evidence](evidence/).

No HOME or CODEX_HOME override was used; no real user provider credentials were
read or copied. Both broker and model endpoints were the same loopback-only mock.
No real provider spend occurred. Real browser login, subscription routing,
provider refresh, broker transport authorization, mid-session renewal,
checkpoint/fork behavior and isolation from same-user code were not tested.
The result demonstrates delegating credential acquisition, not keeping an
access token out of the guest. A proxy could instead accept a guest-scoped
capability, but that was not implemented here.

Cleanup completed: VM stopped and deleted; delete operation
`c82bec4fc2f029fdd1ba2f3cbdeb9c14` succeeded. No VM/checkpoint remains from this spike.
