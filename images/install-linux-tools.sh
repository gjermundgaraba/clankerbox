#!/usr/bin/env bash
# Build only a rootfs freshly created by stage-linux.sh. Never boot it here.
# Usage: sudo bash images/install-linux-tools.sh NEW_ROOTFS
set -euo pipefail
rootfs=${1:?usage: install-linux-tools.sh NEW_ROOTFS}
test "$#" = 1
test "$(id -u)" = 0
profiles=/home/clanker/clankerbox/profiles
test "$(dirname -- "$rootfs")" = "$profiles"
test "$(realpath -e -- "$rootfs")" = "$rootfs"
test "$rootfs" != "$profiles/ubuntu-dev-v1"
test ! -L "$rootfs"
metadata="$rootfs/.clankerbox-image"
test ! -L "$metadata"
test "$(cat "$metadata/state")" = clankerbox-ubuntu-26.04.1-pending
owner=$(cat "$metadata/owner")
test "$owner" = 1000:1000
test -x "$rootfs/usr/bin/apt-get"
# Refuse pre-existing mounts, even on a resumed failed build.
if findmnt -rn -o TARGET | awk -v r="$rootfs" '$0 == r || index($0, r "/") == 1 {found=1} END {exit !found}'; then
  printf 'Refusing mounted rootfs: %s\n' "$rootfs" >&2
  exit 1
fi
exec > >(tee -a "$metadata/build.log") 2>&1
# EXIT cleanup also runs after package failure. No host filesystem is mounted.
devices=()
cleanup() {
  rc=$?
  trap - EXIT
  rm -f "$rootfs/usr/sbin/policy-rc.d"
  for device in "${devices[@]}"; do rm -f "$rootfs/dev/$device"; done
  find "$rootfs/etc/ssh" -maxdepth 1 -type f -name 'ssh_host_*' -delete
  rm -f "$rootfs/etc/resolv.conf"
  printf 'nameserver 100.96.0.1\n' > "$rootfs/etc/resolv.conf"
  chown -hR "$owner" "$rootfs"
  exit "$rc"
}
test ! -e "$rootfs/usr/sbin/policy-rc.d" && test ! -L "$rootfs/usr/sbin/policy-rc.d"
trap cleanup EXIT
printf '#!/bin/sh\nexit 101\n' > "$rootfs/usr/sbin/policy-rc.d"
chmod 0755 "$rootfs/usr/sbin/policy-rc.d"
# A failed attempt is returned to UID 1000 by cleanup; restore build ownership.
chown -hR 0:0 "$rootfs"
chmod 1777 "$rootfs/tmp"
mkdir -p "$rootfs/dev" "$rootfs/root/workspace" "$rootfs/run/sshd" "$rootfs/etc/ssh"
for spec in 'null 1 3' 'zero 1 5' 'random 1 8' 'urandom 1 9'; do
  read -r device major minor <<< "$spec"
  test ! -e "$rootfs/dev/$device" && test ! -L "$rootfs/dev/$device"
  devices+=("$device")
  mknod -m 0666 "$rootfs/dev/$device" c "$major" "$minor"
done
rm -f "$rootfs/etc/resolv.conf"
printf 'nameserver 185.12.64.1\n' > "$rootfs/etc/resolv.conf"
# Check the extracted release before running any package scripts.
# shellcheck disable=SC2016 # Expand release variables inside the guest.
chroot "$rootfs" /bin/sh -c '. /etc/os-release; test "$ID" = ubuntu; test "$VERSION_ID" = 26.04'
run_guest() {
  chroot "$rootfs" /usr/bin/env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    DEBIAN_FRONTEND=noninteractive "$@"
}
apt_options=(-o Acquire::ForceIPv4=true -o Acquire::http::Timeout=30 -o Acquire::Retries=3 -o Dpkg::Use-Pty=0 -o APT::Get::Always-Include-Phased-Updates=true)
run_guest /usr/bin/apt-get "${apt_options[@]}" update
# Satisfy SSH user/tmpfiles dependencies without selecting systemd as init.
packages=(git curl openssh-server python3 lsof iproute2 tmux build-essential ca-certificates
  systemd-standalone-sysusers systemd-standalone-tmpfiles)
run_guest /usr/bin/apt-get "${apt_options[@]}" install -y --no-install-recommends "${packages[@]}"
run_guest /usr/bin/apt-get "${apt_options[@]}" full-upgrade -y --no-install-recommends
run_guest /usr/sbin/usermod --home /root root
run_guest /usr/bin/dpkg --audit > "$metadata/dpkg-audit.txt"
test ! -s "$metadata/dpkg-audit.txt"
# shellcheck disable=SC2016 # dpkg-query owns the format variable.
if run_guest /usr/bin/dpkg-query -W -f='${db:Status-Status}' systemd 2>/dev/null | /bin/grep -qx installed; then
  printf 'Unexpected systemd init package installed\n' >&2
  exit 1
fi
# shellcheck disable=SC2016 # dpkg-query owns these format variables.
run_guest /usr/bin/dpkg-query -W -f='${binary:Package}\t${Version}\t${Architecture}\t${db:Status-Status}\n' > "$metadata/packages.tsv"
run_guest /usr/bin/apt-cache policy "${packages[@]}" > "$metadata/package-candidates.txt"
run_guest /usr/bin/apt-get "${apt_options[@]}" --simulate full-upgrade > "$metadata/remaining-upgrades.txt"
{
  run_guest /usr/local/bin/node --version
  run_guest /usr/local/bin/npm --version
  run_guest /usr/bin/python3 --version
  run_guest /usr/bin/git --version
  run_guest /usr/bin/curl --version
  run_guest /usr/sbin/sshd -V
  run_guest /usr/bin/tmux -V
  run_guest /usr/bin/gcc --version
} > "$metadata/tool-versions.txt" 2>&1
test "$(run_guest /usr/local/bin/node --version)" = v26.8.1
test "$(run_guest /usr/local/bin/npm --version)" = 11.19.0
run_guest /usr/bin/apt-get clean
# Preserve inventory and source pins; archives need not occupy the guest disk.
rm -f "$metadata/ubuntu-base-26.04.1-base-amd64.tar.gz" "$metadata/node-v26.8.1-linux-x64.tar.xz"
# Fresh machine identities are supplied/generated in the guest, never reused.
: > "$rootfs/etc/machine-id"
rm -f "$rootfs/var/lib/dbus/machine-id" "$rootfs/var/lib/systemd/random-seed"
cat > "$metadata/FINALIZATION.txt" <<'FINAL'
Package preparation complete; NOT a boot-ready profile.
Parent must install verified smolvm-agent matching runtime 1.14.1 as PID1,
plus required libraries/support files, from its explicitly selected agent source.
Do not install the old recovery-spike agent or boot systemd as PID1.
Guest root home is /root; workspace is /root/workspace. Runtime supplies /dev and guest DNS
relay 100.96.0.1. Bootstrap must restore root ownership of sshd directories,
generate fresh SSH host keys, and supply per-guest authorized access as needed.
After finalization, keep image files copyable by runtime UID/GID 1000:1000.
Distro packages use current signed 26.04 repositories; packages.tsv records
this build exactly. Rebuilding later may pick up newer distro updates.
FINAL
printf '%s\n' clankerbox-ubuntu-26.04.1-awaiting-agent > "$metadata/state"
printf 'Image packages prepared: %s (parent agent finalization required)\n' "$rootfs"
