# smolvm 1.16.0 qualification — 2026-09-14

## Scope and builds

Linux guests on macOS/arm64 (Hypervisor.framework) and Linux/amd64 (KVM).
Tart, macOS guest images, Ubuntu/Node and the locked apt inventories are unchanged.
This updates release inputs, not the production installation. Old checkpoints
retain their old runtime/image identity and cannot be relabeled for this build.

The engine is smolvm **1.16.0**, commit
`e1dd54bf7be6d144ad6bdef4ebf310f57809a6a6`, with the release's matching
smol-machines submodule pair, not later development branch heads:

- libkrun: `d1f79154fbfd7e8ecf9d4e259e2006524e6cf913`.
- libkrunfw: `6ec329e11154814a4df9963a3f94f2a430f55723`
  (ABI 5 / version 5.5.0, Linux 6.12.95; the amd64 firmware bytes are unchanged).

`runtime.patch` is rebased onto this source. Its strict shutdown acknowledgment
check now runs inside upstream's bounded framed I/O implementation; the patch
retains the orphan/live-process stop guard, persistent-root overlay options and
restart-aware fork state. Engines and both static musl agents were rebuilt with
Rust 1.98.0 and Zig 0.16.0 using `--locked`. The amd64 engine targets glibc 2.35;
the arm64 macOS engine is ad-hoc signed with upstream hypervisor entitlements.
Native libraries come from the verified 1.16.0 release archives. The Linux
`libkrun.provenance` is copied from the same pinned source distribution.

## Disk templates and image permissions

The existing qualified templates contain 512 MiB ext4 filesystems padded with
zeros to 20 GiB (storage) and 10 GiB (overlay). smolvm 1.16.0 tries to run host
`resize2fs` when those files exceed the requested disk size. Without that host
tool, the warning-and-continue fallback leaves no formatted marker; another
start can overwrite the guest's disk. Qualification reproduced lost workspace
contents with both old and new padded templates. Those candidates were rejected.

The qualified inputs remove **only verified zero padding outside the ext4
filesystem**, keeping the original 512 MiB filesystem bytes unchanged. For each
platform/template, the build:

1. Verifies the previously qualified compressed-template hash, then expands it
   sparsely with `zstd -d --sparse` in a disposable build directory.
2. Checks the ext4 magic, block count (including 64-bit high bits where enabled)
   and block size: their product must be exactly 536870912 bytes.
3. Reads the entire tail beyond that boundary and refuses any nonzero byte;
   only then truncates to the verified filesystem length.
4. Runs `e2fsck -fn` (1.47.4), requiring success without repairs, and recompresses
   using `zstd -19 -T1` (1.5.7).
5. Pins the resulting compressed bytes in `runtime-artifacts.json`, assembles
   with ordinary guards and performs fresh live qualification on both platforms.

