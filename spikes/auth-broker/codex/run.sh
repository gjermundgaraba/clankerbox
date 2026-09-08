#!/bin/sh
# Mock-only probe. Creates and deletes a disposable VM; no real credentials.
set -eu
cd "$(dirname "$0")"
vm=auth-exp-codex
clankerbox create --profile linux-dev-v2 "$vm"
cleanup() {
  clankerbox stop "$vm" || true
  clankerbox delete "$vm"
}
trap cleanup EXIT
clankerbox exec "$vm" -- sh -c 'useradd -m -s /bin/bash authprobe && mkdir -p /opt/auth-probe && npm install --prefix /opt/auth-probe @openai/codex@0.153.4 && chmod -R a+rX /opt/auth-probe'
clankerbox exec "$vm" -- sh -c 'cat > /opt/auth-probe/probe.py && chmod a+r /opt/auth-probe/probe.py' < probe.py
clankerbox exec "$vm" -- unshare --net sh -c 'ip link set lo up; runuser -l authprobe -c "python3 /opt/auth-probe/probe.py"' > mock-results.json
