package client

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/urfave/cli/v3"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/rpcmodel"
)

const labelSeparator = "="

func (streams commandStreams) addSessionCommands(root *cli.Command) {
	command := streams.command
	root.Commands = append(root.Commands,
		command(
			"sessions",
			"List a machine's guest sessions, or show one with its final screen once it has ended",
			"MACHINE [SESSION_ID]",
			1, 2,
			func(ctx context.Context, r commandRunner, c *cli.Command) error {
				if c.NArg() == 1 {
					return r.listSessions(ctx, c.Args().First())
				}
				return r.showSession(ctx, c.Args().Get(0), c.Args().Get(1))
			},
		),
		streams.shell(),
		command(
			"guest",
			"Describe a machine's guest daemon",
			"MACHINE",
			1, 1,
			func(ctx context.Context, r commandRunner, c *cli.Command) error {
				return r.describeGuest(ctx, c.Args().First())
			},
		),
		command(
			"labels",
			"Replace a machine's labels (no pairs clears them)",
			"MACHINE [KEY=VALUE...]",
			1, -1,
			func(ctx context.Context, r commandRunner, c *cli.Command) error {
				return r.setLabels(ctx, c.Args().Slice())
			},
		),
	)
}

// attachmentStream is a client's side of one session attachment.
type attachmentStream = connect.BidiStreamForClient[v1.AttachmentRequest, v1.AttachmentEvent]

func (runner commandRunner) listSessions(ctx context.Context, name string) error {
	m, err := runner.api.Resolve(ctx, name)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	sessions, err := runner.sessionRecords(ctx, m.ID)
	if err != nil {
		return err
	}
	if runner.structured {
		return jsonOut(runner.streams.Out, sessions)
	}
	header := []string{"ID", "STATUS", "EXIT", "SIZE", "LABEL"}
	return writeTable(runner.streams.Out, header, sessions, func(s protocol.Session) []string {
		size := fmt.Sprintf("%dx%d", s.Cols, s.Rows)
		if s.Pipes {
			size = "pipes"
		}
		return []string{s.ID, s.Status, sessionExit(s), size, s.Label}
	})
}

func (runner commandRunner) sessionRecords(ctx context.Context, machineID string) ([]protocol.Session, error) {
	response, err := runner.api.sessions.ListSessions(ctx, connect.NewRequest(&v1.ListSessionsRequest{MachineId: machineID}))
	if err != nil {
		return nil, err
	}
	var sessions []protocol.Session
	for _, value := range response.Msg.GetSessions() {
		record, recordErr := rpcmodel.FromSession(value)
		if recordErr != nil {
			return nil, recordErr
		}
		sessions = append(sessions, record)
	}
	return sessions, nil
}

// sessionExit is an ended session's exit status or signal, empty while it runs.
func sessionExit(s protocol.Session) string {
	switch {
	case s.ExitCode != nil:
		return strconv.Itoa(*s.ExitCode)
	case s.Signal != nil:
		return *s.Signal
	}
	return ""
}

// showSession prints one session's record and, once a terminal session has
// ended, the final screen its guest retains. Only that screen needs an
// attachment, which a running pipe session would refuse.
func (runner commandRunner) showSession(ctx context.Context, name, id string) error {
	m, err := runner.api.Resolve(ctx, name)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	sessions, err := runner.sessionRecords(ctx, m.ID)
	if err != nil {
		return err
	}
	i := slices.IndexFunc(sessions, func(s protocol.Session) bool { return s.ID == id })
	if i < 0 {
		return fmt.Errorf("%s has no session %s", name, id)
	}
	record := sessions[i]
	ended := record.Status == protocol.StatusExited || record.Status == protocol.StatusLost
	var screen *string
	if ended && !record.Pipes {
		text, retained, screenErr := runner.finalScreen(ctx, m.ID, id)
		if screenErr != nil {
			return screenErr
		}
		if retained {
			screen = &text
		}
	}
	if runner.structured {
		return jsonOut(runner.streams.Out, struct {
			Session protocol.Session `json:"session"`
			Screen  *string          `json:"screen"`
		}{record, screen})
	}
	_, err = fmt.Fprintf(runner.streams.Out, "Session %s  %s  exit %s  label %q\nCommand: %s\n",
		record.ID, record.Status, sessionExit(record), record.Label, strings.Join(record.Argv, " "))
	if err != nil {
		return err
	}
	switch {
	case record.Pipes:
		return nil
	case !ended:
		_, err = fmt.Fprintln(runner.streams.Out, "Its final screen is shown once it ends.")
		return err
	case screen == nil:
		_, err = fmt.Fprintln(runner.streams.Out, "The guest no longer retains this session's screen.")
		return err
	}
	_, err = fmt.Fprintln(runner.streams.Out, strings.TrimRight(*screen, "\n"))
	return err
}

