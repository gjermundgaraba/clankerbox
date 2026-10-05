#!/bin/sh
# Build and bundle clankerbox for each target: OUT/clankerbox-<target>.tar.gz,
# beside <bundle>.sha256, which `sha256sum -c` and `shasum -a 256 -c` check.
# Usage: build.sh [--out OUT] [TARGET...], TARGET darwin-arm64 or linux-x64; OUT defaults to
# tools/release/dist. By default it builds what this machine can: both targets on macOS,
# linux-x64 on Linux (darwin needs codesign).
# Bundle the code first (vp run -r build). The Node is the one .node-version pins, its
# archives' checksums in release-inputs.json. The first run downloads them into
# tools/release/cache/, so `vp run ready` doesn't include it and stays offline. The names carry
# no version: the release's tag and the binary's --version do. A bundle holds, at its top level:
#   clankerbox                       the SEA binary
#   LICENSE                          clankerbox's own
#   notices/node/LICENSE             Node's, from the archive the SEA was built on
#   notices/npm/licenses.json        every production dependency of apps/clankerbox, its
#                                    workspace packages' included, from `pnpm licenses list`
#   notices/npm/<name>@<version>/    that package's own license and notice files
# A package that ships no license file is listed in licenses.json with "files": [].
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out="$here/dist"
if [ "${1:-}" = --out ]; then
  [ $# -ge 2 ] || { echo "--out needs a directory" >&2; exit 1; }
  out=$2 && shift 2
fi
code="$root/apps/clankerbox/dist/clankerbox.mjs"
inputs="$here/release-inputs.json"
node_version=$(tr -d '[:space:]' <"$root/.node-version")
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) builder_platform=darwin-arm64 ;;
  Linux-x86_64) builder_platform=linux-x64 ;;
  *) echo "no pinned Node for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
if command -v sha256sum >/dev/null; then sha256() { sha256sum "$1"; }; else sha256() { shasum -a 256 "$1"; }; fi
# Owned by root:0 in the archive. bsdtar must not add AppleDouble (._*) or xattr entries.
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  pack() { tar --owner=0 --group=0 --numeric-owner -czf "$@"; }
else
  pack() { COPYFILE_DISABLE=1 tar --uid 0 --gid 0 --uname root --gname root --no-mac-metadata --no-xattrs --no-acls --no-fflags -czf "$@"; }
fi

# Print the directory holding the platform's verified bin/node and Node's LICENSE,
# downloading them on first use.
node_for() {
  sum=$(node -p 'require(process.argv[1]).nodeArchiveSha256[process.argv[2]]?.[process.argv[3]] ?? ""' \
    "$inputs" "$node_version" "$1")
  [ -n "$sum" ] || { echo "release-inputs.json has no checksum for node-v$node_version-$1" >&2; exit 1; }
  dir="$here/cache/$sum"
  if [ ! -x "$dir/node" ] || [ ! -f "$dir/LICENSE" ]; then
    name="node-v$node_version-$1"
    rm -rf "$dir" "$dir.part" && mkdir -p "$dir.part"
    curl -fsSL -o "$dir.part/$name.tar.xz" "https://nodejs.org/dist/v$node_version/$name.tar.xz"
    [ "$(sha256 "$dir.part/$name.tar.xz" | cut -d ' ' -f 1)" = "$sum" ] || { echo "$name.tar.xz: sha256 mismatch" >&2; exit 1; }
    tar -xJf "$dir.part/$name.tar.xz" -C "$dir.part" --strip-components 1 "$name/bin/node" "$name/LICENSE"
    mv "$dir.part/bin/node" "$dir.part/node" && rmdir "$dir.part/bin"
    rm "$dir.part/$name.tar.xz" && mv "$dir.part" "$dir"
  fi
  echo "$dir"
}

[ -f "$code" ] || { echo "missing $code: run vp run -r build first" >&2; exit 1; }
if [ $# -eq 0 ]; then
  case "$builder_platform" in darwin-arm64) set -- darwin-arm64 linux-x64 ;; *) set -- linux-x64 ;; esac
fi
for target in "$@"; do
  case "$target" in
    darwin-arm64) [ "$builder_platform" = darwin-arm64 ] || { echo "darwin-arm64 builds need macOS" >&2; exit 1; } ;;
    linux-x64) ;;
    *) echo "unknown target $target: darwin-arm64 or linux-x64" >&2; exit 1 ;;
  esac
done
builder=$(node_for "$builder_platform")/node
# Absolute, since the bundles are packed from inside each stage.
mkdir -p "$out" && out=$(cd "$out" && pwd)

notices="$out/notices.part"
rm -rf "$notices" && mkdir -p "$notices/npm"
(cd "$root" && pnpm --filter '@clankerbox/clankerbox...' licenses list --prod --json) >"$notices/pnpm-licenses.json"
# pnpm's listing names local paths; licenses.json keeps everything but those.
node --input-type=module - "$notices/pnpm-licenses.json" "$notices/npm" <<'NODE'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [listing, out] = process.argv.slice(2);
const noticeName = /^(licen[cs]e|copying|notice|copyright)/i;
const index = [];
for (const [license, packages] of Object.entries(JSON.parse(readFileSync(listing, "utf8")))) {
  for (const { name, versions, paths, homepage } of packages) {
    versions.forEach((version, i) => {
      const files = readdirSync(paths[i])
        .filter((file) => noticeName.test(file) && statSync(join(paths[i], file)).isFile())
        .sort();
      const dir = join(out, `${name}@${version}`);
      if (files.length > 0) mkdirSync(dir, { recursive: true });
      for (const file of files) copyFileSync(join(paths[i], file), join(dir, file));
      index.push({ name, version, license, homepage, files });
    });
  }
}
index.sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
writeFileSync(join(out, "licenses.json"), `${JSON.stringify(index, null, 2)}\n`);
NODE

for target in "$@"; do
  name="clankerbox-$target"
  stage="$out/$name"
  node_dir=$(node_for "$target")
  rm -rf "$stage" && mkdir -p "$stage/notices/node"
  cat >"$out/$name.sea-config.json" <<JSON
{
  "main": "$code",
  "mainFormat": "module",
  "executable": "$node_dir/node",
  "output": "$stage/clankerbox",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": false,
  "execArgvExtension": "none"
}
JSON
  "$builder" --build-sea "$out/$name.sea-config.json"
  rm "$out/$name.sea-config.json"
  if [ "$target" = darwin-arm64 ]; then
    codesign --force --sign - --options runtime --entitlements "$here/entitlements.plist" "$stage/clankerbox"
  fi
  cp "$root/LICENSE" "$stage/LICENSE"
  cp "$node_dir/LICENSE" "$stage/notices/node/LICENSE"
  cp -R "$notices/npm" "$stage/notices/npm"
  chmod -R u=rwX,go=rX "$stage"
  rm -f "$out/$name.tar.gz" "$out/$name.tar.gz.sha256"
  (cd "$stage" && pack "$out/$name.tar.gz" clankerbox LICENSE notices)
  (cd "$out" && sha256 "$name.tar.gz" >"$name.tar.gz.sha256")
  rm -rf "$stage"
  echo "bundled $out/$name.tar.gz"
done
rm -rf "$notices"
