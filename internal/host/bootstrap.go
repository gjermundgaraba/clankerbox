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

type guestPreparation string

const (
	guestBind   guestPreparation = "bind"
	guestStart  guestPreparation = "start"
	guestRebind guestPreparation = "rebind"
)

// BindGuest installs a fresh machine identity into a prepared image or RAM child.
func (n *NativeRuntime) BindGuest(ctx context.Context, m Manifest) (string, error) {
	return n.prepareGuest(ctx, m, guestBind)
}

// StartGuest authenticates a retained guest, starting its daemon after a cold boot.
func (n *NativeRuntime) StartGuest(ctx context.Context, m Manifest) (string, error) {
	return n.prepareGuest(ctx, m, guestStart)
}

// RebindGuest renews a live manager. An absent daemon is never a cold-start request.
func (n *NativeRuntime) RebindGuest(ctx context.Context, m Manifest) (string, error) {
	return n.prepareGuest(ctx, m, guestRebind)
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
	b.Pending = true
	//nolint:gosec // The guest private key is deliberately stored in a private binding file.
	raw, err = json.Marshal(b)
	if err != nil {
		return b, err
	}
	return b, statefs.WritePrivate(path, raw)
}

func (n *NativeRuntime) prepareGuest(ctx context.Context, m Manifest, mode guestPreparation) (_ string, resultErr error) {
	defer n.trace(ctx, m, "guest-prepare")(&resultErr)
	if !model.ValidID(m.ID) || !model.ValidName(n.Config.HostID) {
		return "", errors.New("valid machine and host identities required for guest binding")
	}
	a := n.authority
	if a == nil {
		return "", errors.New("host guest authority is not initialized")
	}
	binding, err := loadBinding(n.Config, m, a, mode == guestBind)
	if err != nil {
		return "", err
	}
	credentials, err := a.HostCredentials(n.Config.HostID)
	if err != nil {
		return "", err
	}
	// A healthy retained identity needs no native exec, rebind, or state rewrite.
	if mode == guestStart && !binding.Pending {
		probe, cancel := context.WithTimeout(ctx, identityAttemptTimeout)
		endpoint, probeErr := n.probeGuestIdentity(probe, m, credentials)
		cancel()
		if probeErr == nil {
			return endpoint, nil
		}
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
	}
	if err = n.ensureGuestService(ctx, m, binding, mode); err != nil {
		return "", err
	}
	endpoint, err := n.waitGuestIdentity(ctx, m, credentials)
	if err != nil {
		return "", err
	}
	if !binding.Pending {
		return endpoint, nil
	}
	binding.Pending = false
	//nolint:gosec // Binding credentials are persisted only through statefs mode 0600.
	raw, err := json.Marshal(binding)
	if err != nil {
		return "", err
	}
	return endpoint, statefs.WritePrivate(bindingPath(n.Config, m), raw)
}

func (n *NativeRuntime) ensureGuestService(
	ctx context.Context,
	m Manifest,
	binding rpcidentity.Binding,
	mode guestPreparation,
) error {
	if err := n.waitGuestExecution(ctx, m); err != nil {
		return err
	}
	guestState := guestStatePath(m)
	guestBinding := guestState + "/binding.json"
	if err := n.checkPreparedGuest(ctx, m); err != nil {
		return err
	}
	if mode == guestBind {
		if _, err := n.guest(ctx, m, guestPrivateStateScript(m)); err != nil {
			return err
		}
	}
	if binding.Pending {
		if err := n.installGuestBinding(ctx, m, binding); err != nil {
			return err
		}
	}
	// Exit 3 specifically means there is no listening daemon. Other failures never
	// become permission to replace a live manager or cold-restore a RAM child.
	rebind := "set +e\n" + guestBinaryPath + " rebind --state-dir " + guestState + " < " + guestBinding + "\ncode=$?\nif [ \"$code\" -eq 0 ]; then printf 'bound\\n'; elif [ \"$code\" -eq 3 ]; then printf 'absent\\n'; else exit \"$code\"; fi\n"
	out, err := n.guest(ctx, m, privilegedScript(m, rebind))
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(out)) == "absent" {
		if mode == guestRebind || (mode == guestBind && m.Profile.Runtime == runtimeSmolvm && m.SourceMachineID != "") {
			return errors.New("live guest daemon is absent; refusing cold session substitution")
		}
		command := guestBinaryPath + " serve --state-dir " + guestState + " --binding-file " + guestBinding + " --listen 0.0.0.0:7443"
		launch := "set -eu\numask 077\nnohup " + command + " > " + guestState + "/daemon.log 2>&1 < /dev/null &\n"
		if _, err = n.guest(ctx, m, privilegedScript(m, launch)); err != nil {
			return err
		}
	} else if strings.TrimSpace(string(out)) != "bound" {
		return errors.New("guest did not acknowledge identity binding")
	}

	return nil
}

