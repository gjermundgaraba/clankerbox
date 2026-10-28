#!/bin/sh
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export DEBIAN_FRONTEND=noninteractive

agent_version=0.5.3
agent_sha256=48b8bcdabf7d22e276593651a64c72e84e41fd8ef743b524721e949f9c330b90
node_version=22.23.4
node_sha256=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce

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

timeout 300 su - admin -c 'sandbox-agent install-agent claude' >/var/tmp/install-agent.log 2>&1 || {
  tail -n 15 /var/tmp/install-agent.log
  exit 1
}
rm /var/tmp/install-agent.log

install -d /etc/clankerbox
cat >/etc/clankerbox/start <<'START'
#!/bin/sh
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

mkdir -p /run/sshd
pid=$(cat /run/sshd.pid 2>/dev/null || true)
if [ -z "$pid" ] || [ "$(cat "/proc/$pid/comm" 2>/dev/null || true)" != sshd ]; then
  /usr/sbin/sshd
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

if ! running; then
  su - admin -c '
    if [ -r /etc/sandbox-agent.env ]; then set -a; . /etc/sandbox-agent.env; set +a; fi
    setsid -f sandbox-agent server --no-token --no-telemetry >/dev/null 2>&1
  '
fi

if ! answers_within 20; then
  echo "the Sandbox Agent's server didn't answer its health check within 20 s"
  exit 1
fi
START
chmod 755 /etc/clankerbox/start

mkdir -p /run/sshd
/usr/sbin/sshd
