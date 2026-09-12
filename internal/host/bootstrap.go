package host

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net"

	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"clankerbox/internal/model"
)

// bootstrapScript contains only fixed shell source, a checked hex ID and base64
// data made from parsed public keys. No caller-controlled shell syntax is used.
// The guest's durable claim is written before generating its single new key:
// reply loss resumes that identity, never rotates it. Starts only verify it.
func bootstrapScript(m Manifest, initialize bool) (string, error) {
	if !model.ValidID(m.ID) {
		return "", errors.New("invalid bootstrap ID")
	}
	user, home, decode := rootUser, rootHome, linuxDecode
	if m.Profile.Runtime == runtimeTart {
		user = adminUser
		home = adminHome
		decode = macDecode
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
AllowTcpForwarding no
PermitTTY no
MaxSessions 64
AllowStreamLocalForwarding no
GatewayPorts no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
UsePAM yes
StrictModes yes
PidFile /var/run/clankerbox-sshd.pid
`
	if m.Profile.Runtime == runtimeTart {
		// Noninteractive SSH does not read the image's Homebrew login profile.
		config += "SetEnv PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin\n"
	}
	cfgData := base64.StdEncoding.EncodeToString([]byte(config))
	var s strings.Builder
	s.WriteString("set -eu\numask 077\n")
	if m.Profile.Runtime == runtimeSmolvm {
		// The bare rootfs is staged by the unprivileged host account. Restore
		// sshd's required ownership inside the guest, before validating config.
		s.WriteString("mkdir -p /run/sshd\nchown 0:0 /run/sshd /root /etc/ssh\nchmod 0755 /run/sshd\n")
	}
	if initialize && m.SourceMachineID != "" {
		if err := installChildIdentity(&s, m, decode); err != nil {
			return "", err
		}
	}

	if initialize {
		s.WriteString(
			"if [ ! -e /etc/clankerbox/owner ]; then\n  test ! -e /etc/clankerbox\n  mkdir -m 700 /etc/clankerbox\n  printf '%s\\n' '" + m.ID + "' > /etc/clankerbox/owner\n  sync\nfi\n",
		)
	}
	s.WriteString("test \"$(cat /etc/clankerbox/owner)\" = '" + m.ID + "'\n")
	if initialize {
		if m.SourceMachineID == "" {
			s.WriteString(
				"if [ ! -e /etc/clankerbox/ssh_host_ed25519_key ]; then\n  /usr/bin/ssh-keygen -q -t ed25519 -N '' -f /etc/clankerbox/ssh_host_ed25519_key\n  sync\nfi\n",
			)
		}
		s.WriteString(
			"/usr/bin/ssh-keygen -y -f /etc/clankerbox/ssh_host_ed25519_key > /etc/clankerbox/ssh_host_ed25519_key.pub\n",
		)
		s.WriteString(
			"mkdir -p '" + home + "/.ssh'\nchmod 700 '" + home + "/.ssh'\n: > '" + home + "/.ssh/authorized_keys'\nchmod 600 '" + home + "/.ssh/authorized_keys'\nchown -R '" + user + "' '" + home + "/.ssh'\nprintf '%s' '" + cfgData + "' | " + decode + " > /etc/ssh/sshd_config\nchmod 600 /etc/ssh/sshd_config\n/usr/sbin/sshd -t\nsync\n",
		)
	} else {
		s.WriteString(
			"test -s /etc/clankerbox/ssh_host_ed25519_key\ntest -s /etc/clankerbox/prepared\n/usr/sbin/sshd -t\n",
		)
	}
	writeSSHDStart(&s, m.Profile.Runtime, initialize)
	if initialize {
		s.WriteString("printf '%s\\n' '" + m.ID + "' > /etc/clankerbox/prepared\nsync\n")
	}
	s.WriteString("/usr/bin/ssh-keygen -y -f /etc/clankerbox/ssh_host_ed25519_key\n")
	script := s.String()
	if m.Profile.Runtime == runtimeTart {
		script = "sudo -n /bin/bash -se <<'CLANKERBOX_TRUSTED_BOOTSTRAP'\n" + script + "CLANKERBOX_TRUSTED_BOOTSTRAP\n"
	}
	return script, nil
}

// prepare installs or verifies the guest SSH identity through trusted runtime execution.
func (n *NativeRuntime) prepare(ctx context.Context, m Manifest, initialize bool) (string, string, string, error) {
	script, err := bootstrapScript(m, initialize)
	if err != nil {
		return "", "", "", err
	}
	call, cancel := context.WithTimeout(ctx, guestReadyTimeout)
	defer cancel()
	out, err := n.guest(call, m, script)
	if err != nil {
		return "", "", "", err
	}
	// Use exactly one public-key line from the trusted runtime channel.
	key := strings.TrimSpace(string(out))
	canonical, err := model.ValidateKey(key)
	if err != nil {
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
	if m.Profile.Runtime == runtimeTart {
		user = "admin"
	}
	if m.SourceMachineID != "" && initialize {
		if canonical != m.SSHHostKey {
			return "", "", "", errors.New("fresh host key was not installed")
		}
		if err = waitSSHIdentity(call, state.Endpoint, m.SSHHostKey); err != nil {
			return "", "", "", err
		}
	}
	return user, canonical, state.Endpoint, nil
}

// Readiness follows a handshake with the new daemon key, not merely writing it.
// No guest login or application process is needed to verify the host identity.
func waitSSHIdentity(ctx context.Context, endpoint, want string) error {
	verified := errors.New("host identity verified")
	for {
		conn, err := (&net.Dialer{Timeout: identityAttemptTimeout}).DialContext(ctx, "tcp", endpoint)
		if err == nil {
			if deadlineErr := conn.SetDeadline(time.Now().Add(identityAttemptTimeout)); deadlineErr != nil {
				return errors.Join(deadlineErr, conn.Close())
			}
			_, _, _, err = ssh.NewClientConn(
				conn,
				endpoint,
				&ssh.ClientConfig{
					User: "clankerbox-identity-check",
					HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
						if strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))) == want {
							return verified
						}
						return errors.New("inherited SSH host key still active")
					},
				},
			)
			// NewClientConn closes the transport when the callback aborts the handshake.
			if errors.Is(err, verified) {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("fresh SSH identity not ready: %w", ctx.Err())
		case <-time.After(identityRetryInterval):
		}
	}
}

func installChildIdentity(s *strings.Builder, m Manifest, decode string) error {
	if !model.ValidID(m.SourceMachineID) || m.SSHPrivateKey == "" {
		return errors.New("persisted child identity required")
	}
	signer, err := ssh.ParsePrivateKey([]byte(m.SSHPrivateKey))
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey()))) != m.SSHHostKey {
		return errors.New("persisted child SSH identity mismatch")
	}
	private := base64.StdEncoding.EncodeToString([]byte(m.SSHPrivateKey))
	s.WriteString(
		"owner=$(cat /etc/clankerbox/owner)\ncase \"$owner\" in '" + m.SourceMachineID + "'|'" + m.ID + "') ;; *) exit 1 ;; esac\n",
	)
	s.WriteString(
		"printf '%s' '" + private + "' | " + decode + " > /etc/clankerbox/ssh_host_ed25519_key\nchmod 600 /etc/clankerbox/ssh_host_ed25519_key\nprintf '%s\\n' '" + m.ID + "' > /etc/clankerbox/owner\nrm -f /etc/clankerbox/prepared\nsync\n",
	)
	return nil
}

func writeSSHDStart(s *strings.Builder, runtime string, initialize bool) {
	if runtime == runtimeTart {
		// Private DHCP DNS servers are deliberately unreachable through Softnet.
		// The supported Tart image names its primary network service Ethernet.
		if initialize {
			s.WriteString("/usr/sbin/networksetup -setdnsservers Ethernet 1.1.1.1 8.8.8.8\n")
		}
		s.WriteString(
			"/bin/launchctl enable system/com.openssh.sshd\nif ! /bin/launchctl print system/com.openssh.sshd >/dev/null 2>&1; then\n  /bin/launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist\nfi\n",
		)
	} else {
		// The supported bare profile has smolvm-agent as init, not guest systemd.
		// sshd's daemon mode survives the short synchronous guest exec command.
		s.WriteString(
			"mkdir -p /run/sshd\nif [ -s /var/run/clankerbox-sshd.pid ] && kill -0 \"$(cat /var/run/clankerbox-sshd.pid)\" 2>/dev/null; then\n  kill -HUP \"$(cat /var/run/clankerbox-sshd.pid)\"\nelse\n  rm -f /var/run/clankerbox-sshd.pid\n  /usr/sbin/sshd -f /etc/ssh/sshd_config\nfi\n",
		)
	}
}

// Initialize establishes the owned guest identity during create/fork/restore.
func (n *NativeRuntime) Initialize(ctx context.Context, m Manifest) (string, string, string, error) {
	return n.prepare(ctx, m, true)
}

// Verify checks the existing identity on start without rotating keys.
func (n *NativeRuntime) Verify(ctx context.Context, m Manifest) (string, string, string, error) {
	return n.prepare(ctx, m, false)
}
