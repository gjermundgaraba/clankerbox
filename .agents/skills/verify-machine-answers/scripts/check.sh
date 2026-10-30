#!/bin/sh
# Usage: check.sh [--quick]
set -eu
case ${1:-} in
  '' | --quick) ;;
  *) echo "usage: check.sh [--quick]" >&2; exit 2 ;;
esac
model=$(cd "$(dirname "$0")/../model" && pwd)
tla_version=1.8.0
tla_sha256=fc6878c603f0fdc18b9fe3e5bf51860cb90ab5b1154e3c371660c036d6bdd63e
cache=${XDG_CACHE_HOME:-$HOME/.cache}/clankerbox-tla
jar=$cache/tla2tools-$tla_version.jar

command -v java >/dev/null || { echo "check: needs java 11 or later on PATH" >&2; exit 2; }
spec=$(java -XshowSettings:properties -version 2>&1 | sed -n 's/^ *java.specification.version = //p')
[ "${spec%%.*}" -ge 11 ] 2>/dev/null || { echo "check: needs java 11 or later; PATH has ${spec:-a java that does not run}" >&2; exit 2; }

if [ ! -r "$jar" ]; then
  mkdir -p "$cache"
  part=$(mktemp "$cache/tla2tools.XXXXXX")
  curl -fsSL -o "$part" "https://github.com/tlaplus/tlaplus/releases/download/v$tla_version/tla2tools.jar"
  mv "$part" "$jar"
fi
if command -v sha256sum >/dev/null; then
  digest=$(sha256sum "$jar" | cut -d ' ' -f 1)
else
  digest=$(shasum -a 256 "$jar" | cut -d ' ' -f 1)
fi
[ "$digest" = "$tla_sha256" ] || { echo "check: $jar isn't tla2tools $tla_version" >&2; exit 2; }

work=$(mktemp -d "${TMPDIR:-/tmp}/verify-machine-answers.XXXXXX")
cp "$model/MachineAnswers.tla" "$work/"
if [ "${1:-}" = --quick ]; then
  sed '/^PROPERTIES/,$d' "$model/MachineAnswers.cfg" >"$work/MachineAnswers.cfg"
else
  cp "$model/MachineAnswers.cfg" "$work/"
fi

cd "$work"
status=0
java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers auto -noGenerateSpecTE \
  -metadir "$work/states" -cleanup -dumpTrace json "$work/trace.json" \
  -config MachineAnswers.cfg MachineAnswers.tla >"$work/tlc.out" 2>&1 || status=$?

grep -E '^Error: |is violated|were violated|No error has been found|distinct states found|^Finished in' "$work/tlc.out" || true
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
