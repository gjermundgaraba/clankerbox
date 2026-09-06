#!/bin/sh
set -eu
ulimit -c 0
adduser -D -u 1100 -s /bin/sh agent
mkdir -p /home/agent/.codex
chmod 700 /home/agent /home/agent/.codex
chown -R 1100:1100 /home/agent /opt/real-agent/fixture
# Auth is injected by the coordinator into this VM's private writable layer.
# Neither preparation nor evidence collection reads that file.
while [ ! -f /home/agent/.codex/auth.json ]; do sleep 1; done
exec su - agent -c 'export HTTP_PROXY=http://127.0.0.1:8888 HTTPS_PROXY=http://127.0.0.1:8888 ALL_PROXY=http://127.0.0.1:8888 NO_PROXY=localhost,127.0.0.1; python3 /opt/real-agent/relay.py serve --upstream-unix /run/real-agent-proxy.sock & exec python3 /opt/real-agent/guest.py serve --socket /tmp/real-agent.sock --workdir /opt/real-agent/fixture --codex /opt/real-agent/codex --isolated-user agent'
