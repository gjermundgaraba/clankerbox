---
name: bump-sandbox-agent
description: Move the Sandbox Agent provider package and its recipes to a new release of Rivet's Sandbox Agent, re-checking every claim about its SDK and server they rely on.
disable-model-invocation: true
---

# Bump Sandbox Agent

`packages/rivet-sandbox-agent` is a provider for Rivet's Sandbox Agent SDK
(npm `sandbox-agent`) whose sandboxes are clankerbox machines, and its recipes
install the Sandbox Agent's server in a guest. Both are pinned to one release.
A bump re-checks the claims below against the SDK's and the server's source at
the target release, not just the tests: the provider and the recipes embody
each one. Fix what broke, report optional opportunities separately, and don't
publish, change production hosts, or commit unless asked.

## Source and scope

- **Pinned in this repo:** `sandbox-agent` in `pnpm-workspace.yaml`'s catalog,
  exact, and the package's peer range (`~<major.minor.patch>`) in
  `packages/rivet-sandbox-agent/package.json`; `agent_version` and
  `agent_sha256` in `recipes/ubuntu/setup.sh` and `recipes/macos/setup.sh`,
  with `node_version` and `node_sha256` beside them. The SDK and the server
  move together: one version in all of them. `git grep -nF` the old version
  finds each.
- **Target:** the latest stable `sandbox-agent` on npm (`npm view
  sandbox-agent version`), unless the user names one. Record old and new
  versions; if already current, say so.
- **Source:** the canonical repository is `rivet-dev/agents`, subdirectory
  `sandbox-agent/`; `rivet-dev/sandbox-agent` redirects there. Keep a
  read-only cache at `~/.cache/checkouts/github.com/rivet-dev/agents`, and
  read at the release's tag. The published SDK is also at hand, built, in
  `packages/rivet-sandbox-agent/node_modules/sandbox-agent/dist`.
- **Notation:** a citation is a path in that repository's `sandbox-agent/`
  directory at the tested release, 0.5.6, or `dist:` in the published
  package's `dist/`; the identifier beside it finds the code.

## Claims to re-check

**The provider interface** (`src/provider.ts`, `src/sandboxes.ts`)

- `SandboxProvider` (dist:types-*.d.ts) is `name`, `create()`, `destroy(id)`
  and the optional `reconnect`, `pause`, `kill`, `getUrl`, `getFetch`,
  `getInspectorUrl`, `ensureServer` and `defaultCwd`. Ours implements
  `create`, `destroy`, `pause`, `reconnect`, `ensureServer`, `getUrl`,
  `getFetch` and `defaultCwd`, and adds `dispose`, which the SDK never calls: no `kill` (the
  SDK falls back to `destroy`), no token (the
  server runs with `--no-token`; the SDK also reads an undeclared `getToken`,
  `maybeGetToken`). A member the target adds or makes required needs a
  decision here.
- `SandboxAgent.start` (dist:chunk-*.js, `static async start`) makes the
  sandbox's ID `${provider.name}/${rawId}`, and refuses an ID of another
  provider's name. For a new sandbox it calls `create`; for an existing ID,
  `reconnect` then `ensureServer`. Then it calls `getUrl` once and keeps the
  URL. Ours: `reconnect` only starts the machine and `ensureServer` opens the
  tunnel; the provider listens on a sandbox's local port itself until it is
  destroyed, relaying to whichever tunnel is open, so the URL a client kept
  still leads to it after a tunnel is opened again, and to nothing else while
  none is.
- The SDK's health wait polls `/v1/health` from 500 ms, doubling to 15 s, with
  no deadline unless the caller gives one, and calls `ensureServer` after
  every 3 failures in a row, swallowing its error
  (`HEALTH_WAIT_ENSURE_SERVER_AFTER_FAILURES`). Ours: `ensureServer` opens a
  tunnel that ended, and starts the machine when its agent doesn't answer,
  then opens its tunnel anew, to the endpoint it has now; a
  machine that is gone leaves the SDK waiting, so the caller's timeout or
  signal bounds it. The health wait runs once, from the client's constructor,
  and `start` is the SDK's only other call to `ensureServer`: a tunnel that
  ends later is the caller's to bring back (README).
