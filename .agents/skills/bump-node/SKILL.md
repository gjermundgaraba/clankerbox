---
name: bump-node
description: Move clankerbox's pinned Node, the base of its single-executable binaries, to a new release, re-checking the Node claims the build and the binary rely on.
disable-model-invocation: true
---

# Bump Node

Each clankerbox binary is a Node single-executable application (SEA) built on an
official Node archive pinned by checksum, and the release follows Node's latest
patch at each release. A bump re-checks the claims below against Node's docs
and source at the target, not just the tests: the build scripts and the binary
embody each one. Fix what broke, report optional opportunities separately, and
don't tag, release, publish or commit unless asked. A candidate whose bundles
haven't passed the smoke test on both targets is an **unqualified candidate**.

Effect, `@effect/platform-node` and effect-actions have claims of their own (for
example `NodeHttpClient.layerUndici` forcing a 1 h header timeout, and an
aborted request interrupting its handler); they belong to a bump of those
packages, not this one.

## Source and scope

- **Pinned in this repo:** `.node-version`, the one Node pin, which the
  workflows' `setup-node` (`node-version-file`) and the release build read;
  `tools/release/release-inputs.json`, each target's archive sha256 under
  `nodeArchiveSha256.<version>` (`node-v<version>-darwin-arm64.tar.xz` and
  `node-v<version>-linux-x64.tar.xz`); README ("Node 26.10.0 inside").
  `git grep -n '26\.10'` finds them. `@types/node` in
  `pnpm-workspace.yaml`'s catalog has its own version (26.6.4). The major alone
  is in `engines` in the root `package.json` (`"node": ">=26"`, a floor) and
  README's "Node 26 and pnpm 12": a patch or minor bump leaves both, and that
  grep doesn't find them.
- **Target:** the latest release of the current major on
  `https://nodejs.org/dist/` (its `index.json`), unless the user names one. A
  new major is a larger change: also `engines`, the `@types/node` major and
  every claim below.
- **Checksums:** take each archive's sha256 from that release's
  `SHASUMS256.txt`, verify the file's signature (`SHASUMS256.txt.asc`) against
  Node's release keys, and confirm by hashing the downloaded archives.
- **Notation:** `N@v<version>:path` is Node's source at that tag
  (`github.com/nodejs/node`); the identifier beside it finds the code.
  The SEA claims are in `doc/api/single-executable-applications.md`.

## Claims to re-check

Each: what Node does, where, and what of ours depends on it.

**Building the SEA** (`tools/release/build.sh`)

- `node --build-sea <config>` builds a SEA for another target, given that
  target's official `node` as `executable`, from a builder Node of the same
  version, with no postject: both targets build on macOS. Ours: the builder is
  the pinned Node for the build machine's platform, from the same archives.
- The config: `main` (one ESM bundle, `mainFormat: "module"`), `executable`,
  `output`, `disableExperimentalSEAWarning`, `useSnapshot: false` and
  `useCodeCache: false` (both work only for same-platform builds), and
  `execArgvExtension: "none"`, which makes the binary ignore `NODE_OPTIONS`.
  Ours: the config `build.sh` writes; `smoke.sh` checks that
  `NODE_OPTIONS` is ignored. Check whether any field was renamed, became the
  default or was removed.
- darwin-arm64 needs re-signing after `--build-sea`: an ad-hoc signature with the
  hardened runtime and the `com.apple.security.cs.allow-jit` entitlement
  (`tools/release/entitlements.plist`). curl and scp downloads get no
  quarantine attribute, so no notarization. Ours: `codesign --force --sign -
  --options runtime --entitlements …` in `build.sh`.
- The official linux-x64 `node` is non-PIE; `--build-sea` adds two read-only
  segments, and the result ran on a glibc 2.43 host. Check the official build's
  glibc floor against the hosts' (Ubuntu 24.04 on CI).
- The archive holds `bin/node` and `LICENSE` under `node-v<version>-<target>/`
  (`LICENSE` 156,386 bytes at 26.10.0). Ours: `build.sh` extracts both, and
  ships `LICENSE` as `notices/node/LICENSE`. A big change in the
  LICENSE (a newly bundled dependency) is worth a look.

