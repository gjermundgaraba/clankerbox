package client

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"clankerbox/internal/model"
)

// Streams supplies the command input, output and diagnostic destinations.
type Streams struct {
	In  io.Reader
	Out io.Writer
	Err io.Writer
}

func jsonOut(w io.Writer, v any) error { return json.NewEncoder(w).Encode(v) }
func executable() (string, error) {
	p, e := os.Executable()
	if e != nil {
		return "", e
	}
	return filepath.Abs(p)
}
func sshDirectory() string { h, _ := os.UserHomeDir(); return filepath.Join(h, ".ssh") }
func requestKey(s string) (string, error) {
	if s != "" {
		if len(s) > 200 || strings.ContainsAny(s, "\r\n\x00 \t") {
			return "", errors.New("invalid idempotency key")
		}
		return s, nil
	}
	b := make([]byte, requestKeyBytes)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return hex.EncodeToString(b), nil
}

func acquireName(ctx context.Context, a *API, name string) (*Handle, error) {
	p, e := a.Pin(ctx, name)
	if e != nil {
		return nil, e
	}
	b, e := executable()
	if e != nil {
		return nil, e
	}
	h, e := Acquire(ctx, a.Config, p, b)
	return h, e
}
func queryPin(ctx context.Context, a *API, name string) (Pin, error) {
	if model.ValidID(name) {
		pins := map[string]Pin{}
		if e := readJSONFile(filepath.Join(a.Config.StateDir, "trust.json"), &pins); e != nil {
			return Pin{}, e
		}
		if p, ok := pins[a.Config.URL+"\x00"+name]; ok {
			return p, p.Validate()
		}
	}
	return a.Pin(ctx, name)
}
func installPinned(ctx context.Context, a *API, p Pin) error {
	ms, e := a.Machines(ctx)
	if e != nil {
		return e
	}
	found := false
	for _, m := range ms {
		if m.ID == p.ID {
			current, pinMachineErr := PinMachine(a.Config.URL, m)
			if pinMachineErr != nil || current != p {
				return errors.New("machine identity changed during SSH installation")
			}
			found = true
		}
	}
	if !found {
		return errors.New("pinned machine no longer present")
	}
	b, e := executable()
	if e != nil {
		return e
	}
	_, e = InstallSSHConfig(a.Config, b, sshDirectory(), ms)
	return e
}
func (runner commandRunner) hold(ctx context.Context, h *Handle) error {
	ticker := time.NewTicker(statusRefreshInterval)
	defer ticker.Stop()
	for {
		r, e := h.Ports(ctx)
		if e != nil {
			if ctx.Err() != nil {
				return nil
			}
			return e
		}
		if e = runner.output(r); e != nil {
			return e
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
func awaitMapping(ctx context.Context, h *Handle, ep Endpoint) (Mapping, error) {
	ctx, cancel := context.WithTimeout(ctx, forwardReadyTimeout)
	defer cancel()
	ticker := time.NewTicker(forwardPollInterval)
	defer ticker.Stop()
	for {
		r, e := h.Ports(ctx)
		if e != nil {
			return Mapping{}, e
		}
		for _, m := range r.Mappings {
			if m.Guest == ep && m.Available {
				return m, nil
			}
		}
		select {
		case <-ctx.Done():
			return Mapping{}, errors.New("explicit forward is unavailable; inspect ports for conflicts or SSH failure")
		case <-ticker.C:
		}
	}
}

// SSHExitError carries an SSH process status whose diagnostics were already streamed.
type SSHExitError struct{ *exec.ExitError }

func runSSH(ctx context.Context, streams Streams, args ...string) error {
	//nolint:gosec // G204: Execute the fixed SSH program with separate arguments from the local CLI.
	cmd := exec.CommandContext(ctx, "ssh", args...)
	cmd.Stdin = streams.In
	cmd.Stdout = streams.Out
	cmd.Stderr = streams.Err
	err := cmd.Run()
	if exit, ok := errors.AsType[*exec.ExitError](err); ok {
		return &SSHExitError{exit}
	}
	return err
}
func openViewer(ctx context.Context, url string) error {
	command := "xdg-open"
	if runtime.GOOS == "darwin" {
		command = "open"
	}
	//nolint:gosec // G204: The viewer is fixed per platform and receives a validated URL as a separate argument.
	return exec.CommandContext(ctx, command, url).Run()
}
func proxyStdio(ctx context.Context, c net.Conn, in io.Reader, out io.Writer) (err error) {
	closeInput := func() error {
		if closer, ok := in.(io.Closer); ok {
			return closedStreamError(closer.Close())
		}
		return nil
	}
	cleanup := sync.OnceValue(func() error { return errors.Join(closeStream(c), closeInput()) })
	stop := interruptOnCancel(ctx, cleanup)
	defer func() { err = errors.Join(err, stop()) }()
	upstream := make(chan error, 1)
	go func() {
		_, copyErr := io.Copy(c, in)
		var closeErr error
		if cw, ok := c.(interface{ CloseWrite() error }); ok {
			closeErr = closedStreamError(cw.CloseWrite())
		} else {
			closeErr = closeStream(c)
		}
		upstream <- errors.Join(closedStreamError(copyErr), closeErr)
	}()
	_, copyErr := io.Copy(out, c)
	closeErr := cleanup()
	return errors.Join(closedStreamError(copyErr), closeErr, <-upstream)
}

const (
	deleteCommand     = "delete"
	checkpointCommand = "checkpoint"
	forkCommand       = "fork"
	createCommand     = "create"
	openURLCommand    = "open-url"
	portsCommand      = "ports"
)

type commandRunner struct {
	api        *API
	streams    Streams
	structured bool
}

func (runner commandRunner) listResources(ctx context.Context, command string) error {
	var e error
	out := resourceList(command)
	e = runner.api.Do(ctx, "GET", "/v1/"+command, nil, "", out)
	if e != nil {
		return e
	}
	return runner.output(out)
}

func (runner commandRunner) inspectMachine(ctx context.Context, args []string) error {
	m, resolveErr := runner.api.Resolve(ctx, args[0])
	if resolveErr != nil {
		return resolveErr
	}
	return runner.output(m)
}

func (runner commandRunner) inspectOperation(ctx context.Context, args []string) error {
	var e error
	if !model.ValidID(args[0]) {
		return errors.New("operation requires an immutable operation ID")
	}
	var out model.Operation
	if e = runner.api.Do(ctx, "GET", "/v1/operations/"+args[0], nil, "", &out); e != nil {
		return e
	}
	return runner.output(out)
}

func (runner commandRunner) createMachine(
	ctx context.Context,
	name, profile, host, key, idem string,
	wait *waitOptions,
) error {
	var e error
	if key == "" || profile == "" {
		return errors.New("create requires a profile and public key (flags or config defaults)")
	}
	host, e = runner.api.selectHost(ctx, host, profile)
	if e != nil {
		return e
	}
	//nolint:gosec // Read the public-key file explicitly selected by the CLI user.
	b, readFileErr := os.ReadFile(key)
	if readFileErr != nil {
		return readFileErr
	}
	in := model.CreateInput{
		Name:          name,
		Profile:       profile,
		Host:          host,
		SSHPublicKeys: []string{strings.TrimSpace(string(b))},
	}
	if readFileErr = in.Validate(); readFileErr != nil {
		return readFileErr
	}
	id, readFileErr := requestKey(idem)
	if readFileErr != nil {
		return readFileErr
	}
	return runner.mutate(ctx, "/v1/machines", in, id, wait, createCommand)
}

func (runner commandRunner) mutateMachine(ctx context.Context, command, target, idem string, wait *waitOptions) error {
	m, resolveErr2 := runner.api.Resolve(ctx, target)
	if resolveErr2 != nil {
		return resolveErr2
	}
	id, resolveErr2 := requestKey(idem)
	if resolveErr2 != nil {
		return resolveErr2
	}
	return runner.mutate(ctx, "/v1/machines/"+m.ID+"/"+command, nil, id, wait, command)
}

func (runner commandRunner) proxyMachine(ctx context.Context, args []string) (err error) {
	if !model.ValidID(args[0]) {
		return errors.New("proxy requires an immutable machine ID")
	}
	conn, upgradeErr := runner.api.Upgrade(ctx, args[0])
	if upgradeErr != nil {
		return upgradeErr
	}
	defer func() { err = errors.Join(err, closeStream(conn)) }()
	return proxyStdio(ctx, conn, runner.streams.In, runner.streams.Out)
}

func (runner commandRunner) installSSH(ctx context.Context) error {
	binary, executableErr := executable()
	if executableErr != nil {
		return executableErr
	}
	ms, executableErr := runner.api.Machines(ctx)
	if executableErr != nil {
		return executableErr
	}
	paths, executableErr := InstallSSHConfig(runner.api.Config, binary, sshDirectory(), ms)
	if executableErr != nil {
		return executableErr
	}
	return runner.output(map[string]any{"files": paths})
}

func (runner commandRunner) sshMachine(ctx context.Context, args []string) (err error) {
	p, pinErr := runner.api.Pin(ctx, args[0])
	if pinErr != nil {
		return pinErr
	}
	if pinErr = installPinned(ctx, runner.api, p); pinErr != nil {
		return pinErr
	}
	binary, e := executable()
	if e != nil {
		return e
	}
	h, e := Acquire(ctx, runner.api.Config, p, binary)
	if e != nil {
		return e
	}
	defer func() { err = errors.Join(err, h.Close()) }()
	argv := []string{"-F", filepath.Join(runner.api.Config.StateDir, "ssh_config"), "cb." + p.ID}
	return runSSH(ctx, runner.streams, argv...)
}

func (runner commandRunner) serveOwner(ctx context.Context, args []string) error {
	b, decodeStringErr := base64.RawURLEncoding.DecodeString(args[0])
	if decodeStringErr != nil {
		return decodeStringErr
	}
	var p Pin
	if decodeStringErr = json.Unmarshal(b, &p); decodeStringErr != nil {
		return decodeStringErr
	}
	ownerCtx, cancelOwner := context.WithCancel(ctx)
	defer cancelOwner()
	var readinessErr error
	ownerErr := ServeOwner(ownerCtx, runner.api.Config, p, SSHDialer(runner.api), func(startErr error) {
		message := ""
		if startErr != nil {
			message = startErr.Error()
		}
		readinessErr = jsonOut(runner.streams.Out, map[string]string{"error": message})
		if readinessErr != nil {
			cancelOwner()
		}
	})
	return errors.Join(ownerErr, readinessErr)
}

func (runner commandRunner) connectMachine(ctx context.Context, target string, explicit []Endpoint) (err error) {
	h, acquireNameErr := acquireName(ctx, runner.api, target)
	if acquireNameErr != nil {
		return acquireNameErr
	}
	defer func() { err = errors.Join(err, h.Close()) }()
	for _, ep := range explicit {
		if _, acquireNameErr = h.Forward(ctx, ep); acquireNameErr != nil {
			return acquireNameErr
		}
	}
	return runner.hold(ctx, h)
}

func (runner commandRunner) queryForward(ctx context.Context, command string, args []string) error {
	// External URLs need no mapping; validate first and launch without acquiring.
	if command == openURLCommand {
		if raw, rewriteURLErr := RewriteURL(args[1], nil, true); rewriteURLErr == nil {
			if rewriteURLErr = openViewer(ctx, raw); rewriteURLErr != nil {
				return rewriteURLErr
			}
			return runner.output(map[string]string{urlCommand: raw})
		}
	}
	p, queryPinErr := queryPin(ctx, runner.api, args[0])
	if queryPinErr != nil {
		return queryPinErr
	}
	r, queryPinErr := ExistingPorts(ctx, runner.api.Config, p)
	if queryPinErr != nil {
		return queryPinErr
	}
	if command == portsCommand {
		return runner.output(r.Mappings)
	}
	raw, queryPinErr := RewriteURL(args[1], r.Mappings, command == openURLCommand)
	if queryPinErr != nil {
		return queryPinErr
	}
	if command == openURLCommand {
		if queryPinErr = openViewer(ctx, raw); queryPinErr != nil {
			return queryPinErr
		}
	}
	return runner.output(map[string]string{"machine_id": p.ID, urlCommand: raw})
}

func (runner commandRunner) vncMachine(ctx context.Context, target string, viewer bool) (err error) {
	h, acquireNameErr2 := acquireName(ctx, runner.api, target)
	if acquireNameErr2 != nil {
		return acquireNameErr2
	}
	defer func() { err = errors.Join(err, h.Close()) }()
	ep := Endpoint{ipv4Loopback, 5900}
	if _, acquireNameErr2 = h.Forward(ctx, ep); acquireNameErr2 != nil {
		return acquireNameErr2
	}
	m, acquireNameErr2 := awaitMapping(ctx, h, ep)
	if acquireNameErr2 != nil {
		return acquireNameErr2
	}
	if acquireNameErr2 = runner.output(m); acquireNameErr2 != nil {
		return acquireNameErr2
	}
	if viewer {
		if acquireNameErr2 = openViewer(ctx, "vnc://"+m.Local); acquireNameErr2 != nil {
			return acquireNameErr2
		}
	}
	return runner.hold(ctx, h)
}

const (
	requestKeyBytes       = 16
	statusRefreshInterval = 2 * time.Second
	forwardReadyTimeout   = 20 * time.Second
	forwardPollInterval   = 100 * time.Millisecond
)

const (
	inspectCommand = "inspect"
	urlCommand     = "url"
)

func (runner commandRunner) execMachine(ctx context.Context, args []string) error {
	if len(args) < 3 || args[1] != "--" {
		return errors.New("exec requires MACHINE -- ARGV")
	}
	p, err := runner.api.Pin(ctx, args[0])
	if err != nil {
		return err
	}
	if err = installPinned(ctx, runner.api, p); err != nil {
		return err
	}
	quoted := make([]string, 0, len(args))
	for _, arg := range args[2:] {
		if strings.ContainsRune(arg, 0) {
			return errors.New("exec arguments cannot contain NUL")
		}
		quoted = append(quoted, "'"+strings.ReplaceAll(arg, "'", "'\"'\"'")+"'")
	}
	return runSSH(
		ctx,
		runner.streams,
		"-T",
		"-F",
		filepath.Join(runner.api.Config.StateDir, "ssh_config"),
		"cb."+p.ID,
		strings.Join(quoted, " "),
	)
}
