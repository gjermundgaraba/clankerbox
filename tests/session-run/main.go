// Command session-run is a test-only guest-action adapter for live acceptance.
// It is not installed or exposed by the product CLI.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"clankerbox/internal/client"
	guest "clankerbox/internal/guest/client"
	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/model"
	"clankerbox/internal/statefs"

	"github.com/google/uuid"
)

func main() {
	config := flag.String("config", client.DefaultConfigPath(), "Client configuration")
	flag.Parse()
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	code, err := run(ctx, *config, flag.Args(), os.Stdin, os.Stdout)
	cancel()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(code)
}

func run(ctx context.Context, path string, args []string, in io.Reader, out io.Writer) (int, error) {
	if len(args) < minimumArgs {
		return 0, errors.New("requires MACHINE COMMAND [ARG...]")
	}
	config, err := client.LoadConfig(path)
	if err != nil {
		return 0, err
	}
	api, err := client.NewAPI(config)
	if err != nil {
		return 0, err
	}
	machine, err := readyMachine(ctx, api, args[0])
	if err != nil {
		return 0, err
	}
	link, err := connect(ctx, config, machine.ID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = link.Close() }()
	input, err := io.ReadAll(io.LimitReader(in, maxInputBytes+1))
	if err != nil {
		return 0, err
	}
	if len(input) > maxInputBytes {
		return 0, errors.New("acceptance input too large")
	}
	// The command waits behind a gate until its output subscription is installed.
	// Text stdin is supplied by a pipe, not PTY canonical input or an EOF keystroke.
	argv := make([]string, len(args)-1)
	for i, arg := range args[1:] {
		argv[i] = quote(arg)
	}
	script := "stty -echo -onlcr; printf 'SESSION_RUN_READY\\n'; read gate; printf %s " + quote(
		string(input),
	) + " | " + strings.Join(
		argv,
		" ",
	)
	return execute(ctx, link, script, out)
}

func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }

func readyMachine(ctx context.Context, api *client.API, name string) (model.Machine, error) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		m, err := api.Resolve(ctx, name)
		if err != nil {
			return m, err
		}
		if m.Deleted || m.State != model.Running {
			return m, errors.New("session requires a running machine")
		}
		if m.Guest != nil && m.Guest.Status == "ready" {
			return m, nil
		}
		select {
		case <-ctx.Done():
			return m, ctx.Err()
		case <-ticker.C:
		}
	}
}

func connect(ctx context.Context, config client.Config, id string) (*guest.Client, error) {
	token, err := statefs.ReadPrivate(config.TokenFile)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, config.URL+"/v1/machines/"+id+"/sessions/stream", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "clankerbox-session")
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return nil, errors.New("default transport is not HTTP")
	}
	transport := base.Clone()
	transport.Proxy = nil
	transport.ForceAttemptHTTP2 = false
	defer transport.CloseIdleConnections()
	httpClient := &http.Client{
		Transport:     transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	response, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusSwitchingProtocols || response.Header.Get("Upgrade") != "clankerbox-session" {
		_ = response.Body.Close()
		return nil, fmt.Errorf("session upgrade returned HTTP %d", response.StatusCode)
	}
	stream, ok := response.Body.(io.ReadWriteCloser)
	if !ok {
		_ = response.Body.Close()
		return nil, errors.New("session upgrade is not bidirectional")
	}
	return guest.Dial(ctx, stream)
}

func execute(ctx context.Context, link *guest.Client, script string, out io.Writer) (int, error) {
	id := uuid.NewString()
	args := protocol.SessionArgs{SessionID: id}
	if err := link.CallInto(
		ctx,
		protocol.OpSessionCreate,
		protocol.CreateArgs{
			SessionID: id,
			Argv:      []string{"/bin/sh", "-c", script},
			Cols:      terminalCols,
			Rows:      terminalRows,
			CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
		},
		nil,
	); err != nil {
		return 0, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
		defer cancel()
		_ = link.CallInto(cleanup, protocol.OpSessionEnd, args, nil)
	}()
	offset := uint64(0)
	var opened protocol.OpenValue
	if err := link.CallInto(
		ctx,
		protocol.OpSessionOpen,
		protocol.OpenArgs{SessionID: id, FromOffset: &offset, FromIncarnation: link.Hello().Incarnation},
		&opened,
	); err != nil {
		return 0, err
	}
	if opened.Mode != "resume" {
		return 0, fmt.Errorf("expected complete output replay, got %s", opened.Mode)
	}
	return consume(ctx, link, id, out)
}

const (
	commandTimeout = 90 * time.Second
	cleanupTimeout = 5 * time.Second
	minimumArgs    = 2
	maxInputBytes  = 32 << 10
)

type outputReader struct {
	ready   bool
	pending strings.Builder
	out     io.Writer
}

func (r *outputReader) output(ctx context.Context, link *guest.Client, id string, body []byte) error {
	_, data, err := protocol.ParseOutput(body)
	if err != nil {
		return err
	}
	if r.ready {
		_, err = r.out.Write(data)
		return err
	}
	r.pending.Write(data)
	if !strings.Contains(r.pending.String(), "SESSION_RUN_READY\n") {
		return nil
	}
	r.ready = true
	return link.CallInto(
		ctx,
		protocol.OpSessionInput,
		protocol.InputArgs{SessionID: id, Data: base64.StdEncoding.EncodeToString([]byte("\n"))},
		nil,
	)
}

func sessionExit(frame guest.Frame, id string) (int, bool, error) {
	if frame.Event == protocol.EventOutputGap {
		return 0, false, errors.New("session output lost")
	}
	if frame.Event != protocol.EventSession {
		return 0, false, nil
	}
	var event protocol.SessionEvent
	if err := json.Unmarshal(frame.Body, &event); err != nil {
		return 0, false, err
	}
	if event.Session.ID != id || event.Session.Status == protocol.StatusRunning {
		return 0, false, nil
	}
	if event.Session.ExitCode == nil {
		return 0, false, errors.New("session ended without exit status")
	}
	return *event.Session.ExitCode, true, nil
}

func consume(ctx context.Context, link *guest.Client, id string, out io.Writer) (int, error) {
	reader := outputReader{out: out}
	for {
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case frame, ok := <-link.Events():
			if !ok {
				return 0, link.Err()
			}
			if frame.Kind == protocol.KindOutput {
				if err := reader.output(ctx, link, id, frame.Body); err != nil {
					return 0, err
				}
				continue
			}
			code, done, err := sessionExit(frame, id)
			if err != nil || done {
				return code, err
			}
		}
	}
}

const terminalCols = 120
const terminalRows = 40