- `start` resolves `getFetch(rawId)` and uses `options.fetch ?? ` its answer
  for every request the client makes, the ACP connection's included
  (`resolveProviderFetch`). A `session/prompt` POST has no reply headers until
  the turn ends, and Node's fetch gives up on headers after 300 s (undici's
  `headersTimeout`), which the next claim turns into an ended process. Ours:
  `agentFetch` in `fetch.ts`, over `node:http`, which bounds no wait for a
  reply, a new one at each `getFetch`, all over one `http.Agent` of the
  provider's own, so a cap on Node's global agent's sockets or a proxy it
  takes from `NODE_USE_ENV_PROXY` never reaches the tunnel, and an SDK
  started again on a sandbox takes up the connections the last one left.
- The ACP connection posts each message to `/v1/acp/<server>` (`API_PREFIX`,
  dist:chunk-*.js, `new AcpHttpClient`) without awaiting it:
  `acp-http-client`'s `StreamableHttpAcpTransport.postMessage` takes a 2xx
  as accepted, pushing in the JSON-RPC message a 200 carries, and logs any
  other outcome as `ACP write
  error` and errors the transport's stream unless the transport is closed.
  `@agentclientprotocol/sdk` 0.16's `Connection` never catches `#receive()`,
  so that error is an unhandled rejection that ends Node; 0.18.1 catches it.
  The transport's `close` (`closeImpl`) sets `closed` before it sends a
  DELETE to the same path, and `pushInbound` drops what arrives once
  `closed` is set; ACP 0.16's `Connection` never rejects its pending
  requests when its stream closes. So a request still waiting when
  `dispose()` closes its connection never settles. `close` passes no signal
  to a POST, so a POST still waiting outlives it. `destroySandbox`,
  `pauseSandbox` and `killSandbox` call the provider before `dispose()`.
  Ours: `fetch.ts` answers a request (a message with `id` and `method`)
  posted on `/v1/acp/` that is cut or refused as a 200 carrying that request's
  JSON-RPC error, which `postMessage` pushes in and `#handleResponse` rejects
  the caller's promise with, and any other message as 202 with no body,
  logging its loss as `postMessage` does, `ACP write error`. A refused POST's
  `AcpHttpError` never reached a caller, since `writeMessage` doesn't await
  `postMessage`. The DELETE aborts the POSTs still waiting on its path, so
  their sockets don't keep the process alive. `responseEnvelopeId` drops
  whichever of that error and the event stream's answer comes second.
  `tests/fetch.test.ts` holds each case; `tests/session.test.ts` ends a
  sandbox both ways under a reply the stand-in agent holds, cuts a prompt,
  rejects a held prompt under `destroySandbox`, `pauseSandbox` and the
  provider's `dispose`, and has a held prompt never settle under the SDK's
  `dispose()` while the process ends at once. When ACP 0.18.1 or later is
  under the SDK and the transport fails its pending requests rather than its
  stream, the fetch can stop answering failures.
- `SandboxDestroyedError(sandboxId, provider, { cause })` is a runtime export,
  and what `start` expects of a `reconnect` to a sandbox that no longer
  exists. Ours: `reconnect` maps the host's `NotFound` to it.
- A healthy server answers `GET /v1/health` with `{"status":"ok"}`. Ours:
  `healthy` in `sandboxes.ts`, and both recipes' start hooks.

**The server** (the recipes)

- `sandbox-agent server --no-token --no-telemetry` listens on
  `127.0.0.1:2468` by default. Telemetry is on unless the flag is given;
  `daemon start` has no such flag, which is why the recipes run `server`. A
  second server on the port exits 1 and leaves the first running.
