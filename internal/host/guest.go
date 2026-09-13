package host

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"clankerbox/internal/model"
)

const (
	guestShell      = "/bin/sh"
	guestBinaryDir  = "guest"
	guestBinaryPath = "/usr/local/bin/clankerbox-guest"
)

// readyMachine resolves the current endpoint only after the owned generation succeeds.
// Callers hold admission only until registering a cancellable guest lease.
func (h *Helper) readyMachine(ctx context.Context, id string) (Manifest, error) {
	if err := h.cfg.quarantineError(id); err != nil {
		return Manifest{}, err
	}
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
	goos := hostLinux
	if m.Profile.Runtime == runtimeTart {
		goos = hostDarwin
	}
	name := "clankerbox-guest-" + goos + "-" + m.Profile.Arch
	path := filepath.Join(h.cfg.Root, guestBinaryDir, name)
	data, err := os.ReadFile(path) //nolint:gosec // Operator-deployed artifact under Root.
	if err != nil {
		return nil, fmt.Errorf("guest binary %s is not deployed: %w", name, err)
	}
	return data, nil
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
