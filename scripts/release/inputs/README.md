# Release inputs

- `pins.json`: the smolvm, libkrun and libkrunfw source commits, the toolchain
  versions used to build them, the upstream macOS runtime release URL and
  archive hash, and SHA256 hashes of the engine, agent and `runtime.patch`.
  Assembly enforces the engine, agent and patch hashes; the archive, library and
  Cargo lock hashes are provenance only.
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

The runtime inventories were taken from qualified release bundles and checked
against each bundle's `bundle.json`. Assembly enforces the `files` lists. Update
them only from a separately qualified build: hashing whatever is in a proposed
`--runtime-assets` directory does not establish qualification.

The current [smolvm 1.16.0 qualification record](smolvm-1.16.0-qualification.md)
records the release-matched library pair, build/test evidence and compact disk
templates. `template-provenance.json` records the verified zero-padding removal;
it is build provenance, while `runtime-artifacts.json` remains the enforced
artifact authority. The compact 512 MiB templates avoid a host `resize2fs`
dependency for supported profile sizes. Do not restore upstream's padded
10/20 GiB files or relabel old checkpoint identities.
