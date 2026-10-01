#!/bin/sh
# Minimal Node SEA pipeline: fetch + verify pinned Node, build-sea per target, sign darwin.
# usage: build.sh OUT_DIR MAIN_JS [commonjs|module]    (MAIN_JS is already bundled)
# Env: NODE_CACHE (default OUT_DIR/node) keeps verified archives between builds.
set -eu
NODE_VERSION=26.10.0
SHA_darwin_arm64=f222f7e85cc1d5a3d84786aa86836ec3d41c4dcdf59a40e4a9d719b6b0ae28af # node-v26.10.0-darwin-arm64.tar.xz
SHA_linux_x64=ca70e9e349de048b9522abb3adc05b3bd6f43c5ffd3ec57916c7da292f59f022    # node-v26.10.0-linux-x64.tar.xz
OUT=$1 MAIN=$2 FORMAT=${3:-commonjs}
CACHE=${NODE_CACHE:-$OUT/node}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$CACHE"

node_for() { # target -> path of that target's verified official node binary
  dir=node-v$NODE_VERSION-$1
  case $1 in darwin-arm64) sha=$SHA_darwin_arm64 ;; linux-x64) sha=$SHA_linux_x64 ;; esac
  if [ ! -x "$CACHE/$dir/bin/node" ]; then
    curl -fsSL -o "$CACHE/$dir.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/$dir.tar.xz" || exit 1
    echo "$sha  $CACHE/$dir.tar.xz" | shasum -a 256 -c - >&2 || exit 1
    tar -xJf "$CACHE/$dir.tar.xz" -C "$CACHE" "$dir/bin/node" || exit 1
  fi
  echo "$CACHE/$dir/bin/node"
}

BUILDER=$(node_for darwin-arm64) # builder must be the same Node version as the targets
for target in darwin-arm64 linux-x64; do
  mkdir -p "$OUT/$target"
  EXE=$(node_for $target)
  cat >"$OUT/$target/sea.json" <<EOF
{ "main": "$MAIN", "mainFormat": "$FORMAT", "executable": "$EXE",
  "output": "$OUT/$target/clankerbox", "disableExperimentalSEAWarning": true,
  "useSnapshot": false, "useCodeCache": false, "execArgvExtension": "none" }
EOF
  "$BUILDER" --build-sea "$OUT/$target/sea.json"
done

codesign --force --sign - --options runtime --entitlements "$HERE/entitlements.plist" "$OUT/darwin-arm64/clankerbox"
"$OUT/darwin-arm64/clankerbox" --version # smoke test the native target; linux-x64 is smoke-tested on Linux
