#!/bin/sh
# A clankerbox setup that makes an x86_64 Ubuntu machine a sandbox for Rivet's Sandbox Agent:
# sshd with your key, the Sandbox Agent's server and Claude Code under a `sandbox` user, and an
# /etc/clankerbox/start that keeps the server running on the guest's loopback, port 2468.
#
# Copy this directory, put the public keys that may log in into `authorized_keys` beside this
# file, and name the copy as a profile's `setup.path`. An optional `agent.env` beside it, of
# `NAME=value` lines such as `ANTHROPIC_API_KEY=…`, becomes the server's environment, which is
# where the agents it launches find their credentials.
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export DEBIAN_FRONTEND=noninteractive

# The pins, each an x86_64 Linux download with its sha256. The bump-sandbox-agent skill says
# where each comes from.
agent_version=0.5.2
agent_sha256=5ebefccb130cccb0aa7972eacc8ff7c55550b959b2dd682a232a21a5712d955e
# The agents' adapters run on Node, and need a newer one than Ubuntu 24.04 packages.
node_version=22.23.3
node_sha256=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de

if [ ! -s authorized_keys ]; then
  echo "this recipe needs an authorized_keys file beside setup.sh, holding your public key"
  exit 1
fi

apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  openssh-server curl ca-certificates xz-utils procps >/dev/null

install -d -m 700 /root/.ssh
install -m 600 authorized_keys /root/.ssh/authorized_keys

# Downloads $1 to $3 and refuses it unless its sha256 is $2.
fetch() {
  curl -fsSL "$1" -o "$3"
  echo "$2  $3" | sha256sum -c - >/dev/null
}

fetch "https://releases.rivet.dev/sandbox-agent/$agent_version/binaries/sandbox-agent-x86_64-unknown-linux-musl" \
  "$agent_sha256" /var/tmp/sandbox-agent
install -m 755 /var/tmp/sandbox-agent /usr/local/bin/sandbox-agent
rm /var/tmp/sandbox-agent

fetch "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-x64.tar.xz" \
  "$node_sha256" /var/tmp/node.tar.xz
tar -xJf /var/tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner
rm /var/tmp/node.tar.xz

# The agents run as their own user: as root, Claude Code offers no bypass-permissions mode.
useradd -m -s /bin/bash sandbox

if [ -s agent.env ]; then
  install -m 600 -o sandbox -g sandbox agent.env /etc/sandbox-agent.env
fi

# Claude Code at its latest release, and its adapter at the version the server pins. Other
# agents install the same way; `install-agent codex` hangs in its own check at this version, so
# give it a timeout too, and end what it leaves running.
timeout 300 su - sandbox -c 'sandbox-agent install-agent claude' >/var/tmp/install-agent.log 2>&1 || {
  tail -n 15 /var/tmp/install-agent.log
  exit 1
}
rm /var/tmp/install-agent.log

install -d /etc/clankerbox
cat >/etc/clankerbox/start <<'START'
#!/bin/sh
# Runs at every activation: after a create, a start, a fork and a restore.
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

mkdir -p /run/sshd
pid=$(cat /run/sshd.pid 2>/dev/null || true)
if [ -z "$pid" ] || [ "$(cat "/proc/$pid/comm" 2>/dev/null || true)" != sshd ]; then
  /usr/sbin/sshd
fi

# The server listens on loopback alone, with no token: guest port 22 is the only way to it.
if ! pgrep -u sandbox -x sandbox-agent >/dev/null; then
  su - sandbox -c '
    if [ -r /etc/sandbox-agent.env ]; then set -a; . /etc/sandbox-agent.env; set +a; fi
    setsid -f sandbox-agent server --no-token --no-telemetry >/dev/null 2>&1
  '
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

# sshd runs before preparation, so its re-mint of the host keys has a running sshd to SIGHUP.
mkdir -p /run/sshd
/usr/sbin/sshd
