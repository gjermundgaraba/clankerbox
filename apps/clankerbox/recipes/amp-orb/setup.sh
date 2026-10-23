#!/bin/sh
# A clankerbox setup that makes Amp's orb image (Debian 12, x86_64) a machine for
# `clankerbox amp-orb`: the login user `admin` with passwordless sudo, for whom the host then
# installs your keys, and an /etc/clankerbox/start that keeps sshd running with root's login and
# passwords off. The image already has sshd, sudo, perl and Amp's own user `user`, which runs the
# orb's bootstrap and tools, in the image's environment this records in /etc/clankerbox/image-env.
#
# Name this directory, or a copy, as a profile's `setup.path`.
set -eu

# smolvm runs a setup in the image's environment, and sudo's env_reset drops it: Amp's git,
# libraries and Node options are only on the PATH, LD_LIBRARY_PATH and NODE_OPTIONS it sets.
install -d /etc/clankerbox
export -p |
  grep -vE '^export (HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|SHLVL|MAIL|TERM|SMOLVM_[A-Z_]*)=' \
    >/etc/clankerbox/image-env
chmod 644 /etc/clankerbox/image-env

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
