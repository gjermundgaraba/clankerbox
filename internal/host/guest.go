package host

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"clankerbox/internal/model"
)

const (
	rootUser        = "root"
	adminUser       = "admin"
	rootHome        = "/root"
	adminHome       = "/Users/admin"
	linuxDecode     = "base64 -d"
	macDecode       = "/usr/bin/base64 -D"
	guestShell      = "/bin/sh"
	guestBinaryDir  = "guest"
	guestBinaryPath = "/usr/local/bin/clankerbox-guest"
	guestKeyComment = "clankerbox-terminal"
)

// PrepareGuest installs the terminal key and the guest
// session binary through the trusted runtime channel.
func (h *Helper) PrepareGuest(ctx context.Context, id, publicKey string) (resultErr error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	lock, err := h.state.Lock(".lock", true)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, lock.Close()) }()
	canonicalKey, err := model.ValidateKey(publicKey)
	if err != nil {
		return errors.New("invalid terminal public key")
	}
	m, err := h.readyMachine(ctx, id)
	if err != nil {
		return err
	}
	rt, ok := h.runtime.(interface {
		PrepareGuest(context.Context, Manifest, string, []byte) error
	})
	if !ok {
		return errors.New("runtime does not support guest preparation")
	}
	binary, err := h.guestBinary(m)
	if err != nil {
		return err
	}
	return rt.PrepareGuest(ctx, m, canonicalKey, binary)
}

// readyMachine resolves the current endpoint only after the owned generation succeeds.
// Callers retain their own mutation locks; Connect never holds one for a stream lifetime.
func (h *Helper) readyMachine(ctx context.Context, id string) (Manifest, error) {
	if !model.ValidID(id) {
		return Manifest{}, errors.New("invalid machine ID")
	}
	m, err := h.manifest(ctx, id)
	if err != nil {
		return Manifest{}, err
	}
	if !m.Prepared || m.Deleted {
		return Manifest{}, errors.New("machine is not prepared")
	}
	var body []byte
	if err = h.db.QueryRowContext(ctx, "SELECT body FROM operations WHERE machine_id=? AND generation=?", id, m.Generation).
		Scan(&body); err != nil {
		return Manifest{}, err
	}
	var op accepted
	if err = json.Unmarshal(body, &op); err != nil {
		return Manifest{}, err
	}
	if op.Response.Status != statusSucceeded {
		return Manifest{}, errors.New("machine operation is unresolved")
	}
	obs, err := h.observation(ctx, m)
	if err != nil {
		return Manifest{}, err
	}
	if obs.State != model.Running {
		return Manifest{}, errors.New("machine is not running")
	}
	if err = validEndpoint(m, obs.Endpoint); err != nil {
		return Manifest{}, err
	}
	m.Endpoint = obs.Endpoint
	return m, nil
}

// guestBinary reads the deployed guest binary for the machine's platform.
func (h *Helper) guestBinary(m Manifest) ([]byte, error) {
	goos := "linux"
	if m.Profile.Runtime == runtimeTart {
		goos = "darwin"
	}
	name := "clankerbox-guest-" + goos + "-" + m.Profile.Arch
	path := filepath.Join(h.cfg.Root, guestBinaryDir, name)
	data, err := os.ReadFile(path) //nolint:gosec // Operator-deployed artifact under Root.
	if err != nil {
		return nil, fmt.Errorf("guest binary %s is not deployed: %w", name, err)
	}
	return data, nil
}

// PrepareGuest installs the binary when its digest differs, then the key line
// in an already running guest.
func (n *NativeRuntime) PrepareGuest(ctx context.Context, m Manifest, publicKey string, binary []byte) error {
	digest := sha256.Sum256(binary)
	want := hex.EncodeToString(digest[:])
	call, cancel := context.WithTimeout(ctx, guestReadyTimeout)
	defer cancel()
	installed, err := n.guest(call, m, guestDigestScript(m))
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(installed)) != want {
		if err = n.guestInstall(call, m, guestInstallScript(m, want), binary); err != nil {
			return err
		}
	}
	script, err := guestKeyScript(m, publicKey)
	if err != nil {
		return err
	}
	_, err = n.guest(call, m, script)
	return err
}

