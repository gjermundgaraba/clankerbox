#!/bin/sh
set -eu
[ $# -eq 2 ] || { echo "usage: tlc.sh <dir> <config>" >&2; exit 2; }
dir=$(cd "$1" && pwd)
tla_version=1.8.0
cache=${XDG_CACHE_HOME:-$HOME/.cache}/clankerbox-tla
jar=$cache/tla2tools-$tla_version.jar

command -v java >/dev/null || { echo "tlc: needs java 11 or later on PATH" >&2; exit 2; }
spec=$(java -XshowSettings:properties -version 2>&1 | sed -n 's/^ *java.specification.version = //p')
[ "${spec%%.*}" -ge 11 ] 2>/dev/null || { echo "tlc: needs java 11 or later; PATH has ${spec:-a java that does not run}" >&2; exit 2; }

if [ ! -r "$jar" ]; then
  mkdir -p "$cache"
  part=$(mktemp "$cache/tla2tools.XXXXXX")
  curl -fsSL -o "$part" "https://github.com/tlaplus/tlaplus/releases/download/v$tla_version/tla2tools.jar"
  mv "$part" "$jar"
fi

cd "$dir"
exec java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers auto -noGenerateSpecTE \
  -metadir "$dir/states" -cleanup -dumpTrace json "$dir/trace.json" \
  -config "$2" MachineAnswers.tla >"$dir/tlc.out" 2>&1
