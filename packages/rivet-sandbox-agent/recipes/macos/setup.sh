#!/bin/sh
set -eu
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

agent_version=0.5.3
agent_sha256=b4bf7244a67bd74ed91bef68051717503d3b4db6aad8f76c1ba71fccb9712b48
node_version=22.23.4
node_sha256=c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428

use_public_dns_past_softnet_host_block() {
  networksetup -listallnetworkservices | tail -n +2 | sed 's/^\*//' | while IFS= read -r service; do
    networksetup -setdnsservers "$service" 1.1.1.1 9.9.9.9
  done
}
use_public_dns_past_softnet_host_block

fetch() {
  curl -fsSL "$1" -o "$3"
  echo "$2  $3" | shasum -a 256 -c - >/dev/null
}

mkdir -p /usr/local/bin
fetch "https://releases.rivet.dev/sandbox-agent/$agent_version/binaries/sandbox-agent-aarch64-apple-darwin" \
  "$agent_sha256" /var/tmp/sandbox-agent
install -m 755 /var/tmp/sandbox-agent /usr/local/bin/sandbox-agent
rm /var/tmp/sandbox-agent

fetch "https://nodejs.org/dist/v$node_version/node-v$node_version-darwin-arm64.tar.gz" \
  "$node_sha256" /var/tmp/node.tar.gz
tar -xzf /var/tmp/node.tar.gz -C /usr/local --strip-components=1 --no-same-owner
rm /var/tmp/node.tar.gz

if [ -s agent.env ]; then
  install -m 600 -o admin -g staff agent.env /etc/sandbox-agent.env
fi

# Claude Code at its latest release, and its adapter at the version the server pins. Other
# agents install the same way; `install-agent codex` hangs in its own check at this version, so
# give it a time limit too, and end what it leaves running. macOS has no timeout(1): perl's alarm
# is the limit. Claude's install takes about 20 s; 300 s leaves room for a slow mirror. It runs in
# admin's home: sudo keeps the working directory, and the recipe's own, root's alone, is one npm
# can't read.
(cd /Users/admin && sudo -n -u admin -H env PATH="$PATH" perl -e 'alarm 300; exec @ARGV' \
  sandbox-agent install-agent claude) >/var/tmp/install-agent.log 2>&1 || {
  tail -n 15 /var/tmp/install-agent.log
  exit 1
}
rm /var/tmp/install-agent.log

cat >/Library/LaunchDaemons/dev.clankerbox.sandbox-agent.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.clankerbox.sandbox-agent</string>
  <key>UserName</key>
  <string>admin</string>
  <key>WorkingDirectory</key>
  <string>/Users/admin</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>if [ -r /etc/sandbox-agent.env ]; then set -a; . /etc/sandbox-agent.env; set +a; fi; exec /usr/local/bin/sandbox-agent server --no-token --no-telemetry</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>/Users/admin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
PLIST
chmod 644 /Library/LaunchDaemons/dev.clankerbox.sandbox-agent.plist

mkdir -p /etc/clankerbox
cat >/etc/clankerbox/start <<'START'
#!/bin/sh
set -eu
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

if ! launchctl print system/dev.clankerbox.sandbox-agent >/dev/null 2>&1; then
  launchctl bootstrap system /Library/LaunchDaemons/dev.clankerbox.sandbox-agent.plist
fi

answers() {
  curl -fs -m 2 -o /dev/null http://127.0.0.1:2468/v1/health
}

answers_within() {
  until=$(($(date +%s) + $1))
  while [ "$(date +%s)" -lt "$until" ]; do
    answers && return 0
    sleep 0.25
  done
  return 1
}

running() {
  pgrep -u admin -f 'sandbox-agent server' >/dev/null
}

if running; then
  answers_within 10 || launchctl kickstart -k system/dev.clankerbox.sandbox-agent
else
  launchctl kickstart system/dev.clankerbox.sandbox-agent
fi

if ! answers_within 20; then
  echo "the Sandbox Agent's server didn't answer its health check within 20 s"
  exit 1
fi
START
chmod 755 /etc/clankerbox/start
