# Spike S4: SEA build and signing, D9, glibc floor

Date: 2026-09-30. Machine: this Apple Silicon Mac (macOS 27). Node v26.8.2.
The Linux box was not touched. Sources: `main.cjs`, `sea-*.json`,
`entitlements-jit-only.plist` and `entitlements.plist` in this directory.
Scratch was under `out/` and has been deleted.

## Results

| Criterion | Result | Evidence |
| --- | --- | --- |
| Official Node binaries verified | PASS | darwin-arm64, linux-arm64 and linux-x64 archives match `SHASUMS256.txt` from nodejs.org. The signature on `SHASUMS256.txt.sig` was not checked. |
| Multi-role SEA (`server\|host\|guest\|cli`) builds for darwin-arm64 | PASS | `node --build-sea sea-darwin-arm64.json`, with `executable` set to the official binary. No postject needed. `node:sea` `isSea()` returns true. |
| Linux SEAs cross-build on macOS | PASS (build only) | The same command with the linux-arm64 and linux-x64 Node binaries produces valid ELF executables. Running them is left to S1/S3. |
| Signing requirement | PASS | `--build-sea` strips the official signature. The unsigned output is SIGKILLed on launch (exit 137). An ad-hoc signature is enough without the hardened runtime. |
| Hardened runtime needs a JIT entitlement | PASS | With `--options runtime` and no entitlements, V8 aborts ("Failed to reserve virtual memory for CodeRange", exit 133). `com.apple.security.cs.allow-jit` alone is enough, and JS JIT and WebAssembly both work (`--jit-check`, `--wasm-check`). The Go release had no such entitlement, because Go doesn't need JIT. `bundle.py:257-261` only ad-hoc signs without the runtime. |
| Runs as a launchd job | PASS | User jobs `clankerbox-rewrite-s4-3759f4d8` (bare binary) and `clankerbox-rewrite-s4-54dbc136` (inside an `.app`) ran and exited 0. Both were booted out, and `launchctl print` confirms both are gone. |
| Size | measured | SEA: darwin-arm64 144.2 MB, linux-arm64 148.8 MB, linux-x64 150.4 MB. Essentially the Node binary; the blob is tiny. |
| Startup | measured | Median over 20 runs: SEA `host` 41.9 ms, plain `node -e 0` 41.0 ms. No measurable SEA overhead with snapshot and code cache off. |
| Info.plist embedded in the Mach-O (Go's `-sectcreate __TEXT,__info_plist`) | FAIL | postject (LIEF) can add `__TEXT,__info_plist` to the SEA, and codesign then reports `Info.plist entries=5`. But dyld refuses to start the binary ("unsupported thread-local, larger than 4GB"). Not viable. |
| Info.plist via an `.app` wrapper | PASS | `Clankerbox.app/Contents/{Info.plist, MacOS/clankerbox}`, signed as a bundle (runtime + allow-jit). codesign reports "app bundle", `Info.plist entries=7` on both the bundle and the inner executable, and `--verify --strict --deep` passes. The inner executable runs from launchd. The actual Local Network grant was not tested, since no TCC changes were made. |

## D9: does Local Network permission still matter?

**Why it existed.** Commit `360422d` added `HostInfo.plist` (`NSLocalNetworkUsageDescription`)
and `build-mac-host.py`. The Mac host dials each Tart guest's daemon at
`<tart ip>:7443` on the vmnet private network (`internal/host/runtime.go:568-577`,
`host.go:833`). macOS blocked that until an operator granted Local Network access
to a signed host (`scripts/release/inputs/tart-prepared-qualification.md:35-37`).

**Under the new design:**
- **Host→Tart guest** goes over `tart exec -i` (D2), a child process that talks to
  Tart's control socket. The host opens no socket to a vmnet address, so the
  original reason disappears.
- **Inbound: controller→Mac host.** In production this is
  `listen: https://192.168.50.15:8444`. It is inbound. Local Network privacy
  governs outgoing connections and Bonjour. This is not verified here.
- **New outbound: Mac host→clankerauth key list** (`POST /api/issuer/keyList`).
  In production the issuer is `https://clankerauth.home.garaba.net`. From this Mac
  it doesn't resolve; on the home LAN it probably resolves to a LAN address. If it
  does, that fetch is a Local Network connection.
- **CLI→controller** from Terminal or SSH is exempt (TN3179: command-line tools run
  from Terminal or over SSH, and their children).
- **Dev mode** uses loopback only.

**TN3179 also says:** macOS allows local network access to any daemon started by
launchd, any root process, and tools run from Terminal or SSH. A known DNS
interaction bug can still block a root daemon.

The production host is a system LaunchDaemon with `UserName` gg. Qualification
still needed an explicit grant for it (or for the agent used then), so don't
assume the exemption applies.

**Conclusion:**
- D9 shrinks from "host→guest traffic" to "one HTTPS fetch of the key list, if the
  issuer resolves to a LAN address".
- Keep a stable signed identity for the Mac host. Do that with an `.app` wrapper,
  not an embedded plist:
  - The darwin binary ships as `Clankerbox.app/Contents/MacOS/clankerbox`, and the
    CLI can be a symlink to it.
  - The launchd job points at the inner executable.
  - Signing is `--options runtime --entitlements allow-jit`. Production uses the
    existing Apple identity; bundles are ad-hoc.
- If production's issuer is reachable by a non-LAN route, or the daemon exemption
  holds, no grant is needed. The fallback is to resolve this at deploy time
  (phase 9) with one operator grant, as today.

## glibc floor

| | Required by the official Node 26.8.2 linux binary | Provided by the seed guest images (Ubuntu 26.04.1) |
| --- | --- | --- |
| glibc | GLIBC_2.28 max (libc, libm 2.27) | GLIBC_2.43 |
| libstdc++ | GLIBCXX_3.4.21 | GLIBCXX_3.4.35 |
| Other NEEDED libraries | `libatomic.so.1`, `libgcc_s.so.1`, `libstdc++.so.6`, `libdl`, `libpthread`, `libm` | all present, in `/usr/lib/<triple>/` in both `image-darwin-arm64` and `image-linux-amd64` |

PASS, with a wide margin. Unlike the static Go guest, a Node SEA also needs
`libstdc++`, `libatomic` and `libgcc_s` in every guest image. Image validation
must check for them.

Tart guests are macOS, so this doesn't apply to them. The Tart guest SEA is the
darwin-arm64 binary.

**Seed image observation:** both seed images already ship exactly Node 26.8.2 at
`/usr/local/bin/node`:
- linux-arm64 sha256 `79cacf59…`, identical to the official binary
- linux-x64 sha256 `8a22a371…`, identical to the official binary

`images/stage-linux.py` pins it. The images are Ubuntu 26.04.1; the Linux test box
is Ubuntu 26.04.1 with glibc 2.43.

## What the plan must change

1. **D9:** replace "`.app` wrapper or re-signing with an embedded plist" with the
   following, and move the Local Network check to phase 9:
   - an `.app` wrapper for the darwin binary; embedding a plist breaks dyld
   - the reason is now only the key-list fetch
2. **S4 bullet and `tools/release`:**
   - `--build-sea` with the official per-target Node binary replaces postject.
   - All three targets build on macOS.
   - darwin signing is `--options runtime` plus `com.apple.security.cs.allow-jit`
     only.
3. **Release inputs:** pin the three official Node archives by SHASUMS256. The
   seed images already pin the same Linux binaries.
4. **Image validation:** require `libstdc++.so.6`, `libatomic.so.1` and
   `libgcc_s.so.1`, and glibc ≥ 2.28.
5. **Open question for the plan:**
   - The guest images already carry Node 26.8.2 for workloads. The guest could run
     as `node guest.mjs` against that copy instead of a 149 MB SEA, which would
     avoid shipping Node twice.
   - The catch: profile setup could replace the image's Node and break the daemon.
   - Recommendation: keep the SEA as the plan says, but it's worth a decision.

## Resources

- **Runtime resources remaining:** none. Both launchd jobs were booted out and
  verified absent. `launchctl list | grep clankerbox-rewrite` returns nothing.
  There are no processes, containers or VMs.
- **Disk retained:** none beyond these small source and results files. The 1.1 GB
  of scratch was deleted: Node archives, extracted binaries, SEAs, `.app`,
  postject tooling and launchd logs. The seeds were read only.