- The binaries are at
  `https://releases.rivet.dev/sandbox-agent/<version>/binaries/sandbox-agent-<target>`,
  with the recipes' targets `x86_64-unknown-linux-musl` and
  `aarch64-apple-darwin`. Rivet publishes no checksum file, so each recipe's
  `agent_sha256` is the sha256 of that release download. npm's
  `@sandbox-agent/cli-linux-x64` and `@sandbox-agent/cli-darwin-arm64` of the
  same version carry byte-identical binaries, and the registry pins each
  tarball by its `dist.integrity`, so compare both downloads against them.
- `install-agent claude` installs Claude Code at its latest release and its
  ACP adapter from npm, which needs Node 22 or newer and npm on the path:
  Ubuntu 24.04's Node 18 fails the adapter's check. The recipes install a
  pinned Node 22 from nodejs.org (`node_sha256` is that file's line in
  `https://nodejs.org/dist/v<version>/SHASUMS256.txt`; move it to the latest
  22.x, or to the major the adapters then need).
- `install-agent codex` never returns: its check starts `codex app-server`,
  which doesn't exit. The recipes install Claude alone; whoever adds Codex
  bounds its install with a timeout and ends what it leaves running. If the
  target fixes this, drop this claim.
- As root, Claude Code offers no `bypassPermissions` mode, so the server runs
  as the login user, `admin`. The server keeps its state under
  the user's `~/.local/share/sandbox-agent` (Linux) or
  `~/Library/Application Support/sandbox-agent` (macOS).
- The server finds an agent's credential in its own environment
  (`ANTHROPIC_API_KEY` or `CLAUDE_API_KEY`, then the OAuth tokens
  `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN`; `OPENAI_API_KEY` or
  `CODEX_API_KEY`) or in the user's `~/.claude.json` and
  `~/.claude/.credentials.json` (`extract_all_credentials`,
  server/packages/agent-credentials/src/lib.rs, whose
  `include_oauth` is on by default). Ours: the recipes' `agent.env`, which
  `setup.sh` installs as `/etc/sandbox-agent.env`, and which `serve.sh`,
  installed as `/usr/local/bin/sandbox-agent-serve`, sources into the
  server's environment at every launch. `/etc/clankerbox/` holds only the
  hooks the host runs by name.
- A request's POST waits for the agent's answer for
  `SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS`, 2 min unless set
  (`DEFAULT_REQUEST_TIMEOUT_MS`,
  server/packages/sandbox-agent/src/acp_proxy_runtime.rs). Past it, `post`
  (server/packages/acp-http-adapter/src/process.rs) asks
  `try_process_exit_info`, which waits on the `child` lock that
  `spawn_exit_watcher` holds until the agent exits, so the POST stays open with
  no answer while the agent runs; the turn's answer still comes on the SSE
  stream. Ours: each recipe's `serve.sh`, which starts the server, sources
  the `agent.env` its launcher names and sets the bound to a day only if
  that left it unset. `tests/recipes.test.ts` takes what each recipe's
  launcher runs, the Ubuntu start hook's command and the macOS launch
  daemon's `ProgramArguments`, checks it is the `serve.sh` and the
  `agent.env` where `setup.sh` installs them, and runs it as installed under
  a scratch root, over a stand-in server, with and without an `agent.env`.
- `@sandbox-agent/cli`, the SDK's optional dependency, carries a server binary
  for the machine the SDK runs on. Ours: `ignoredOptionalDependencies` in
  `pnpm-workspace.yaml` keeps it out of this workspace.

## Verify

- `pnpm install` after the catalog change, then `vp run --no-cache ready`. The
  package's tests run the real SDK against the provider, over a stub host, a
  test control plane over hosts on smol cloud's and boat's fakes, and a
  stand-in ssh that serves a stand-in agent.
- Each recipe's downloads against their pins: run `recipes/ubuntu/setup.sh` in
  a throwaway `linux/amd64` `ubuntu:24.04` container. It needs no keys: the
  host installs the operator's after a setup.

## After

- Move the catalog pin, the peer range and both recipes' pins together, and
  the release in Notation above; edit a citation only where its identifier
  moved, and add claims the release introduced.
- Report the version transition, the checksums and how they were verified,
  the claims that changed and their fixes, the checks actually run, and
  remaining runtime resources and retained disk separately.
