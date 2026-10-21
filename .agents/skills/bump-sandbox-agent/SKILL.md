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
  move together: one version in all of them. `git grep -n '0\.5\.3'`.
- **Target:** the latest stable `sandbox-agent` on npm (`npm view
  sandbox-agent version`), unless the user names one. Record old and new
  versions; if already current, say so.
- **Source:** the canonical repository is `rivet-dev/agents`, subdirectory
  `sandbox-agent/`; `rivet-dev/sandbox-agent` redirects there. Keep a
  read-only cache at `~/.cache/checkouts/github.com/rivet-dev/agents`, and
  read at the release's tag. The published SDK is also at hand, built, in
  `packages/rivet-sandbox-agent/node_modules/sandbox-agent/dist`.
- **Notation:** a citation is a path in that repository's `sandbox-agent/`
  directory at the tested release, 0.5.3, or `dist:` in the published
  package's `dist/`; the identifier beside it finds the code.

## Claims to re-check

**The provider interface** (`src/provider.ts`, `src/sandboxes.ts`)

- `SandboxProvider` (dist:types-*.d.ts) is `name`, `create()`, `destroy(id)`
  and the optional `reconnect`, `pause`, `kill`, `getUrl`, `getFetch`,
  `getInspectorUrl`, `ensureServer` and `defaultCwd`. Ours implements
  `create`, `destroy`, `pause`, `reconnect`, `ensureServer`, `getUrl` and
  `defaultCwd`, and adds `dispose`, which the SDK never calls: no `kill` (the
  SDK falls back to `destroy`), no token (the
  server runs with `--no-token`; the SDK also reads an undeclared `getToken`,
  `maybeGetToken`). A member the target adds or makes required needs a
  decision here.
- `SandboxAgent.start` (dist:chunk-*.js, `static async start`) makes the
  sandbox's ID `${provider.name}/${rawId}`, and refuses an ID of another
  provider's name. For a new sandbox it calls `create`; for an existing ID,
  `reconnect` then `ensureServer`. Then it calls `getUrl` once and keeps the
  URL. Ours: `reconnect` only starts the machine and `ensureServer` opens the
  tunnel; a sandbox keeps its local port until it is destroyed, so the URL a
  client kept still leads to it after a tunnel is opened again.
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
  `aarch64-apple-darwin`. Rivet publishes no checksum file, so the recipes pin
  a sha256 taken from the download itself (`agent_sha256` in each recipe).
  Cross-check the Linux one against the npm package of the same version,
  `@sandbox-agent/cli-linux-x64`, whose binary is identical.
- `install-agent claude` installs Claude Code at its latest release and its
  ACP adapter from npm, which needs Node 22 or newer and npm on the path:
  Ubuntu 24.04's Node 18 fails the adapter's check. The recipes install a
  pinned Node 22 from nodejs.org (`node_sha256` from that release's
  `SHASUMS256.txt`; move it to the latest 22.x, or to the major the adapters
  then need).
- `install-agent codex` never returns: its check starts `codex app-server`,
  which doesn't exit. The recipes install Claude alone and tell whoever adds
  Codex to bound it. If the target fixes this, drop that note.
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
  `include_oauth` is on by default). Ours: the recipes' `agent.env`, sourced into
  the server's environment at every launch.
- `@sandbox-agent/cli`, the SDK's optional dependency, carries a server binary
  for the machine the SDK runs on. Ours: `ignoredOptionalDependencies` in
  `pnpm-workspace.yaml` keeps it out of this workspace.

## Verify

- `pnpm install` after the catalog change, then `vp run --no-cache ready`. The
  package's tests run the real SDK against the provider, over a stub host and
  a stand-in ssh.
- Each recipe's downloads against their pins: run `recipes/ubuntu/setup.sh` in
  a throwaway `linux/amd64` `ubuntu:24.04` container. It needs no keys: the
  host installs the operator's after a setup, which the host's tests cover
  (`packages/host/tests/machines.test.ts`), not this run.

## After

- Move the catalog pin, the peer range and both recipes' pins together, and
  the release in Notation above; edit a citation only where its identifier
  moved, and add claims the release introduced.
- Report the version transition, the checksums and how they were verified,
  the claims that changed and their fixes, the checks actually run, and
  remaining runtime resources and retained disk separately.
