# Managed Codex authentication

The auth module runs inside `clankerbox-server`. Provider access and refresh tokens
stay in the controller. A machine gets a loopback HTTP relay over controller-initiated
SSH, plus a `clankerbox-codex` launcher. No provider token or controller private key
is installed in the guest. Ordinary guest `~/.codex` files are not overwritten.

## Controller setup

Install matching server, host helper and `scripts/host-entry.sh` versions on both
runtime hosts. Add `--auth-key-file /etc/clankerbox/auth.key` to the server command.
The file must contain exactly 32 random binary bytes, belong to the service user,
and have mode 0600. Create it once with a cryptographic random generator; never
silently replace it. Omitting the flag leaves managed auth disabled.

Credentials are encrypted with AES-256-GCM in `controller.db`; the key stays outside
the state directory and must be backed up separately. Losing the key loses access
to stored connections. Supplying a wrong key fails startup instead of discarding
credentials. The same key derives a domain-separated SSH relay signing key.

The host's existing forced-command wrapper admits only a validated machine ID and
public relay key for preparation. There is no extra network listener on either host
and no extra deployed service. The SSH listener binds only `127.0.0.1:18443` inside
the VM and supports both Linux/smolvm and macOS/Tart networking.

## Use

```sh
clankerbox auth connect codex
clankerbox auth attach my-machine
clankerbox auth status
# Wait until this machine's relay is ready. Install Codex in the guest if needed.
clankerbox exec my-machine -- clankerbox-codex --model YOUR_MODEL
clankerbox auth detach my-machine
clankerbox auth disconnect codex
```

`connect` imports `~/.codex/auth.json` over the existing authenticated HTTPS API.
Use `--auth-file /private/path/auth.json` and `--name NAME` for a separate login.
Importing does not log the source client out or change its files. That client still
holds the same refresh token and can independently rotate it, so a dedicated login
is preferable for long-lived controller use. The controller coordinates refreshes
among its machines, but cannot coordinate with a separate local Codex process.

The launcher overrides the model provider for this invocation and forwards user
arguments unchanged; specify a model available to the connected account. It needs
no placeholder auth cache and does not install the Codex CLI itself. Direct `codex`
invocations continue to use their own configuration.

## Lifecycle and failure behavior

Attachments are explicit and persist through controller restarts and machine stops.
A running prepared machine receives a relay; stopped machines show a waiting state.
Forks and checkpoint restores start **detached**, even if the launcher was copied.
Attach the child explicitly. Deletion removes the binding. Detach/disconnect cancel
active broker requests; requests already accepted upstream cannot be recalled.

Before a lifecycle operation can copy memory, the controller closes its source
relay and waits for its transport to finish. The operation journal prevents
reconnection while a source-referencing operation is pending or unresolved,
including across controller restart. Relay shutdown has a forced-close deadline
for unresponsive guests. An interrupted stream is not resumed automatically.

A request's machine identity comes from its controller-created SSH listener. Guest
headers, copied auth files and copied machine IDs cannot choose another binding.
The server pins the prepared guest SSH host key and admits only the expected
running generation. Host/control accounts and root in the controller remain trusted.

Refresh happens shortly before token expiry and serializes per account. A durable
marker records refresh intent before transmission; a lost response, interrupted
refresh, invalid result or provider rejection requires a fresh import. The module
never blindly retries a rotating refresh token or an inference request. Reconnect
by disconnecting the old connection, importing a fresh login and attaching machines.

## Scope

This version supports HTTP streaming `POST /v1/responses` only, using the ChatGPT
Codex backend. API-key billing, Claude Code, pi, WebSockets, model listing, remote
compaction, image endpoints and account login capture are not implemented. Those
routes fail explicitly instead of forwarding credentials to arbitrary destinations.
Only a small request/response header allowlist crosses the broker. Guest request
bodies are limited to 16 MiB, with eight concurrent broker requests globally and
four HTTP channels per machine. SSH channels have actual header/body/idle deadlines.

The [experiment report](../spikes/auth-broker/README.md) covers the earlier feasibility
work. Package and controller tests cover encryption/restart, concurrent refresh,
revocation, streaming, identity isolation, unresolved-fork gating, request limits
and unresponsive-guest shutdown. Live deployment validation is recorded separately.

## Live validation: 2026-09-08

Deployed to the existing controller and both runtime hosts. Codex 0.153.4 with
`gpt-6-astra` completed real streamed requests on Linux, macOS, and a restored Linux
RAM checkpoint. Guests had no Codex auth cache. A Linux fork initially had no
binding or listener, and explicit attachment established its own relay.

For running-process continuity, Codex started a shell tool waiting on a local file.
The VM forked while that tool was running. After attaching the child and releasing
the tool separately in each VM, both captured Codex processes completed their
turns with `AUTH_RUNNING_OK`. This proves that controlled case, not arbitrary
mid-inference stream continuation or provider-side session independence.

A controller restart recovered the encrypted connection and all five attached
machine relays. Detaching one child closed its listener while the parent remained
available. The local source login file was unchanged. Real token refresh was not
forced; refresh concurrency and ambiguous outcomes were tested with synthetic
credentials. The existing imported login remains connected as `codex`.

All five disposable machines and the test checkpoint were deleted after these
checks. No test bindings remain; the imported connection is retained.
Sanitized outcomes and deployed artifact hashes are in
[managed-auth-validation.json](managed-auth-validation.json). No provider tokens,
private keys, raw account identifiers or full provider replies are included there.
