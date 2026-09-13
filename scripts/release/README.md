# Installed release bundles

`bundle.py` assembles the qualified macOS/arm64 and Linux/amd64 releases. Each
archive contains `clankerbox` beside `bundle.json`, ordinary controller/host/guest
binaries, the patched smolvm engine, matching runtime libraries and Linux agent,
compressed disk templates, and a generic Linux image. Extraction and `clankerbox
dev` require no Go or Rust toolchain. Private GitHub release assets require the
operator's normal repository access; no unauthenticated private URL is embedded.

Manifest format 2 enumerates every payload file, directory, and relative symlink,
including POSIX permission modes and file/link SHA256. Startup rejects missing,
extra, changed-type, or changed-mode entries before creating a VM.
`runtime_digest` and `image_digest` use sorted relative content inventories, so
installation paths and workstation accounts do not change checkpoint identity.
Modes and directory metadata, including each component root, do affect identity.
Extract under a private parent with `tar -xzpf` to preserve guest permissions;
restrictive host umasks must not silently remove guest traversal or execute bits.
The host expands disk templates in its private runtime cache. It never writes
into the installed bundle. Archive SHA256 must be checked before extraction.

## Build inputs

1. Build the exact engine and static guest agent from
   [the engine pins](../../spikes/real-local-engine/pins.json) and
   [qualified patch](../../spikes/real-local-engine/runtime.patch). Preserve the
   upstream runtime archive and source/build provenance. Replacing the engine
   with a newer unqualified upstream binary is not a dependency update.
2. Download the Ubuntu Base 26.04.1 and Node 26.8.2 archives for each architecture.
   `images/stage-linux.py` checks their exact SHA256 pins and the supplied static
   agent hash before creating a new image directory. It normalizes absolute
   guest symlinks into relative links within the image, strips setuid/setgid,
   and never creates host users or device nodes.
3. Boot that directory as `SMOLVM_AGENT_ROOTFS` in an explicitly isolated,
   disposable native VM (no `--image` OCI container). Mount a recipe directory
   read-only and an empty export directory. Run `images/install-linux-tools.sh`
   inside the guest through trusted native exec. Copy the adjacent `images/package-locks` directory too. The recipe verifies
   the pristine base, pins the complete apt dependency closure, and checks the
   qualified final package inventory. It records tool versions, locks root login, and leaves workload-user creation to trusted
   per-machine bootstrap. It installs no guest SSH server.
4. Export the merged guest filesystem with `tar --one-file-system`, excluding
   `proc`, `sys`, `dev`, `run`, `tmp`, `mnt`, `oldroot`, `storage`, `export`,
   `recipe`, and `.smolvm`. Stop/delete only that exact disposable builder. Use
   the staging script's safe extractor to normalize export symlinks; recreate
   empty runtime mount directories and mode-1777 `tmp`.
5. Collect notices from locked dependency sources with `notices.py`, then build:

```sh
python3 scripts/release/bundle.py --os darwin --arch arm64 --version VERSION \
  --engine PATCHED_ENGINE --runtime-assets VERIFIED_RUNTIME_DIRECTORY \
  --image NORMALIZED_ARM64_IMAGE --output NEW_OUTPUT_DIRECTORY
```

Repeat for `--os linux --arch amd64`. `--no-archive` creates a local qualification
candidate; release artifacts always include the compressed archive and checksum.
The assembler cross-compiles Go binaries. It preserves and verifies the engine's
macOS signature/virtualization entitlements and ad-hoc signs Go executables.
These builds are not Developer ID notarized; do not describe them as notarized.
Host qualification used macOS 26.6.2 and Ubuntu 26.04.1 amd64 with glibc 2.43.
Linux bundles include the qualified libkrun/libkrunfw, while the host supplies
the GNU loader, libc/libm and libgcc_s. Qualification does not establish support
for musl-only distributions or older host releases.

## Redistribution inventory

The release carries native component notices in `licenses/`, locked Go/Rust
source notices and dependency inventory, and image package copyright files under
`image/usr/share/doc`. Node's distribution notices remain in `image/usr/local`.
The exact upstream runtime archive hash pins the shipped graphics libraries.

- smolvm and libkrun: Apache-2.0; retain licenses/notices and identify the included
  local patch. Source commits and patch hash are in `engine-pins.json`.
- libkrunfw includes GPL-2.0-only Linux and LGPL-2.1-only components. Preserve both
  license texts and provide corresponding source, build configuration, and
  patches with redistributions. Its pinned Makefile selects Linux 6.12.95;
  archive the matching libkrunfw repository and upstream kernel source alongside
  release artifacts. Do not replace this with a link to a moving default branch.
- MoltenVK: Apache-2.0; libepoxy and virglrenderer: their included MIT-style
  notices, including component copyright notices. They are shipped unmodified
  from the pinned smolvm runtime distribution.
- Ubuntu and Node contain multiple licenses. Retain per-package copyright and
  license material and the exact package/source inventory; source redistribution
  requirements follow those component licenses.

Authoritative sources: [libkrun](https://github.com/smol-machines/libkrun),
[libkrunfw](https://github.com/smol-machines/libkrunfw),
[MoltenVK](https://github.com/KhronosGroup/MoltenVK),
[libepoxy](https://github.com/anholt/libepoxy), and
[virglrenderer](https://gitlab.freedesktop.org/virgl/virglrenderer).
