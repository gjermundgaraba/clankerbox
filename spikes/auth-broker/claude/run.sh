#!/bin/sh
set -eu
cd "$(dirname "$0")"
vm=auth-exp-claude
clankerbox create --profile linux-dev-v2 "$vm"
cleanup() {
  clankerbox stop "$vm" || true
  clankerbox delete "$vm"
}
trap cleanup EXIT
clankerbox exec "$vm" -- sh -c 'useradd -m -s /bin/bash authprobe && runuser -l authprobe -c "npm install --prefix /home/authprobe/cli @anthropic-ai/claude-code@2.1.263"'
clankerbox exec "$vm" -- sh -c 'cat > /tmp/claude-probe.py' < probe.py
clankerbox exec "$vm" -- unshare --net python3 /tmp/claude-probe.py > results.json
