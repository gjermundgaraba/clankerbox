// Command session-run is a test-only guest-action adapter for live acceptance.
// It is not installed or exposed by the product CLI.
package main

import (
	"context"
	"crypto/tls"
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
	expectDependency := flag.Bool(
		"expect-delete-dependency",
		false,
		"Require deletion to reject MACHINE_ID with 409 dependency",
	)
	expectStopped := flag.Bool(
		"expect-stopped",
		false,
		"Require the session endpoint to reject MACHINE_ID with 409 prerequisite",
	)
	flag.Parse()
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	var code int
	var err error
	switch {
	case *expectDependency && *expectStopped:
		err = errors.New("choose only one prerequisite probe")
	case *expectDependency:
		err = runDeleteDependencyCheck(ctx, *config, flag.Args(), os.Stdout)
	case *expectStopped:
		err = runStoppedCheck(ctx, *config, flag.Args())
	default:
		code, err = run(ctx, *config, flag.Args(), os.Stdin, os.Stdout)
	}
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
	script, err := commandScript(args[1:], in)
	if err != nil {
		return 0, err
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
	return execute(ctx, link, script, out)
}

func commandScript(args []string, in io.Reader) (string, error) {
	// Raw input cannot fit if it already exceeds the per-argument protocol bound.
	// The final check also accounts for quoting, argv and the gate's overhead.
	input, err := io.ReadAll(io.LimitReader(in, protocol.MaxArg+1))
	if err != nil {
		return "", err
	}
	// The command waits behind a gate until its output subscription is installed.
	// Text stdin is supplied by a pipe, not PTY canonical input or an EOF keystroke.
	argv := make([]string, len(args))
	for i, arg := range args {
		argv[i] = quote(arg)
	}
	script := "stty -echo -onlcr; printf 'SESSION_RUN_READY\\n'; read gate; printf %s " + quote(
		string(input),
	) + " | " + strings.Join(
		argv,
		" ",
	)
	if len(script) > protocol.MaxArg {
		return "", fmt.Errorf(
			"quoted command, stdin and gate must fit the session argv limit of %d bytes",
			protocol.MaxArg,
		)
	}
	return script, nil
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
	response, err := requestSession(ctx, config, id)
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

func runStoppedCheck(ctx context.Context, path string, args []string) error {
	if len(args) != 1 || !model.ValidID(args[0]) {
		return errors.New("--expect-stopped requires one MACHINE_ID")
	}
	config, err := client.LoadConfig(path)
	if err != nil {
		return err
	}
	// Deliberately bypass readiness/inspection: only the authenticated session
	// endpoint's specific prerequisite response can satisfy this acceptance check.
	response, err := requestSession(ctx, config, args[0])
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusConflict {
		return fmt.Errorf("expected stopped-session HTTP 409 prerequisite, got HTTP %d", response.StatusCode)
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, maxErrorBytes)).Decode(&body); err != nil {
		return fmt.Errorf("invalid stopped-session response: %w", err)
	}
	if body.Error.Code != "prerequisite" {
		return fmt.Errorf("expected stopped-session prerequisite, got %q", body.Error.Code)
	}
	return nil
}

// runDeleteDependencyCheck makes exactly one mutation attempt against the source
// explicitly supplied by checkpoint acceptance. Unexpected acceptance must be
// emitted before returning an error so the harness can retain the operation ID.
func runDeleteDependencyCheck(ctx context.Context, path string, args []string, out io.Writer) error {
	if len(args) != 1 || !model.ValidID(args[0]) {
		return errors.New("--expect-delete-dependency requires one MACHINE_ID")
	}
	config, err := client.LoadConfig(path)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		config.URL+"/v1/machines/"+args[0]+"/delete",
		strings.NewReader("{}"),
	)
	if err != nil {
		return err
	}
	key := model.NewID()
	req.Header.Set("Idempotency-Key", key)
	req.Header.Set("Content-Type", "application/json")
	response, err := sendRequest(config, req)
	if err != nil {
		return fmt.Errorf("delete probe idempotency key %s requires inspection: %w", key, err)
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxErrorBytes+1))
	if err != nil || len(body) > maxErrorBytes {
		return fmt.Errorf("delete probe idempotency key %s: incomplete or oversized response", key)
	}
	if response.StatusCode >= http.StatusOK && response.StatusCode < http.StatusMultipleChoices {
		// Emit the complete accepted response, even if its schema is unexpected.
		// The surrounding report already records the mutation intent.
		if _, err = out.Write(body); err != nil {
			return fmt.Errorf("delete probe idempotency key %s: recording acceptance: %w", key, err)
		}
	}
	var problem struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if response.StatusCode != http.StatusConflict || json.Unmarshal(body, &problem) != nil ||
		problem.Error.Code != "dependency" {
		return fmt.Errorf(
			"expected HTTP 409 dependency, got HTTP %d (delete probe idempotency key %s)",
			response.StatusCode,
			key,
		)
	}
	return nil
}

func requestSession(ctx context.Context, config client.Config, id string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, config.URL+"/v1/machines/"+id+"/sessions/stream", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "clankerbox-session")
	return sendRequest(config, req)
}

func sendRequest(config client.Config, req *http.Request) (*http.Response, error) {
	token, err := statefs.ReadPrivate(config.TokenFile)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return nil, errors.New("default transport is not HTTP")
	}
	transport := base.Clone()
	transport.Proxy = nil
	// Session streams use an HTTP/1.1 upgrade, including over TLS. A cloned
	// default transport may already have HTTP/2 registered in TLSNextProto.
	transport.Protocols = new(http.Protocols)
	transport.Protocols.SetHTTP1(true)
	if transport.TLSClientConfig == nil {
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	transport.TLSClientConfig.NextProtos = []string{"http/1.1"}
	defer transport.CloseIdleConnections()
	httpClient := &http.Client{
		Transport:     transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return httpClient.Do(req)
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
	maxErrorBytes  = 4 << 10
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
