#!/bin/bash
# Invoke a command through the owned outer VM's loopback-only SSH listener.
set -euo pipefail
cd "$(dirname "$0")"
python3 - <<'PY'
from pathlib import Path
import json
from cube_spike import GRANTS, require
s=json.loads(Path('.work/scope.json').read_text())
require(s['grant'] in GRANTS, 'Wrong grant')
require(str(Path.cwd())==s['root']+'/cube', 'Wrong exact host scope')
PY
exec ssh -n -i "$PWD/.work/target/id_ed25519" -p 22070 \
  -o ConnectTimeout=5 -o ServerAliveInterval=15 -o ServerAliveCountMax=2 \
  -o UserKnownHostsFile="$PWD/.work/target/known_hosts" -o StrictHostKeyChecking=yes \
  cube@127.0.0.1 "$@"
