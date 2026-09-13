# Generic Linux amd64 image qualification

Built from `images/stage-linux.py` and `images/install-linux-tools.sh`, using the
same Ubuntu Base 26.04.1 / Node 26.8.2 recipe as the arm64 image. The static agent
SHA256 is recorded in `validation.json` and matches the qualified engine source.
The apt-resolved package inventory describes this specific build, not a promise
that a mutable upstream package repository reproduces identical bytes later.

The disposable builder used root `/home/clanker/cbi.WQiqZj` on the operator Linux
host. Engine HOME/XDG paths were all isolated there. Native bare-rootfs create
used 2 CPUs, 2048 MiB, virtio-net and DNS 185.12.64.1, with only its recipe and
export directories mounted. A dedicated user systemd oneshot owned the detached
VMM with MemoryMax=3G and CPUQuota=200%.

Installation and tool checks completed inside the real VM. No managed sshd,
authorized keys, host credentials or account directories were imported. Export
used `tar --one-file-system --numeric-owner --owner=0 --group=0`, excluding
oldroot, storage, proc, sys, dev, run, tmp, mnt, export, recipe and .smolvm.
The oldroot mount is especially important: traversing it would include the
lower filesystem and the live overlay backing tree again.

Final export:
`/home/clanker/cbi.WQiqZj/export/linux-dev-v3-amd64.tar`
SHA256 `b4241e4dba6501787cb2361cdfebb37fb39c29d038130d2a52a06b18ceca6e81`.
All 21,304 tar entries have UID/GID zero, with no special nodes or excluded mount
trees. Safe unprivileged extraction normalizes absolute guest symlinks and
recreates the engine's empty mountpoint directories. At runtime, workload UID
selection must differ from the host owner of these extracted files.

The builder VM was gracefully stopped, natively deleted, and its exact systemd
unit stopped/disabled. `final-inventory.json` is the empty isolated engine
inventory. Export, source inputs and build evidence remain; production resources
were untouched. Full command scripts/logs are in `.work/real-local-engine/linux-image`.
