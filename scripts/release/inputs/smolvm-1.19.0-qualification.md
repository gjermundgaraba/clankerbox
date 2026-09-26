# smolvm 1.19.0 qualification — 2026-09-26

## Scope and builds

Linux guests on macOS/arm64 (Hypervisor.framework) and Linux/amd64 (KVM).
Tart, macOS guest images, Ubuntu/Node, the locked apt inventories and the compact
disk templates are unchanged. This updates release inputs, not the production
installation. Old checkpoints retain their old runtime/image identity and cannot
be relabeled for this build.

The engine is smolvm **1.19.0**, commit
`572bb694d7dc6857d5de012c9e24a6e4a857ca27` (a descendant of 1.16.0), with the
release's matching smol-machines submodule pair:

- libkrun: `2210fda788c7fa13c23b592261a14db2f2cadc4a` (additive ABI; SONAME and
  install name unchanged).
- libkrunfw: `6ec329e11154814a4df9963a3f94f2a430f55723`, unchanged
  (ABI 5 / version 5.5.0, Linux 6.12.95).

Engines and both static musl agents were rebuilt with Rust 1.98.0 and Zig 0.16.0
using `--locked`. The amd64 engine targets glibc 2.35 (highest required symbol
GLIBC_2.34); the arm64 macOS engine is ad-hoc signed with upstream hypervisor
entitlements and passed `codesign --verify --strict`.

Native libraries are the **unmodified** bytes of the verified 1.19.0 release
archives (darwin `8b2eaafd…0cc85`, linux-x86_64 `4feb274f…83311`, both matching
upstream `checksums.sha256` and GitHub asset digests). Only `libkrun` changed
on each platform; libkrunfw, MoltenVK, libepoxy and virglrenderer are
byte-identical to 1.16.0. The engine was linked against a private copy of the
darwin libraries, because smolvm's `build.rs` re-signs `libkrun.dylib` in place.
The 1.16.0 inventory's `e47998f0…` dylib was such a build-time re-signature; this
inventory pins the release signature (`7c7062c0…`), which verifies strictly. The
Linux `libkrun.provenance` is taken from the tagged tree; its LFS pointer for
`libkrun.so` matches the release bytes.

## Runtime patch

`runtime.patch` was rebased deliberately rather than reapplied:

- **Dropped (absorbed upstream).** smolvm 1.19 requires the guest's
  `quiesced-shutdown-v1` capability and a `filesystems_quiesced: true`
  acknowledgment (sent after freezing writable ext4 mounts). It also refuses to
  terminate a live VMM without that acknowledgment in every mode. This
  supersedes the patch's client acknowledgment check and manager live-process
  guard.
- **Retained.**
  - Persistent-root overlay options (`index=off,redirect_dir=off,metacopy=off`).
    Upstream still mounts without them.
  - Restart-aware fork state in `state_probe`. Upstream still treats every
    dependent clone as freezing, and a Frozen stop now terminates without a
    handshake.
  - The `SMOLVM_STOP_REQUIRE_ACK=1` guards that refuse the Unreachable-zombie
    kill and the orphaned-boot-process kill.
- **Rewritten.** The orphan regression now asserts that a live VMM and its
  PID/config markers survive an unacknowledged stop in both modes, and that
  dead-process cleanup still works. It runs on macOS and Linux.

The host now sets `SMOLVM_DISABLE_READONLY_RESTORE=1`. On a root Linux engine,
1.19 would otherwise stage restore RAM outside the pending directory that
retained-start validation requires.

## Compatibility notes

- **Guest agents must match.** A 1.19 host refuses to stop a VM whose agent lacks
  the quiesced-shutdown capability (the VM is left running). Machines created
  under 1.16 keep that agent in their private rootfs. As with any runtime change,
  stop or destroy 1.16 machines with their matching bundle before switching.
  Do not start them under this runtime.
