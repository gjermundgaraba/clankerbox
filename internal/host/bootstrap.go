package host

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcidentity"
	"clankerbox/internal/statefs"

	"connectrpc.com/connect"
)

func guestStatePath(m Manifest) string {
	if m.Profile.Runtime == runtimeTart {
		return "/private/var/lib/clankerbox-guest"
	}
	return "/var/lib/clankerbox-guest"
}

// Initialize installs and binds the dedicated guest service after creation.
func (n *NativeRuntime) Initialize(ctx context.Context, m Manifest) (string, error) {
	return n.prepareRPC(ctx, m, true)
}

// Verify authenticates the retained service, renewing its identity when required.
func (n *NativeRuntime) Verify(ctx context.Context, m Manifest) (string, error) {
	return n.prepareRPC(ctx, m, false)
}

func bindingPath(cfg Config, m Manifest) string {
	return filepath.Join(machineDir(cfg, m), "guest-binding.json")
}
func loadBinding(cfg Config, m Manifest, a *rpcidentity.Authority, initial bool) (rpcidentity.Binding, error) {
	path := bindingPath(cfg, m)
	raw, err := statefs.ReadRegular(path)
	switch {
	case err == nil:
		var b rpcidentity.Binding
		if err = json.Unmarshal(raw, &b); err != nil {
			return b, err
		}
		if b.MachineID != m.ID || b.HostID != cfg.HostID {
			return b, errors.New("retained guest binding identity mismatch")
		}
		if !rpcidentity.Expiring(b.Certificate) {
			return b, nil
		}
	case !errors.Is(err, os.ErrNotExist):
		return rpcidentity.Binding{}, err
	case !initial:
		return rpcidentity.Binding{}, errors.New(
			"prerequisite: retained machine requires explicit guest RPC identity cutover",
		)
	}
	b, err := a.Binding(m.ID, cfg.HostID)
	if err != nil {
		return b, err
	}
	//nolint:gosec // The guest private key is deliberately stored in a private binding file.
	raw, err = json.Marshal(b)
	if err != nil {
		return b, err
	}
	return b, statefs.WritePrivate(path, raw)
}

func (n *NativeRuntime) prepareRPC(ctx context.Context, m Manifest, initial bool) (string, error) {
	if !model.ValidID(m.ID) || !model.ValidName(n.Config.HostID) {
		return "", errors.New("valid machine and host identities required for guest binding")
	}
	a, err := rpcidentity.LoadOrCreate(filepath.Join(n.Config.Root, "guest-authority"))
	if err != nil {
		return "", err
	}
	defer func() { _ = a.Close() }()
	binding, err := loadBinding(n.Config, m, a, initial)
	if err != nil {
		return "", err
	}
	credentials, err := a.HostCredentials(n.Config.HostID)
	if err != nil {
		return "", err
	}
	if err = n.installGuestService(ctx, m, binding, initial); err != nil {
		return "", err
	}
	return n.waitGuestIdentity(ctx, m, credentials)
}

func (n *NativeRuntime) installGuestService(
	ctx context.Context,
	m Manifest,
	binding rpcidentity.Binding,
	initial bool,
) error {
	guestState := guestStatePath(m)
	guestBinding := guestState + "/binding.json"
	binary, err := (&Helper{cfg: n.Config}).guestBinary(m)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(binary)
	digest := hex.EncodeToString(sum[:])
	installed, err := n.guest(ctx, m, guestDigestScript(m))
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(installed)) != digest {
		if err = n.guestInstall(ctx, m, guestInstallScript(m, digest), binary); err != nil {
			return err
		}
	}
	script, err := provisionGuestScript(m)
	if err != nil {
		return err
	}
	if _, err = n.guest(ctx, m, script); err != nil {
		return err
	}
	//nolint:gosec // Trusted native stdin delivers the private guest binding.
	raw, err := json.Marshal(binding)
	if err != nil {
		return err
	}
	install := "set -eu\numask 077\ncat > " + guestBinding + ".tmp\nchmod 600 " + guestBinding + ".tmp\nchown 0:0 " + guestBinding + ".tmp\nmv -f " + guestBinding + ".tmp " + guestBinding + "\nsync\n"
	if err = n.guestInstall(ctx, m, install, raw); err != nil {
		return err
	}
	// Exit 3 specifically means there is no listening daemon. Other failures never
	// become permission to replace a live manager or cold-restore a RAM child.
	rebind := "set +e\n" + guestBinaryPath + " rebind --state-dir " + guestState + " < " + guestBinding + "\ncode=$?\nif [ \"$code\" -eq 0 ]; then printf 'bound\\n'; elif [ \"$code\" -eq 3 ]; then printf 'absent\\n'; else exit \"$code\"; fi\n"
	out, err := n.guest(ctx, m, privilegedScript(m, rebind))
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(out)) == "absent" {
		if initial && m.Profile.Runtime == runtimeSmolvm && m.SourceMachineID != "" {
			return errors.New("RAM child daemon is absent; refusing cold session substitution")
		}
		command := guestBinaryPath + " serve --state-dir " + guestState + " --binding-file " + guestBinding + " --listen 0.0.0.0:7443 --workload-user clankerbox"
		launch := "set -eu\numask 077\nnohup " + command + " > " + guestState + "/daemon.log 2>&1 < /dev/null &\n"
		if _, err = n.guest(ctx, m, privilegedScript(m, launch)); err != nil {
			return err
		}
	} else if strings.TrimSpace(string(out)) != "bound" {
		return errors.New("guest did not acknowledge identity binding")
	}

	return nil
}

