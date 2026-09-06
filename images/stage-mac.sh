#!/usr/bin/env bash
# Run on the Mac host. Pull a pinned public image into a new private Tart home.
set -euo pipefail
destination=${1:?usage: stage-mac.sh NEW_TART_HOME}
tart="$HOME/clankerbox/versions/tart-2.36.0/tart.app/Contents/MacOS/tart"
# Resolved from the latest published Tahoe/Xcode image on 2026-09-06.
image=ghcr.io/cirruslabs/macos-tahoe-xcode@sha256:e0721ddeae3c7c037b764c1aebd0b2d245495c16622413f5a567d7110d18d863
test ! -e "$destination"
test -x "$tart"
test "$("$tart" --version)" = 2.36.0
umask 077
mkdir -p "$destination"
TART_HOME="$destination" TART_NO_AUTO_PRUNE=1 "$tart" clone "$image" seed-e0721ddeae3c
printf '%s\n' "$image" > "$destination/image-source.txt"
printf '%s\n' 'clankerbox-mac-inputs-v1' > "$destination/.clankerbox-inputs"
TART_HOME="$destination" TART_NO_AUTO_PRUNE=1 "$tart" list