See [template-provenance.json](template-provenance.json) for original archive,
input, unchanged filesystem and final compressed hashes.
The checked-in [prepare-templates.py](../prepare-templates.py) reproduces this
transformation and checks those pins without modifying its inputs. See the
[build-only preparation commands](../README.md#prepare-the-compact-templates).

The engine now extends the sparse file and the guest grows its filesystem;
no host e2fsprogs dependency is introduced. Do not pad these templates back to
upstream defaults or substitute freshly hashed unqualified files.

The image agent and its provenance metadata are replaced in otherwise unchanged
qualified image copies. Preserve modes during extraction (`tar -xzpf`); an
initial amd64 staging attempt with umask-stripped executable bits was rejected.
The corrected amd64 staging was checked against every entry of the original
qualified bundle manifest before replacing the agent. Both architectures pass
`images/verify-package-locks.py` against the unchanged apt locks.

## Qualification

Both supported host platforms passed with fresh isolated `clankerbox dev`
environments on the runtime hosts documented in `personal-cloud`. Neither
production service, configuration, runtime nor existing workload was modified.
The tested profile was `linux-dev-v3` (1 GiB storage / 8 GiB overlay). Both hosts
materialized 512 MiB templates, created formatted markers and honored those disk
sizes. The macOS host needed no installed e2fsprogs.

- Rust: strict/default shutdown helper and wire tests; Linux orphan/live-process
  safety in both modes; upstream partial-frame shutdown deadline; retained-root
  overlay flags; rustfmt. macOS code signature/entitlements verification passed.
- Live lifecycle: noninteractive Git staged/unstaged data, executable bits and
  symlinks survive stop/start; stopped sessions reject with the typed error;
  cold starts preserve machine identity and replace manager incarnation.
- SDK: nonroot identity and private-state isolation; 8 MiB retained-prefix resume.
- HTTPS/H2 sessions: invalid bearer rejection, ordered controls, 64 MiB output,
  bounded stalled viewer beside a healthy sibling, cancel/resume on the same
  shell. Topology was a private loopback TLS/H2 proxy over an SSH tunnel to each
  isolated controller, not the production ingress.
- RAM forks/checkpoints: live memory identity, independent child disk writes,
  source restart with a retained descendant, source deletion, two independent
  restores, checkpoint deletion and retained descendants' cold restarts.
- All owned test VMs/checkpoints were deleted. `dev destroy` removed the isolated
  host jobs and roots; local test tunnels/proxies were stopped.
- Repository checks: `make build`, `make test`, `make lint`, and the SDK typecheck
  and seven unit tests passed. The Python suites passed 17 acceptance-harness and
  23 release tests; Go tests passed with the race detector.

Final candidate `0.4.0-smolvm1.16.0-candidate3` identities (full payload inventory,
entry types, modes, content hashes and absence of extra entries checked remotely):

| Platform | Identity | SHA256 |
|---|---|---|
| darwin-arm64 | manifest | `a7a8454d6c1b2a5404221f5931becd29cb09f8fb76ded75d590d066da4e070e5` |
| darwin-arm64 | runtime | `4a9570ecf4ed50471d57a2286ee2000a0f9ffa4b9bc1df617e1154ba6539cf11` |
| darwin-arm64 | image | `0efc1098d5f75583f34f3af9633b05cd284a1360281cecec6492dc3bc01593e5` |
| linux-amd64 | manifest | `1c6d800444a1dfcc246f8796f4a3f3f5bf74a1192f224e64a71f0dacb48d100f` |
| linux-amd64 | runtime | `75156912ac4dfa6b9679fe1b4d70380c7083efdad86904f5b8f5c7bc38ce0d33` |
| linux-amd64 | image | `0f9025a6ff6dd4040049b6dbd31a56ce0edaf11b431ceac2f56e22c61c94fe28` |

Live evidence receipt hashes (private journals/logs, not release inputs):

| Platform | Check | SHA256 |
|---|---|---|
| darwin-arm64 | lifecycle | `61066a0022c78dab1dbf0d9db16c9c18b615aebdf8694c8f608797475cba20e8` |
| darwin-arm64 | checkpoints | `cd9bf37bf23232cc3fd2f6365c95065acdc7853a7af3f9086c37391b57d8d817` |
| darwin-arm64 | sdk | `c1be850e2b92ceb05c50b1afd7e03eeab376558b5ef83ac701435f66fae8cd46` |
| darwin-arm64 | public-session | `a5876f486a44d84fbb25476002ab6e403ebbfa685f9fa7c11001f04f7d0f8986` |
| linux-amd64 | lifecycle | `4e67532ae7aa548cca50ef174c3bb6840df4ad47782454b2a4be61f5aad6c721` |
| linux-amd64 | checkpoints | `260f42005741751223ea2d73763b0f07c4b7005fcc25122b1abb8e7e32e69191` |
| linux-amd64 | sdk | `bce337b49582a2fc67064ba005e1c9b707b93b40d9dddff542ab4dc438f075a5` |
| linux-amd64 | public-session | `bd7098f95056210c7a54685579cd98c972b1a14657203f360b120e3147d5da56` |

## Evidence and corresponding source

Local build inputs, source/patch, Cargo metadata, complete regenerated Go/Rust
notices (542 packages), native unit-test logs, compact-template provenance and
failed-attempt journals are retained privately in
`.work/smolvm-1.16.0-update/`. Final live journals are in
`attempt3/results/{darwin-arm64,linux-amd64}/`. These directories can contain
local development credentials; do not publish them wholesale. The notices
collector expands `go.sum` in the isolated build checkout via
`go mod download all`; its provenance binds that checkout, without changing
Go dependency versions or this repository's module files.
These retained notices intentionally fail verification through the main checkout's
`bundle.py`, whose `go.sum` differs. Use the matching isolated checkout's assembler;
the [release guide](../README.md#reuse-the-retained-1160-inputs) gives exact retained
input paths and a fresh same-checkout collection/assembly workflow. Changing only
the shell's working directory does not select a different provenance root.

The matching libkrun, libkrunfw (including kernel patches/configuration) and
Linux 6.12.95 archives are retained under `corresponding-source/`. Redistribute
these with release artifacts as described in the [release guide](../README.md),
not links to moving branches. Source/archive SHA256 values:

| Archive | SHA256 |
|---|---|
| smolvm source archive | `65aaebf1aa33a7ec5a3dd0895b2bac0bafd6c1cd84e996f604f4196b7cf1d347` |
| smolvm 1.16.0 darwin-arm64 release | `7be55af510b698bb95c9e9b103004c81f75cacfaa62b00aaf554441e9023353b` |
| smolvm 1.16.0 linux-amd64 release | `cb7d6ea34914b4d71958e16eafc8a3220fe9e8cd5b76fa983ef9f648159f4c9b` |
| libkrun source archive | `52e21ef3f6b0724a9dae9bc0a00060c9362d268a7bf3eb2b6804672d8db44f65` |
| libkrunfw source archive | `fd1978d7f22464c67848949cd50debddfb1cc75bb2a9b59326dcc75bf7acdc0e` |
| linux-6.12.95 source archive | `a9e8c51fcb1e695d1d35dde5886cba579cb6f29c9646c5889f39d63841d4b9f6` |

The kernel archive hash also matches kernel.org’s published SHA256 list.
Source URLs and download manifests remain with the archived inputs.


## Build reproducibility follow-up

The checked-in preparation tool reproduced all four templates from the original
v0.3.0 archive inputs using the recorded tools, matching the pinned compressed
hashes exactly. Reassembly through the retained isolated checkout with its
existing notices produced byte-identical `bundle.json` manifests on both targets.
The release test suite now has 39 passing tests, including transformation refusal
cases and checkout-specific `go.sum` provenance; the 17 acceptance-harness tests,
Go race tests and lint also pass. No runtime pins, engine/agent binaries or runtime/image
identities changed; live VM qualification was not repeated for this build-tool/documentation
follow-up.
