#!/usr/bin/env bash
# Run as the unprivileged Linux runtime account; sudo only extracts the new image.
# Usage: bash images/stage-linux.sh NEW_ROOTFS [--resume-downloads]
# Then: sudo bash images/install-linux-tools.sh NEW_ROOTFS
# Finalization: install the matching smolvm-agent PID1 and its support files from
# an explicitly selected, verified agent rootfs. No agent/runtime is bundled here.
set -euo pipefail
rootfs=${1:?usage: stage-linux.sh NEW_ROOTFS}
test "$#" -le 2
resume=${2:-}
test -z "$resume" || test "$resume" = --resume-downloads
test "$(id -u)" = 1000
test "$(uname -m)" = x86_64
# Restrict this recipe to new, direct children of the image profiles directory.
profiles=/home/clanker/clankerbox/profiles
test "$(dirname -- "$rootfs")" = "$profiles"
test "$(realpath -m -- "$rootfs")" = "$rootfs"
test "$rootfs" != "$profiles/ubuntu-dev-v1"
umask 022
metadata="$rootfs/.clankerbox-image"
if test "$resume" = --resume-downloads; then
  test -d "$rootfs" && test ! -L "$rootfs" && test ! -L "$metadata"
  test "$(stat -c %u "$rootfs")" = "$(id -u)"
  test "$(cat "$metadata/state")" = clankerbox-ubuntu-26.04.1-pending
  # Resume only pre-extraction downloads, never overwrite an extracted image.
  test -z "$(find "$rootfs" -mindepth 1 -maxdepth 1 ! -name .clankerbox-image -print -quit)"
else
  test ! -e "$rootfs" && test ! -L "$rootfs"
  mkdir -- "$rootfs"
  mkdir -- "$metadata"
  printf '%s\n' clankerbox-ubuntu-26.04.1-pending > "$metadata/state"
  printf '%s\n' "$(id -u):$(id -g)" > "$metadata/owner"
fi
fetch() {
  # A supplied cache file is still subject to metadata/pinned archive validation.
  # Download to .part so an interrupted transfer is never considered complete.
  test ! -L "$2"
  if test ! -s "$2"; then
    curl -4 --fail --location --retry 3 --connect-timeout 15 --max-time 600 "$1" -o "$2.part"
    mv -- "$2.part" "$2"
  fi
}
ubuntu_url=https://cdimage.ubuntu.com/ubuntu-base/releases/26.04.1/release
ubuntu_archive=ubuntu-base-26.04.1-base-amd64.tar.gz
ubuntu_sha256=a496a960472ce474a59590b8987d3a1135d3cbef1991f3b1abe8cacfea8bf85a
node_version=v26.8.1
node_archive=node-v26.8.1-linux-x64.tar.xz
node_sha256=3e301118d7df53d563b7e96c1617545f26e2f76f9724be668d6cab65c15dda5d
fetch "$ubuntu_url/SHA256SUMS" "$metadata/ubuntu-SHA256SUMS"
fetch https://nodejs.org/dist/index.json "$metadata/node-index.json"
fetch "https://nodejs.org/dist/$node_version/SHASUMS256.txt" "$metadata/node-SHASUMS256.txt"
python3 - "$metadata" "$ubuntu_archive" "$ubuntu_sha256" "$node_archive" "$node_sha256" <<'PY'
import json, pathlib, re, sys
p = pathlib.Path(sys.argv[1])
for sums, name, digest in [('ubuntu-SHA256SUMS', *sys.argv[2:4]),
                           ('node-SHASUMS256.txt', *sys.argv[4:6])]:
    entries = {line.split()[1].lstrip('*'): line.split()[0]
               for line in (p / sums).read_text().splitlines() if line.strip()}
    if entries.get(name) != digest:
        raise SystemExit('official checksum differs from pin: ' + name)
releases = [r for r in json.loads((p / 'node-index.json').read_text())
            if re.fullmatch(r'v\d+\.\d+\.\d+', r['version']) and 'linux-x64' in r['files']]
latest = max(releases, key=lambda r: tuple(map(int, r['version'][1:].split('.'))))
(p / 'latest-node-at-build.json').write_text(json.dumps(latest, indent=2) + '\n')
print('Latest stable Node at build:', latest['version'], '(recipe pins v26.8.1)')
PY
fetch "$ubuntu_url/$ubuntu_archive" "$metadata/$ubuntu_archive"
fetch "https://nodejs.org/dist/$node_version/$node_archive" "$metadata/$node_archive"
printf '%s  %s\n%s  %s\n' "$ubuntu_sha256" "$ubuntu_archive" "$node_sha256" "$node_archive" > "$metadata/archives.sha256"
(cd "$metadata" && sha256sum --check archives.sha256)
printf 'ubuntu_url=%s/%s\nubuntu_sha256=%s\nnode_url=https://nodejs.org/dist/%s/%s\nnode_sha256=%s\n' \
  "$ubuntu_url" "$ubuntu_archive" "$ubuntu_sha256" "$node_version" "$node_archive" "$node_sha256" > "$metadata/sources.txt"
# These are verified official archives, extracted only beneath this new rootfs.
sudo -n tar --extract --gzip --file "$metadata/$ubuntu_archive" --directory "$rootfs" --numeric-owner
sudo -n mkdir -p "$rootfs/usr/local"
sudo -n tar --extract --xz --file "$metadata/$node_archive" --directory "$rootfs/usr/local" --strip-components=1 --no-same-owner
printf '%s\n' 'Staged verified Ubuntu Base 26.04.1 and Node v26.8.1.' \
  "Next: sudo bash images/install-linux-tools.sh $rootfs" \
  'Parent must finalize with the matching smolvm-agent PID1 and support files.'
