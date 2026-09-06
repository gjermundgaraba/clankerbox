#!/usr/bin/env bash
# Run as clanker after install-linux-tools.sh and the matching runtime build.
set -euo pipefail
rootfs=${1:?usage: finalize-linux.sh NEW_ROOTFS}
runtime=/home/clanker/clankerbox/versions/1.14.1
test "$#" = 1 && test "$(id -u)" = 1000
test "$(dirname -- "$rootfs")" = /home/clanker/clankerbox/profiles
test "$(realpath -e -- "$rootfs")" = "$rootfs"
metadata="$rootfs/.clankerbox-image"
test "$(cat "$metadata/state")" = clankerbox-ubuntu-26.04.1-awaiting-agent
test "$(awk -F: '$1 == "root" {print $6}' "$rootfs/etc/passwd")" = /root
test ! -e "$rootfs/sbin/init" && test ! -L "$rootfs/sbin/init"
agent="$runtime/guest-support/usr/local/bin/smolvm-agent"
printf '%s  %s\n' c232121105422b88640b09802a9fca0601caf136d38f04f9b3f0e5d6c3bec0ca "$agent" | sha256sum -c -
install -d -m0755 "$rootfs/usr/local/bin" "$rootfs/sbin" \
  "$rootfs/mnt/overlay" "$rootfs/mnt/storage" "$rootfs/mnt/newroot" \
  "$rootfs/mnt/rosetta" "$rootfs/run/smolvm/virtiofs" "$rootfs/storage" \
  "$rootfs/workspace" "$rootfs/proc" "$rootfs/sys" "$rootfs/dev/pts"
install -m0755 "$agent" "$rootfs/usr/local/bin/smolvm-agent"
ln -s /usr/local/bin/smolvm-agent "$rootfs/sbin/init"
chmod 1777 "$rootfs/tmp"
cp "$runtime/source-pins.json" "$metadata/runtime-source-pins.json"
printf '%s\n' clankerbox-ubuntu-26.04.1-smolvm-1.14.1 > "$metadata/state"
# Separate final manifests preserve the pre-finalization package-build evidence.
(
  cd "$rootfs"
  find . -path ./.clankerbox-image -prune -o -type f -print0 |
    sort -z | xargs -0 sha256sum > "$metadata/final-files.sha256"
  find . -path ./.clankerbox-image -prune -o -printf '%y %m %U:%G %p -> %l\n' |
    sort > "$metadata/final-layout.txt"
  sha256sum -c "$metadata/final-files.sha256" > /dev/null
)
printf '%s\n' 'Finalized bare Ubuntu profile; live acceptance is still required.'
