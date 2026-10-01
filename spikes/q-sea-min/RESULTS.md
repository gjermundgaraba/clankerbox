# Experiment q-sea-min: how small can the SEA pipeline be?

Date: 2026-10-01. Review item 8 ("Node SEA should not bring that much complexity").
Builder: this Apple Silicon Mac (macOS 27). Linux run: the test host (Ubuntu,
kernel 7.0.0-34, glibc 2.43, x86_64). Node **26.10.0** official binaries. Work run
`sea-min-be81390b6ab6`; the evidence is in `.work/runs/sea-min-be81390b6ab6/evidence/`
(`results.json`, `commands.log`).

Files:
- `build.sh` and `entitlements.plist` make up the whole pipeline under measurement.
- `main.cjs` is the multi-role test entry point.
- `effect-main.mjs` is a trivial Effect 4.0.0 program, bundled with esbuild 0.28.2.
- `run.py` and `bench.py` are only the spike harness (work run, inspection, timing,
  Linux host). They are not part of the pipeline.

## Verdicts

| Question | Verdict | Evidence |
| --- | --- | --- |
| Minimal pipeline size | **Small.** 7 steps, `build.sh` is 38 lines (31 excluding blanks and comments) plus a 3-line entitlements plist and one bundler command. It builds both targets from this Mac. | The script is below. Wall clock: 25.6 s for the first build, including about 64 MB of downloads, then about 6 s for both targets. |
| Pinned official Node, verified | PASS | Both `.tar.xz` files match the hashes pinned inline from `SHASUMS256.txt`, using `shasum -a 256 -c`. The `.sig` was not checked. |
| `node --build-sea` cross-build, 26.10 config | PASS | One config per target sets `main`, `mainFormat`, `executable` (that target's official node), `output`, `disableExperimentalSEAWarning`, `useSnapshot:false`, `useCodeCache:false` and `execArgvExtension:"none"`. The builder is the downloaded darwin 26.10.0 node, because the builder version must equal the target version. No postject. |
| darwin signing | PASS | `codesign --force --sign - --options runtime --entitlements entitlements.plist` (allow-jit only) gives flags `adhoc,runtime`, and every role runs. |
| linux-x64 SEA on the Linux host (26.9 layout change for non-PIE) | PASS | The official linux-x64 node is `ET_EXEC` (non-PIE). The SEA keeps the original 4 PT_LOADs, turns `.bss` into file-backed data (RW filesz 0x601a0 → 0xb2668), and appends two read-only PT_LOADs on their own pages. Every role runs on the host. |
| Roles via `argv[2]`, plus `--help` and `--version` | PASS on both | Node does not parse `argv[2]`. `--max-old-space-size=64` as `argv[2]` reaches the app, which prints usage and exits 2. |
| `process.execPath` re-exec of roles | PASS on both | `host` runs `execFileSync(process.execPath, ["cli"])`. The child reports `isSea:true` and the same execPath. This also works through `Clankerbox.app/Contents/MacOS/clankerbox` and through a symlink to it (execPath resolves to the real path). |
| `node:sqlite` in a SEA | PASS on both | In-memory DB, prepared insert and select, SQLite 3.53.4. Stderr is empty, so there is no ExperimentalWarning. |
| `node:http` and `fetch` in a SEA | PASS on both | Listens on `127.0.0.1:0`, fetches itself, closes. |
| `child_process` in a SEA | PASS on both | `/bin/sh -c` and the self re-exec both work. |
| A real bundle (Effect 4, about 650 KB) | PASS, and it doesn't change the pipeline | The CommonJS bundle and the ESM bundle (`"mainFormat":"module"`, no VFS) both build and run on both targets. The SEA grows by about 0.65 MB. Startup is the same as plain `node bundle.mjs`, so the bundle costs startup time whether or not it is packaged as a SEA. |
| `NODE_OPTIONS` injection | Closed by `execArgvExtension:"none"` | `NODE_OPTIONS=--require=/missing` breaks plain `node`, but the SEA ignores it, on both darwin and Linux. Use this in production. |
| Notarization | **Not needed** for curl/tar/scp installs | curl downloads carry only `com.apple.provenance`, not `com.apple.quarantine`. The archives, the extracted node and the SEA all lack the quarantine attribute, and Gatekeeper only assesses quarantined files. `spctl --assess` rejects the ad-hoc SEA, but no launch path checks that without quarantine. Today's Go releases are also ad-hoc signed and not notarized (`scripts/release/README.md:110`), so nothing regresses. Only browser-downloaded binaries would need Developer ID signing and notarization, as any binary would. |
| D9 `.app` wrapper | PASS, about 4 extra lines, only if needed | `Clankerbox.app/Contents/{Info.plist,MacOS/clankerbox}`, signed as a bundle: `Info.plist entries=6`, identifier `net.garaba.clankerbox`, `--verify --strict --deep` OK, and the inner executable runs every role. The Local Network grant itself was not tested (no TCC changes). |

**Bottom line:** the SEA itself adds 3 things to the pipeline: per-target
`--build-sea` with a generated 3-line config, one `codesign` line, and a 3-line
plist. Everything else, such as pinned downloads, bundling and smoke tests, is
also needed by any "ship Node" option. The real costs are binary size (about
150 MB, or 44–47 MB gzipped) and upload time, and those come from shipping Node
at all, not from SEA.

## The minimal pipeline (exact steps)

1. **Pin** the per-target archive hashes. Copy them from `SHASUMS256.txt` once, into
   `release-inputs.json` in the real repo; here they are inline.
2. **Download, verify and extract `bin/node`** per target (`curl`, `shasum -c`, `tar`),
   cached.
3. **Bundle** to one file. Here that's one command, for example
   `esbuild src/main.ts --bundle --platform=node --format=esm --outfile=dist/clankerbox.mjs`.
   ESM works as `mainFormat:"module"`.
4. **Write `sea.json`** per target. It is generated, and the only per-target field is
   `executable`.
5. **Run `node --build-sea sea.json`** per target with the darwin builder.
6. **Sign darwin:** one `codesign` line, plus the entitlements plist.
7. **Smoke test:** run the native binary here; run the linux-x64 binary on Linux
   (CI or the host).

Optional, for D9: put the darwin binary in an `.app` and sign the bundle. That is
`mkdir`, `cp`, an `Info.plist` file, and pointing `codesign` at the bundle.

`build.sh` (verbatim):

```sh
#!/bin/sh
# Minimal Node SEA pipeline: fetch + verify pinned Node, build-sea per target, sign darwin.
# usage: build.sh OUT_DIR MAIN_JS [commonjs|module]    (MAIN_JS is already bundled)
# Env: NODE_CACHE (default OUT_DIR/node) keeps verified archives between builds.
set -eu
NODE_VERSION=26.10.0
SHA_darwin_arm64=f222f7e85cc1d5a3d84786aa86836ec3d41c4dcdf59a40e4a9d719b6b0ae28af # node-v26.10.0-darwin-arm64.tar.xz
SHA_linux_x64=ca70e9e349de048b9522abb3adc05b3bd6f43c5ffd3ec57916c7da292f59f022    # node-v26.10.0-linux-x64.tar.xz
OUT=$1 MAIN=$2 FORMAT=${3:-commonjs}
CACHE=${NODE_CACHE:-$OUT/node}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$CACHE"

node_for() { # target -> path of that target's verified official node binary
  dir=node-v$NODE_VERSION-$1
  case $1 in darwin-arm64) sha=$SHA_darwin_arm64 ;; linux-x64) sha=$SHA_linux_x64 ;; esac
  if [ ! -x "$CACHE/$dir/bin/node" ]; then
    curl -fsSL -o "$CACHE/$dir.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/$dir.tar.xz" || exit 1
    echo "$sha  $CACHE/$dir.tar.xz" | shasum -a 256 -c - >&2 || exit 1
    tar -xJf "$CACHE/$dir.tar.xz" -C "$CACHE" "$dir/bin/node" || exit 1
  fi
  echo "$CACHE/$dir/bin/node"
}

BUILDER=$(node_for darwin-arm64) # builder must be the same Node version as the targets
for target in darwin-arm64 linux-x64; do
  mkdir -p "$OUT/$target"
  EXE=$(node_for $target)
  cat >"$OUT/$target/sea.json" <<EOF
{ "main": "$MAIN", "mainFormat": "$FORMAT", "executable": "$EXE",
  "output": "$OUT/$target/clankerbox", "disableExperimentalSEAWarning": true,
  "useSnapshot": false, "useCodeCache": false, "execArgvExtension": "none" }
EOF
  "$BUILDER" --build-sea "$OUT/$target/sea.json"
done

codesign --force --sign - --options runtime --entitlements "$HERE/entitlements.plist" "$OUT/darwin-arm64/clankerbox"
"$OUT/darwin-arm64/clankerbox" --version # smoke test the native target; linux-x64 is smoke-tested on Linux
```

`entitlements.plist` contains only `com.apple.security.cs.allow-jit`.

## Numbers

### Sizes (bytes)

| | darwin-arm64 | linux-x64 |
| --- | ---: | ---: |
| Official `node-v26.10.0-*.tar.xz` | 30,556,596 | 33,934,532 |
| Official `bin/node` | 146,898,016 | 149,711,504 |
| SEA with `main.cjs` (2.3 KB) | 145,237,136 | 150,060,157 |
| SEA with the Effect bundle (666 KB, unminified) | 145,893,776 | 150,723,709 |
| SEA with `main.cjs`, gzip -6 | 43,781,517 | 47,074,178 |

The darwin SEA is smaller than the official node, partly because the official
signature is replaced by a smaller ad-hoc one (the CodeDirectory shrinks from
1,138,960 to 283,508 bytes). That accounts for about 0.86 MB of the 1.66 MB
difference. The Effect bundle
is 666 KB unminified and 294 KB minified.

### Startup (median of 20 runs, wall clock including process spawn)

| Command | Mac (ms) | Linux host (ms) |
| --- | ---: | ---: |
| `node -e 0` (official 26.10.0) | 38.7 | 32.3 |
| `node main.cjs --version` | 41.0 | 33.7 |
| SEA `--version` | 40.4 | 37.1 |
| SEA `cli` (`node:sqlite`) | 38.8 | 38.9 |
| SEA `server` (listen, self-fetch, close) | 64.1 | 97.0 |
| SEA `host` (re-execs `cli`, runs `sh`) | 98.0 | 78.5 |
| `node effect.mjs` (bundle, not a SEA) | 57.0 | 106.8 |
| SEA with the Effect bundle (CJS) | 63.1 | 104.1 |
| SEA with the Effect bundle (ESM) | 64.0 | 104.1 |
| SEA with the Effect bundle (CJS) and `useCodeCache:true` (darwin only, native build) | 56.8 | n/a |

The SEA has no measurable overhead compared with plain node, which matches S4.
Loading a 666 KB Effect bundle costs about 20 ms on the Mac and about 70 ms on the
Linux host, with or without a SEA. Code cache saves about 6 ms but works only for
native builds, so leave it off.

Linux upload: about 180 MB of gzip-compressed binaries and an archive took 257 s
(about 0.7 MB/s from here). Each deployed SEA is about 47 MB on the wire.

## The alternative: a bundled `.mjs` with a pinned Node install

Ship `node` (the official binary, unmodified), `clankerbox.mjs`, and a launcher
(`exec "$DIR/node" "$DIR/clankerbox.mjs" "$@"`, or `ExecStart=`/`ProgramArguments`
naming both).

- **Steps.** It keeps steps 1–3 and 7 and drops 4–6 (no `sea.json`, `--build-sea` or
  `codesign`). It adds packaging of a launcher plus the `.mjs`. In total that saves
  about 8 lines.
- **Size.** It is no smaller, since the same `bin/node` is shipped (147–150 MB).
- **Startup.** It is the same (`node effect.mjs` 57 ms vs SEA 63 ms on the Mac,
  107 vs 104 ms on Linux).
- **darwin identity.** The process runs as Node.js Foundation's Developer ID `node`,
  which has broad entitlements: allow-jit, allow-unsigned-executable-memory,
  disable-executable-page-protection, disable-library-validation,
  allow-dyld-environment-variables, get-task-allow. Any TCC or Local Network grant
  would attach to that shared node identity, not to clankerbox.
  - To give it its own `Info.plist` identity you would have to re-sign `node`, which
    brings the codesign step back. A bundle whose executable is a launcher script
    was not tested, and it would make TCC attribution less clear.
  - `ps` and launchd show `node`.
- **Re-exec.** Roles need `[process.execPath, process.argv[1], role]` instead of
  `[process.execPath, role]`.
- **NODE_OPTIONS** is honored, so the launcher must clear it.
- **Two files must stay in sync** on every host and update path, instead of one.

Verdict: the alternative saves only the cheap part (about 8 lines). It gives up the
single-file deploy, a clankerbox-owned signing identity, the `.app` option for D9,
and NODE_OPTIONS hardening. Keep the SEA.

## What is genuinely complex (and what isn't)

- **Not complex:**
  - cross-building (one machine, no postject)
  - the 26.9 ELF change (transparent; the binary runs)
  - `node:sqlite`, `child_process`, `http` and re-exec
  - ESM main
  - notarization (not needed for this distribution)
- **Small but real:**
  - Builder and target must be the same Node version. Using the downloaded darwin
    node as the builder handles this automatically.
  - Set `execArgvExtension:"none"`.
  - Keep `useCodeCache` and `useSnapshot` off for cross-built targets.
- **Real cost, from shipping Node rather than from SEA:** about 150 MB per binary
  (about 47 MB gzipped) to every host and guest image, and the Linux runtime needs
  `libstdc++`, `libatomic` and `libgcc_s` (S4).
- **Still open:**
  - The D9 Local Network grant itself; whether the `.app` is needed depends on how
    the issuer resolves (phase 9).
  - Native addons would need extraction to disk. The plan has none.

## Resources

- **Runtime resources remaining:** none.
  - The roles exit by themselves.
  - Locally, `pgrep -fl sea-min` finds nothing.
  - On the Linux host, a `/proc/*/cwd` scan under the run dir found no processes
    before or after teardown.
- **Linux host:** created `~/clankerbox-rewrite/runs/sea-min-be81390b6ab6/` (3 SEAs,
  the Node 26.10.0 linux-x64 archive and extracted `bin/node`, `main.cjs`,
  `effect.mjs`, `bench.py`). The registered teardown removed it and verified it
  absent (`evidence/remote-cleanup.txt`: "absent").
  - `~/clankerbox-rewrite` is back to 116K: the earlier S3 runs and `tools/`,
    untouched.
  - `~/clankerbox`, its service and VMs were not touched. No root was used.
- **Local disk retained:**
  - `.work/runs/sea-min-be81390b6ab6/` is 68K (manifest and evidence:
    `results.json`, `commands.log`, `resources.json`, `remote-cleanup.txt`), kept as
    the record of this experiment.
  - Scratch (Node archives, binaries, SEAs, the `.app`, `node_modules` and the npm
    cache) was deleted (state `cleaned`).
  - Nothing was installed globally; npm used a cache and prefix in scratch.
