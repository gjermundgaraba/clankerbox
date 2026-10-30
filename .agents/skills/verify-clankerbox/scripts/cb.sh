#!/bin/sh
# Usage: cb.sh <run-dir> <clankerbox args...>
set -u
. "$(dirname "$0")/common.sh"
use_run "$@"
shift

if ! host_pid >/dev/null; then
  echo "cb: no host serves $run: launch a new run" >&2
  exit 3
fi

if [ "$(sources)" != "$(cat "$evidence/sources")" ]; then
  echo "cb: the sources changed after this run built them: launch a new run" >&2
  exit 3
fi

out=$(mktemp)
err=$(mktemp)
HOME=$(cat "$run/home") CLANKERBOX_SSH_CONFIG=true env -u XDG_CONFIG_HOME \
  "$node" "$cli" "$@" >"$out" 2>"$err"
code=$?
{
  "$node" -e 'console.log(`$ clankerbox ${JSON.stringify(process.argv.slice(1))}`)' -- "$@"
  cat "$out" "$err"
  echo "[exit $code]"
  echo
} >>"$evidence/transcript.txt"
cat "$out"
cat "$err" >&2
rm -f "$out" "$err"
exit "$code"