- CLI flags used by the host, `machine ls --json` fields, the database location,
  default networking (virtio-net, `100.96.0.0/30`), `SMOLVM_EGRESS_FLOOR=strict`
  and `SMOLVM_PUBLISH_ADDR` semantics are unchanged. Credential interception,
  pause/resume, checkpoint stores and `--disk` are opt-in and unused.
- 1.19 still accepts 1.16 checkpoint artifacts, even though libkrun state
  changed. The host's runtime-pin check remains the only guard against
  restoring them.
- Linux restores extract into the engine's shared `_shared/` cache, which
  `machine delete` does not reclaim. This is unchanged from 1.16.

## Qualification

Both supported host platforms passed with fresh isolated `clankerbox dev`
environments on the runtime hosts documented in `personal-cloud`. The hosts were
Linux 7.0.0 / glibc 2.43 and macOS 27.0 / arm64. Each host was driven through
an SSH tunnel and a local loopback HTTPS/H2 proxy. Neither production service,
its configuration, its runtime nor any existing workload was modified. Host
service PID/start time and binary/configuration hashes (plus Linux production
unit states) matched before and after, and no native job outside the baseline
remained.

- Release smoke: empty catalog, explicit recipe publication (1 GiB storage /
  8 GiB overlay), root tool session, create, stop/start, RAM checkpoint, restore
  and machine/checkpoint deletion.
- `tests/live_lifecycle.py`: Git state, executable modes and symlinks survive
  stop/start; stopped-session refusal; retained identity and incarnation.
- Disk contract: 512 MiB templates in each machine's engine home, `storage.raw`
  and `overlay.raw` extended sparsely to exactly 1 GiB and 8 GiB, both `.formatted`
  markers present, and no host `resize2fs` or pre-format fallback in any log.
- `protocol/test/real-vm.mjs qualify`: root identity/environment and retained
  prefix checks.
- `protocol/test/public-session.mjs` over HTTPS/H2: 64 MiB streaming, ordered
  controls, bounded stalled viewer, cancel/resume.
- `tests/live_checkpoints.py`: RAM fork/capture identity and memory, independent
  restores, source restart with retained descendants, deletions and cleanup.
- Native Linux unit regressions on the KVM host, in both acknowledgment modes:
  orphan preservation, 11 shutdown-wire tests, 8 state-probe tests, graceful
  stop and the fork-lineage restart guard.
