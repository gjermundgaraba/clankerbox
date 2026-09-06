package host

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"clankerbox/internal/model"
)

// bootstrapScript contains only fixed shell source, a checked hex ID and base64
// data made from parsed public keys. No caller-controlled shell syntax is used.
// The guest's durable claim is written before generating its single new key:
// reply loss resumes that identity, never rotates it. Starts only verify it.
func bootstrapScript(m Manifest, keys []string) (string, error) {
	if !model.ValidID(m.ID) {
		return "", errors.New("invalid bootstrap ID")
	}
	create := len(keys) != 0
	keyData := ""
	if create {
		canonical, err := model.ValidateKeys(keys)
		if err != nil {
			return "", err
		}
		keyData = base64.StdEncoding.EncodeToString([]byte(strings.Join(canonical, "\n") + "\n"))
	}
	user, home, decode := "root", "/root", "base64 -d"
	if m.Profile.Runtime == "tart" {
		user = "admin"
		home = "/Users/admin"
		decode = "/usr/bin/base64 -D"
	}
	config := `Port 22
Protocol 2
HostKey /etc/clankerbox/ssh_host_ed25519_key
AuthorizedKeysFile .ssh/authorized_keys
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
AuthenticationMethods publickey
PermitRootLogin prohibit-password
AllowUsers ` + user + `
AllowTcpForwarding local
PermitOpen 127.0.0.1:* [::1]:*
PermitListen none
AllowStreamLocalForwarding no
GatewayPorts no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
UsePAM yes
StrictModes yes
Subsystem sftp internal-sftp
PidFile /var/run/clankerbox-sshd.pid
`
	if m.Profile.Runtime == "tart" {
		// Noninteractive SSH does not read the image's Homebrew login profile.
		config += "SetEnv PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin\n"
	}
	cfgData := base64.StdEncoding.EncodeToString([]byte(config))
	var s strings.Builder
	s.WriteString("set -eu\numask 077\n")
	if m.Profile.Runtime == "smolvm" {
		// The bare rootfs is staged by the unprivileged host account. Restore
		// sshd's required ownership inside the guest, before validating config.
		s.WriteString("mkdir -p /run/sshd\nchown 0:0 /run/sshd /root /etc/ssh\nchmod 0755 /run/sshd\n")
	}
	if create {
		s.WriteString("if [ ! -e /etc/clankerbox/owner ]; then\n  test ! -e /etc/clankerbox\n  mkdir -m 700 /etc/clankerbox\n  printf '%s\\n' '" + m.ID + "' > /etc/clankerbox/owner\n  sync\nfi\n")
	}
	s.WriteString("test \"$(cat /etc/clankerbox/owner)\" = '" + m.ID + "'\n")
	if create {
		s.WriteString("if [ ! -e /etc/clankerbox/ssh_host_ed25519_key ]; then\n  /usr/bin/ssh-keygen -q -t ed25519 -N '' -f /etc/clankerbox/ssh_host_ed25519_key\n  sync\nfi\n/usr/bin/ssh-keygen -y -f /etc/clankerbox/ssh_host_ed25519_key > /etc/clankerbox/ssh_host_ed25519_key.pub\n")
		s.WriteString("mkdir -p '" + home + "/.ssh'\nchmod 700 '" + home + "/.ssh'\nprintf '%s' '" + keyData + "' | " + decode + " > '" + home + "/.ssh/authorized_keys'\nchmod 600 '" + home + "/.ssh/authorized_keys'\nchown -R '" + user + "' '" + home + "/.ssh'\nprintf '%s' '" + cfgData + "' | " + decode + " > /etc/ssh/sshd_config\nchmod 600 /etc/ssh/sshd_config\n/usr/sbin/sshd -t\nsync\n")
	} else {
		s.WriteString("test -s /etc/clankerbox/ssh_host_ed25519_key\ntest -s /etc/clankerbox/prepared\n/usr/sbin/sshd -t\n")
	}
	if m.Profile.Runtime == "tart" {
		// Private DHCP DNS servers are deliberately unreachable through Softnet.
		// The supported Tart image names its primary network service Ethernet.
		if create {
			s.WriteString("/usr/sbin/networksetup -setdnsservers Ethernet 1.1.1.1 8.8.8.8\n")
		}
		s.WriteString("/bin/launchctl enable system/com.openssh.sshd\nif ! /bin/launchctl print system/com.openssh.sshd >/dev/null 2>&1; then\n  /bin/launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist\nfi\n")
	} else {
		// The supported bare profile has smolvm-agent as init, not guest systemd.
		// sshd's daemon mode survives the short synchronous guest exec command.
		s.WriteString("mkdir -p /run/sshd\nif [ -s /var/run/clankerbox-sshd.pid ] && kill -0 \"$(cat /var/run/clankerbox-sshd.pid)\" 2>/dev/null; then\n  kill -HUP \"$(cat /var/run/clankerbox-sshd.pid)\"\nelse\n  rm -f /var/run/clankerbox-sshd.pid\n  /usr/sbin/sshd -f /etc/ssh/sshd_config\nfi\n")
	}
	if create {
		s.WriteString("printf '%s\\n' '" + m.ID + "' > /etc/clankerbox/prepared\nsync\n")
	}
	s.WriteString("/usr/bin/ssh-keygen -y -f /etc/clankerbox/ssh_host_ed25519_key\n")
	script := s.String()
	if m.Profile.Runtime == "tart" {
		script = "sudo -n /bin/bash -se <<'CLANKERBOX_TRUSTED_BOOTSTRAP'\n" + script + "CLANKERBOX_TRUSTED_BOOTSTRAP\n"
	}
	return script, nil
}
func (n *NativeRuntime) Prepare(ctx context.Context, m Manifest, keys []string) (string, string, string, error) {
	script, err := bootstrapScript(m, keys)
	if err != nil {
		return "", "", "", err
	}
	call, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	out, err := n.guest(call, m, script)
	if err != nil {
		return "", "", "", err
	}
	// Use exactly one public-key line from the trusted runtime channel.
	key := strings.TrimSpace(string(out))
	canonical, err := model.ValidateKeys([]string{key})
	if err != nil || len(canonical) != 1 {
		return "", "", "", fmt.Errorf("trusted bootstrap returned invalid host key: %q", key)
	}
	state, err := n.Inspect(ctx, m)
	if err != nil {
		return "", "", "", err
	}
	if state.State != model.Running {
		return "", "", "", errors.New("guest stopped during preparation")
	}
	user := "root"
	if m.Profile.Runtime == "tart" {
		user = "admin"
	}
	return user, canonical[0], state.Endpoint, nil
}
