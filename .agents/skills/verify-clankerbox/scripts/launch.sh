#!/bin/sh
# Usage: RUN=$(launch.sh [linux|mac] [ram-budget-mib])
set -eu
. "$(dirname "$0")/common.sh"
run=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/verify-clankerbox.XXXXXX")" && pwd)
evidence=$run/evidence
mkdir "$evidence"

fail() {
  echo "launch: $1; its log:" >&2
  cat "$2" >&2
  echo "launch: evidence kept in $evidence" >&2
  exit 1
}

sources >"$evidence/sources"
cd "$repo"
vp run -r build >"$evidence/build.log" 2>&1 || fail "the build failed" "$evidence/build.log"
nohup vpx packages/host/tests/serve.ts "$run" "${1:-linux}" ${2:+"$2"} \
  >"$evidence/host.log" 2>&1 </dev/null &
launched=$!

until [ -e "$run/ready" ]; do
  kill -0 "$launched" 2>/dev/null || fail "the host exited before it served" "$evidence/host.log"
  sleep 0.25
done

echo "host at $(cat "$run/ready")" >&2
echo "$run"
