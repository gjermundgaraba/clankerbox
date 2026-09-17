package client

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/urfave/cli/v3"
	"golang.org/x/sys/unix"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/guest/protocol"
)

const (
	// shellFailure is the exit status of a local or transport failure, as
	// distinct as one byte allows from the statuses of the remote program.
	shellFailure = 255
	// shellInterrupted follows the shell convention for an interrupt.
	shellInterrupted = 130
	signalStatusBase = 128
	inputChunk       = 64 * 1024
	inputRetry       = 20 * time.Millisecond
	// Input is sent ahead of its acknowledgements up to a window below the
	// guest's admission budget for the kind of session, so a round trip costs
	// typing nothing and a transfer little.
	terminalWindow = 128 * 1024
	pipeWindow     = 2 * 1024 * 1024
	queueFull      = "queue_full"
	outOfOrder     = "out_of_order"
	// defaultCols and defaultRows size a terminal session nobody is looking at.
	defaultCols = 80
	defaultRows = 24
)

type shellOptions struct {
	machine string
	argv    []string
	cwd     string
	label   string
	env     map[string]string
	// tty chooses a terminal or a pipe session; nil decides from the streams.
	tty *bool
}

func (streams commandStreams) shell() *cli.Command {
	command := streams.command(
		"shell",
		"Run a shell or command in a new session that ends with this command",
		"MACHINE [-- COMMAND [ARG...]]",
		-1,
		func(ctx context.Context, r commandRunner, c *cli.Command) error {
			options, err := shellFlags(c)
			if err != nil {
				return err
			}
			return r.shell(ctx, options)
		},
	)
	// Arguments are judged before configuration is read, like fixed-arity commands.
	command.Before = func(ctx context.Context, c *cli.Command) (context.Context, error) {
		_, err := shellFlags(c)
		return ctx, err
	}
	command.Description = "With a terminal on stdin and stdout the session is an interactive terminal. " +
		"Otherwise stdin, stdout and stderr are pipes to the command; --tty and --no-tty override that choice. " +
		"Exits with the command's status, 128 plus its signal, or 255 for a local or connection failure."
	command.Flags = []cli.Flag{
		&cli.StringFlag{Name: "cwd", Usage: "Working DIRECTORY in the machine (default: home)"},
		&cli.StringSliceFlag{Name: "env", Usage: "Set KEY=VALUE in the session environment"},
		&cli.StringFlag{Name: "label", Usage: "Session LABEL shown by sessions"},
		&cli.BoolFlag{Name: "tty", Aliases: []string{"t"}, Usage: "Give the command a terminal even without one here"},
		&cli.BoolFlag{Name: "no-tty", Aliases: []string{"T"}, Usage: "Use pipes even on a terminal"},
	}
	return command
}

func shellFlags(c *cli.Command) (shellOptions, error) {
	if c.NArg() == 0 {
		return shellOptions{}, fmt.Errorf("shell requires a machine; usage: %s %s", c.FullName(), c.ArgsUsage)
	}
	options := shellOptions{
		machine: c.Args().First(),
		argv:    c.Args().Tail(),
		cwd:     c.String("cwd"),
		label:   c.String("label"),
		env:     map[string]string{},
	}
	for _, pair := range c.StringSlice("env") {
		key, value, ok := strings.Cut(pair, labelSeparator)
		if !ok || key == "" {
			return options, fmt.Errorf("--env %q must be KEY=VALUE", pair)
		}
		options.env[key] = value
	}
	switch {
	case c.Bool("tty") && c.Bool("no-tty"):
		return options, errors.New("--tty and --no-tty exclude each other")
	case c.Bool("tty"), c.Bool("no-tty"):
		tty := c.Bool("tty")
		options.tty = &tty
	}
	return options, nil
}

