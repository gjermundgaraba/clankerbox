# Release bundles

`bundle.py` assembles the macOS/arm64 and Linux/amd64 release archives. Each
contains `clankerbox` beside `bundle.json`, the controller, host and guest
binaries, the patched smolvm engine with its runtime libraries and Linux agent,
compressed disk templates and a Linux guest image. Running a bundle needs no Go
or Rust toolchain.

The manifest (format 2) lists every payload file, directory and relative
symlink with its POSIX mode and SHA256. Startup rejects missing, extra or
changed entries before creating a VM. `runtime_digest` and `image_digest` are
computed from sorted relative content inventories, so installation paths do not
change checkpoint identity; modes and directory metadata do. Extract with
`tar -xzpf` under a private parent so guest permissions survive. The host
expands disk templates into its own runtime cache and never writes into the
bundle.

## Build inputs

The [smolvm 1.16.0 qualification record](inputs/smolvm-1.16.0-qualification.md)
describes the release-matched libraries and compact disk templates. Raw upstream
templates are not interchangeable with the qualified runtime inventory.

Run collection and assembly from the **same isolated checkout**. Select a committed
revision containing the intended source and artifact pins (not an older HEAD that
omits uncommitted release-input changes):

```sh
SOURCE_REPO=$(git rev-parse --show-toplevel)
RELEASE_COMMIT=COMMIT_CONTAINING_THE_INTENDED_PINS
BUILD_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/clankerbox-release.XXXXXX")
CHECKOUT="$BUILD_ROOT/checkout"
git -C "$SOURCE_REPO" worktree add --detach "$CHECKOUT" "$RELEASE_COMMIT"
cd "$CHECKOUT"
```

Keep this checkout and its post-collection `go.mod`/`go.sum` with the notices until
assembly is finished. `notices.py` runs `go mod download all`, which can expand
`go.sum` without changing dependency versions. Both scripts determine their root
from their **own file location**, not the shell's working directory. Merely using
`cd` while invoking a script from another checkout does not select this checkout.
Do not tidy or replace module files between collection and assembly, or bypass a
provenance mismatch. The original working checkout remains untouched.

1. Build the engine and static guest agent from [the pins](inputs/pins.json)
   and the [qualified patch](inputs/runtime.patch). Keep the upstream runtime
   archive and build provenance. A newer unqualified upstream binary is not a
   dependency update.
2. Download the Ubuntu Base and Node archives for each architecture.
   `images/stage-linux.py` checks their SHA256 pins and the agent hash before
   creating an image directory. It rewrites absolute guest symlinks as relative
   links, strips setuid/setgid bits, and creates no users or device nodes.
3. Boot that directory as `SMOLVM_AGENT_ROOTFS` in a disposable native VM. Mount
   a recipe directory read-only and an empty export directory, then run
   `images/install-linux-tools.sh` inside the guest with `images/package-locks`
   alongside it. The recipe verifies the pristine base, installs the locked apt
   closure, checks the final package inventory, records tool versions and locks
   root login. Workload users are created later by per-machine bootstrap.
4. Export the guest filesystem with `tar --one-file-system`, excluding `proc`,
   `sys`, `dev`, `run`, `tmp`, `mnt`, `oldroot`, `storage`, `export`, `recipe`
   and `.smolvm`. Normalize the export's symlinks with the staging script's
   `extract()`, then recreate the excluded runtime mount directories (`proc`,
   `sys`, `dev/pts`, `run/smolvm/virtiofs`, `mnt/*`, `storage`) and a
   mode-1777 `tmp`; the extractor does not create entries the archive omits.
5. Generate Cargo metadata from the pinned engine source and collect notices.
   Set `ENGINE_SOURCE` to its absolute path; use new metadata/notices paths:

   ```sh
   ENGINE_SOURCE=/absolute/path/to/pinned/patched/smolvm
   CARGO_METADATA_JSON="$BUILD_ROOT/cargo-metadata.json"
   NOTICES_DIRECTORY="$BUILD_ROOT/notices"
   cargo metadata --locked --format-version 1 \
     --manifest-path "$ENGINE_SOURCE/Cargo.toml" > "$CARGO_METADATA_JSON"
   python3 "$CHECKOUT/scripts/release/notices.py" --engine-source "$ENGINE_SOURCE" \
     --rust-metadata "$CARGO_METADATA_JSON" --output "$NOTICES_DIRECTORY"
   ```

   The collector records its Go module files, the engine Cargo lock and the
   metadata hash in `provenance.json`, lists packages and notice paths in
   `dependencies.json`, and binds every copied notice in `inventory.json`.
   Workspace crates inherit the engine license when they have none; a crate
   that declares a license but ships no notice file is recorded as
   `upstream-no-notice-file` rather than given an invented one.
6. Assemble. Before creating output or invoking Go, the assembler verifies
   every shipped library and both compressed templates against the platform
   [runtime artifact inventory](inputs/runtime-artifacts.json); missing
   artifacts, extra library entries and changed types or content fail assembly,
   and the copied artifacts are checked again before the manifest is written.
   It also checks the engine `LICENSE` and `Cargo.lock` against
   [source.json](inputs/source.json), verifies the notices and inventory,
   cross-compiles the Go binaries, and checks the copied license inventory
   again before writing the manifest:

   ```sh
   python3 "$CHECKOUT/scripts/release/bundle.py" --os darwin --arch arm64 --version VERSION \
     --engine PATCHED_ENGINE --runtime-assets RUNTIME_DIRECTORY \
     --image NORMALIZED_ARM64_IMAGE --engine-source "$ENGINE_SOURCE" \
     --dependency-notices "$NOTICES_DIRECTORY" --output OUTPUT_DIRECTORY
   ```

