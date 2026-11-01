#!/bin/sh
# Usage: cleanup.sh <run-dir>
set -eu
. "$(dirname "$0")/common.sh"
use_run "$@"

stop() {
  kill -TERM "$1" 2>/dev/null || return 0
  tries=0
  while kill -0 "$1" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -gt 40 ]; then
      kill -KILL "$1"
      echo "cleanup: process $1 ignored TERM" >&2
      break
    fi
    sleep 0.25
  done
}

if pid=$(server_pid); then
  stop "$pid"
fi

for file in "$run"/hosts/*.pid; do
  [ -e "$file" ] || continue
  if pid=$(serving "$file"); then
    stop "$pid"
  fi
done

echo "stopped $run; evidence in $evidence"
