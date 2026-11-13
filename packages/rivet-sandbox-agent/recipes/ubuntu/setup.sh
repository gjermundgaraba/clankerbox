#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || exec sudo -n /bin/sh "$0" "$@"
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export DEBIAN_FRONTEND=noninteractive

agent_version=0.5.6
agent_sha256=009d01734e75e51d3e1ec341ae21d9cdde08608ba61e3e81bbc1c30bb50d3a7d
node_version=22.23.5
node_sha256=cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8

apt-get update -qq
apt-get install -y -qq --no-install-recommends xz-utils procps >/dev/null

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
