#!/bin/sh
set -eu
. "$(dirname "$0")/common.sh"
use_run "$@"
action=${2:?usage: fault.sh <run-dir> kill-server|start-server|kill-host <id>|stop-host <id>|start-host <id>|freeze-host <id>|thaw-host <id>|hold-capture <id>|drift <id> <machine>|land-late <id>|quota <id> on|off|drop-answer <id> make|delete|setup-go}

ask() {
  host=$1
  request=$run/hosts/$host.fault
  pid=$(host_pid "$host")
  rm -f "$request.ok" "$request.refused"
  printf '%s\n' "$2" >"$request.part"
  mv "$request.part" "$request"
  kill -USR2 "$pid"
  tries=0
  until [ -e "$request.ok" ] || [ -e "$request.refused" ]; do
    tries=$((tries + 1))
    if ! kill -0 "$pid" 2>/dev/null || [ "$tries" -gt 40 ]; then
      echo "host $host didn't answer $action" | tee -a "$evidence/transcript.txt" >&2
      exit 1
    fi
    sleep 0.25
  done
  if [ -e "$request.refused" ]; then
    echo "host $host refused $action: $(cat "$request.refused")" | tee -a "$evidence/transcript.txt" >&2
    rm "$request.refused"
    exit 1
  fi
  cat "$request.ok" >>"$evidence/transcript.txt"
  rm "$request.ok"
}

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
  stop-host)
    pid=$(host_pid "${3:?host id}")
    kill -TERM "$pid"
    while kill -0 "$pid" 2>/dev/null; do sleep 0.05; done
    echo "host $3 stopped" >>"$evidence/transcript.txt"
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
    ask "${3:?host id}" '{"_tag":"hold-capture"}'
    ;;
  drift)
    ask "${3:?host id}" "{\"_tag\":\"drift\",\"machine\":\"${4:?machine}\"}"
    ;;
  land-late)
    ask "${3:?host id}" '{"_tag":"land-late"}'
    ;;
  quota)
    case ${4:?on or off} in
      on) on=true ;;
      off) on=false ;;
      *) echo "fault: quota takes on or off" >&2; exit 2 ;;
    esac
    ask "${3:?host id}" "{\"_tag\":\"quota\",\"on\":$on}"
    ;;
  drop-answer)
    case ${4:?make or delete} in
      make | delete) ;;
      *) echo "fault: drop-answer takes make or delete" >&2; exit 2 ;;
    esac
    ask "${3:?host id}" "{\"_tag\":\"drop-answer\",\"call\":\"$4\"}"
    ;;
  setup-go)
    touch "$run/setup-go"
    ;;
  *)
    echo "fault: no action $action" >&2
    exit 2
    ;;
esac
