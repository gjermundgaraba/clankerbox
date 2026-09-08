# Controller credential broker

`New(db, key)` requires an explicit 32-byte key and exclusive ownership of the
controller database for the lifetime of the process. The controller owns private
key-file creation, database file permissions, process locking, and machine
authorization. The package never reads the user's home directory or auth cache.

`Import` accepts an unexpired ChatGPT Codex auth cache, including its refresh
token, account ID, and an access JWT with matching account and expiry claims.
Those claims are metadata, not locally verified proof; OpenAI validates the
token. API-key and external-token modes are unsupported. Public connection and
binding views contain no tokens. Access and refresh tokens are stored together
using AES-256-GCM, a random nonce per write, and version/name/account associated
data. Account identifiers and expiry/status metadata are not encrypted.

Each account can have one connection. Refreshes serialize per connection and
persist a `refreshing` marker before contacting OpenAI. A successful rotation is
persisted before releasing waiting requests. Any ambiguous or failed refresh,
including a process stopping after the marker, requires a fresh import. No
refresh or inference request is automatically retried. Reauthentication requires
disconnecting, importing a fresh cache, and reattaching machines.

The imported source Codex login may still hold the same refresh token. This
broker cannot coordinate rotation with that separate process. Concurrent use of
the source login can therefore require reauthentication; imports do not transfer
or revoke the original login. `Disconnect` removes local broker authority and
cancels active requests, without logging the user's original Codex client out.

`Proxy` accepts only POST `/responses` and `/v1/responses` without query strings,
admits at most eight concurrent requests before reading their bodies, rejects
excess requests with HTTP 429, limits request JSON to 16 MiB, and always sends it to
`https://chatgpt.com/backend-api/codex/responses`. It takes the machine ID from
the caller's host-owned routing context. It creates upstream headers from a
small allowlist and injects the stored Authorization and account headers.
Redirects and environment HTTP proxies are disabled. Successful responses stream
with cancellation and flushing; upstream HTTP error bodies and unsafe headers
are discarded. Detach and disconnect cancel active streams and refreshes. A
request already accepted by OpenAI cannot be recalled by local cancellation.

The refresh wire format and public OAuth client ID come from the local official
`openai/codex` checkout at commit
`389dd5645944891b65e4ca584125bbb0c852d352`,
`codex-rs/login/src/auth/manager.rs` (`RefreshRequest`, `CLIENT_ID`). The refresh
endpoint is fixed to `https://auth.openai.com/oauth/token`. Tests can override
private transport/destination fields from inside the package; runtime settings
cannot redirect stored credentials.

Tests use only synthetic credentials and local HTTP servers. No live refresh or
model request is part of this package's validation. WebSocket, model listing,
compact, image, and other provider endpoints are deliberately unsupported.
