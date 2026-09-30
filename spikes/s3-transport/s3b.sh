#!/bin/sh
# S3b local 3-hop run: client -> relay1 (WS) -> relay2 (WS) -> guest2 (stdio of a child).
# Usage: s3b.sh LABEL DELAY_MS NOACK CLIENT_ARGS...
# Writes relay logs and the client's JSON line to $WORK_RUN_EVIDENCE (or ./out).
set -eu
cd "$(dirname "$0")"
label=$1; delay=$2; noack=$3; shift 3
ev=${WORK_RUN_EVIDENCE:-out}
mkdir -p "$ev"
p1=$((47100 + $$ % 400)); p2=$((p1 + 1))
node src/relay2.ts --port "$p2" --delay-ms "$delay" --env "S3B_NOACK=$noack" \
  --exec '["node","src/guest2.ts"]' 2>"$ev/$label.relay2.log" &
r2=$!
node src/relay2.ts --port "$p1" --delay-ms "$delay" --to "ws://127.0.0.1:$p2/attach" 2>"$ev/$label.relay1.log" &
r1=$!
trap 'kill -CONT $r1 2>/dev/null; kill $r1 $r2 2>/dev/null; wait 2>/dev/null' EXIT
sleep 1.5
# The client's delay: one hop of latency on the client side, applied by relay1 in both directions.
node src/client2.ts --ws "ws://127.0.0.1:$p1/attach" --stop-pid "$r1" "$@" >"$ev/$label.json" 2>"$ev/$label.client.log" || true
relay1=$(sed -n 's/.*peakRss=\([0-9.]*\)MiB/\1/p' "$ev/$label.relay1.log" | sort -n | tail -1)
relay2=$(sed -n 's/.*peakRss=\([0-9.]*\)MiB/\1/p' "$ev/$label.relay2.log" | sort -n | tail -1)
echo "$label relay1PeakMiB=$relay1 relay2PeakMiB=$relay2 $(cat "$ev/$label.json")"
