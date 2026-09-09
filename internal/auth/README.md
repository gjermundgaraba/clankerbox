# Controller credential broker

`New(db, key)` requires an explicit 32-byte key and exclusive ownership of the
controller database for the lifetime of the process. The controller owns private
key-file creation, database file permissions, process locking, and machine
authorization. The package never reads the user's home directory or auth cache.

`Import` accepts an unexpired ChatGPT Codex auth cache, including its refresh
token, account ID, and an access JWT with matching account and expiry claims.
Those claims are metadata, not locally verified proof; OpenAI validates the
token. Codex API-key and external-token modes are unsupported. `ImportClaude`
accepts JSON `{ "token": "..." }` containing a Claude Code `setup-token` OAuth
token (at most 16 KiB); it rejects API keys and whitespace. The token is opaque:
the controller does not invent an account ID or expiration date, and public
metadata exposes an empty account ID and zero expiry. No Claude refresh request
is made. A provider 401 marks the connection `reauth_required`; the user must
disconnect and import a replacement token. An internal SHA-256 token identifier
deduplicates identical Claude tokens without claiming that distinct tokens
belong to distinct accounts. It is never included in public metadata. Public
connection views contain no tokens. Access and refresh tokens are stored
together using AES-256-GCM, a random nonce per write, and version/name/account
associated data. Account identifiers and expiry/status metadata are not
encrypted.

Each provider can have one connection, enforced by a unique database index. All
machines can use every connected provider; the request route selects the
connection, with no per-machine binding or attach/detach operation. Provider
metadata is encrypted with the credential and checked against the database row
before use, preventing provider substitution. A database without a `provider`
column is rebuilt empty at startup, so each provider is reconnected once; the
obsolete `auth_bindings` table is removed. Codex ciphertext written before the
provider field existed still decrypts and is verified against its row. Codex refreshes serialize per
connection and persist a `refreshing` marker before contacting OpenAI. A
successful rotation is persisted before releasing waiting requests. Any
ambiguous or failed refresh, including a process stopping after the marker,
requires a fresh import. No refresh or inference request is automatically
retried. Reauthentication requires disconnecting and importing a fresh cache.

The imported source Codex login may still hold the same refresh token. This
broker cannot coordinate rotation with that separate process. Concurrent use of
the source login can therefore require reauthentication; imports do not transfer
or revoke the original login. `Disconnect` removes local broker authority and
cancels active requests, without logging the user's original Codex client out.

`Proxy` accepts POST `/responses` and `/v1/responses` without query strings for
Codex, forwarding to `https://chatgpt.com/backend-api/codex/responses`. Claude
connections accept POST `/v1/messages` and `/v1/messages/count_tokens`, with
either no query or exactly `beta=true`, forwarding to the same fixed paths on
`https://api.anthropic.com`. Routes with no connected provider are rejected
before refresh or upstream access. Claude OAuth capability/version and native
client headers are allowlisted; guest API keys, cookies, and routing headers are
discarded. The proxy admits at most eight concurrent requests before reading
their bodies, rejects excess requests with HTTP 429, and limits request JSON to
16 MiB. The caller validates machine authorization before invoking the proxy and
owns the request context for machine shutdown cancellation. It creates upstream
headers from a small allowlist and injects the stored Authorization and account
headers. Redirects and environment HTTP proxies are disabled. Successful
responses stream with cancellation and flushing; upstream HTTP error bodies and
unsafe headers are discarded. Disconnect cancels active streams and refreshes
for that connection while leaving other providers available. A request already
accepted by a provider cannot be recalled by local cancellation.

The refresh wire format and public OAuth client ID come from the local official
`openai/codex` checkout at commit `389dd5645944891b65e4ca584125bbb0c852d352`,
`codex-rs/login/src/auth/manager.rs` (`RefreshRequest`, `CLIENT_ID`). The
refresh endpoint is fixed to `https://auth.openai.com/oauth/token`. Tests can
override private transport/destination fields from inside the package; runtime
settings cannot redirect stored credentials.

Tests use only synthetic credentials and local HTTP servers. No live refresh or
model request is part of this package's validation. WebSocket, model listing,
compact, image, and other provider endpoints are deliberately unsupported.

## GitHub

`ImportGitHub` accepts JSON `{ "token": "..." }` with an opaque ASCII token
(20 bytes to 16 KiB), encrypted in the same store. Public account and expiry
metadata remain empty; GitHub credentials do not refresh. A 401 requires a new
import; 403 and 429 retain the connection. Internal token deduplication uses a
provider-prefixed SHA-256 identifier.

Requests addressed to `api.github.com` use the fixed GitHub REST/GraphQL API
upstream. `/github/git/<owner>/<repo>/...` admits only Git smart-HTTP discovery,
upload-pack and receive-pack against `github.com`; missing `.git` is normalized.
Encoded separators, invalid paths/queries, redirects and arbitrary destinations
are rejected. API requests receive Bearer auth; Git receives Basic auth with
`x-access-token`. Guest credentials and cookies are replaced or discarded.
Git uploads stream with a 256 MiB cap and ten-minute read deadline; API uploads
retain the 16 MiB cap. Both share the eight-request concurrency limit.

GitHub errors preserve bounded, credential-redacted diagnostic bodies and selected
rate-limit headers; pagination links and ETags are retained. Redirect downloads,
LFS, Enterprise hosts and extra-host asset flows are outside the initial scope.
The controller serves the same broker over TCP and a remote Unix SSH listener;
shared per-machine channel limits and lifecycle shutdown apply to both.