// shell creates a session inside its own attachment and stays attached until
// the program exits. The guest ends the session when the attachment goes, so
// neither a killed client nor a lost connection leaves it running.
func (runner commandRunner) shell(ctx context.Context, options shellOptions) error {
	// What the session is and what this end can do are separate questions: a
	// command may need a terminal where none is attached here.
	pty := runner.streams.Terminal != nil
	if options.tty != nil {
		pty = *options.tty
	}
	machine, err := runner.api.Resolve(ctx, options.machine)
	if err != nil {
		return runner.shellError(err)
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	session := &shellSession{
		runner: runner,
		pty:    pty,
		input:  readInput(ctx, runner.streams.In),
		acks:   make(chan *v1.Ack),
		pumped: make(chan struct{}),
	}
	if pty {
		session.terminal = runner.streams.Terminal
	}
	status, err := session.run(ctx, &v1.Open{
		MachineId: machine.ID,
		SessionId: uuid.NewString(),
		Create: &v1.NewSession{
			Label:       options.label,
			Cwd:         options.cwd,
			Argv:        options.argv,
			Env:         options.env,
			CreatedAt:   time.Now().UTC().Format(time.RFC3339Nano),
			EndOnDetach: true,
			Pipes:       !pty,
		},
	})
	if err != nil {
		if ctx.Err() != nil {
			return cli.Exit("interrupted", shellInterrupted)
		}
		return runner.shellError(err)
	}
	return cli.Exit("", status)
}

// shellError renders a failure now, since an exit status error keeps only its text.
func (runner commandRunner) shellError(err error) error {
	return cli.Exit(describeError(err, runner.structured), shellFailure)
}

// localInput is the one reader of the command's input: first the terminal
// probe and then the session consume its chunks. failure is set before chunks
// closes and tells a read error from the end of input.
type localInput struct {
	chunks  chan []byte
	failure error
}

func readInput(ctx context.Context, in io.Reader) *localInput {
	input := &localInput{chunks: make(chan []byte)}
	if in == nil {
		close(input.chunks)
		return input
	}
	go func() {
		defer close(input.chunks)
		for {
			buffer := make([]byte, inputChunk)
			n, err := in.Read(buffer)
			if n > 0 {
				select {
				case input.chunks <- buffer[:n]:
				case <-ctx.Done():
					return
				}
			}
			if err != nil {
				if !errors.Is(err, io.EOF) {
					input.failure = err
				}
				return
			}
		}
	}()
	return input
}

type shellSession struct {
	runner commandRunner
	// pty is the kind of session; terminal is the local terminal serving it, if any.
	pty      bool
	terminal Terminal
	input    *localInput
	stream   *connect.BidiStreamForClient[v1.AttachmentRequest, v1.AttachmentEvent]
	// abandon ends the attachment from inside; inputFailure says why.
	abandon      context.CancelFunc
	inputFailure error

	// sending orders controls and their sequence numbers on the stream.
	sending  sync.Mutex
	sequence uint64
	// acks carries every acknowledgement to the input pump until pumped closes.
	acks   chan *v1.Ack
	pumped chan struct{}
}

func (s *shellSession) run(ctx context.Context, open *v1.Open) (int, error) {
	var typed []byte
	if s.pty {
		open.Create.Cols, open.Create.Rows = defaultCols, defaultRows
	}
	if s.terminal != nil {
		restore, err := s.terminal.Raw()
		if err != nil {
			return 0, fmt.Errorf("enter raw mode: %w", err)
		}
		defer restore()
		cols, rows, err := s.terminal.Size()
		if err != nil {
			return 0, fmt.Errorf("read terminal size: %w", err)
		}
		open.Create.Cols, open.Create.Rows = clampGrid(cols, rows)
		open.OmitAnsweredQueries = true
		open.TerminalProfile, typed = probeProfile(s.runner.streams.Out, s.input.chunks, profileWait)
	}
	ctx, s.abandon = context.WithCancel(ctx)
	var workers sync.WaitGroup
	s.stream = s.runner.api.sessions.AttachSession(ctx)
	// Cancellation alone interrupts neither a read that began before the
	// response nor a control blocked on flow control; closing both directions
	// does, whether the command is interrupted or abandons the attachment itself.
	hungUp := make(chan struct{})
	context.AfterFunc(ctx, func() {
		defer close(hungUp)
		_ = s.stream.CloseRequest()
		_ = s.stream.CloseResponse()
	})
	defer func() {
		s.abandon()
		<-hungUp
		workers.Wait()
	}()
	if err := s.stream.Send(&v1.AttachmentRequest{Command: &v1.AttachmentRequest_Open{Open: open}}); err != nil {
		return 0, s.streamError(err)
	}
	workers.Go(func() { s.pumpInput(ctx, typed) })
	if s.terminal != nil {
		workers.Go(func() { s.followSize(ctx) })
	}
	status, err := s.receive()
	if err != nil {
		// A pump that abandoned the attachment has left its reason by the time it stops.
		s.abandon()
		<-s.pumped
		if s.inputFailure != nil {
			err = fmt.Errorf("read input: %w", s.inputFailure)
		}
		if s.terminal != nil {
			_, _ = io.WriteString(s.runner.streams.Out, terminalReset)
		}
	}
	return status, err
}

// streamError prefers the failure the server reported over the local symptom.
func (s *shellSession) streamError(err error) error {
	if errors.Is(err, io.EOF) {
		if _, receiveErr := s.stream.Receive(); receiveErr != nil && !errors.Is(receiveErr, io.EOF) {
			return receiveErr
		}
	}
	return err
}

func (s *shellSession) receive() (int, error) {
	for {
		event, err := s.stream.Receive()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return 0, errors.New("the session stream ended before the program exited")
			}
			return 0, err
		}
		switch value := event.GetEvent().(type) {
		case *v1.AttachmentEvent_Output:
			out := s.runner.streams.Out
			if value.Output.GetStream() == v1.OutputStream_OUTPUT_STREAM_STDERR {
				out = s.runner.streams.Err
			}
			if _, err = out.Write(value.Output.GetData()); err != nil {
				return 0, err
			}
		case *v1.AttachmentEvent_Ack:
			select {
			case s.acks <- value.Ack:
			case <-s.pumped:
			}
		case *v1.AttachmentEvent_SessionExited:
			return exitStatus(value.SessionExited.GetSession())
		case *v1.AttachmentEvent_Gap:
			return 0, fmt.Errorf("session output was lost: %s", value.Gap.GetReason())
		case *v1.AttachmentEvent_Opened, *v1.AttachmentEvent_SnapshotChunk, *v1.AttachmentEvent_ViewChunk,
			*v1.AttachmentEvent_Resized:
		}
	}
}

