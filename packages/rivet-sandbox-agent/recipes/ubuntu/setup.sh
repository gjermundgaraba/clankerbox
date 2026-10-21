#!/bin/sh
# A clankerbox setup that makes an x86_64 Ubuntu machine a sandbox for Rivet's Sandbox Agent:
# the login user `admin` with passwordless sudo, for whom the host then installs your keys, sshd
# with root's login off, the Sandbox Agent's server and Claude Code under `admin`, and an
# /etc/clankerbox/start that keeps the server running on the guest's loopback, port 2468.
#
# Name this directory, or a copy, as a profile's `setup.path`. An optional `agent.env` beside
# it, of `NAME=value` lines such as `ANTHROPIC_API_KEY=…`, becomes the server's environment,
# which is where the agents it launches find their credentials.
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

apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  openssh-server sudo curl ca-certificates xz-utils procps >/dev/null

install -d /etc/ssh/sshd_config.d
echo "PermitRootLogin no" >/etc/ssh/sshd_config.d/10-clankerbox.conf

if ! id admin >/dev/null 2>&1; then
  groupadd -f admin
  useradd -m -s /bin/bash -g admin admin
fi

echo "admin ALL=(ALL) NOPASSWD: ALL" >/var/tmp/sudoers-admin
visudo -cf /var/tmp/sudoers-admin >/dev/null
install -m 440 /var/tmp/sudoers-admin /etc/sudoers.d/admin
rm /var/tmp/sudoers-admin

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

# The agents run as `admin`: as root, Claude Code offers no bypass-permissions mode.
if [ -s agent.env ]; then
  install -m 600 -o admin -g "$(id -gn admin)" agent.env /etc/sandbox-agent.env
fi

# Claude Code at its latest release, and its adapter at the version the server pins. Other
# agents install the same way; `install-agent codex` hangs in its own check at this version, so
# give it a timeout too, and end what it leaves running. Claude's install takes about 30 s; 300 s
# leaves room for a slow mirror.
timeout 300 su - admin -c 'sandbox-agent install-agent claude' >/var/tmp/install-agent.log 2>&1 || {
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

# The health check, bounded: on loopback a server answers in milliseconds, so one that takes 2 s
# is hung or busy beyond use.
answers() {
  curl -fs -m 2 -o /dev/null http://127.0.0.1:2468/v1/health
}

# Whether the server answers within $1 seconds.
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

# A running server gets 10 s to answer, since this runs at every start, a running machine's too,
# before it is ended as hung: TERM, then KILL after 5 s, as a hung one may ignore TERM.
if running && ! answers_within 10; then
  pkill -u admin -f 'sandbox-agent server' || true
  for tries in $(seq 40); do
    running || break
    if [ "$tries" -eq 20 ]; then
      pkill -KILL -u admin -f 'sandbox-agent server' || true
    fi
    sleep 0.25
  done
fi

# The server listens on loopback alone, with no token: guest port 22 is the only way to it.
if ! running; then
  su - admin -c '
    if [ -r /etc/sandbox-agent.env ]; then set -a; . /etc/sandbox-agent.env; set +a; fi
    setsid -f sandbox-agent server --no-token --no-telemetry >/dev/null 2>&1
  '
fi

# 20 s for a server to start, within preparation's 60 s, the grace and the stop above included;
# it starts in under a second.
if ! answers_within 20; then
  echo "the Sandbox Agent's server didn't answer its health check within 20 s"
  exit 1
fi
START
chmod 755 /etc/clankerbox/start

# sshd runs before preparation, so its re-mint of the host keys has a running sshd to SIGHUP.
mkdir -p /run/sshd
/usr/sbin/sshd
