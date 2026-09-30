# Spike S5: clankerauth offline API keys

Result: **PASS.** All 10 checks pass. `node --test test.ts` finishes in about 6 s.
`tsc` 7.0.2 reports no errors with `strict` and `skipLibCheck: false`.

Versions:
- effect / @effect/platform-node 4.0.0-rc.118
- @gjermundgaraba/effect-actions 0.8.0
- @gjermundgaraba/clankerauth-sdk 0.11.0
- @gjermundgaraba/clankerauth-dev 0.11.0
- Node 26.8.2

Setup: each "service" is an Effect `HttpRouter` app on `NodeHttpServer`. It serves:
- one effect-actions group (`list` is `access: "read"`, `mutate` is `access: "write"`) through `ActionHttp`, behind `Resource.middleware` and the `authorize` hook;
- a `GET /attach` WebSocket route, admitted with `Resource.admit(…, "write")` and raced against `Resource.watch`.

A controller and a host run as two services on two loopback ports, each its own resource.

Time is controlled with a custom `Clock` provided to the server layer. The SDK reads all of its time through `Clock`. Sleeps of 30 s or more take 100 ms of real time, which covers watch's minute-long re-check.

## Criteria

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| 1 | One key minted with grants on both resources is accepted by both, for reads and writes | PASS | `one key: { subject: 'owner', actor: 'key:key-1', scopes: [ 'host:read', 'host:write' ] }`. The principal carries only this resource's scopes. |
| 2 | A key granted on one resource is refused by the other, both ways | PASS | `host refuses controller key: 401 { _tag: 'Unauthorized', message: 'Authentication required' }` |
| 3a | Wrong scope gives InsufficientScope | PASS | `write with read key: 403 { _tag: 'InsufficientScope', scope: 'controller:write' }` |
| 3b | Expired key is refused offline | PASS | The key expires 10 s out, the clock moves 20 s, and the next call is 401 with no new key-list read (the list counter is unchanged). A key minted already expired is 401. |
| 3c | Revoked key is refused after the list refresh | PASS | Immediately after `revoke`, the held list still grants the key (200). After 61 s, 401 Unauthorized. |
| 3d | (extra) A key minted after the last list read | PASS, but see finding 1 | 401 until the next read, then 200 |
| 4 | WebSocket: `admit` before upgrade, refused before upgrade with a bad key, `watch` ends the socket on revocation | PASS | `bad key upgrade: 401 Bearer resource_metadata="…/.well-known/oauth-protected-resource", error="invalid_token", scope="controller:read"`. `read-only key upgrade: 403 {"_tag":"InsufficientScope","scope":"controller:write"}`. `watch closed the socket 103 ms after revocation: { code: 4401, reason: 'Unauthorized' }`, with the clock moved past the refresh. |
| 5a | Issuer unreachable after the first read: keys still accepted | PASS | With the issuer failing and the clock moved 61 s, the call returns 200 and the SDK logs `WARN … key list reads are failing; a held list decides until it expires`. Past 24 h: `503 { _tag: 'ProviderUnavailable', operation: 'key-list.fetch' }` |
| 5b | Issuer down before any read gives ProviderUnavailable | PASS | 503 ProviderUnavailable |
| 6 | (extra) A real `clankerauth-dev` issuer, with two resources, mints one key both services verify | PASS | `dev issuer started in 108 ms …; key accepted by both services` |

A WebSocket route on the same Effect HTTP server needs nothing extra in rc.118:
- `NodeHttpServer` handles `upgrade` events.
- The handler checks `admit` first and returns an ordinary response to refuse. It upgrades only when it calls `request.upgrade`, which gives an Effect `Socket`.
- It sends a close code with `writer.write(new Socket.CloseEvent(4401, tag))`.

## Findings and plan impacts

1. **A newly created key isn't accepted for up to about a minute.** A key the held list doesn't contain is `Unauthorized`, with no extra issuer read, until the next scheduled read.
   - Revocation takes up to about 1 minute for requests, and up to about 2 minutes for a watched socket (the list read plus watch's own re-check).
   - The live tests and dev mode must mint keys before the services first read their list, or retry for about 60 s.
   - The plan's auth row should state both delays.
2. **Rate limiting now belongs to clankerbox.** The issuer no longer counts key use. The SDK README also warns that a key granted on several resources can be replayed by any of them to the others. The controller's key reaches every host, which is what we want, but a less-trusted resource should get its own key.
3. **`CurrentPrincipal.expiresAt`** is set for expiring keys, so the attach relay could close at expiry without `watch`. `watch` already covers expiry, revocation and scope loss, so use `watch`.
4. **Dev mode can embed `startDisposableIssuer` in-process.**
   - The API: `startDisposableIssuer({ resources, client, dataDir?, port? })` gives `{ issuer, apiKey({ permissions }), ownerToken, close }`. The bundle is 1.9 MB with no dependencies; startup takes about 110–150 ms.
   - `client` is required even though clankerbox needs no OAuth client; pass a placeholder.
   - With `dataDir` and a fixed `port`, keys survive a restart. That matches `clankerbox dev`'s persistent state and its stable controller URL.
   - Dev can register the controller and the local host as resources and mint one key for the CLI, and one for the controller's calls to the host, straight into `client.json`.
5. **Tests use `startFakeIssuer`** from `@gjermundgaraba/clankerauth-sdk/testing`, together with a `Clock` override. Everything, including the 24 h window, is testable in seconds.
6. **Declared errors.** `ActionHttp.make({ errors: authenticationErrors })` is enough for the router path. `admit`'s `Refusal` (status, headers, body) returns unchanged from a route handler.
7. **Nothing blocking.** No plan decision changes.

## Resources

- **Runtime resources remaining:** none. All servers, issuers and sockets were closed by the test's `after` hook, and no test processes are left.
- **Disk:** 108 MB, all `node_modules`, which is gitignored. Delete `spikes/s5-clankerauth/node_modules` when the spike is retired. The `clankerauth-*` directories in `$TMPDIR` predate this spike: none is newer than it, so they weren't created here and were left alone.
