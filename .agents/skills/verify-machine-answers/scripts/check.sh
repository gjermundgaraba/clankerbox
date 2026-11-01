#!/bin/sh
# Usage: check.sh [--quick]
set -eu
case ${1:-} in
  '' | --quick) ;;
  *) echo "usage: check.sh [--quick]" >&2; exit 2 ;;
esac
scripts=$(cd "$(dirname "$0")" && pwd)
model=$scripts/../model

vpx "$scripts/export-chart.ts"

work=$(mktemp -d "${TMPDIR:-/tmp}/verify-machine-answers.XXXXXX")
cp "$model/Chart.tla" "$model/MachineAnswers.tla" "$model/MachineAnswers.cfg" "$model/TwoClients.cfg" "$model/ThreeClients.cfg" "$work/"

status=0
check() {
  "$scripts/tlc.sh" "$work" "$1" || status=$?
  if [ ! -e "$work/tlc.out" ]; then
    rm -rf "$work"
    exit "$status"
  fi
  echo "$1:"
  grep -E '^Error: |is violated|were violated|No error has been found|distinct states found|^Finished in' "$work/tlc.out" | tail -4 || true
}

check TwoClients.cfg
if [ "$status" -eq 0 ] && [ "${1:-}" != --quick ]; then
  check MachineAnswers.cfg
fi
if [ "$status" -eq 0 ] && [ "${1:-}" != --quick ]; then
  check ThreeClients.cfg
fi
if [ "$status" -eq 0 ]; then
  rm -rf "$work"
  exit 0
fi
echo "output: $work/tlc.out"
if [ -s "$work/trace.json" ]; then
  echo "counterexample: $work/trace.json"
fi
echo "delete $work once you have read it"
exit "$status"
