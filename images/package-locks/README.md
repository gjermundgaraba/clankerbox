# Linux package locks

These locks freeze the apt package resolution of the qualified guest images.
Node and the Ubuntu Base archives are pinned separately by `../stage-linux.py`.

For each architecture:

- `base.tsv`: the package inventory of the pristine Ubuntu Base archive, from
  its `var/lib/dpkg/status`.
- `packages.tsv`: the inventory exported from the qualified image as
  `.clankerbox-image/packages.tsv`, checked against its installed dpkg status.
- `install.tsv`: additions and upgrades relative to the base, with exact
  versions for the requested tools and their transitive dependencies.
- `automatic.txt`: the apt automatic-dependency flags, so explicit version
  arguments do not mark every package manual.
- `sources.json`: the base archive digest and the SHA256 of every lock file.

The requested tools are git, curl, python3, tmux, build-essential and
ca-certificates.

## Rebuilding

Stage the architecture's Ubuntu and Node archives with `../stage-linux.py`, boot
a disposable image builder, and copy `../install-linux-tools.sh` together with
this directory into it:

```sh
sh /build/install-linux-tools.sh /build/package-locks
```

The recipe checks the base archive identity and the complete pristine inventory
before running apt. It pins the final inventory with apt preferences, installs
only the locked delta, refuses removals and compares the installed inventory
afterwards. Mirror configuration comes from the pinned base with apt
authentication enabled. If a mirror no longer serves a locked version the build
fails; there is no fallback to a newer version. Updating the locks means a new
dependency review, image build, exported inventory and qualification, which
produces a new image content identity.

## Verification

```sh
python3 images/verify-package-locks.py
python3 images/verify-package-locks.py \
  --image arm64=/path/to/arm64-export \
  --image amd64=/path/to/amd64-export
sh -n images/install-linux-tools.sh
```

The optional image checks compare the exported inventory bytes, installed dpkg
state, source provenance and apt automatic flags against the locks. They never
boot, modify or rebuild an image.
