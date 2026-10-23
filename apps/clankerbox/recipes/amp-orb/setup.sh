#!/bin/sh
# A clankerbox setup that makes Amp's orb image (Debian 12, x86_64) a machine for
# `clankerbox amp-orb`: the login user `admin` with passwordless sudo, for whom the host then
# installs your keys, and an /etc/clankerbox/start that keeps sshd running with root's login and
# passwords off. The image already has sshd, sudo, perl and Amp's own user `user`, which runs the
# orb's bootstrap and tools.
#
# Name this directory, or a copy, as a profile's `setup.path`.
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

install -d /etc/ssh/sshd_config.d
printf 'PermitRootLogin no\nPasswordAuthentication no\n' >/etc/ssh/sshd_config.d/10-clankerbox.conf

if ! id admin >/dev/null 2>&1; then
  groupadd -f admin
  useradd -m -s /bin/bash -g admin admin
fi

echo "admin ALL=(ALL) NOPASSWD: ALL" >/var/tmp/sudoers-admin
visudo -cf /var/tmp/sudoers-admin >/dev/null
install -m 440 /var/tmp/sudoers-admin /etc/sudoers.d/admin
rm /var/tmp/sudoers-admin

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
START
chmod 755 /etc/clankerbox/start

# sshd runs before preparation, so its re-mint of the host keys has a running sshd to SIGHUP.
mkdir -p /run/sshd
/usr/sbin/sshd
