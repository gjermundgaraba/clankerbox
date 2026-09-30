# Spike S1 — node-pty inside a Node SEA

**Result: PASS on all three targets.** node-pty's native addon loads from SEA
assets and drives a PTY with raw bytes on:

- darwin-arm64 (native, signed with the hardened runtime)
- linux-arm64 (container)
- linux-amd64 (container, qemu emulation)

Two things only work because we bypass node-pty's defaults: its JS wrapper, and
Node's TTY stream for writes (details below).

Program: [`guest.cjs`](guest.cjs). Signing entitlements: [`entitlements.plist`](entitlements.plist).
Evidence: `out/keep/run-*.json` (gitignored).

## Criteria

| Criterion | darwin-arm64 (SEA, signed) | linux-arm64 (SEA) | linux-amd64 (SEA, emulated) |
| --- | --- | --- | --- |
| Addon extracted from SEA assets to a 0700 dir, loaded with `process.dlopen` | PASS | PASS | PASS |
| Binary-safe round trip: all 256 byte values, invalid UTF-8, a character split across writes, then 1 MiB of pseudo-random bytes | PASS (1,048,849 bytes identical; 550 EAGAIN retries) | PASS (66 retries) | PASS (72 retries) |
| Resize to 100×40, seen by `stty size` in the child | PASS | PASS | PASS |
| Exit code 42 reported | PASS | PASS (then the reader sees `EIO`) | PASS (`EIO`) |
| `kill(-pid, SIGTERM)` ends the whole process group (shell + 2 background `sleep`s) | PASS | PASS | PASS |
| Environment passed exactly, with no TERM or PWD injection | PASS | PASS | PASS |
| Whole run | 2.3 s | 1.0 s | 1.3 s |

A fourth build, linux-arm64 from a debug-stripped Node base, also passed every
check.

## What we bypass, and why

1. **node-pty's JS wrapper is not used.** A SEA can only `require` built-ins, and the
   wrapper finds `pty.node` relative to `__dirname`
   (`lib/utils.js:17-19`, `lib/unixTerminal.js:27-32`). It also does three things
   the guest must not:
   - It sets `env.PWD = cwd` and forces `env.TERM` to `opt.name || env.TERM || "xterm"`
     (`unixTerminal.js:60-62`).
   - It decodes output as UTF-8 by default, which splits multibyte characters
     (`unixTerminal.js:64,94-95`).
   - It writes through an unbounded queue that retries EAGAIN with `setImmediate`, a
     busy loop with no completion signal (`unixTerminal.js:282-335`). It also destroys
     the socket 200 ms after exit (`unixTerminal.js:35,76-80`).

   The addon's own exports are small and sufficient: `fork`, `open`, `resize`,
   `process`.
2. **Writes must not go through a Node TTY stream.** libuv marks a TTY handle on a
   pty *master* as blocking-writes, because it can't reopen a master (`uv_tty_init`
   falls back when `uv__tty_is_slave` is false). Writing through
   `tty.ReadStream(fd, {writable:true})` froze the event loop once the pty input
   queue filled: a 4 KiB raw write deadlocked on macOS. `net.Socket({fd})` refuses a
   TTY fd (`ERR_INVALID_FD_TYPE`).

   **Working shape:**
   - Reads: a read-only `tty.ReadStream(fd)`, which libuv polls.
   - Writes: our own writer using `fs.writeSync` on the non-blocking master. EAGAIN
     retries on a timer backoff (1 ms, doubling to at most 20 ms). Each write resolves
     only once the pty has accepted every byte, which gives exact byte counts for the
     input budget and backpressure (D1).
3. **Linux reports `EIO` on the master once the child side closes.** Treat it as EOF.
   macOS closes cleanly.

## Build recipe

1. **Node binaries.** Official Node v26.8.2 tarballs per target, verified against
   `SHASUMS256.txt`: `darwin-arm64`, `linux-arm64`, `linux-x64`.
2. **node-pty 1.1.0** (latest; only darwin and win32 prebuilds are published).
   Built from source with `node-gyp@13.0.2 rebuild` after
   `npm install --ignore-scripts` (for `node-addon-api`):
   - darwin-arm64: native, Xcode clang 21.
   - linux: in `debian:bookworm-slim`, arm64 native and amd64 emulated (about 2 min),
     with `python3 make g++`, using the matching official Node binary.
   - Outputs: `pty.node` (about 65–90 KB). On macOS also `spawn-helper`, which runs
     the child via `posix_spawn` with `setsid`.
3. **SEA per target, all built on this Mac:**
   ```json
   {
     "main": "guest.cjs",
     "output": "out/sea/guest-<target>",
     "executable": "<official node for the target>/bin/node",
     "disableExperimentalSEAWarning": true,
     "useSnapshot": false,
     "useCodeCache": false,
     "assets": { "pty.node": "…", "spawn-helper": "… (darwin only)" }
   }
   ```
   Run `node --build-sea sea-<target>.json`.
   - Node 26's `--build-sea` accepts another platform's binary as `executable` and
     injects into both Mach-O and ELF from macOS. postject and `--experimental-sea-config`
     aren't needed.
   - Only tested with builder and target on the same Node version (26.8.2), with
     snapshot and code cache off.
