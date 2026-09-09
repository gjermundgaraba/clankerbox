# Managed authentication

The auth module runs inside `clankerbox-server`. Provider access and refresh tokens
stay in the controller. A machine gets a loopback HTTP relay over controller-initiated
SSH, plus `clankerbox-codex` and `clankerbox-claude` launchers. Every prepared,
running machine automatically receives access to all connected providers. No
provider token or controller private key is installed in the guest. Ordinary guest
`~/.codex` files are not overwritten.

The terminal-session daemon uses a second, independent authorized-key line
tagged `clankerbox-terminal` with a forced command, installed by guest
preparation next to the relay key; neither line widens the other. Guest
preparation also sets `MaxSessions 64` in the generated sshd configuration so
session streams and the relay coexist. See
[terminal-sessions.md](terminal-sessions.md).

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
and no extra deployed service. The guest listeners bind `127.0.0.1:18443` and `/tmp/clankerbox-gh.sock`
through SSH, supporting both Linux/smolvm and macOS/Tart networking.

## Use

```sh
clankerbox auth connect codex
clankerbox auth status
# Wait until this machine's relay is ready. Install Codex in the guest if needed.
clankerbox exec my-machine -- clankerbox-codex --model YOUR_MODEL
clankerbox auth disconnect codex
```

`connect` imports `~/.codex/auth.json` over the existing authenticated HTTPS API.
Use `--auth-file /private/path/auth.json` to import a different login. The controller
keeps one connection per provider; its relays choose the connection by the
provider requested. A machine can use Codex, Claude and GitHub concurrently. There are no
per-machine attachment commands or opt-outs. Disconnecting a provider removes
its access from every machine.
Importing does not log the source client out or change its files. That client still
holds the same refresh token and can independently rotate it, so a dedicated login
is preferable for long-lived controller use. The controller coordinates refreshes
among its machines, but cannot coordinate with a separate local Codex process.

The launcher overrides the model provider for this invocation and forwards user
arguments unchanged; specify a model available to the connected account. It needs
no placeholder auth cache and does not install the Codex CLI itself. Direct `codex`
invocations continue to use their own configuration.

### Claude subscription tokens

Generate a token locally with the unmodified Claude Code CLI's `claude setup-token`
and import it through stdin. Do not paste tokens into command arguments or chat.
For example, in zsh, read the generated token without echoing it:

```sh
read -rs 'claude_token?Claude subscription token: '; print
print -rn -- "$claude_token" | clankerbox auth connect claude --token-stdin
unset claude_token
clankerbox auth status
# Install Claude Code in the guest if needed; wait for its relay to be ready.
clankerbox exec my-machine -- clankerbox-claude
```

The controller stores the opaque token encrypted. It cannot infer the token's
account or expiry; `ready` means locally configured, not yet verified by Anthropic.
Claude connections do not refresh. An upstream authentication rejection marks the
connection as requiring a fresh import. Disconnect it, import a replacement token,
and running machines automatically use it when their relays are ready. Local
disconnect does not revoke the token at Anthropic.

The Claude launcher supplies a non-secret OAuth placeholder and the loopback base
URL. Only the controller substitutes the real token into requests to Anthropic.
The launcher does not write a real token into the guest's environment or auth files.
Ordinary `claude` invocations continue to use their own authentication. Both
launchers use the same machine relay, which selects the corresponding provider
connection for each request.

This supports Claude Code's subscription model requests, not using Claude
subscription credentials in Pi or another model client. `setup-token` does not
support Remote Control or claude.ai connectors. Native login, token capture, and
automatic token renewal are outside this implementation.

