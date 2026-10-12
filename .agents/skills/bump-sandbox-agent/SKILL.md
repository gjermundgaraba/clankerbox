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
publish, change production hosts, or commit unless asked. A candidate without
the live run below is an **unqualified candidate**.

## Source and scope

- **Pinned in this repo:** `sandbox-agent` in `pnpm-workspace.yaml`'s catalog,
  exact, and the package's peer range (`~<major.minor.patch>`) in
  `packages/rivet-sandbox-agent/package.json`; `agent_version` and
  `agent_sha256` in `recipes/ubuntu/setup.sh` and `recipes/macos/setup.sh`,
  with `node_version` and `node_sha256` beside them. The SDK and the server
  move together: one version in all of them. `git grep -n '0\.5\.2'`.
- **Target:** the latest stable `sandbox-agent` on npm (`npm view
  sandbox-agent version`), unless the user names one. Record old and new
  versions; if already current, say so.
- **Source:** the canonical repository is `rivet-dev/agents`, subdirectory
  `sandbox-agent/`; `rivet-dev/sandbox-agent` redirects there. Keep a
  read-only cache at `~/.cache/checkouts/github.com/rivet-dev/agents`, and
  read at the release's tag. The published SDK is also at hand, built, in
  `packages/rivet-sandbox-agent/node_modules/sandbox-agent/dist`.
- **Notation:** `A@<version>:path` is that repository's `sandbox-agent/`
  directory at the release, and `dist:` the published package's `dist/`. The
  identifier beside a citation finds the code. Every citation is at 0.5.2.

## Claims to re-check

**The provider interface** (`src/provider.ts`, `src/sandboxes.ts`)

- `SandboxProvider` (dist:types-*.d.ts) is `name`, `create()`, `destroy(id)`
  and the optional `reconnect`, `pause`, `kill`, `getUrl`, `getFetch`,
  `getInspectorUrl`, `ensureServer` and `defaultCwd`. Ours implements
  `create`, `destroy`, `pause`, `reconnect`, `ensureServer`, `getUrl` and
  `defaultCwd`: no `kill` (the SDK falls back to `destroy`), no token (the
  server runs with `--no-token`; the SDK also reads an undeclared `getToken`,
  `maybeGetToken`). A member the target adds or makes required needs a
  decision here.
- `SandboxAgent.start` (dist:chunk-*.js, `static async start`) makes the
  sandbox's ID `${provider.name}/${rawId}`, and refuses an ID of another
  provider's name. For a new sandbox it calls `create`; for an existing ID,
  `reconnect` then `ensureServer`. Then it calls `getUrl` once and keeps the
  URL. Ours: a tunnel keeps its local port for as long as the provider lives,
  so the URL the SDK kept still leads to the sandbox after a tunnel is opened
  again.
- The SDK's health wait polls `/v1/health` from 500 ms, doubling to 15 s, with
  no deadline unless the caller gives one, and calls `ensureServer` after
  every 3 failures in a row, swallowing its error
  (`HEALTH_WAIT_ENSURE_SERVER_AFTER_FAILURES`). Ours: `ensureServer` opens a
  tunnel that ended, and starts the machine when its agent doesn't answer; a
  machine that is gone leaves the SDK waiting, so the caller's timeout or
  signal bounds it.
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
  with targets `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl` and
  `aarch64-apple-darwin`. Rivet publishes no checksum file, so the recipes pin
  a sha256 taken from the download itself. Cross-check the Linux one against
  the npm package of the same version, `@sandbox-agent/cli-linux-x64`, whose
  binary is identical. At 0.5.2: linux x64
  `5ebefccb130cccb0aa7972eacc8ff7c55550b959b2dd682a232a21a5712d955e`, linux
  arm64 `6c3362a9d2d59220757d6b8ca9a3032464b7ce589d9d43c2b728e44ad6a09382`,
  darwin arm64
  `58417cf5fa1e2dc417fc4a92d11840cc245ad599b87dd4c9a41686b05c36d877`.
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
  as `sandbox` (Ubuntu) or `admin` (macOS). The server keeps its state under
  the user's `~/.local/share/sandbox-agent` (Linux) or
  `~/Library/Application Support/sandbox-agent` (macOS).
- The server finds an agent's credential in its own environment
  (`ANTHROPIC_API_KEY` or `CLAUDE_API_KEY`, then the OAuth tokens
  `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN`; `OPENAI_API_KEY` or
  `CODEX_API_KEY`) or in the user's `~/.claude.json` and
  `~/.claude/.credentials.json` (`extract_all_credentials`,
  A@0.5.2:server/packages/agent-credentials/src/lib.rs, whose
  `include_oauth` is on by default). The live suite runs on a
  `CLAUDE_CODE_OAUTH_TOKEN`. Ours: the recipes' `agent.env`, sourced into
  the server's environment at every launch.
- `@sandbox-agent/cli`, the SDK's optional dependency, carries a server binary
  for the machine the SDK runs on. Ours: `ignoredOptionalDependencies` in
  `pnpm-workspace.yaml` keeps it out of this workspace.

**Sizes** (sanity checks, not contracts)

- At 0.5.2 on smolvm: a create whose setup is the Ubuntu recipe took about
  50 s (packages 14, binary 2, Node 6, Claude 26), Claude's install 553 MB of
  disk, the idle server 13 MB of RAM and a Claude session about 470 MB. On
  Tart the same took about 6 minutes, most of it the clone and first boot.

## Verify

- `pnpm install` after the catalog change, then `vp run --no-cache ready`. The
  package's tests run the real SDK against the provider, over a stub host and
  a stand-in ssh.
- Each recipe's downloads against their pins: run `recipes/ubuntu/setup.sh` in
  a throwaway `linux/amd64` `ubuntu:24.04` container, with an
  `authorized_keys` beside it.
- Live: `pnpm live:smolvm` and `pnpm live:tart`, each with `--agent-env-file`,
  so `tests/live/tests/sandbox-agent.test.ts` runs, with its real prompt to
  Claude (`tests/live/README.md`).

## After

- Move the catalog pin, the peer range and both recipes' pins together, and
  each citation here to the new version; add claims the release introduced.
- Report the version transition, the checksums and how they were verified,
  the claims that changed and their fixes, the checks actually run, and
  remaining runtime resources and retained disk separately.
