#!/usr/bin/env bash
# Run on the Mac host after pulling the pinned input with stage-mac.sh.
# Copies the existing Apple-signed host Xcode; never modifies the host installation.
set -euo pipefail
home=${1:?usage: finalize-mac.sh OWNED_TART_HOME}
tart=$(command -v "${TART_BIN:-tart}") || {
  printf '%s\n' 'Tart not found; set TART_BIN or add Tart to PATH.' >&2
  exit 1
}
seed='seed-macos26.6.2-xcode26.6'
source=/Applications/Xcode.app
home=$(cd "$home" && pwd -P)
test "$(cat "$home/.clankerbox-inputs")" = clankerbox-mac-inputs-v1
test -d "$home/vms/seed-e0721ddeae3c"
export TART_HOME="$home" TART_NO_AUTO_PRUNE=1
export PATH=/usr/local/libexec/clankerbox:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
test -x "$tart"
test "$("$tart" --version)" = 2.36.0
test "$(DEVELOPER_DIR="$source/Contents/Developer" /usr/bin/xcodebuild -version)" = $'Xcode 26.6\nBuild version 17F113'
/usr/bin/codesign --verify --deep --strict "$source"
test ! -e "$home/vms/$seed"
"$tart" clone seed-e0721ddeae3c "$seed"
"$tart" set "$seed" --cpu 4 --memory 8192 --random-mac --random-serial
"$tart" run "$seed" --no-graphics --no-audio --no-clipboard \
  --net-softnet --net-softnet-allow 'in @host' \
  --net-softnet-block 'out @host,out 0.0.0.0/8,out 10.0.0.0/8,out 100.64.0.0/10,out 127.0.0.0/8,out 169.254.0.0/16,out 172.16.0.0/12,out 192.168.0.0/16' \
  > "$home/$seed.log" 2>&1 &
runtime_pid=$!
# A failure leaves this exact staging VM for inspection, never a ready marker.
ready=false
for _ in {1..90}; do
  if "$tart" exec "$seed" /usr/bin/true >/dev/null 2>&1; then ready=true; break; fi
  sleep 2
done
test "$ready" = true
"$tart" exec "$seed" sudo -n mkdir -p /Applications/Clankerbox-Toolchains
/usr/bin/tar -cf - -C /Applications Xcode.app |
  "$tart" exec -i "$seed" sudo -n /usr/bin/tar -xf - -C /Applications/Clankerbox-Toolchains
"$tart" exec -i "$seed" /bin/bash -se <<'GUEST'
set -eu
new=/Applications/Clankerbox-Toolchains/Xcode.app
sudo -n /usr/bin/codesign --verify --deep --strict "$new"
sudo -n /usr/bin/xcode-select -s "$new/Contents/Developer"
sudo -n /usr/bin/xcodebuild -license accept
sudo -n /usr/bin/xcodebuild -runFirstLaunch
test "$(sw_vers -productVersion)" = 26.6.2
test "$(xcodebuild -version)" = $'Xcode 26.6\nBuild version 17F113'
printf 'print("CLANKERBOX_SWIFT_OK")\n' > /tmp/clankerbox-image.swift
xcrun swiftc /tmp/clankerbox-image.swift -o /tmp/clankerbox-image-check
test "$(/tmp/clankerbox-image-check)" = CLANKERBOX_SWIFT_OK
rm /tmp/clankerbox-image.swift /tmp/clankerbox-image-check
test ! -e /etc/clankerbox
# Use public resolvers inside the seed VM so the download below does not depend
# on the host's DHCP configuration. Override with IMAGE_DNS_SERVERS.
sudo -n /usr/sbin/networksetup -setdnsservers Ethernet ${IMAGE_DNS_SERVERS:-1.1.1.1 8.8.8.8}
# Pin the upstream toolchain rather than the older Homebrew Node in the base.
node_archive=/tmp/node-v26.8.1-darwin-arm64.tar.gz
curl -fL --connect-timeout 15 --max-time 180 --retry 3 https://nodejs.org/dist/v26.8.1/node-v26.8.1-darwin-arm64.tar.gz -o "$node_archive"
printf '%s  %s\n' 6e577fd0d9db776db82306629e441a9dace416702622aebdd171c9dfaa41f4d2 "$node_archive" | shasum -a 256 -c -
sudo -n mkdir -p /usr/local
sudo -n tar -xzf "$node_archive" --strip-components=1 -C /usr/local
rm "$node_archive"
export PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
test "$(node --version)" = v26.8.1
test "$(python3 --version)" = 'Python 3.14.7'
sync
GUEST
"$tart" exec "$seed" /bin/bash -c 'export PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin; sw_vers; xcodebuild -version; xcrun swift --version; node --version; npm --version; python3 --version' > "$home/$seed.versions.txt"
"$tart" exec "$seed" sudo -n /sbin/shutdown -h now || true
wait "$runtime_pid"
printf '%s\n' 'macOS 26.6.2; Xcode 26.6 17F113; Swift compile/run passed; Node 26.8.1; Python 3.14.7' > "$home/$seed.ready"
