// Command session-run is a test-only guest-action adapter for live acceptance.
// It is not installed or exposed by the product CLI.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/client"
	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"

	"github.com/google/uuid"
)

func main() {
	config := flag.String("config", client.DefaultConfigPath(), "Client configuration")
	expectDependency := flag.Bool(
		"expect-delete-dependency",
		false,
		"Require deletion to reject MACHINE_ID with typed dependency",
	)
	expectStopped := flag.Bool(
		"expect-stopped",
		false,
		"Require the session endpoint to reject MACHINE_ID with typed prerequisite",
	)
	describeGuest := flag.Bool("describe-guest", false, "Describe MACHINE_ID through authenticated ordinary guest RPC")
	flag.Parse()
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	var code int
	var err error
	switch {
	case (*expectDependency && *expectStopped) || (*describeGuest && (*expectDependency || *expectStopped)):
		err = errors.New("choose only one prerequisite probe")
	case *describeGuest:
		err = runDescribeGuest(ctx, *config, flag.Args(), os.Stdout)
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
	defer api.Close()
	return execute(ctx, api, machine.ID, script, out)
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

func runStoppedCheck(ctx context.Context, path string, args []string) error {
	if len(args) != 1 || !model.ValidID(args[0]) {
		return errors.New("--expect-stopped requires one MACHINE_ID")
	}
	config, err := client.LoadConfig(path)
	if err != nil {
		return err
	}
	api, err := client.NewAPI(config)
	if err != nil {
		return err
	}
	defer api.Close()
	_, err = api.SessionClient().DescribeGuest(ctx, connect.NewRequest(&v1.DescribeGuestRequest{MachineId: args[0]}))
	detail, ok := rpcmodel.Detail(err)
	if !ok || detail.GetReason() != v1.ErrorReason_ERROR_REASON_PREREQUISITE {
		return fmt.Errorf("expected stopped-session prerequisite, got %w", err)
	}
	return nil
}
func runDeleteDependencyCheck(ctx context.Context, path string, args []string, out io.Writer) error {
	if len(args) != 1 || !model.ValidID(args[0]) {
		return errors.New("--expect-delete-dependency requires one MACHINE_ID")
	}
	config, err := client.LoadConfig(path)
	if err != nil {
		return err
	}
	api, err := client.NewAPI(config)
	if err != nil {
		return err
	}
	defer api.Close()
	key := model.NewID()
	op, err := api.DeleteMachine(ctx, args[0], key)
	if err == nil {
		if writeErr := json.NewEncoder(out).Encode(op); writeErr != nil {
			return writeErr
		}
		return fmt.Errorf("unexpected accepted delete operation %s (idempotency key %s)", op.ID, key)
	}
	detail, ok := rpcmodel.Detail(err)
	if !ok || detail.GetReason() != v1.ErrorReason_ERROR_REASON_DEPENDENCY {
		return fmt.Errorf("delete probe idempotency key %s requires inspection: %w", key, err)
	}
	return nil
}
func execute(ctx context.Context, api *client.API, machine, script string, out io.Writer) (int, error) {
	service := api.SessionClient()
	desc, err := service.DescribeGuest(ctx, connect.NewRequest(&v1.DescribeGuestRequest{MachineId: machine}))
	if err != nil {
		return 0, err
	}
	id := uuid.NewString()
	_, err = service.CreateSession(
		ctx,
		connect.NewRequest(
			&v1.CreateSessionRequest{
				MachineId: machine,
				SessionId: id,
				Argv:      []string{"/bin/sh", "-c", script},
				Cols:      terminalCols,
				Rows:      terminalRows,
				CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
			},
		),
	)
	if err != nil {
		return 0, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
		defer cancel()
		_, _ = service.EndSession(cleanup, connect.NewRequest(&v1.EndSessionRequest{MachineId: machine, SessionId: id}))
	}()
	stream := service.AttachSession(ctx)
	defer func() { _ = stream.CloseRequest() }()
	defer func() { _ = stream.CloseResponse() }()
	err = stream.Send(
		&v1.AttachmentRequest{
			Command: &v1.AttachmentRequest_Open{
				Open: &v1.Open{
					MachineId:            machine,
					SessionId:            id,
					ExpectedEngineDigest: desc.Msg.GetEngineDigest(),
					ResumeCursor:         &v1.ResumeCursor{Offset: 0, Incarnation: desc.Msg.GetIncarnation()},
				},
			},
		},
	)
	if err != nil {
		return 0, err
	}
	first, err := stream.Receive()
	if err != nil {
		return 0, err
	}
	opened := first.GetOpened()
	if opened == nil || opened.GetMode() != v1.OpenMode_OPEN_MODE_RESUME {
		return 0, errors.New("expected complete output resume")
	}
	return receiveCommand(stream, id, out)
}

func receiveCommand(
	stream *connect.BidiStreamForClient[v1.AttachmentRequest, v1.AttachmentEvent],
	id string,
	out io.Writer,
) (int, error) {
	ready := false
	var pending strings.Builder
	for {
		event, err := stream.Receive()
		if err != nil {
			return 0, err
		}
		switch value := event.GetEvent().(type) {
		case *v1.AttachmentEvent_Output:
			ready, err = commandOutput(stream, value.Output.GetData(), out, &pending, ready)
			if err != nil {
				return 0, err
			}

		case *v1.AttachmentEvent_Ack:
			if !value.Ack.GetAccepted() {
				return 0, fmt.Errorf("command gate input refused: %s", value.Ack.GetReason())
			}
		case *v1.AttachmentEvent_Gap:
			return 0, errors.New("session output lost")
		case *v1.AttachmentEvent_SessionExited:
			if value.SessionExited.GetSession().GetId() != id {
				return 0, errors.New("session identity changed")
			}
			if value.SessionExited.Session.ExitCode == nil {
				return 0, errors.New("session ended without exit status")
			}
			return int(value.SessionExited.GetSession().GetExitCode()), nil
		}
	}
}

const (
	commandTimeout = 90 * time.Second
	cleanupTimeout = 5 * time.Second
	minimumArgs    = 2
)

const terminalCols = 120
const terminalRows = 40

func runDescribeGuest(ctx context.Context, path string, args []string, out io.Writer) error {
	if len(args) != 1 || !model.ValidID(args[0]) {
		return errors.New("--describe-guest requires one MACHINE_ID")
	}
	cfg, err := client.LoadConfig(path)
	if err != nil {
		return err
	}
	api, err := client.NewAPI(cfg)
	if err != nil {
		return err
	}
	defer api.Close()
	result, err := api.SessionClient().
		DescribeGuest(ctx, connect.NewRequest(&v1.DescribeGuestRequest{MachineId: args[0]}))
	if err != nil {
		return err
	}
	if result.Msg.GetMachineId() != args[0] || result.Msg.GetIncarnation() == "" {
		return errors.New("guest description identity mismatch")
	}
	raw, err := (protojson.MarshalOptions{UseProtoNames: true}).Marshal(result.Msg)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(out, string(raw))
	return err
}

func commandOutput(
	stream *connect.BidiStreamForClient[v1.AttachmentRequest, v1.AttachmentEvent],
	data []byte,
	out io.Writer,
	pending *strings.Builder,
	ready bool,
) (bool, error) {
	if ready {
		_, err := out.Write(data)
		return true, err
	}
	pending.Write(data)
	if !strings.Contains(pending.String(), "SESSION_RUN_READY\n") {
		return false, nil
	}
	err := stream.Send(
		&v1.AttachmentRequest{Command: &v1.AttachmentRequest_Input{Input: &v1.Input{Sequence: 1, Data: []byte("\n")}}},
	)
	return true, err
}
