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
	"time"

	"clankerbox/internal/model"
)

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
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return hex.EncodeToString(b), nil
}

const Usage = `usage: clankerbox [--config PATH] COMMAND
  profiles | hosts | machines | inspect NAME/ID | operation ID
  create --name NAME --profile PROFILE --host HOST --key PUBLIC_KEY_FILE [--idempotency-key KEY]
  start|stop|delete [--idempotency-key KEY] NAME/ID
  ssh NAME/ID [command...] | proxy IMMUTABLE_ID | ssh-config install
  connect [--forward 127.0.0.1:PORT|[::1]:PORT] NAME/ID
  ports NAME/ID | url NAME/ID URL | open-url NAME/ID URL
  vnc [--viewer] NAME/ID
`

func Run(ctx context.Context, args []string, streams Streams) error {
	global := flags("clankerbox", streams.Err)
	path := global.String("config", DefaultConfigPath(), "client JSON config")
	if e := global.Parse(args); e != nil {
		return e
	}
	args = global.Args()
	if len(args) == 0 {
		return errors.New(Usage)
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
	switch command {
	case "profiles", "hosts", "machines":
		if len(args) != 0 {
			return errors.New("unexpected arguments")
		}
		var out json.RawMessage
		e = a.Do(ctx, "GET", "/v1/"+command, nil, "", &out)
		if e != nil {
			return e
		}
		return jsonOut(streams.Out, out)
	case "inspect":
		if e = oneArg(args); e != nil {
			return e
		}
		m, e := a.Resolve(ctx, args[0])
		if e != nil {
			return e
		}
		return jsonOut(streams.Out, m)
	case "operation":
		if len(args) != 1 || !model.ValidID(args[0]) {
			return errors.New("operation requires an immutable operation ID")
		}
		var out json.RawMessage
		if e = a.Do(ctx, "GET", "/v1/operations/"+args[0], nil, "", &out); e != nil {
			return e
		}
		return jsonOut(streams.Out, out)
	case "create":
		f := flags(command, streams.Err)
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
		b, e := os.ReadFile(*key)
		if e != nil {
			return e
		}
		in := model.CreateInput{Name: *name, Profile: *profile, Host: *host, SSHPublicKeys: []string{strings.TrimSpace(string(b))}}
		if e = in.Validate(); e != nil {
			return e
		}
		id, e := requestKey(*idem)
		if e != nil {
			return e
		}
		return mutate(ctx, a, "/v1/machines", in, id, streams.Out)
	case "start", "stop", "delete":
		f := flags(command, streams.Err)
		idem := f.String("idempotency-key", "", "retry key")
		if e = f.Parse(args); e != nil {
			return e
		}
		if e = oneArg(f.Args()); e != nil {
			return e
		}
		m, e := a.Resolve(ctx, f.Arg(0))
		if e != nil {
			return e
		}
		id, e := requestKey(*idem)
		if e != nil {
			return e
		}
		return mutate(ctx, a, "/v1/machines/"+m.ID+"/"+command, nil, id, streams.Out)
	case "proxy":
		if len(args) != 1 || !model.ValidID(args[0]) {
			return errors.New("proxy requires an immutable machine ID")
		}
		conn, e := a.Upgrade(ctx, args[0])
		if e != nil {
			return e
		}
		defer conn.Close()
		return proxyStdio(ctx, conn, streams.In, streams.Out)
	case "ssh-config":
		if len(args) != 1 || args[0] != "install" {
			return errors.New("usage: ssh-config install")
		}
		binary, e := executable()
		if e != nil {
			return e
		}
		ms, e := a.Machines(ctx)
		if e != nil {
			return e
		}
		paths, e := InstallSSHConfig(c, binary, sshDirectory(), ms)
		if e != nil {
			return e
		}
		return jsonOut(streams.Out, map[string]any{"files": paths})
	case "ssh":
		if len(args) < 1 {
			return errors.New("ssh requires a machine")
		}
		p, e := a.Pin(ctx, args[0])
		if e != nil {
			return e
		}
		if e = installPinned(ctx, a, p); e != nil {
			return e
		}
		argv := append([]string{"-F", filepath.Join(c.StateDir, "ssh_config"), "cb." + p.ID}, args[1:]...)
		return runCommand(ctx, streams, "ssh", argv...)
	case "_owner":
		if len(args) != 1 {
			return errors.New("invalid owner startup")
		}
		b, e := base64.RawURLEncoding.DecodeString(args[0])
		if e != nil {
			return e
		}
		var p Pin
		if e = json.Unmarshal(b, &p); e != nil {
			return e
		}
		return ServeOwner(ctx, c, p, SSHDialer(a), func(e error) {
			message := ""
			if e != nil {
				message = e.Error()
			}
			jsonOut(streams.Out, map[string]string{"error": message})
		})
	case "connect":
		f := flags(command, streams.Err)
		var explicit endpointFlags
		f.Var(&explicit, "forward", "numeric guest loopback HOST:PORT (repeatable)")
		if e = f.Parse(args); e != nil {
			return e
		}
		if e = oneArg(f.Args()); e != nil {
			return e
		}
		_, h, e := acquireName(ctx, a, f.Arg(0))
		if e != nil {
			return e
		}
		defer h.Close()
		for _, ep := range explicit {
			if _, e = h.Forward(ctx, ep); e != nil {
				return e
			}
		}
		return hold(ctx, h, streams.Out)
	case "ports", "url", "open-url":
		expected := 1
		if command != "ports" {
			expected = 2
		}
		if len(args) != expected {
			return errors.New("invalid command arguments")
		}
		// External URLs need no mapping; validate first and launch without acquiring.
		if command == "open-url" {
			if raw, e := RewriteURL(args[1], nil, true); e == nil {
				if e = openViewer(ctx, raw); e != nil {
					return e
				}
				return jsonOut(streams.Out, map[string]string{"url": raw})
			}
		}
		p, e := queryPin(ctx, a, args[0])
		if e != nil {
			return e
		}
		r, e := ExistingPorts(ctx, c, p)
		if e != nil {
			return e
		}
		if command == "ports" {
			return jsonOut(streams.Out, r.Mappings)
		}
		raw, e := RewriteURL(args[1], r.Mappings, command == "open-url")
		if e != nil {
			return e
		}
		if command == "open-url" {
			if e = openViewer(ctx, raw); e != nil {
				return e
			}
		}
		return jsonOut(streams.Out, map[string]string{"machine_id": p.ID, "url": raw})
	case "vnc":
		f := flags(command, streams.Err)
		viewer := f.Bool("viewer", false, "launch the native viewer")
		if e = f.Parse(args); e != nil {
			return e
		}
		if e = oneArg(f.Args()); e != nil {
			return e
		}
		_, h, e := acquireName(ctx, a, f.Arg(0))
		if e != nil {
			return e
		}
		defer h.Close()
		ep := Endpoint{"127.0.0.1", 5900}
		if _, e = h.Forward(ctx, ep); e != nil {
			return e
		}
		m, e := awaitMapping(ctx, h, ep)
		if e != nil {
			return e
		}
		if e = jsonOut(streams.Out, m); e != nil {
			return e
		}
		if *viewer {
			if e = openViewer(ctx, "vnc://"+m.Local); e != nil {
				return e
			}
		}
		return hold(ctx, h, streams.Out)
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
func acquireName(ctx context.Context, a *API, name string) (Pin, *Handle, error) {
	p, e := a.Pin(ctx, name)
	if e != nil {
		return p, nil, e
	}
	b, e := executable()
	if e != nil {
		return p, nil, e
	}
	h, e := Acquire(ctx, a.Config, p, b)
	return p, h, e
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
			current, e := PinMachine(a.Config.URL, m)
			if e != nil || current != p {
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
	ticker := time.NewTicker(2 * time.Second)
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
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	ticker := time.NewTicker(100 * time.Millisecond)
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
func runCommand(ctx context.Context, streams Streams, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
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
	return exec.CommandContext(ctx, command, url).Run()
}
func proxyStdio(ctx context.Context, c net.Conn, in io.Reader, out io.Writer) error {
	// In production stdin is an os.File; closing it releases a blocked read when
	// the server disconnects. Proxy stdout carries raw bytes only.
	stop := context.AfterFunc(ctx, func() {
		c.Close()
		if closer, ok := in.(io.Closer); ok {
			closer.Close()
		}
	})
	defer stop()
	upstream := make(chan error, 1)
	go func() {
		_, e := io.Copy(c, in)
		if cw, ok := c.(interface{ CloseWrite() error }); ok {
			cw.CloseWrite()
		} else {
			c.Close()
		}
		upstream <- e
	}()
	_, e := io.Copy(out, c)
	c.Close()
	if closer, ok := in.(io.Closer); ok {
		closer.Close()
	}
	// Non-closable readers are used only by callers whose reads eventually finish.
	<-upstream
	if ctx.Err() != nil {
		return nil
	}
	if errors.Is(e, net.ErrClosed) {
		return nil
	}
	return e
}
