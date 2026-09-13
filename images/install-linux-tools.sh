#!/bin/sh
# Run only INSIDE a newly created disposable Linux image build VM.
set -eu
[ "$(id -u)" = 0 ]
[ -f /.clankerbox-image/sources.json ]
[ ! -e /etc/clankerbox/owner ]
# Copy package-locks alongside this script, or pass its absolute directory.
lock_root=${1:-$(dirname "$0")/package-locks}
arch=$(dpkg --print-architecture)
case "$arch" in arm64|amd64) ;; *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; esac
lock="$lock_root/$arch"
node - "$lock_root" "$arch" <<'JS'
const fs = require("node:fs");
const crypto = require("node:crypto");
const [root, arch] = process.argv.slice(2);
const metadata = JSON.parse(fs.readFileSync(`${root}/sources.json`));
const source = JSON.parse(fs.readFileSync("/.clankerbox-image/sources.json"));
const pin = metadata.architectures[arch];
if (metadata.format !== 1 || source.arch !== arch || source.ubuntu !== pin.ubuntu || source.archives.ubuntu !== pin.ubuntu_sha256) {
  throw new Error("Image base does not match the qualified package lock");
}
for (const name of ["base.tsv", "packages.tsv", "install.tsv", "automatic.txt"]) {
  const digest = crypto.createHash("sha256").update(fs.readFileSync(`${root}/${arch}/${name}`)).digest("hex");
  if (digest !== pin.files[name]) throw new Error(`Package lock hash mismatch: ${name}`);
}
JS
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
inventory() {
  dpkg-query -W -f='${binary:Package}\t${Version}\t${Architecture}\n' | LC_ALL=C sort
}
inventory > "$work/before.tsv"
# Refuse a partially provisioned or different base before touching apt state.
cmp "$lock/base.tsv" "$work/before.tsv"
mkdir "$work/preferences.d"
# Specific package pins take precedence over the catch-all rejection below.
awk -F '\t' '{printf "Package: %s\nPin: version %s\nPin-Priority: 1001\n\n", $1, $2}' "$lock/packages.tsv" > "$work/preferences"
printf 'Package: *\nPin: version *\nPin-Priority: -1\n' >> "$work/preferences"
export DEBIAN_FRONTEND=noninteractive
apt-get -o Acquire::Retries=3 update
set --
while IFS="$(printf '\t')" read -r package version architecture; do
  set -- "$@" "$package=$version"
done < "$lock/install.tsv"
apt-get -o Acquire::Retries=3 \
  -o "Dir::Etc::preferences=$work/preferences" \
  -o "Dir::Etc::preferencesparts=$work/preferences.d" \
  install -y --no-remove --no-install-recommends "$@"
# Explicit transitive constraints must not turn dependencies into manual roots.
set --
while IFS= read -r package; do set -- "$@" "$package"; done < "$lock/automatic.txt"
[ "$#" -eq 0 ] || apt-mark auto "$@"
inventory > "$work/after.tsv"
LC_ALL=C sort "$lock/packages.tsv" > "$work/expected.tsv"
cmp "$work/expected.tsv" "$work/after.tsv"
apt-get clean
cp "$lock/packages.tsv" /.clankerbox-image/packages.tsv
node --version > /.clankerbox-image/tool-versions.txt
npm --version >> /.clankerbox-image/tool-versions.txt
git --version >> /.clankerbox-image/tool-versions.txt
python3 --version >> /.clankerbox-image/tool-versions.txt
# Disable login accounts; the root service drops to a separately provisioned
# workload UID.
passwd -l root
rm -f /etc/machine-id
: > /etc/machine-id
sync