4. **macOS signing.** Unsigned, the SEA is SIGKILLed on launch (exit 137). Then:
   ```sh
   codesign --remove-signature guest
   codesign --force --sign - --options runtime --entitlements entitlements.plist guest
   ```
   The entitlements are `allow-jit`, `allow-unsigned-executable-memory` and
   `disable-library-validation`.
   - Without `disable-library-validation`, the hardened runtime refuses to `dlopen`
     the extracted ad-hoc-signed `pty.node`: "code signature … not valid for use in
     process". A release must either keep that entitlement, or sign `pty.node` and
     `spawn-helper` with the same Developer ID team as the executable.

## Sizes and runtime floors

| Target | SEA size | Stripped base |
| --- | --- | --- |
| darwin-arm64 | 144.0 MB | — |
| linux-arm64 | 148.9 MB | 138.6 MB (`strip --strip-debug` on the Node base before injection; passes) |
| linux-amd64 | 150.5 MB | not tried; the official binary also ships debug info |

**Runtime floors:**
- **Official Node 26 Linux binaries:**
  - `GLIBC_2.28`, `GLIBCXX_3.4.21`, `CXXABI_1.3.11`
  - NEEDED libraries: `libatomic.so.1`, `libstdc++.so.6`, `libgcc_s.so.1`, `libm`,
    `libdl`, `libpthread`, `libc`
  - `debian:bookworm-slim` lacks `libatomic.so.1`, so the SEA fails to start there.
- **`pty.node` built on bookworm:** `GLIBC_2.34` (`forkpty` moved into libc) and
  `GLIBCXX_3.4.22`.
- **The Ubuntu 26.04 guest seeds** (`.work/inputs/smolvm-1.19.0-images`) ship
  `libatomic.so.1` and `libstdc++.so.6.0.35`, and glibc is well above both floors.
  The production Linux host is also Ubuntu 26.04 (glibc 2.43).

## What the plan must change

- **Spike S1 / phase 3 (guest):**
  - Use node-pty's native addon only: `fork` and `resize` (`process` is available for
    the foreground name).
  - Reads through a read-only `tty.ReadStream`, writes through the writeSync
    + backoff writer, `EIO` treated as EOF.
  - Don't bundle node-pty's JS.
  - Extract the addon once, into a root-only directory under the guest's state dir
    keyed by the asset's digest, not a fresh temp dir per process.
- **S4 / `tools/release`:**
  - Build all three SEAs from one macOS builder with `node --build-sea` and an
    `executable` per target. No postject.
  - Pin the three official Node tarballs by SHA-256 in `release-inputs.json`.
  - Strip debug info from the Linux bases (about −10 MB each).
  - Sign the macOS binary as above; decide Developer ID vs `disable-library-validation`.
- **Images:** prepared images must keep `libatomic.so.1`, `libstdc++.so.6` and
  `libgcc_s.so.1`. Checked once at build validation, alongside the guest digest.
- **Orphan reaping (new, for S3 and the guest phase):**
  - On Linux the killed group's two `sleep`s stayed zombies until PID 1 reaped them.
    The check counts only non-zombie members for that reason.
  - Node can neither `waitpid` arbitrary PIDs nor become a child subreaper. The guest
    daemon therefore must not be PID 1, and something in the VM must reap orphans:
    the smolvm/Tart agent or a minimal init.
  - S3 should confirm who is PID 1 in each runtime's guest.
- **Throughput tuning (guest phase):** a 1 MiB PTY echo round trip took about
  0.6–1.7 s with the 1→20 ms backoff. Try `setImmediate` for the first retry before
  timers, and measure again.

## Runtime resources and retained disk

- **Runtime resources remaining: none.**
  - All containers ran with `--rm` and prefix `clankerbox-rewrite-s1-*`; none remain.
  - The pulled `debian:bookworm-slim` images (arm64 `813cd0370d82`, amd64
    `db9f02c6bde9`) are removed.
  - Pre-existing images (`clankerpedia-*`, `ubuntu:22.04`, untagged `57ca06a00268`)
    were left alone.
  - Two extracted temp dirs from runs killed by `timeout` were removed.
- **Disk retained: `spikes/s1-pty/out/keep/`, 308 KB (gitignored).** It holds the three
  built `pty.node` binaries and `spawn-helper`, for reuse by S3 and S4. SHA-256:
  - darwin-arm64 `pty.node`: `6edb9b54…`
  - `spawn-helper`: `738b7049…`
  - linux-arm64 `pty.node`: `b10c2ea7…`
  - linux-amd64 `pty.node`: `e333c757…`

  It also holds the run JSON files. Node tarballs, build trees and SEA binaries
  (about 2 GB) were deleted.
