#!/bin/sh
set -eu

# The server answers a request's POST only within SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS, 2 min
# unless set, and past it holds the POST open until the agent exits.
env_file=$1
if [ -r "$env_file" ]; then
  set -a
  . "$env_file"
  set +a
fi
export SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS="${SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS:-86400000}"

exec sandbox-agent server --no-token --no-telemetry