**Inside the binary**

- In a SEA, every role, `node:sqlite`, `node:http`, `fetch` and `child_process`
  work, and `process.execPath` is the binary (including through a symlink). Ours:
  the CLI and the `host` role in one binary; units run it as
  `<binary> host --config PATH`.
- `node:sqlite` (`DatabaseSync`) works with no experimental warning (SQLite
  3.53.4 at 26.10.0), and its errors carry SQLite's extended result codes in
  `errcode` (`SQLITE_BUSY` 5, `SQLITE_CONSTRAINT_PRIMARYKEY` 1555). Ours:
  `packages/host/src/store.ts` (the owner lock through `locking_mode =
  EXCLUSIVE`, the claim's primary-key conflict). Check the module's stability
  and the bundled SQLite's version.
- `process.platform`-`process.arch` names the targets `darwin-arm64` and
  `linux-x64`. Ours: smolvm's checkpoint `pin` and the release's target names.

**HTTP timeouts** (a mutation replies when its action ends, which can take
minutes)

- `fetch` runs on Node's bundled undici (8.10.2 at 26.10.0,
  `process.versions.undici`), whose `headersTimeout` and `bodyTimeout` are both
  300 000 ms (`kBodyTimeout`, `kHeadersTimeout`,
  N@v26.10.0:deps/undici/src/lib/dispatcher/client.js); a 330 s call failed at
  300.9 s with `UND_ERR_HEADERS_TIMEOUT`, and Node has no public API to change
  them. Ours: the SDK's `Client.layer` uses `node:http`, which sets no client
  timeout; README's SDK section says a `fetch` client gives up after 300 s.
- The `node:http` server's defaults: `requestTimeout` 300 000 ms, covering only
  receiving the request, `headersTimeout` 60 000, `keepAliveTimeout` 5 000 and
  `timeout` 0 (`storeHTTPOptions` and `Server`, N@v26.10.0:lib/_http_server.js);
  330 s handlers replied under them. Ours: `packages/host/src/server.ts` creates
  the server with Node's defaults. A default that starts bounding a response
  would cut long mutations off.

**Sizes and startup** (sanity checks, not contracts)

- At 26.10.0: about 148 MB (darwin-arm64) and 154 MB (linux-x64), 44 and 48 MB
  as bundles; `--version` in about 40 ms. A large jump is worth explaining.

## Verify

- `pnpm install` after the catalog change, then `vp run --no-cache ready`.
- Build, bundle and smoke both targets: `pnpm build`,
  `pnpm sea:build --out "$WORK_RUN_SCRATCH/bundles"` (both on macOS), then
  `pnpm sea:smoke <bundle>` for each, the linux-x64 one on a Linux/amd64
  machine. CI's `sea` job does the same on `macos-15` (arm64) and
  `ubuntu-24.04`. Builds run as work runs (`scripts/WORK_RUNS.md`); keep the
  bundles you need outside scratch.
- Live: at least `pnpm live:smolvm` (its suite has the create whose setup runs
  past 300 s, and a client that goes away mid-call), since every live suite runs
  the new binary as host and CLI; Tart's and boat's suites if the bump touched
  anything platform-specific (`tests/live/README.md`).

## After

- Update `.node-version` and `release-inputs.json` (the new version's two
  checksums; drop the old version's) together, `@types/node` (the newest of the
  major, which waits a day under the workspace's `minimumReleaseAge`) and
  README's "Node 26.10.0 inside". For a new major, also raise `engines`'
  floor to it (`>=27`) and README's "Node 26".
- Move each `N@v<old>` citation, here and in comments, to the new tag, and add
  claims the release introduced.
- Hosts pick the new Node up only with a new clankerbox release; running VMs
  never reference the binary.
- Report the version transition, the checksums and how they were verified, the
  claims that changed and their fixes, the checks actually run, and remaining
  runtime resources and retained disk separately.