// guestInstall runs a fixed installer command with the binary on stdin.
func (n *NativeRuntime) guestInstall(ctx context.Context, m Manifest, script string, payload []byte) error {
	path := n.Config.SmolvmPath
	var args []string
	if m.Profile.Runtime == runtimeTart {
		path = n.Config.TartPath
		args = []string{runtimeExec, "-i", m.RuntimeName(), "sudo", "-n", "/bin/bash", "-c", script}
	} else {
		args = []string{
			smolvmMachineCommand,
			runtimeExec,
			nameFlag,
			m.RuntimeName(),
			"-i",
			"--",
			guestShell,
			"-c",
			script,
		}
	}
	_, err := n.Runner.Run(ctx, path, args, n.env(m), payload)
	return err
}

func guestDigestTool(m Manifest) string {
	if m.Profile.Runtime == runtimeTart {
		return "/usr/bin/shasum -a 256"
	}
	return "sha256sum"
}

// guestDigestScript prints the installed binary digest, or nothing when absent.
func guestDigestScript(m Manifest) string {
	script := "if [ -x " + guestBinaryPath + " ]; then " + guestDigestTool(m) + " " + guestBinaryPath +
		" | cut -d' ' -f1; fi\n"
	if m.Profile.Runtime == runtimeTart {
		return "sudo -n /bin/bash -se <<'CLANKERBOX_GUEST_DIGEST'\n" + script + "CLANKERBOX_GUEST_DIGEST\n"
	}
	return script
}

// guestInstallScript validates stdin against the expected digest and renames
// it into place atomically. A running daemon keeps its old inode.
func guestInstallScript(m Manifest, digest string) string {
	tmp := guestBinaryPath + ".tmp"
	return "set -eu\numask 022\nmkdir -p /usr/local/bin\ncat > '" + tmp + "'\n" +
		"actual=$(" + guestDigestTool(m) + " '" + tmp + "' | cut -d' ' -f1)\n" +
		"if [ \"$actual\" != '" + digest + "' ]; then rm -f '" + tmp + "'; echo 'guest binary digest mismatch' >&2; exit 1; fi\n" +
		"chmod 755 '" + tmp + "'\nchown 0:0 '" + tmp + "'\nmv -f '" + tmp + "' '" + guestBinaryPath + "'\n"
}

// guestKeyScript installs the sole managed terminal key.
func guestKeyScript(m Manifest, publicKey string) (string, error) {
	if !model.ValidID(m.ID) {
		return "", errors.New("invalid machine ID")
	}
	canonicalKey, err := model.ValidateKey(publicKey)
	if err != nil {
		return "", errors.New("invalid terminal public key")
	}
	user, home, decode := rootUser, rootHome, linuxDecode
	if m.Profile.Runtime == runtimeTart {
		user, home, decode = adminUser, adminHome, macDecode
	}
	line := `restrict,command="` + guestBinaryPath + ` proxy" ` + canonicalKey + " " + guestKeyComment
	encoded := base64.StdEncoding.EncodeToString([]byte(line + "\n"))
	script := "set -eu\numask 077\ntest \"$(cat /etc/clankerbox/owner)\" = '" + m.ID + "'\n" +
		"mkdir -p '" + home + "/.ssh'\nkeys='" + home + "/.ssh/authorized_keys'\ntest -f \"$keys\"\n" +
		"printf '%s' '" + encoded + "' | " + decode + " > \"$keys.guest-tmp\"\n" +
		"chmod 600 \"$keys.guest-tmp\"\nchown '" + user + "' \"$keys.guest-tmp\"\nmv \"$keys.guest-tmp\" \"$keys\"\n"
	var b strings.Builder
	b.WriteString(script)
	writeSSHDStart(&b, m.Profile.Runtime, false)
	script = b.String()
	if m.Profile.Runtime == runtimeTart {
		script = "sudo -n /bin/bash -se <<'CLANKERBOX_GUEST_PREPARE'\n" + script + "CLANKERBOX_GUEST_PREPARE\n"
	}
	return script, nil
}