- macOS build host: the full smolvm library suite (880 tests) passed.
  `smolvm-agent` passed 230 of 231 tests; the remaining test asserts a 0644
  file mode and passes under umask 022 (it fails only under the build's 027).
- Repository checks from the candidate checkout: Go race tests, 35 harness
  tests and 45 release tests passed.

`dev destroy` removed each environment, host root and native job. The staging
roots, tunnels and proxies were removed, and no new native jobs remained.

Candidate `0.10.0-smolvm1.19.0-candidate1` identities:

| Platform | Identity | SHA256 |
|---|---|---|
| darwin-arm64 | manifest | `bfef2248df3f19d25172ba4e36fb01379ac649f1e661355b6892c7ea7b119dff` |
| darwin-arm64 | runtime | `2c3846ea8ead5f814abec3f23bcdb8f3d32506b93be9f7dd3246d4210c819654` |
| darwin-arm64 | image | `cdff76aa92fe6db7a9779381b00a84dac38aa917414672b0458d45c5c5f4c10d` |
| darwin-arm64 | archive | `e48af58a21e2e1cd47e9fd592dfc5c650af3be4028e9a749838cec30e3abceba` |
| linux-amd64 | manifest | `096f868f17558ca072eda26b75b96e921d005b8270582421ad54f8f021ab5d28` |
| linux-amd64 | runtime | `bdf45df0fd6dcb3f9efa04b7c019fb519ec7f71295b7e0fe7a0324bc96a10d78` |
| linux-amd64 | image | `d83ab7cf627543f1e43f99dadf53a4aea7d737b355612e89f5b56a2c24a37880` |
| linux-amd64 | archive | `6d2fef00b0ccde3579d71dead0de14eab22ed72d0df46740cba200d0297a7ddf` |

Candidate images are copies of the qualified 1.16.0 generic images. Only
`usr/local/bin/smolvm-agent` was replaced (mode 0755). Every other entry's type,
mode and content was compared unchanged, and both pass
`images/verify-package-locks.py`.

Live evidence receipt hashes (private journals/logs, not release inputs):

| Platform | Check | SHA256 |
|---|---|---|
| darwin-arm64 | smoke/disks | `f057a0c67fe8b04f175923817108bd5a83e03f25208947856bf5fa80f83575c7` |
| darwin-arm64 | lifecycle | `6abbb335d818b09a5552409a9db7627c1c142ac35e899b8bae91be19be172b79` |
| darwin-arm64 | checkpoints | `9b9597084944bf6bbe852c4013cea1b5bcad3d09afa2dde05c338b7e8ab1871e` |
| darwin-arm64 | sdk | `f2cfc290fa1145ff7bcf339a627596cd19e5f91f0c7dbdc730d126eb15fa0cae` |
| darwin-arm64 | public-session | `2c0735871f6854f00820378bdd48d00f67f5250168e5b507fd8a67142c655d2d` |
| darwin-arm64 | teardown | `284f647ec2bbe24ba3e3efc1ebf8a6d4cdacb79f1d98026f1d39dafd834f4aef` |
| linux-amd64 | smoke/disks | `607c9006fa55be24e2c83a634f4e855336dbcd823238296be20786c4dc1c5d02` |
| linux-amd64 | lifecycle | `1397df6fdccf5a73114333e50c600268eacbc3e57748bf0285e3ef0955195af3` |
| linux-amd64 | checkpoints | `7799945faefea75f62a3562cf9966079f60919e6d61ef2e2b02ad715b4fa8faf` |
| linux-amd64 | sdk | `cd678b3e148d1b7666f9758ee06268a728561dc1f6447ba28ef3b3438e3ef191` |
| linux-amd64 | public-session | `495e81a0f74e44267eff6a99d12cbb05b580b58ce561b7553ac99a8fc264c5ab` |
| linux-amd64 | teardown | `96c2c77824055e875d74feffa8e6175f6dfdf20703773a6d6434eb4bbe82715b` |

## Evidence and corresponding source

Build inputs, the patched source checkout, Cargo metadata, regenerated notices
(548 packages), build/test logs, the isolated candidate checkout and live
journals are retained privately in `.work/smolvm-1.19.0-update/`. Journals are in
`results/{darwin-arm64,linux-amd64}/`. They contain development credentials;
do not publish them wholesale. As before, reassemble with the matching isolated
checkout (`clankerbox-candidate/`), not the main checkout's `bundle.py`.

`corresponding-source/` holds these archives with a `sources.json` manifest:

| Archive | SHA256 |
|---|---|
| smolvm 1.19.0 source archive | `4b076cb13312dee5c7a75692a6b8e1bcddd3bf81256953308ea536fa533906e0` |
| smolvm runtime patch | `2f159988d75bb0410745db1b69ad4e0e73471031874ddeb9272cc356350fdcc7` |
| smolvm 1.19.0 darwin-arm64 release | `8b2eaafdf15734b87a9f92aa837c79afa8bb351e183b7cd4f2205ffcd0f0cc85` |
| smolvm 1.19.0 linux-x86_64 release | `4feb274fd24d4722d718b9c85881fb9bba3c0c9f8123f67584436065bf583311` |
| libkrun source archive | `be9b715cb47769b33be5efbe2e7e38402d58349f7b32c7c7807784d1e68ffd06` |
| libkrunfw source archive (unchanged) | `fd1978d7f22464c67848949cd50debddfb1cc75bb2a9b59326dcc75bf7acdc0e` |
| linux-6.12.95 source archive (unchanged) | `a9e8c51fcb1e695d1d35dde5886cba579cb6f29c9646c5889f39d63841d4b9f6` |
