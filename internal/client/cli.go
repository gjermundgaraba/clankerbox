package client

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
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
func flags(name string, errOut io.Writer) *flag.FlagSet {
	f := flag.NewFlagSet(name, flag.ContinueOnError)
	f.SetOutput(errOut)
	return f
}
func oneArg(args []string) error {
	if len(args) != 1 {
		return errors.New("command requires exactly one machine name or ID")
	}
	return nil
}
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

// Usage describes the supported CLI commands.
const Usage = `usage: clankerbox [--config PATH] COMMAND
  profiles | hosts | machines | inspect NAME/ID | operation ID
  create --name NAME --profile PROFILE --host HOST --key PUBLIC_KEY_FILE [--idempotency-key KEY]
  fork|restore --name CHILD --key PUBLIC_KEY_FILE [--idempotency-key KEY] SOURCE/CHECKPOINT_ID
  checkpoint create SOURCE | checkpoint list | checkpoint inspect ID | checkpoint delete ID
  start|stop|delete [--idempotency-key KEY] NAME/ID
  ssh NAME/ID [command...] | proxy IMMUTABLE_ID | ssh-config install
  connect [--forward 127.0.0.1:PORT|[::1]:PORT] NAME/ID
  ports NAME/ID | url NAME/ID URL | open-url NAME/ID URL
  vnc [--viewer] NAME/ID
`

// Run executes one CLI command using the supplied streams and cancellation context.
func Run(ctx context.Context, args []string, streams Streams) error {
	global := flags("clankerbox", streams.Err)
	path := global.String("config", DefaultConfigPath(), "client JSON config")
	if e := global.Parse(args); e != nil {
		return e
	}
	args = global.Args()
	if len(args) == 0 {
		return errors.New(strings.TrimSpace(Usage))
	}
	if args[0] == "help" {
		_, e := io.WriteString(streams.Out, Usage)
		return e
	}
	c, e := LoadConfig(*path)
	if e != nil {
		return e
	}
	a, e := NewAPI(c)
	if e != nil {
		return e
	}
	command := args[0]
	args = args[1:]
	runner := commandRunner{api: a, streams: streams}
	switch command {
	case "profiles", "hosts", "machines":
		return runner.listResources(ctx, command, args)
	case inspectCommand:
		return runner.inspectMachine(ctx, args)
	case "operation":
		return runner.inspectOperation(ctx, args)
	case createCommand:
		return runner.createMachine(ctx, command, args)
	case forkCommand, "restore", checkpointCommand:
		return deriveCLI(ctx, a, command, args, streams)
	case "start", "stop", "delete":
		return runner.mutateMachine(ctx, command, args)
	case "proxy":
		return runner.proxyMachine(ctx, args)
	case "ssh-config":
		return runner.installSSH(ctx, args)
	case "ssh":
		return runner.sshMachine(ctx, args)
	case "_owner":
		return runner.serveOwner(ctx, args)
	case "connect":
		return runner.connectMachine(ctx, command, args)
	case portsCommand, urlCommand, openURLCommand:
		return runner.queryForward(ctx, command, args)
	case "vnc":
		return runner.vncMachine(ctx, command, args)
	default:
		return fmt.Errorf("unknown command %q", command)
	}
}

func mutate(ctx context.Context, a *API, path string, in any, id string, w io.Writer) error {
	var out json.RawMessage
	if e := a.Do(ctx, "POST", path, in, id, &out); e != nil {
		return fmt.Errorf("%w; retry with --idempotency-key %s", e, id)
	}
	return jsonOut(w, out)
}

type endpointFlags []Endpoint

