# Release inputs

- `pins.json`: the smolvm, libkrun and libkrunfw source commits, the toolchain
  versions used to build them, the upstream macOS runtime release URL and
  archive hash, and SHA256 hashes of the engine, agent and `runtime.patch`.
  Assembly enforces the engine, agent and patch hashes; the archive, library,
  sentinel and Cargo lock hashes are provenance only.
- `runtime-artifacts.json`: the complete shipped library tree and both
  compressed disk templates for each platform, with entry types and the SHA256
  of file bytes or symlink targets. Assembly rejects missing or extra entries,
  changed content, setuid/setgid bits and special files. Ordinary permission
  modes are recorded by the installed manifest instead.
- `runtime.patch`: the local patch applied to the pinned engine source.
- `linux-amd64-image-sources.json`: SHA256 pins for the amd64 static agent and
  the pristine Ubuntu and Node archives. Assembly checks the agent; image
  staging checks the archives.
- `source.json`: the expected engine source `LICENSE` and `Cargo.lock` digests.
- `HostInfo.plist`: the Info.plist template for the signed macOS host.

The runtime inventories were taken from the qualified v0.3.0 release archives,
verified against their published SHA256 files and GitHub asset digests, and
checked against each archive's `bundle.json`. Their provenance fields record the
archive URL and hash and the manifest hash; assembly enforces only the `files`
lists. Update them only from a separately qualified release: hashing whatever
is in a proposed `--runtime-assets` directory does not establish qualification.
