#!/bin/sh
set -eu
. "$(dirname "$0")/common.sh"
use_run "$@"
repo=$(git -C "${2:?usage: upgrade.sh <run-dir> <worktree>}" rev-parse --show-toplevel)

fail() {
  echo "upgrade: $1; its log:" >&2
  cat "$2" >&2
  exit 1
}

urls=$(mktemp -d)
for file in "$run"/hosts/*.url; do
  [ -e "$file" ] && cp "$file" "$urls/"
done

"$(dirname "$0")/cleanup.sh" "$run" >/dev/null

if [ -e "$run/kind" ]; then
  case $(cat "$run/kind") in
    linux) echo smolvm >"$run/runtime" ;;
    mac) echo tart >"$run/runtime" ;;
    *)
      echo "upgrade: no runtime for the kind $(cat "$run/kind")" >&2
      exit 2
      ;;
  esac
  rm "$run/kind"
fi

sources >"$evidence/sources"
(cd "$repo" && vp run @gjermundgaraba/clankerbox#build) >"$evidence/upgrade-build.log" 2>&1 ||
  fail "the build of $repo failed" "$evidence/upgrade-build.log"

for file in "$urls"/*.url; do
  [ -e "$file" ] || continue
  cp "$file" "$run/hosts/"
  start_host "$(basename "$file" .url)"
done
rm -r "$urls"

start_server
echo "upgraded to $(cat "$evidence/sources"), built in $repo" >>"$evidence/transcript.txt"
echo "control plane at $(cat "$run/server.ready")" >&2