func exitStatus(session *v1.Session) (int, error) {
	switch {
	case session.ExitCode != nil:
		return int(session.GetExitCode()), nil
	case session.Signal != nil:
		if number := unix.SignalNum(session.GetSignal()); number > 0 {
			return signalStatusBase + int(number), nil
		}
		return 0, fmt.Errorf("the program was ended by %s", session.GetSignal())
	default:
		return 0, fmt.Errorf("the session ended as %s without an exit status", session.GetStatus())
	}
}

// control sends one control under the next sequence number.
func (s *shellSession) control(build func(sequence uint64) *v1.AttachmentRequest) (uint64, error) {
	s.sending.Lock()
	defer s.sending.Unlock()
	s.sequence++
	return s.sequence, s.stream.Send(build(s.sequence))
}

// inputPump sends input ahead of its acknowledgements within a window. Every
// Input names the offset the guest has accepted from this attachment, and the
// guest refuses any other: once one Input is refused, those behind it are too,
// so unaccepted input stays one contiguous run that is sent again from the
// accepted offset once every outstanding acknowledgement has arrived. Nothing
// can be reordered, and nothing accepted can be applied twice.
type inputPump struct {
	session *shellSession
	window  int
	// accepted is the guest's count; unaccepted is what was sent beyond it.
	accepted   uint64
	unaccepted [][]byte
	held       int
	// awaiting are the sequences of inputs whose acknowledgement is outstanding.
	awaiting []uint64
	refused  bool
	next     []byte
	ended    bool
}

func (s *shellSession) pumpInput(ctx context.Context, typed []byte) {
	defer close(s.pumped)
	pump := &inputPump{session: s, window: pipeWindow}
	if s.pty {
		pump.window = terminalWindow
	}
	if len(typed) > 0 {
		pump.next = typed
	}
	pump.run(ctx)
}

