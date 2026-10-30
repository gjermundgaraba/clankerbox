#!/bin/sh
# Usage: cleanup.sh <run-dir>
set -eu
. "$(dirname "$0")/common.sh"
use_run "$@"

left() {
  echo "cleanup: the host left its scratch directory: $(dirname "$(cat "$run/home")")" >&2
}

if ! pid=$(host_pid); then
  echo "cleanup: no host serves $run" >&2
  if [ -r "$run/home" ]; then
    left
  fi
  exit 0
fi

kill -TERM "$pid"
tries=0
while kill -0 "$pid" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 40 ]; then
    kill -KILL "$pid"
    echo "cleanup: the host ignored TERM" >&2
    left
    break
  fi
  sleep 0.25
done

echo "stopped $run; evidence in $evidence"
