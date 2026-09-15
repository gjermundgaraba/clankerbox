package host

import (
	"context"
	"database/sql"
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
	if !model.ValidID(id) {
		return Manifest{}, model.NewError(model.ReasonInvalid, "invalid machine ID", false)
	}
	m, err := h.manifest(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Manifest{}, model.NewError(model.ReasonNotFound, "owned machine not found", false)
	}
	if err != nil {
		return Manifest{}, err
	}
	if !m.Prepared || m.Deleted {
		return Manifest{}, model.NewError(model.ReasonPrerequisite, "machine is not prepared", false)
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
		return Manifest{}, model.NewError(model.ReasonReconciliationRequired, "machine operation is unresolved", false)
	}
	obs, err := h.observation(ctx, m)
	if err != nil {
		return Manifest{}, err
	}
	if obs.State != model.Running {
		return Manifest{}, model.NewError(model.ReasonNotRunning, "machine is not running", false)
	}
	if err = validEndpoint(m, obs.Endpoint); err != nil {
		return Manifest{}, err
	}
	m.Endpoint = obs.Endpoint
	return m, nil
}

// guestBinary reads the deployed guest binary for the machine's platform.
func (n *NativeRuntime) guestBinary(m Manifest) ([]byte, error) {
	goos := hostLinux
	if m.Profile.Runtime == runtimeTart {
		goos = hostDarwin
	}
	name := "clankerbox-guest-" + goos + "-" + m.Profile.Arch
	path := filepath.Join(n.Config.Root, guestBinaryDir, name)
	data, err := os.ReadFile(path) //nolint:gosec // Operator-deployed artifact under Root.
	if err != nil {
		return nil, fmt.Errorf("guest binary %s is not deployed: %w", name, err)
	}
	return data, nil
}

// guestInstall runs a fixed installer command with binding credentials on stdin.
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

	return script
}
