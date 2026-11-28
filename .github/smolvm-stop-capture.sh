#!/usr/bin/env bash
# Through the built host, control plane and CLI over the smolvm install at $1: `stop --capture` of a
# running machine, then a restore of what it captured, which must hold the source's /root and
# /workspace. The host only ever sees a stop and a capture; the control plane orders them, so this
# is the run that proves the action as a client asks it.
set -euo pipefail

prefix=$1
image=mirror.gcr.io/library/ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7
dir=$RUNNER_TEMP/stop-capture
node=$(command -v node)

mkdir -p "$dir/home/.config/clankerbox"
ssh-keygen -q -t ed25519 -N '' -f "$dir/key"
cat > "$dir/host.json" <<JSON
{ "id": "smolvm-1", "listen": { "address": "127.0.0.1", "port": 8484 }, "stateDir": "/srv/cbx/smolvm",
  "bases": { "ubuntu": "$image" }, "runtime": { "smolvm": { "prefix": "$prefix" } } }
JSON
cat > "$dir/server.json" <<JSON
{ "listen": { "address": "127.0.0.1", "port": 8485 }, "stateDir": "state", "authorizedKeys": "key.pub",
  "hosts": [{ "id": "smolvm-1", "url": "http://127.0.0.1:8484" }] }
JSON
echo '{ "server": "http://127.0.0.1:8485" }' > "$dir/home/.config/clankerbox/config.json"

sudo mkdir -p /srv/cbx
sudo "$node" apps/host/dist/clankerbox-host.mjs --config "$dir/host.json" > "$dir/host.log" 2>&1 &
"$node" apps/server/dist/clankerbox-server.mjs --config "$dir/server.json" > "$dir/server.log" 2>&1 &
trap 'echo "--- host log"; tail -60 "$dir/host.log"; echo "--- server log"; tail -30 "$dir/server.log"' EXIT

cb() { HOME="$dir/home" XDG_CONFIG_HOME="$dir/home/.config" CLANKERBOX_SSH_CONFIG=false "$node" apps/cli/dist/clankerbox.mjs "$@"; }

# The control plane reads a host unreachable until its next recheck, so wait for the runtime itself.
for _ in $(seq 60); do
  if cb hosts 2>/dev/null | grep -qE '^smolvm-1 +up +smolvm '; then break; fi
  sleep 2
done
cb hosts | grep -qE '^smolvm-1 +up +smolvm '

cb create dev --base ubuntu --runtime smolvm --cpu 2 --ram 2G --disk 10G
cb exec dev -- sh -c 'echo root-marker > /root/marker && mkdir -p /workspace && echo workspace-marker > /workspace/marker && sync'
cb stop dev --capture snap
cb get dev | tee /dev/stderr | grep -qE '\bstopped\b'
for _ in $(seq 120); do
  if cb checkpoint get snap | grep -qE '\b(ready|failed)\b'; then break; fi
  sleep 5
done
cb checkpoint get snap | tee /dev/stderr | grep -qE '\bready\b'
cb restore snap restored
test "$(cb exec restored -- cat /root/marker /workspace/marker)" = "$(printf 'root-marker\nworkspace-marker')"

cb delete restored
cb delete dev
cb checkpoint delete snap
echo "stop --capture of a running smolvm machine, and its restore, held /root and /workspace"
