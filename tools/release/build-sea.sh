#!/bin/sh
# Build the clankerbox SEA binaries into tools/release/dist/<target>/clankerbox.
# Usage: build-sea.sh [TARGET...], TARGET darwin-arm64 or linux-x64. By default it builds
# what this machine can: both targets on macOS, linux-x64 on Linux (darwin needs codesign).
# Bundle first (vp run -r build). The first run downloads the pinned Node archives into
# tools/release/cache/, so `vp run ready` doesn't include it and stays offline.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
bundle="$here/../../apps/clankerbox/dist/clankerbox.mjs"
inputs="$here/release-inputs.json"
version=$(node -p 'require(process.argv[1]).node' "$inputs")
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) builder_platform=darwin-arm64 ;;
  Linux-x86_64) builder_platform=linux-x64 ;;
  *) echo "no pinned Node for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
if command -v sha256sum >/dev/null; then sha256() { sha256sum "$1"; }; else sha256() { shasum -a 256 "$1"; }; fi

# Print the path of the platform's verified bin/node, downloading it on first use.
node_for() {
  sum=$(node -p 'require(process.argv[1]).platforms[process.argv[2]].sha256' "$inputs" "$1")
  dir="$here/cache/$sum"
  if [ ! -x "$dir/node" ]; then
    name="node-v$version-$1"
    mkdir -p "$dir.part"
    curl -fsSL -o "$dir.part/$name.tar.xz" "https://nodejs.org/dist/v$version/$name.tar.xz"
    [ "$(sha256 "$dir.part/$name.tar.xz" | cut -d ' ' -f 1)" = "$sum" ] || { echo "$name.tar.xz: sha256 mismatch" >&2; exit 1; }
    tar -xJf "$dir.part/$name.tar.xz" -C "$dir.part" --strip-components 2 "$name/bin/node"
    rm "$dir.part/$name.tar.xz" && mv "$dir.part" "$dir"
  fi
  echo "$dir/node"
}

[ -f "$bundle" ] || { echo "missing $bundle: run vp run -r build first" >&2; exit 1; }
if [ $# -eq 0 ]; then
  case "$builder_platform" in darwin-arm64) set -- darwin-arm64 linux-x64 ;; *) set -- linux-x64 ;; esac
fi
builder=$(node_for "$builder_platform")
for target in "$@"; do
  [ "$target" != darwin-arm64 ] || [ "$builder_platform" = darwin-arm64 ] || { echo "darwin-arm64 builds need macOS" >&2; exit 1; }
  out="$here/dist/$target"
  executable=$(node_for "$target")
  mkdir -p "$out"
  cat >"$out/sea-config.json" <<JSON
{
  "main": "$bundle",
  "mainFormat": "module",
  "executable": "$executable",
  "output": "$out/clankerbox",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": false,
  "execArgvExtension": "none"
}
JSON
  "$builder" --build-sea "$out/sea-config.json"
  if [ "$target" = darwin-arm64 ]; then
    codesign --force --sign - --options runtime --entitlements "$here/entitlements.plist" "$out/clankerbox"
  fi
  echo "built $out/clankerbox"
done
