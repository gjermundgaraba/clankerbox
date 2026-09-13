#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile
pnpm check
go test -race -count=1 ./...
mkdir -p .run
go build -o .run/gate-server ./cmd/gate-server
run_dir=$(mktemp -d /tmp/clankerbox-rpc.XXXXXX)
server_pid=
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$run_dir"
}
trap cleanup EXIT INT TERM
.run/gate-server -state-dir "$run_dir" >"$run_dir/server.log" 2>&1 &
server_pid=$!
for ((i=0; i<100; i++)); do
  [[ -f "$run_dir/endpoints.json" ]] && break
  kill -0 "$server_pid" 2>/dev/null || { cat "$run_dir/server.log" >&2; exit 1; }
  sleep 0.05
done
[[ -f "$run_dir/endpoints.json" ]] || { cat "$run_dir/server.log" >&2; exit 1; }
GATE_MANIFEST="$run_dir/endpoints.json" pnpm test
