#!/bin/sh
set -eu
# Explicit signing identity; no keychain, privacy, or production settings change.
output=${1:?usage: build.sh NEW_OUTPUT_DIRECTORY}
identity=${CLANKERBOX_SIGNING_IDENTITY:?Set the existing Apple-issued signing identity hash}
repo=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir "$output"
output=$(cd "$output" && pwd)
cd "$repo"
python3 scripts/release/build-mac-host.py --output "$output/clankerbox-host" --version "${CLANKERBOX_VERSION:-0.3.0}" --identity "$identity"
GOOS=darwin GOARCH=arm64 go build -o "$output/clankerbox-guest-darwin-arm64" ./cmd/clankerbox-guest
(cd spikes/real-local-engine/tart-gate && go build -o "$output/tart-gate" .)
shasum -a 256 "$output/clankerbox-host" "$output/clankerbox-guest-darwin-arm64" "$output/tart-gate"
