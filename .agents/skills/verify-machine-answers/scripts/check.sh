#!/bin/sh
# Usage: check.sh [--quick]
set -eu
case ${1:-} in
  '' | --quick) ;;
  *) echo "usage: check.sh [--quick]" >&2; exit 2 ;;
esac
scripts=$(cd "$(dirname "$0")" && pwd)
model=$scripts/../model
tla_version=1.8.0
cache=${XDG_CACHE_HOME:-$HOME/.cache}/clankerbox-tla
jar=$cache/tla2tools-$tla_version.jar

vpx "$scripts/export-chart.ts"

command -v java >/dev/null || { echo "check: needs java 11 or later on PATH" >&2; exit 2; }
spec=$(java -XshowSettings:properties -version 2>&1 | sed -n 's/^ *java.specification.version = //p')
[ "${spec%%.*}" -ge 11 ] 2>/dev/null || { echo "check: needs java 11 or later; PATH has ${spec:-a java that does not run}" >&2; exit 2; }

if [ ! -r "$jar" ]; then
  mkdir -p "$cache"
  part=$(mktemp "$cache/tla2tools.XXXXXX")
  curl -fsSL -o "$part" "https://github.com/tlaplus/tlaplus/releases/download/v$tla_version/tla2tools.jar"
  mv "$part" "$jar"
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/verify-machine-answers.XXXXXX")
cp "$model/Chart.tla" "$model/MachineAnswers.tla" "$model/MachineAnswers.cfg" "$model/TwoClients.cfg" "$model/ThreeClients.cfg" "$work/"

cd "$work"
status=0
check() {
  java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers auto -noGenerateSpecTE \
    -metadir "$work/states" -cleanup -dumpTrace json "$work/trace.json" \
    -config "$1" MachineAnswers.tla >"$work/tlc.out" 2>&1 || status=$?
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