Official references: [Claude token setup](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token),
[subscription gateways](https://code.claude.com/docs/en/llm-gateway), and
[credential-use restrictions](https://code.claude.com/docs/en/legal-and-compliance).
Token substitution is a technical design; those sources do not explicitly approve
this controller's storage and substitution of subscription tokens.

### GitHub

`clankerbox auth connect github` privately imports the local GitHub CLI token.
Ordinary guest `git` and `gh` commands then use the controller connection through
managed Git URL rewrites and GitHub CLI's native Unix-socket routing. Guest config
contains only a placeholder. See [GitHub authentication](github-auth.md) for setup,
permissions, validation and current limitations.

## Lifecycle and failure behavior

Every prepared, running machine receives a relay automatically. Newly connected
providers become available through it without changing the machine. Stopped machines
wait until started. After a fork or
checkpoint restore completes, the resulting running machines automatically get
their own relays and access to all connected providers. Controller restarts recover
this access without per-machine configuration. Deletion removes the machine relay.
Disconnecting a provider cancels its active broker requests across all machines;
requests already accepted upstream cannot be recalled.

Before a lifecycle operation can copy memory, the controller closes its source
relay and waits for its transport to finish. The operation journal prevents
reconnection while a source-referencing operation is pending or unresolved,
including across controller restart. Relay shutdown has a forced-close deadline
for unresponsive guests. An interrupted stream is not resumed automatically.

A request's machine identity comes from its controller-created SSH listener. Guest
headers, copied auth files and copied machine IDs cannot impersonate another
machine. Provider credentials and machine authorization remain outside snapshots.
The server pins the prepared guest SSH host key and admits only the expected
running generation. Host/control accounts and root in the controller remain trusted.

For Codex, refresh happens shortly before token expiry and serializes per account. A durable
marker records refresh intent before transmission; a lost response, interrupted
refresh, invalid result or provider rejection requires a fresh import. The module
never blindly retries a rotating refresh token or an inference request. Reconnect
by disconnecting the old connection and importing a fresh login. Running machines
automatically use the replacement connection.

## Scope

This version supports HTTP streaming `POST /v1/responses` using the ChatGPT
Codex backend and Claude `POST /v1/messages` plus `/v1/messages/count_tokens`.
The Claude routes accept the native CLI's optional `beta=true` query. The controller
selects Codex credentials for Codex routes and Claude credentials for Claude routes;
a provider's credentials cannot be forwarded to the other provider. API-key billing,
pi, WebSockets, model listing, remote
compaction, image endpoints and account login capture are not implemented. Those
routes fail explicitly instead of forwarding credentials to arbitrary destinations.
Only a small request/response header allowlist crosses the broker. Agent and GitHub API request
bodies are limited to 16 MiB (Git pack uploads: 256 MiB), with eight concurrent broker requests globally and
four HTTP channels per machine. SSH channels have actual header/body/idle deadlines.

The [experiment report](../spikes/auth-broker/README.md) covers the earlier feasibility
work. Package and controller tests cover encryption/restart, concurrent refresh,
revocation, streaming, identity isolation, unresolved-fork gating, request limits
and unresponsive-guest shutdown. Live deployment validation is recorded separately.

## Historical live validation: 2026-09-08

The following results describe the earlier implementation with manual attachments
and one provider per machine. They establish the recorded inference and isolation
checks, but do not validate the current automatic, multiple-provider behavior.
The automatic workflow was subsequently validated; see the automatic-access record below.

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


## Historical Claude validation: 2026-09-08

These checks also used the earlier manual-attachment implementation.

The controller, both runtime helpers, and local CLI were updated with Claude
subscription-token support. Existing Codex credentials migrated successfully.
The installed Claude Code 2.1.263 passed a loopback-only mock test with streaming,
a Bash tool call, and a second inference request carrying the tool result.
Conflicting shell and user/project credentials were overridden for the invocation;
ordinary settings files were unchanged and the configured API-key helper did not run.
See [the Claude experiment report](../spikes/auth-broker/claude/REPORT.md).

A disposable live Linux VM received the wrapper and a relay for a synthetic Claude
connection. The broker rejected Codex routes for that binding. Its RAM fork had no
relay until explicitly attached; controller restart recovered both relays, and
child detach preserved parent authorization. Both VMs and the synthetic connection
were removed. Both runtime helper hashes matched the local builds. Infrastructure
validation, database integrity, the full Go race suite, and lint passed.

The initial checks above used synthetic credentials. After the operator imported
a token generated by `claude setup-token`, real Claude Code 2.1.263 inference with
`claude-sonnet-4-6` passed on Linux and macOS through the same controller connection.

On Linux, Claude invoked a Bash tool that waited for a release file. A RAM fork
preserved the running process (PID 624) and waiting tool in both VMs. The child had
no relay until explicitly attached. Both processes had only the OAuth placeholder
in their environment, and neither had a Claude credential cache. Releasing the
tool independently in each VM caused both captured processes to make a subsequent
real inference request and finish with `CLAUDE_FORK_OK` (two turns, no API error).
This verifies the controlled tool-wait case, not arbitrary mid-inference streaming
continuation. No running-process fork was performed on macOS.

All three real-inference test VMs were stopped and deleted. The operator's `claude`
and existing `codex` connections remain available, with no test bindings retained.
Sanitized results: [Linux and running fork](../spikes/auth-broker/claude/linux-live-results.json),
[macOS](../spikes/auth-broker/claude/mac-live-results.json). No billing dashboard was
inspected; CLI list-price cost estimates do not establish separately billed usage.


## Automatic-access validation: 2026-09-08

Deployed the controller and CLI with manual attachment APIs, commands, and stored
bindings removed. Both encrypted provider connections survived the migration.
An already-running prepared Linux VM automatically received its relay. Real Codex
0.153.4 (`gpt-6-astra`) and Claude Code 2.1.263 (`claude-sonnet-4-6`) requests ran
concurrently on it and returned their expected markers.

A Linux fork automatically received a relay and completed real Claude inference.
A RAM checkpoint restore automatically received a relay and completed real Codex
inference. No attach operation was used. Controller restart recovered all three
relays automatically. Both helpers were unchanged from the prior deployment.
The full race suite, lint, migration integrity, and infrastructure checks passed.
Provider-isolated cancellation was checked with concurrent mock streams.

All three disposable VMs and the checkpoint were deleted. Both provider connections
remain ready. These checks cover automatic access after creation, fork, restore,
and restart; they do not add a new arbitrary mid-stream continuity guarantee.
Sanitized evidence is in [automatic-auth-validation.json](automatic-auth-validation.json).
