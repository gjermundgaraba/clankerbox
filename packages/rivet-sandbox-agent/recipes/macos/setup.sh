#!/bin/sh
# A clankerbox setup that makes a macOS machine (Tart, a Cirrus base) a sandbox for Rivet's
# Sandbox Agent: your key for `admin`, the Sandbox Agent's server and Claude Code under `admin`,
# a LaunchDaemon that runs the server on the guest's loopback, port 2468, and an
# /etc/clankerbox/start that keeps it running. Give the provider `cwd: "/Users/admin"`.
#
# Copy this directory, put the public keys that may log in into `authorized_keys` beside this
# file, and name the copy as a profile's `setup.path`. An optional `agent.env` beside it, of
# `NAME=value` lines such as `ANTHROPIC_API_KEY=…`, becomes the server's environment, which is
# where the agents it launches find their credentials.
set -eu
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

# The pins, each an arm64 macOS download with its sha256. The bump-sandbox-agent skill says
# where each comes from.
agent_version=0.5.2
agent_sha256=58417cf5fa1e2dc417fc4a92d11840cc245ad599b87dd4c9a41686b05c36d877
node_version=22.23.3
node_sha256=23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53

if [ ! -s authorized_keys ]; then
  echo "this recipe needs an authorized_keys file beside setup.sh, holding your public key"
  exit 1
fi

# Softnet blocks the gateway's DNS, so public resolvers come first.
networksetup -listallnetworkservices | tail -n +2 | sed 's/^\*//' | while IFS= read -r service; do
  networksetup -setdnsservers "$service" 1.1.1.1 9.9.9.9
done

install -d -m 700 -o admin -g staff /Users/admin/.ssh
install -m 600 -o admin -g staff authorized_keys /Users/admin/.ssh/authorized_keys

# Downloads $1 to $3 and refuses it unless its sha256 is $2.
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
# is the limit.
sudo -n -u admin -H env PATH="$PATH" perl -e 'alarm 300; exec @ARGV' \
  sandbox-agent install-agent claude >/var/tmp/install-agent.log 2>&1 || {
  tail -n 15 /var/tmp/install-agent.log
  exit 1
}
rm /var/tmp/install-agent.log

# The server listens on loopback alone, with no token: guest port 22 is the only way to it.
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
# Runs at every activation: after a create, a start, a fork and a restore. launchd starts the
# server at boot; this loads its job the first time, and starts it again when it has ended.
set -eu
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

if ! launchctl print system/dev.clankerbox.sandbox-agent >/dev/null 2>&1; then
  launchctl bootstrap system /Library/LaunchDaemons/dev.clankerbox.sandbox-agent.plist
fi

if ! pgrep -u admin -x sandbox-agent >/dev/null; then
  launchctl kickstart system/dev.clankerbox.sandbox-agent
fi

tries=0
until curl -fs -o /dev/null http://127.0.0.1:2468/v1/health; do
  tries=$((tries + 1))
  if [ "$tries" -ge 80 ]; then
    echo "the Sandbox Agent's server didn't answer its health check within 20 s"
    exit 1
  fi
  sleep 0.25
done
START
chmod 755 /etc/clankerbox/start
