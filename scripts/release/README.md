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
5. Generate Cargo metadata from the pinned engine source
   (`cargo metadata --locked --format-version 1 --manifest-path
   ENGINE_SOURCE/Cargo.toml`) and collect notices:

   ```sh
   python3 scripts/release/notices.py --engine-source ENGINE_SOURCE \
     --rust-metadata CARGO_METADATA_JSON --output NOTICES_DIRECTORY
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
   python3 scripts/release/bundle.py --os darwin --arch arm64 --version VERSION \
     --engine PATCHED_ENGINE --runtime-assets RUNTIME_DIRECTORY \
     --image NORMALIZED_ARM64_IMAGE --engine-source ENGINE_SOURCE \
     --dependency-notices NOTICES_DIRECTORY --output OUTPUT_DIRECTORY
   ```

Repeat for `--os linux --arch amd64`. `--no-archive` produces a local
qualification candidate without the archive and checksum. On macOS the
assembler preserves and verifies the engine's signature and virtualization
entitlements and ad-hoc signs the Go executables; the builds are not notarized.
Linux bundles include libkrun and libkrunfw and link against the host's glibc,
loader and libgcc_s; musl-only distributions are not supported.

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