func (e *endpointFlags) String() string { return "" }
func (e *endpointFlags) Set(s string) error {
	ep, err := ParseEndpoint(s)
	if err == nil {
		*e = append(*e, ep)
	}
	return err
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
func hold(ctx context.Context, h *Handle, w io.Writer) error {
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
		if e = jsonOut(w, r); e != nil {
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
func runSSH(ctx context.Context, streams Streams, args ...string) error {
	//nolint:gosec // G204: Execute the fixed SSH program with separate arguments from the local CLI.
	cmd := exec.CommandContext(ctx, "ssh", args...)
	cmd.Stdin = streams.In
	cmd.Stdout = streams.Out
	cmd.Stderr = streams.Err
	return cmd.Run()
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
	checkpointCommand = "checkpoint"
	forkCommand       = "fork"
	createCommand     = "create"
	openURLCommand    = "open-url"
	portsCommand      = "ports"
)

type commandRunner struct {
	api     *API
	streams Streams
}

func (runner commandRunner) listResources(ctx context.Context, command string, args []string) error {
	var e error
	if len(args) != 0 {
		return errors.New("unexpected arguments")
	}
	var out json.RawMessage
	e = runner.api.Do(ctx, "GET", "/v1/"+command, nil, "", &out)
	if e != nil {
		return e
	}
	return jsonOut(runner.streams.Out, out)
}

func (runner commandRunner) inspectMachine(ctx context.Context, args []string) error {
	var e error
	if e = oneArg(args); e != nil {
		return e
	}
	m, resolveErr := runner.api.Resolve(ctx, args[0])
	if resolveErr != nil {
		return resolveErr
	}
	return jsonOut(runner.streams.Out, m)
}

func (runner commandRunner) inspectOperation(ctx context.Context, args []string) error {
	var e error
	if len(args) != 1 || !model.ValidID(args[0]) {
		return errors.New("operation requires an immutable operation ID")
	}
	var out json.RawMessage
	if e = runner.api.Do(ctx, "GET", "/v1/operations/"+args[0], nil, "", &out); e != nil {
		return e
	}
	return jsonOut(runner.streams.Out, out)
}

func (runner commandRunner) createMachine(ctx context.Context, command string, args []string) error {
	var e error
	f := flags(command, runner.streams.Err)
	name := f.String("name", "", "machine name")
	profile := f.String("profile", "", "profile ID")
	host := f.String("host", "", "host ID")
	key := f.String("key", "", "public key file")
	idem := f.String("idempotency-key", "", "retry key")
	if e = f.Parse(args); e != nil {
		return e
	}
	if f.NArg() != 0 || *key == "" {
		return errors.New("create requires --name, --profile, --host and --key")
	}
	b, readFileErr := os.ReadFile(*key)
	if readFileErr != nil {
		return readFileErr
	}
	in := model.CreateInput{
		Name:          *name,
		Profile:       *profile,
		Host:          *host,
		SSHPublicKeys: []string{strings.TrimSpace(string(b))},
	}
	if readFileErr = in.Validate(); readFileErr != nil {
		return readFileErr
	}
	id, readFileErr := requestKey(*idem)
	if readFileErr != nil {
		return readFileErr
	}
	return mutate(ctx, runner.api, "/v1/machines", in, id, runner.streams.Out)
}

func (runner commandRunner) mutateMachine(ctx context.Context, command string, args []string) error {
	var e error
	f := flags(command, runner.streams.Err)
	idem := f.String("idempotency-key", "", "retry key")
	if e = f.Parse(args); e != nil {
		return e
	}
	if e = oneArg(f.Args()); e != nil {
		return e
	}
	m, resolveErr2 := runner.api.Resolve(ctx, f.Arg(0))
	if resolveErr2 != nil {
		return resolveErr2
	}
	id, resolveErr2 := requestKey(*idem)
	if resolveErr2 != nil {
		return resolveErr2
	}
	return mutate(ctx, runner.api, "/v1/machines/"+m.ID+"/"+command, nil, id, runner.streams.Out)
}

func (runner commandRunner) proxyMachine(ctx context.Context, args []string) (err error) {
	if len(args) != 1 || !model.ValidID(args[0]) {
		return errors.New("proxy requires an immutable machine ID")
	}
	conn, upgradeErr := runner.api.Upgrade(ctx, args[0])
	if upgradeErr != nil {
		return upgradeErr
	}
	defer func() { err = errors.Join(err, closeStream(conn)) }()
	return proxyStdio(ctx, conn, runner.streams.In, runner.streams.Out)
}

func (runner commandRunner) installSSH(ctx context.Context, args []string) error {
	if len(args) != 1 || args[0] != "install" {
		return errors.New("usage: ssh-config install")
	}
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
	return jsonOut(runner.streams.Out, map[string]any{"files": paths})
}

func (runner commandRunner) sshMachine(ctx context.Context, args []string) error {
	if len(args) < 1 {
		return errors.New("ssh requires a machine")
	}
	p, pinErr := runner.api.Pin(ctx, args[0])
	if pinErr != nil {
		return pinErr
	}
	if pinErr = installPinned(ctx, runner.api, p); pinErr != nil {
		return pinErr
	}
	argv := append([]string{"-F", filepath.Join(runner.api.Config.StateDir, "ssh_config"), "cb." + p.ID}, args[1:]...)
	return runSSH(ctx, runner.streams, argv...)
}

func (runner commandRunner) serveOwner(ctx context.Context, args []string) error {
	if len(args) != 1 {
		return errors.New("invalid owner startup")
	}
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

func (runner commandRunner) connectMachine(ctx context.Context, command string, args []string) (err error) {
	var e error
	f := flags(command, runner.streams.Err)
	var explicit endpointFlags
	f.Var(&explicit, "forward", "numeric guest loopback HOST:PORT (repeatable)")
	if e = f.Parse(args); e != nil {
		return e
	}
	if e = oneArg(f.Args()); e != nil {
		return e
	}
	h, acquireNameErr := acquireName(ctx, runner.api, f.Arg(0))
	if acquireNameErr != nil {
		return acquireNameErr
	}
	defer func() { err = errors.Join(err, h.Close()) }()
	for _, ep := range explicit {
		if _, acquireNameErr = h.Forward(ctx, ep); acquireNameErr != nil {
			return acquireNameErr
		}
	}
	return hold(ctx, h, runner.streams.Out)
}

func (runner commandRunner) queryForward(ctx context.Context, command string, args []string) error {
	expected := 1
	if command != portsCommand {
		expected = 2
	}
	if len(args) != expected {
		return errors.New("invalid command arguments")
	}
	// External URLs need no mapping; validate first and launch without acquiring.
	if command == openURLCommand {
		if raw, rewriteURLErr := RewriteURL(args[1], nil, true); rewriteURLErr == nil {
			if rewriteURLErr = openViewer(ctx, raw); rewriteURLErr != nil {
				return rewriteURLErr
			}
			return jsonOut(runner.streams.Out, map[string]string{urlCommand: raw})
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
		return jsonOut(runner.streams.Out, r.Mappings)
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
	return jsonOut(runner.streams.Out, map[string]string{"machine_id": p.ID, urlCommand: raw})
}

func (runner commandRunner) vncMachine(ctx context.Context, command string, args []string) (err error) {
	var e error
	f := flags(command, runner.streams.Err)
	viewer := f.Bool("viewer", false, "launch the native viewer")
	if e = f.Parse(args); e != nil {
		return e
	}
	if e = oneArg(f.Args()); e != nil {
		return e
	}
	h, acquireNameErr2 := acquireName(ctx, runner.api, f.Arg(0))
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
	if acquireNameErr2 = jsonOut(runner.streams.Out, m); acquireNameErr2 != nil {
		return acquireNameErr2
	}
	if *viewer {
		if acquireNameErr2 = openViewer(ctx, "vnc://"+m.Local); acquireNameErr2 != nil {
			return acquireNameErr2
		}
	}
	return hold(ctx, h, runner.streams.Out)
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