// probeGuestIdentity makes one authenticated read, without polling or native effects.
func (n *NativeRuntime) probeGuestIdentity(ctx context.Context, m Manifest, credentials rpcidentity.Credentials) (string, error) {
	if err := validEndpoint(m, m.Endpoint); err != nil {
		return "", err
	}
	httpClient, err := credentials.HTTPClient(m.ID)
	if err != nil {
		return "", err
	}
	defer httpClient.CloseIdleConnections()
	client := clankerboxv1connect.NewSessionServiceClient(httpClient, "https://"+m.Endpoint)
	if err = checkGuestIdentity(ctx, client, m.ID); err != nil {
		return "", err
	}
	return m.Endpoint, nil
}

// checkGuestIdentity performs one authenticated request using the caller's client.
// Endpoint discovery, connection lifetime and retry policy belong to the caller.
func checkGuestIdentity(ctx context.Context, client clankerboxv1connect.SessionServiceClient, machine string) error {
	result, err := client.DescribeGuest(ctx, connect.NewRequest(&v1.DescribeGuestRequest{MachineId: machine}))
	if err != nil {
		return err
	}
	if result.Msg.GetMachineId() != machine {
		return errors.New("guest identity mismatch")
	}
	return nil
}

func (n *NativeRuntime) waitGuestIdentity(
	ctx context.Context,
	m Manifest,
	credentials rpcidentity.Credentials,
) (_ string, resultErr error) {
	defer n.trace(ctx, m, "guest-authenticate")(&resultErr)
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
	client := clankerboxv1connect.NewSessionServiceClient(httpClient, "https://"+state.Endpoint)
	deadline, cancel := context.WithTimeout(ctx, guestReadyTimeout)
	defer cancel()
	for {
		call, done := context.WithTimeout(deadline, identityAttemptTimeout)
		err = checkGuestIdentity(call, client, m.ID)
		done()
		if err == nil {
			return state.Endpoint, nil
		}
		select {
		case <-deadline.Done():
			return "", fmt.Errorf("guest TLS identity readiness: %w (last: %w)", deadline.Err(), err)
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

// Prepared images own static installation. Directory-image ownership still needs
// a bounded guest-root cutover for private state ancestors.
func guestPrivateStateScript(m Manifest) string {
	ownership := ""
	if m.Profile.Runtime == runtimeSmolvm {
		// The lower image inherits the host operator's UID. These few overlay
		// metadata changes establish statefs trust without walking the image.
		ownership = "chown 0:0 / /var /var/lib\nchmod 755 / /var /var/lib\n"
	}
	return privilegedScript(m, "set -eu\numask 077\n"+ownership+
		"test ! -L "+guestStatePath(m)+"\n"+
		"mkdir -p "+guestStatePath(m)+"\n"+
		"chown 0:0 "+guestStatePath(m)+"\nchmod 700 "+guestStatePath(m)+"\n")
}

func preparedGuestScript(m Manifest) string {
	s := "set -eu\ntest \"$(cat /usr/local/share/clankerbox/prepared)\" = clankerbox-prepared-v2\n"
	return privilegedScript(m, s+guestDigestScript(m))
}

func (n *NativeRuntime) checkPreparedGuest(ctx context.Context, m Manifest) (resultErr error) {
	defer n.trace(ctx, m, "guest-image-check")(&resultErr)
	binary, err := n.guestBinary(m)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(binary)
	installed, err := n.guest(ctx, m, preparedGuestScript(m))
	if err != nil {
		return fmt.Errorf("prepared guest image required: %w", err)
	}
	if strings.TrimSpace(string(installed)) != hex.EncodeToString(sum[:]) {
		return errors.New("prepared guest binary differs from deployed binary; rebuild image")
	}
	return nil
}

func (n *NativeRuntime) installGuestBinding(ctx context.Context, m Manifest, binding rpcidentity.Binding) (resultErr error) {
	defer n.trace(ctx, m, "guest-binding-install")(&resultErr)
	//nolint:gosec // Trusted native stdin delivers only the private machine binding.
	raw, err := json.Marshal(binding)
	if err != nil {
		return err
	}
	path := guestStatePath(m) + "/binding.json"
	install := "set -eu\numask 077\ncat > " + path + ".tmp\nchmod 600 " + path + ".tmp\nchown 0:0 " + path + ".tmp\nmv -f " + path + ".tmp " + path + "\nsync\n"
	return n.guestInstall(ctx, m, install, raw)
}

// Tart reports a running VM before its guest agent accepts exec requests.
// Retry only a side-effect-free readiness command, never bootstrap mutations.
func (n *NativeRuntime) waitGuestExecution(ctx context.Context, m Manifest) (resultErr error) {
	defer n.trace(ctx, m, "guest-execution-ready")(&resultErr)
	if m.Profile.Runtime != runtimeTart {
		return nil
	}
	const agentReadyTimeout = 90 * time.Second
	ready, cancel := context.WithTimeout(ctx, agentReadyTimeout)
	defer cancel()
	var last error
	for {
		probe, done := context.WithTimeout(ready, connectionTimeout)
		_, last = n.Runner.Run(
			probe,
			n.Config.TartPath,
			[]string{runtimeExec, m.RuntimeName(), "/usr/bin/true"},
			n.env(m),
			nil,
		)
		done()
		if last == nil {
			return nil
		}
		select {
		case <-ready.Done():
			return fmt.Errorf("waiting for Tart guest execution: %w (last probe: %w)", ready.Err(), last)
		case <-time.After(time.Second):
		}
	}
}