func (n *NativeRuntime) waitGuestIdentity(
	ctx context.Context,
	m Manifest,
	credentials rpcidentity.Credentials,
) (string, error) {
	state, err := n.Inspect(ctx, m)
	if err != nil {
		return "", err
	}
	if state.State != model.Running {
		return "", errors.New("guest stopped during preparation")
	}
	httpClient, err := credentials.HTTPClient(m.ID)
	if err != nil {
		return "", err
	}
	defer httpClient.CloseIdleConnections()
	client := clankerboxv1connect.NewGuestServiceClient(httpClient, "https://"+state.Endpoint)
	deadline, cancel := context.WithTimeout(ctx, guestReadyTimeout)
	defer cancel()
	for {
		call, done := context.WithTimeout(deadline, identityAttemptTimeout)
		result, e := client.DescribeGuest(call, connect.NewRequest(&v1.DescribeGuestRequest{MachineId: m.ID}))
		done()
		if e == nil && result.Msg.GetMachineId() == m.ID && result.Msg.GetUser() == "clankerbox" {
			return state.Endpoint, nil
		}
		select {
		case <-deadline.Done():
			return "", fmt.Errorf("guest TLS identity readiness: %w (last: %w)", deadline.Err(), e)
		case <-time.After(identityRetryInterval):
		}
	}
}

func privilegedScript(m Manifest, script string) string {
	if m.Profile.Runtime == runtimeTart {
		return "sudo -n /bin/bash -se <<'CLANKERBOX_ROOT_BOOTSTRAP'\n" + script + "CLANKERBOX_ROOT_BOOTSTRAP\n"
	}
	return script
}

// Only system directories and the dedicated service account are provisioned.
// The root daemon's identity/admin socket remains inaccessible to PTY workloads.
func provisionGuestScript(m Manifest) (string, error) {
	if !model.ValidID(m.ID) {
		return "", errors.New("invalid owned machine identity")
	}
	s := fmt.Sprintf("set -eu\numask 077\nhost_uid=%d\nstate_dir=%s\n", os.Geteuid(), guestStatePath(m))
	if m.Profile.Runtime == runtimeSmolvm {
		s += `for d in / /usr /usr/local /usr/local/bin /bin /sbin /etc /lib /lib64 /var /var/lib /home; do
 if [ -d "$d" ]; then chown 0:0 "$d"; chmod 755 "$d"; fi
done
for d in /usr /lib /lib64; do if [ -d "$d" ]; then find "$d" -type d -exec chmod 755 {} \;; fi; done
chown 0:0 /tmp; chmod 1777 /tmp
if ! id clankerbox >/dev/null 2>&1; then
 uid=32001
 while [ "$uid" = "$host_uid" ] || [ -n "$(awk -F: -v uid="$uid" '$3 == uid { print $1 }' /etc/passwd)" ]; do
  uid=$((uid + 1)); test "$uid" -lt 60000
 done
 if command -v useradd >/dev/null 2>&1; then useradd -u "$uid" -m -s /bin/sh clankerbox; else adduser -u "$uid" -D -h /home/clankerbox -s /bin/sh clankerbox; fi
fi
uid=$(id -u clankerbox); test "$uid" -ge 1000; test "$uid" != "$host_uid"
for d in /usr /etc /lib /lib64 /bin /sbin; do
 if [ -d "$d" ]; then test -z "$(find "$d" -xdev -uid "$uid" -print -quit)"; fi
done
home=/home/clankerbox
mkdir -p "$home"; chown clankerbox "$home"; chmod 700 "$home"
`
	} else {
		s += `if ! id clankerbox >/dev/null 2>&1; then
 test -z "$(dscl . -search /Users UniqueID 1001)"
 dscl . -create /Users/clankerbox
 dscl . -create /Users/clankerbox UniqueID 1001
 dscl . -create /Users/clankerbox PrimaryGroupID 20
 dscl . -create /Users/clankerbox UserShell /bin/zsh
 dscl . -create /Users/clankerbox NFSHomeDirectory /Users/clankerbox
 dscl . -create /Users/clankerbox Password '*'
fi
test "$(id -u clankerbox)" -ge 501
mkdir -p /Users/clankerbox; chown clankerbox:staff /Users/clankerbox; chmod 700 /Users/clankerbox
`
	}
	s += `for group in $(id -Gn clankerbox); do case "$group" in root|wheel|sudo|admin) echo 'workload account has privileged membership' >&2; exit 1;; esac; done
test ! -L "$state_dir"
mkdir -p "$state_dir"
chown 0:0 "$state_dir"
chmod 700 "$state_dir"
`
	return privilegedScript(m, s), nil
}