func (p *inputPump) run(ctx context.Context) {
	var retry <-chan time.Time
	for {
		if !p.advance() {
			return
		}
		if p.refused && len(p.awaiting) == 0 && retry == nil {
			retry = time.After(inputRetry)
		}
		var chunks <-chan []byte
		if p.next == nil && !p.ended && !p.refused {
			chunks = p.session.input.chunks
		}
		select {
		case <-ctx.Done():
			return
		case ack := <-p.session.acks:
			if !p.acknowledged(ack) {
				return
			}
		case data, open := <-chunks:
			p.next, p.ended = data, !open
		case <-retry:
			retry = nil
			if !p.sendAgain() {
				return
			}
		}
	}
}

// advance sends what the window admits and reports false when the pump is done.
func (p *inputPump) advance() bool {
	if p.refused {
		return true
	}
	if p.next != nil && (len(p.unaccepted) == 0 || p.held+len(p.next) <= p.window) {
		p.unaccepted = append(p.unaccepted, p.next)
		if !p.send(p.next, p.accepted+uint64(p.held)) {
			return false
		}
		p.held += len(p.next)
		p.next = nil
	}
	if !p.ended || p.next != nil || len(p.unaccepted) > 0 {
		return true
	}
	p.finish()
	return false
}

// finish ends the input. A read error is not an end: the program must not see
// one and succeed on a prefix, so the attachment is abandoned instead and the
// guest ends the session.
func (p *inputPump) finish() {
	s := p.session
	if s.input.failure != nil {
		s.inputFailure = s.input.failure
		s.abandon()
		return
	}
	if s.pty {
		return
	}
	_, _ = s.control(func(sequence uint64) *v1.AttachmentRequest {
		return &v1.AttachmentRequest{
			Command: &v1.AttachmentRequest_CloseInput{CloseInput: &v1.CloseInput{Sequence: sequence}},
		}
	})
}

func (p *inputPump) send(data []byte, offset uint64) bool {
	sequence, err := p.session.control(func(sequence uint64) *v1.AttachmentRequest {
		return &v1.AttachmentRequest{
			Command: &v1.AttachmentRequest_Input{Input: &v1.Input{Sequence: sequence, Data: data, Offset: offset}},
		}
	})
	p.awaiting = append(p.awaiting, sequence)
	return err == nil
}

// acknowledged settles the oldest outstanding input; other controls'
// acknowledgements pass by.
func (p *inputPump) acknowledged(ack *v1.Ack) bool {
	if len(p.awaiting) == 0 || p.awaiting[0] != ack.GetSequence() {
		return true
	}
	p.awaiting = p.awaiting[1:]
	p.accepted = ack.GetInputOffset()
	switch {
	case ack.GetAccepted():
		p.held -= len(p.unaccepted[0])
		p.unaccepted = p.unaccepted[1:]
	case ack.GetReason() == queueFull || ack.GetReason() == outOfOrder:
		p.refused = true
	default:
		// The program is gone or takes no more input; its exit arrives on the stream.
		return false
	}
	return true
}

func (p *inputPump) sendAgain() bool {
	p.refused = false
	offset := p.accepted
	for _, data := range p.unaccepted {
		if !p.send(data, offset) {
			return false
		}
		offset += uint64(len(data))
	}
	return true
}

func (s *shellSession) followSize(ctx context.Context) {
	resized := s.terminal.Resized(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-resized:
			cols, rows, err := s.terminal.Size()
			if err != nil {
				continue
			}
			width, height := clampGrid(cols, rows)
			_, _ = s.control(func(sequence uint64) *v1.AttachmentRequest {
				return &v1.AttachmentRequest{
					Command: &v1.AttachmentRequest_Resize{Resize: &v1.Resize{Sequence: sequence, Cols: width, Rows: height}},
				}
			})
		}
	}
}

func clampGrid(cols, rows int) (uint32, uint32) {
	return uint32(min(max(cols, protocol.MinCols), protocol.MaxCols)), uint32(min(max(rows, protocol.MinRows), protocol.MaxRows))
}
