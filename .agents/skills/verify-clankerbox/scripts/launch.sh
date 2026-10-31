#!/bin/sh
# Usage: RUN=$(launch.sh [linux|mac] [ram-budget-mib] [hosts])
set -eu
. "$(dirname "$0")/common.sh"
run=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/verify-clankerbox.XXXXXX")" && pwd)
evidence=$run/evidence
kind=${1:-linux}
budget=${2:-}
count=${3:-1}
mkdir "$evidence" "$run/hosts"
echo "$kind" >"$run/kind"
echo "$budget" >"$run/budget"

fail() {
  echo "launch: $1; its log:" >&2
  cat "$2" >&2
  echo "launch: evidence kept in $evidence" >&2
  exit 1
}

sources >"$evidence/sources"
cd "$repo"
vp run -r build >"$evidence/build.log" 2>&1 || fail "the build failed" "$evidence/build.log"

number=0
while [ "$number" -lt "$count" ]; do
  number=$((number + 1))
  start_host "$kind-$number"
done

start_server
echo "control plane at $(cat "$run/server.ready")" >&2
echo "$run"