// finalScreen reads the screen the guest retains for an ended terminal
// session, reporting false once it no longer does.
func (runner commandRunner) finalScreen(ctx context.Context, machineID, id string) (string, bool, error) {
	stream := runner.api.sessions.AttachSession(ctx)
	defer func() {
		_ = stream.CloseRequest()
		_ = stream.CloseResponse()
	}()
	open := &v1.Open{MachineId: machineID, SessionId: id}
	if err := stream.Send(&v1.AttachmentRequest{Command: &v1.AttachmentRequest_Open{Open: open}}); err != nil {
		return "", false, streamError(stream, err)
	}
	event, err := stream.Receive()
	if err != nil {
		return "", false, err
	}
	opened := event.GetOpened()
	if opened == nil {
		return "", false, errors.New("session attachment did not open")
	}
	if opened.GetMode() != v1.OpenMode_OPEN_MODE_ENDED || opened.GetView() == nil {
		return "", false, nil
	}
	size := opened.GetView().GetBytes()
	var text strings.Builder
	for uint64(text.Len()) < size {
		event, err = stream.Receive()
		if err != nil {
			return "", false, err
		}
		chunk := event.GetViewChunk()
		if chunk == nil || chunk.GetPosition() != uint64(text.Len()) {
			return "", false, errors.New("session view chunks are out of order")
		}
		text.Write(chunk.GetData())
		if chunk.GetFinal() != (uint64(text.Len()) == size) {
			return "", false, errors.New("session view length is inconsistent")
		}
	}
	return text.String(), true, nil
}

// describeGuest walks the controller, host and guest route and reports the
// daemon that answered for the machine.
func (runner commandRunner) describeGuest(ctx context.Context, name string) error {
	m, err := runner.api.Resolve(ctx, name)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	response, err := runner.api.sessions.DescribeGuest(ctx, connect.NewRequest(&v1.DescribeGuestRequest{MachineId: m.ID}))
	if err != nil {
		return err
	}
	guest := response.Msg
	if guest.GetMachineId() != m.ID || guest.GetIncarnation() == "" {
		return errors.New("guest description identity mismatch")
	}
	if runner.structured {
		raw, marshalErr := (protojson.MarshalOptions{UseProtoNames: true}).Marshal(guest)
		if marshalErr != nil {
			return marshalErr
		}
		_, err = fmt.Fprintln(runner.streams.Out, string(raw))
		return err
	}
	_, err = fmt.Fprintf(
		runner.streams.Out,
		"Guest of %s\nDaemon: %s  OS: %s  User: %s  Sessions: up to %d\nIncarnation: %s  Boot: %s\nEngine: %s\n",
		guest.GetMachineId(), guest.GetDaemonVersion(), guest.GetOs(), guest.GetUser(), guest.GetMaxSessions(),
		guest.GetIncarnation(), guest.GetBootId(), guest.GetEngineDigest(),
	)
	return err
}

func (runner commandRunner) setLabels(ctx context.Context, args []string) error {
	m, err := runner.api.Resolve(ctx, args[0])
	if err != nil {
		return err
	}
	labels := make(map[string]string, len(args)-1)
	for _, pair := range args[1:] {
		key, value, ok := strings.Cut(pair, labelSeparator)
		if !ok || key == "" {
			return fmt.Errorf("label %q must be KEY=VALUE", pair)
		}
		labels[key] = value
	}
	updated, err := runner.api.SetLabels(ctx, m.ID, labels)
	if err != nil {
		return err
	}
	return runner.output(&updated)
}
