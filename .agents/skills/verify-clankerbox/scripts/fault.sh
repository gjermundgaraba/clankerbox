#!/bin/sh
set -eu
. "$(dirname "$0")/common.sh"
use_run "$@"
action=${2:?usage: fault.sh <run-dir> kill-server|start-server|kill-host <id>|start-host <id>|freeze-host <id>|thaw-host <id>|hold-capture <id>|setup-go}

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
  start-host)
    start_host "${3:?host id}"
    echo "host $3 back" >>"$evidence/transcript.txt"
    ;;
  freeze-host)
    kill -STOP "$(host_pid "${3:?host id}")"
    echo "host $3 frozen" >>"$evidence/transcript.txt"
    ;;
  thaw-host)
    kill -CONT "$(host_pid "${3:?host id}")"
    echo "host $3 thawed" >>"$evidence/transcript.txt"
    ;;
  hold-capture)
    kill -USR2 "$(host_pid "${3:?host id}")"
    echo "host $3 holds its next capture" >>"$evidence/transcript.txt"
    ;;
  setup-go)
    touch "$run/setup-go"
    ;;
  *)
    echo "fault: no action $action" >&2
    exit 2
    ;;
esac
