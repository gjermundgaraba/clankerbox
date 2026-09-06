#!/bin/sh
# Scoped Linux root operation: only under the coordinator's storage execution slot.
set -eu
test "${CLANKER_HOST_SLOT:-}" = storage
test "$(id -u)" = 0
script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
command -v mkfs.xfs >/dev/null
command -v mountpoint >/dev/null
command -v findmnt >/dev/null
test "$(findmnt -n -o FSTYPE -T /home/clanker)" = ext4
base=$(mktemp -d /home/clanker/clankerbox-storage.XXXXXX)
case "$base" in /home/clanker/clankerbox-storage.??????) ;; *) exit 1;; esac
printf 'Owned evidence directory: %s\n' "$base"
mkdir "$base/xfs"
cleanup() {
    if mountpoint -q "$base/xfs"; then
        if ! umount -- "$base/xfs"; then
            printf 'Unmount failed; image retained at %s/xfs.img\n' "$base" >&2
            return 1
        fi
    fi
    if test -f "$base/xfs.img"; then rm -- "$base/xfs.img"; fi
    rmdir -- "$base/xfs"
}
trap cleanup EXIT
python3 "$script_dir/storage.py" --directory "$base" --mode copy > "$base/ext4.json"
# This path was just created in a private root-owned mktemp directory, never a device.
truncate -s 4G "$base/xfs.img"
test -f "$base/xfs.img"
test ! -L "$base/xfs.img"
mkfs.xfs -q -f -m reflink=1 "$base/xfs.img"
mount -o loop,nodev,nosuid,noexec "$base/xfs.img" "$base/xfs"
test "$(findmnt -n -o FSTYPE -T "$base/xfs")" = xfs
python3 "$script_dir/storage.py" --directory "$base/xfs" --mode reflink > "$base/xfs.json"
printf 'PASS: ext4 copy and XFS reflink reports retained in %s\n' "$base"