Repeat for `--os linux --arch amd64`. `--no-archive` produces a local
qualification candidate without the archive and checksum. On macOS the
assembler preserves and verifies the engine's signature and virtualization
entitlements and ad-hoc signs the Go executables; the builds are not notarized.
Linux bundles include libkrun and libkrunfw and link against the host's glibc,
loader and libgcc_s; musl-only distributions are not supported.

### Prepare the compact templates

`prepare-templates.py` is build-only. It reads the original qualified compressed
templates from the v0.3.0 bundle's `runtime/` directory; their lineage and hashes
are in [template-provenance.json](inputs/template-provenance.json). It does **not**
accept the newer upstream templates or previously compacted outputs as inputs.
Provide an existing parent for a new output directory:

```sh
python3 "$CHECKOUT/scripts/release/prepare-templates.py" \
  --platform darwin-arm64 --input /absolute/path/to/original-qualified/runtime \
  --output "$BUILD_ROOT/templates-darwin-arm64"
```

Repeat for `linux-amd64` with that platform's original templates. The script needs
build-host `zstd` and `e2fsck` on PATH, or explicit `--zstd` / `--e2fsck` executable
paths (for example Homebrew's e2fsprogs `sbin/e2fsck` on macOS). The qualified
tool versions are recorded in the provenance file; final byte hashes remain
authoritative. No tools are installed or added to the host runtime.

The script verifies private input copies against the original hashes, validates
the ext4 superblock and pinned filesystem boundary, reads the entire discarded
tail to check it is zero, and requires `e2fsck -fn` success without changes. It
checks the unchanged filesystem hash and final compressed hashes against both
provenance and the enforced runtime inventory. Both outputs must pass before
publication; existing outputs are refused and source templates are untouched.

Copy the resulting two `.zst` files into a **new build-only runtime-assets staging
directory** alongside the qualified libraries, then supply that directory to
`bundle.py`. Never rewrite an installed bundle or an existing VM's template cache.

### Reuse the retained 1.16.0 inputs

The retained notices belong to the isolated qualification checkout, **not** the
main working checkout. Where the private inputs are still available, this is a
guarded macOS/arm64 reassembly using their matching checkout. Run this block from
the original working checkout, not the new worktree (output must not exist):

```sh
INPUTS=$(cd "$(git rev-parse --show-toplevel)/.work/smolvm-1.16.0-update" && pwd)
CHECKOUT="$INPUTS/clankerbox-candidate"
python3 "$CHECKOUT/scripts/release/bundle.py" \
  --os darwin --arch arm64 --version 0.4.0-smolvm1.16.0-candidate3 --no-archive \
  --engine "$INPUTS/source/target/release/smolvm" \
  --runtime-assets "$INPUTS/runtime-darwin-arm64" --image "$INPUTS/image-darwin-arm64" \
  --engine-source "$INPUTS/source" --dependency-notices "$INPUTS/notices" \
  --output "$INPUTS/reassembled-darwin-arm64"
```

For Linux, use `--os linux --arch amd64`, engine
`$INPUTS/linux-target/x86_64-unknown-linux-gnu/release/smolvm`, the `linux-amd64`
runtime/image directories and a distinct output directory. Do not substitute the
main checkout's `bundle.py`: its unexpanded `go.sum` correctly rejects these
notices. If the matching checkout is unavailable or has changed, use fresh
collection and assembly together as above. Regenerating notices does not waive
runtime, image-agent, source or patch verification.

## Redistribution

Bundles carry Clankerbox's own MIT `LICENSE` at the root, native component
notices in `licenses/`, Go and Rust dependency notices with their inventory,
image package copyright files under
`image/usr/share/doc`, and Node's notices under `image/usr/local`. The shipped
graphics libraries are pinned individually by `runtime-artifacts.json`, which
ships beside `engine-pins.json`; the upstream runtime archive hash in the pins
is provenance only.

- smolvm and libkrun: Apache-2.0. Retain the notices and identify the local
  patch; source commits and the patch hash ship as `engine-pins.json`, a
  copy of `inputs/pins.json`.
- libkrunfw: GPL-2.0-only Linux plus LGPL-2.1-only components. Preserve both
  license texts and provide corresponding source, build configuration and
  patches with any redistribution. Its pinned Makefile selects Linux 6.12.95;
  archive the matching libkrunfw and kernel sources alongside release artifacts
  rather than linking to a moving branch.
- MoltenVK: Apache-2.0. libepoxy and virglrenderer: their MIT-style notices.
  All three ship unmodified from the pinned smolvm runtime distribution.
- Ubuntu and Node packages: retain per-package copyright material and the exact
  package inventory; source obligations follow each component's license.

Upstream: [libkrun](https://github.com/smol-machines/libkrun),
[libkrunfw](https://github.com/smol-machines/libkrunfw),
[MoltenVK](https://github.com/KhronosGroup/MoltenVK),
[libepoxy](https://github.com/anholt/libepoxy),
[virglrenderer](https://gitlab.freedesktop.org/virgl/virglrenderer).

## Signed macOS host

`build-mac-host.py` builds the host with its `org.clankerbox.host` bundle
identity and Local Network purpose string, embeds the versioned Info.plist,
signs with the hardened runtime using an existing Apple signing identity and
verifies the certificate chain. It does not install anything or change keychain
or privacy settings. Bundle hosts stay ad-hoc signed.

```sh
python3 scripts/release/build-mac-host.py --output HOST_BINARY \
  --version VERSION --identity APPLE_SIGNING_IDENTITY
```
