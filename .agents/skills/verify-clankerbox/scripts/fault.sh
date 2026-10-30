#!/bin/sh
# Usage: fault.sh <run-dir> kill-server | start-server | kill-host <id> | setup-go
set -eu
. "$(dirname "$0")/common.sh"
use_run "$@"
action=${2:?usage: fault.sh <run-dir> kill-server|start-server|kill-host <id>|setup-go}

case $action in
  kill-server)
    pid=$(server_pid)
    kill -KILL "$pid"
    while kill -0 "$pid" 2>/dev/null; do sleep 0.05; done
    echo "control plane killed" >>"$evidence/transcript.txt"
    ;;
  start-server)
    start_server
    echo "control plane back" >>"$evidence/transcript.txt"
    ;;
  kill-host)
    pid=$(host_pid "${3:?host id}")
    kill -KILL "$pid"
    while kill -0 "$pid" 2>/dev/null; do sleep 0.05; done
    echo "host $3 killed" >>"$evidence/transcript.txt"
    ;;
  setup-go)
    touch "$run/setup-go"
    ;;
  *)
    echo "fault: no action $action" >&2
    exit 2
    ;;
esac
