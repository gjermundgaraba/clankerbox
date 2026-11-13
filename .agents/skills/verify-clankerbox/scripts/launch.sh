#!/bin/sh
set -eu
. "$(dirname "$0")/common.sh"

usage() {
  echo "usage: launch.sh [runtime | runtime:hosts[,runtime:hosts...]] [ram-budget-mib] [hosts], each runtime smolvm, tart, fixed or smol-cloud" >&2
  exit 2
}

fleet=${1:-smolvm}
budget=${2:-}
case $fleet in
  *:*) [ -z "${3:-}" ] || usage ;;
  *) fleet=$fleet:${3:-1} ;;
esac

set -f
IFS=,
for entry in $fleet; do
  case $entry in
    smolvm:* | tart:* | fixed:* | smol-cloud:*) ;;
    *) usage ;;
  esac
  case ${entry#*:} in
    '' | *[!0-9]* | 0*) usage ;;
  esac
done
unset IFS

run=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/verify-clankerbox.XXXXXX")" && pwd)
evidence=$run/evidence
mkdir "$evidence" "$run/hosts"
echo "${fleet%%:*}" >"$run/runtime"
echo "$budget" >"$run/budget"

fail() {
  echo "launch: $1; its log:" >&2
  cat "$2" >&2
  echo "launch: evidence kept in $evidence" >&2
  exit 1
}

sources >"$evidence/sources"
cd "$repo"
vp run @gjermundgaraba/clankerbox#build >"$evidence/build.log" 2>&1 || fail "the build failed" "$evidence/build.log"

IFS=,
for entry in $fleet; do
  unset IFS
  runtime=${entry%%:*}
  started=0
  while [ "$started" -lt "${entry#*:}" ]; do
    started=$((started + 1))
    number=1
    while [ -e "$run/hosts/$runtime-$number.runtime" ]; do number=$((number + 1)); done
    echo "$runtime" >"$run/hosts/$runtime-$number.runtime"
    start_host "$runtime-$number"
  done
done

start_server
echo "control plane at $(cat "$run/server.ready")" >&2
echo "$run"
