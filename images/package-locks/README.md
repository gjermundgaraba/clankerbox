# Qualified Linux package resolution

These locks freeze the package resolution already installed and qualified on
2026-09-12. They do not change the exported arm64 or amd64 image, its content
identity, or its qualification evidence. Node 26.8.2 and the Ubuntu Base 26.04.1
archives remain independently SHA-256 pinned by `../stage-linux.py`.

For each architecture:

- `base.tsv` records the complete installed package inventory from the original,
  SHA-256-verified Ubuntu Base archive's `var/lib/dpkg/status`.
- `packages.tsv` is the exact `.clankerbox-image/packages.tsv` exported from the
  qualified image, checked against its actual installed dpkg status.
- `install.tsv` contains only additions and upgrades relative to the base. All
  top-level tools and their added or upgraded transitive dependencies have exact
  versions. There are seven upgraded base packages on each architecture.
- `automatic.txt` preserves the qualified apt automatic dependency flags; explicit
  dependency version arguments must not accidentally make every package manual.
- `sources.json` binds the base archive digest and SHA-256 of every lock file.

Both bases contain 87 installed packages. The qualified final inventories contain
188 arm64 packages and 189 amd64 packages; the installation deltas contain 108
and 109 packages respectively. The six requested tools are git, curl, python3,
tmux, build-essential, and ca-certificates.

## Rebuilding

Stage the architecture's verified original Ubuntu and Node archives using
`../stage-linux.py`, then boot a new disposable image builder. Copy
`../install-linux-tools.sh` and this entire `package-locks` directory into the
builder, retaining their relative layout, or pass the lock directory explicitly:

```sh
sh /build/install-linux-tools.sh /build/package-locks
```

The recipe checks the source archive identity and complete pristine base
inventory before running apt. It constrains the complete final inventory with
apt preferences, rejects every other package version, and installs only the
exact added/upgraded package delta. It refuses removals and compares the complete
installed inventory afterward. The architecture's ordinary Ubuntu archive and
security mirror configuration comes from the pinned base; apt authentication
remains enabled. If a mirror no longer serves a locked version, the build fails.
There is no automatic fallback to a newer version. An archive retaining those
exact signed packages may be configured explicitly by a future build operator.

This is a frozen, qualified version set, not a claim that the packages remain
latest forever. Updating it requires an explicit new dependency review, image
build, exported inventory, and qualification with a new image content identity.
Package versions and source archive checks do not promise byte-identical apt
logs, timestamps, or filesystem output from a rebuild. Release consumers use
the already qualified immutable image payload and its bundle digest.

## Read-only verification

```sh
python3 images/verify-package-locks.py
python3 images/verify-package-locks.py \
  --image arm64=/path/to/qualified-arm64-export \
  --image amd64=/path/to/qualified-amd64-export
sh -n images/install-linux-tools.sh
```

The optional image checks compare exact exported inventory bytes, actual dpkg
installed state, source provenance, and apt automatic flags. They never boot,
modify, or rebuild an image. These checks passed against both release exports
when the locks were introduced. The apt installation itself was not rerun: the
qualified image bytes were deliberately retained.
