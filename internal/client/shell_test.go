package client_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/urfave/cli/v3"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/client"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
	"clankerbox/internal/rpctransport"
)

const shellCommand = "shell"

// scriptedGuest plays the guest for one attachment.
type scriptedGuest struct {
	clankerboxv1connect.UnimplementedSessionServiceHandler

	mu       sync.Mutex
	open     *v1.Open
	controls []*v1.AttachmentRequest
	detached chan struct{}
	// refusals is how many times an input is refused for lack of room. Like the
	// guest, the script admits input only at the offset it has accepted.
	refusals int
	accepted uint64
	// script runs after Opened; the default echoes input like cat.
	script func(*scriptedGuest, *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent]) error
	// refuse fails the attachment before it opens.
	refuse error
}

func (g *scriptedGuest) DescribeGuest(
	_ context.Context,
	r *connect.Request[v1.DescribeGuestRequest],
) (*connect.Response[v1.GuestDescription], error) {
	if g.refuse != nil {
		return nil, g.refuse
	}
	return connect.NewResponse(&v1.GuestDescription{
		MachineId: r.Msg.GetMachineId(), Incarnation: "incarnation", DaemonVersion: "test", User: "root", Schema: rpcmodel.Schema,
	}), nil
}

func (g *scriptedGuest) AttachSession(
	_ context.Context,
	stream *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent],
) error {
	defer close(g.detached)
	first, err := stream.Receive()
	if err != nil {
		return err
	}
	g.mu.Lock()
	g.open = first.GetOpen()
	g.mu.Unlock()
	if g.refuse != nil {
		return g.refuse
	}
	session := &v1.Session{Id: g.open.GetSessionId(), Status: v1.SessionStatus_SESSION_STATUS_RUNNING}
	if err = stream.Send(&v1.AttachmentEvent{Event: &v1.AttachmentEvent_Opened{Opened: &v1.Opened{
		Session: session, Mode: v1.OpenMode_OPEN_MODE_RESUME,
	}}}); err != nil {
		return err
	}
	if g.script != nil {
		return g.script(g, stream)
	}
	return g.cat(stream)
}

func output(data string, stream v1.OutputStream) *v1.AttachmentEvent {
	return &v1.AttachmentEvent{Event: &v1.AttachmentEvent_Output{Output: &v1.Output{Data: []byte(data), Stream: stream}}}
}

func exited(code int32) *v1.AttachmentEvent {
	return &v1.AttachmentEvent{Event: &v1.AttachmentEvent_SessionExited{SessionExited: &v1.SessionExited{
		Session: &v1.Session{Status: v1.SessionStatus_SESSION_STATUS_EXITED, ExitCode: &code},
	}}}
}

func (g *scriptedGuest) record(control *v1.AttachmentRequest) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.controls = append(g.controls, control)
}

// cat echoes input to stdout until input closes, then reports on stderr and exits 3.
func (g *scriptedGuest) cat(stream *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent]) error {
	for {
		control, err := stream.Receive()
		if err != nil {
			return nil //nolint:nilerr // The client leaving ends the script.
		}
		g.record(control)
		if closing := control.GetCloseInput(); closing != nil {
			for _, event := range []*v1.AttachmentEvent{
				{Event: &v1.AttachmentEvent_Ack{Ack: &v1.Ack{Sequence: closing.GetSequence(), Accepted: true}}},
				output("done\n", v1.OutputStream_OUTPUT_STREAM_STDERR),
				exited(3),
			} {
				if err = stream.Send(event); err != nil {
					return err
				}
			}
			continue
		}
		input := control.GetInput()
		ack := &v1.Ack{Sequence: input.GetSequence(), Accepted: true}
		g.mu.Lock()
		switch {
		case input.GetOffset() != g.accepted:
			ack.Accepted, ack.Reason = false, "out_of_order"
		case g.refusals > 0 && input.GetSequence()%3 == 0:
			g.refusals--
			ack.Accepted, ack.Reason = false, "queue_full"
		default:
			g.accepted += uint64(len(input.GetData()))
		}
		ack.InputOffset = g.accepted
		g.mu.Unlock()
		if err = stream.Send(&v1.AttachmentEvent{Event: &v1.AttachmentEvent_Ack{Ack: ack}}); err != nil {
			return err
		}
		if ack.GetAccepted() {
			if err = stream.Send(output(string(input.GetData()), v1.OutputStream_OUTPUT_STREAM_UNSPECIFIED)); err != nil {
				return err
			}
		}
	}
}

func newShellFixture(t *testing.T, guest *scriptedGuest) *apiFixture {
	t.Helper()
	guest.detached = make(chan struct{})
	mux := http.NewServeMux()
	mux.Handle(clankerboxv1connect.NewMachineServiceHandler(&rpcFixture{}))
	mux.Handle(clankerboxv1connect.NewSessionServiceHandler(guest))
	a := testAPI(t, startH2(t, rpctransport.Bearer(testToken, mux)))
	writeConfig(t, a)
	return a
}

type shellResult struct {
	out, diagnostics string
	status           int
	message          string
}

func runShell(t *testing.T, a *apiFixture, streams client.Streams, args ...string) shellResult {
	t.Helper()
	var out, diagnostics bytes.Buffer
	streams.Out, streams.Err = &out, &diagnostics
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	err := client.Run(ctx, append([]string{configFlag, a.path}, args...), streams)
	result := shellResult{out: out.String(), diagnostics: diagnostics.String()}
	if err == nil {
		return result
	}
	result.message = err.Error()
	result.status = 1
	if coder, ok := errors.AsType[cli.ExitCoder](err); ok {
		result.status = coder.ExitCode()
	}
	return result
}

func TestShellPipesInputOutputAndStatus(t *testing.T) {
	t.Parallel()
	guest := &scriptedGuest{refusals: 3}
	a := newShellFixture(t, guest)
	payload := strings.Repeat("binary\x00safe\n", 90000)
	result := runShell(t, a, client.Streams{In: strings.NewReader(payload)},
		shellCommand, "--cwd", "work", "--env", "A=b=c", "--label", "job", testMachineName, "--", "cat", "-u")
	if result.status != 3 || result.message != "" || result.out != payload || result.diagnostics != "done\n" {
		t.Fatalf("status %d message %q stdout %d bytes stderr %q", result.status, result.message, len(result.out), result.diagnostics)
	}
	<-guest.detached
	create := guest.open.GetCreate()
	if !create.GetPipes() || !create.GetEndOnDetach() || create.GetCols() != 0 || guest.open.GetMachineId() != testID ||
		guest.open.GetSessionId() == "" || strings.Join(create.GetArgv(), " ") != "cat -u" ||
		create.GetCwd() != "work" || create.GetEnv()["A"] != "b=c" || create.GetLabel() != "job" {
		t.Fatalf("create %v", create)
	}
	if guest.open.GetOmitAnsweredQueries() || guest.open.GetTerminalProfile() != nil || guest.open.GetExpectedEngineDigest() != "" {
		t.Fatalf("a pipe attachment asked for terminal handling: %v", guest.open)
	}
	var previous uint64
	var offered int
	for _, control := range guest.controls {
		sequence := control.GetInput().GetSequence() + control.GetCloseInput().GetSequence()
		if sequence <= previous {
			t.Fatalf("control sequence %d after %d", sequence, previous)
		}
		previous = sequence
		offered += len(control.GetInput().GetData())
	}
	// The echoed output above is exactly the payload, so refused input was sent
	// again from the accepted offset, in order, and nothing was applied twice.
	if offered <= len(payload) || guest.refusals != 0 {
		t.Fatalf("refused input was not sent again: %d bytes offered, %d refusals unused", offered, guest.refusals)
	}
	if guest.controls[len(guest.controls)-1].GetCloseInput() == nil {
		t.Fatal("end of input was not delivered last")
	}
}

type fakeTerminal struct {
	mu       sync.Mutex
	raw      bool
	restored bool
	cols     int
	resized  chan struct{}
}

func (f *fakeTerminal) Raw() (func(), error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.raw = true
	return func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.restored = true
	}, nil
}

func (f *fakeTerminal) Size() (int, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cols, 5000, nil
}

func (f *fakeTerminal) Resized(context.Context) <-chan struct{} { return f.resized }

func TestShellTerminalSession(t *testing.T) {
	t.Parallel()
	terminal := &fakeTerminal{cols: 132, resized: make(chan struct{}, 1)}
	guest := &scriptedGuest{script: func(g *scriptedGuest, stream *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent]) error {
		var typed []byte
		for len(typed) < len("typed ahead") {
			control, err := stream.Receive()
			if err != nil {
				return err
			}
			typed = append(typed, control.GetInput().GetData()...)
			if err = stream.Send(&v1.AttachmentEvent{
				Event: &v1.AttachmentEvent_Ack{Ack: &v1.Ack{Sequence: control.GetInput().GetSequence(), Accepted: true}},
			}); err != nil {
				return err
			}
		}
		terminal.mu.Lock()
		terminal.cols = 90
		terminal.mu.Unlock()
		terminal.resized <- struct{}{}
		control, err := stream.Receive()
		if err != nil {
			return err
		}
		g.record(control)
		if err = stream.Send(output("screen:"+string(typed), v1.OutputStream_OUTPUT_STREAM_UNSPECIFIED)); err != nil {
			return err
		}
		return stream.Send(exited(0))
	}}
	a := newShellFixture(t, guest)
	// The terminal answers the colour probe around what the user already typed.
	in, feed := io.Pipe()
	go func() {
		_, _ = feed.Write([]byte("typed\x1b]11;rgb:fafa/fbfb/fcfc\x1b\\ ahead\x1b]10;rgb:1/2/3\x07\x1b[?62;22c"))
	}()
	t.Cleanup(func() { _ = feed.Close() })
	result := runShell(t, a, client.Streams{In: in, Terminal: terminal}, shellCommand, testMachineName)
	if result.status != 0 || result.message != "" {
		t.Fatalf("status %d message %q", result.status, result.message)
	}
	if !strings.HasSuffix(result.out, "screen:typed ahead") || strings.Contains(result.out, "\x1b[?1049l") {
		t.Fatalf("output %q", result.out)
	}
	<-guest.detached
	create, profile := guest.open.GetCreate(), guest.open.GetTerminalProfile()
	if create.GetPipes() || !create.GetEndOnDetach() || create.GetCols() != 132 || create.GetRows() != 300 || len(create.GetArgv()) != 0 {
		t.Fatalf("create %v", create)
	}
	if !guest.open.GetOmitAnsweredQueries() || profile.GetBackground() != 0xFAFBFC || profile.GetForeground() != 0x112233 {
		t.Fatalf("open %v", guest.open)
	}
	if resize := guest.controls[0].GetResize(); resize.GetCols() != 90 || resize.GetRows() != 300 {
		t.Fatalf("resize %v", guest.controls)
	}
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	if !terminal.raw || !terminal.restored {
		t.Fatalf("terminal raw=%t restored=%t", terminal.raw, terminal.restored)
	}
}

func TestShellFailures(t *testing.T) {
	t.Parallel()
	prerequisite := rpcmodel.ToError(model.NewError(model.ReasonPrerequisite, "session requires a running machine", false))
	for _, test := range []struct {
		name     string
		guest    *scriptedGuest
		args     []string
		terminal bool
		status   int
		message  string
	}{
		{"typed refusal", &scriptedGuest{refuse: prerequisite}, []string{shellCommand, testMachineName}, false, 255, "reason: prerequisite"},
		{"lost output", &scriptedGuest{script: func(_ *scriptedGuest, s *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent]) error {
			return s.Send(&v1.AttachmentEvent{Event: &v1.AttachmentEvent_Gap{Gap: &v1.Gap{Reason: "overflow"}}})
		}}, []string{shellCommand, testMachineName}, true, 255, "output was lost: overflow"},
		{"stream ends early", &scriptedGuest{script: func(*scriptedGuest, *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent]) error {
			return nil
		}}, []string{shellCommand, testMachineName}, false, 255, "before the program exited"},
		{"killed program", &scriptedGuest{script: func(_ *scriptedGuest, s *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent]) error {
			name := "SIGKILL"
			return s.Send(&v1.AttachmentEvent{Event: &v1.AttachmentEvent_SessionExited{SessionExited: &v1.SessionExited{
				Session: &v1.Session{Status: v1.SessionStatus_SESSION_STATUS_EXITED, Signal: &name},
			}}})
		}}, []string{shellCommand, testMachineName}, false, 137, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			a := newShellFixture(t, test.guest)
			streams := client.Streams{}
			if test.terminal {
				streams.Terminal = &fakeTerminal{cols: 80, resized: make(chan struct{})}
			}
			result := runShell(t, a, streams, test.args...)
			if result.status != test.status || !strings.Contains(result.message, test.message) ||
				(test.message == "" && result.message != "") {
				t.Fatalf("status %d message %q", result.status, result.message)
			}
			if test.terminal && !strings.Contains(result.out, "\x1b[?25h") {
				t.Fatalf("a cut-off terminal session did not reset the terminal: %q", result.out)
			}
		})
	}
}

func TestStructuredErrorsCarryTheReason(t *testing.T) {
	t.Parallel()
	refusal := rpcmodel.ToError(model.NewError(model.ReasonPrerequisite, "session requires a running machine", false))
	for _, args := range [][]string{{jsonFlag, "guest", testMachineName}, {jsonFlag, shellCommand, testMachineName}} {
		result := runShell(t, newShellFixture(t, &scriptedGuest{refuse: refusal}), client.Streams{}, args...)
		var report struct {
			Error struct {
				Message   string `json:"message"`
				Code      string `json:"code"`
				Reason    string `json:"reason"`
				Retryable bool   `json:"retryable"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(result.message), &report); err != nil {
			t.Fatalf("%v: %q: %v", args, result.message, err)
		}
		if report.Error.Reason != "prerequisite" || report.Error.Code != "failed_precondition" || report.Error.Retryable ||
			!strings.Contains(report.Error.Message, "running machine") || result.out != "" || result.diagnostics != "" {
			t.Fatalf("%v: %+v stdout %q", args, report, result.out)
		}
	}
}

func TestGuestCommand(t *testing.T) {
	t.Parallel()
	a := newShellFixture(t, &scriptedGuest{})
	result := runShell(t, a, client.Streams{}, jsonFlag, "guest", testMachineName)
	var guest map[string]any
	if err := json.Unmarshal([]byte(result.out), &guest); err != nil || result.status != 0 {
		t.Fatalf("%q: %v", result.out, err)
	}
	if guest["machine_id"] != testID || guest["incarnation"] != "incarnation" || guest["daemon_version"] != "test" {
		t.Fatalf("guest %v", guest)
	}
	plain := runShell(t, a, client.Streams{}, "guest", testMachineName)
	if !strings.Contains(plain.out, "Guest of "+testID) || !strings.Contains(plain.out, "Incarnation: incarnation") {
		t.Fatalf("plain %q", plain.out)
	}
}

func TestShellJudgesArgumentsBeforeConfiguration(t *testing.T) {
	t.Parallel()
	for want, args := range map[string][]string{
		"requires a machine":   {shellCommand},
		"must be KEY=VALUE":    {shellCommand, "--env", "novalue", testMachineName},
		"exclude each other":   {shellCommand, "-t", "-T", testMachineName},
		"requires 1 arguments": {"guest"},
	} {
		err := client.Run(t.Context(), append([]string{configFlag, missingConfig}, args...), client.Streams{})
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("%v: %v", args, err)
		}
	}
}

// What the session is does not depend on what is attached here: a command can
// be given a terminal from a script, and pipes from a terminal.
func TestShellSessionKindIsIndependentOfTheLocalTerminal(t *testing.T) {
	t.Parallel()
	finish := func(_ *scriptedGuest, stream *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent]) error {
		return stream.Send(exited(0))
	}
	headless := &scriptedGuest{script: finish}
	result := runShell(t, newShellFixture(t, headless), client.Streams{In: strings.NewReader("ignored")},
		shellCommand, "--tty", testMachineName, "--", "top")
	<-headless.detached
	create := headless.open.GetCreate()
	if result.status != 0 || create.GetPipes() || create.GetCols() != 80 || create.GetRows() != 24 ||
		headless.open.GetOmitAnsweredQueries() || headless.open.GetTerminalProfile() != nil {
		t.Fatalf("status %d message %q open %v", result.status, result.message, headless.open)
	}
	for _, control := range headless.controls {
		if control.GetCloseInput() != nil {
			t.Fatal("a terminal session was sent an end of input")
		}
	}
	terminal := &fakeTerminal{cols: 100, resized: make(chan struct{})}
	piped := &scriptedGuest{script: finish}
	result = runShell(t, newShellFixture(t, piped), client.Streams{Terminal: terminal}, shellCommand, "-T", testMachineName)
	<-piped.detached
	if result.status != 0 || !piped.open.GetCreate().GetPipes() || piped.open.GetCreate().GetCols() != 0 || terminal.raw {
		t.Fatalf("status %d open %v raw %t", result.status, piped.open, terminal.raw)
	}
}

type failingInput struct{ sent bool }

func (f *failingInput) Read(p []byte) (int, error) {
	if !f.sent {
		f.sent = true
		return copy(p, "a prefix"), nil
	}
	return 0, errors.New("input/output error")
}

// A read error is not the end of the input: the program must never see an end
// of input and succeed on a prefix.
func TestShellInputFailureIsNotAnEndOfInput(t *testing.T) {
	t.Parallel()
	guest := &scriptedGuest{}
	result := runShell(t, newShellFixture(t, guest), client.Streams{In: &failingInput{}}, shellCommand, testMachineName, "--", "cat")
	<-guest.detached
	if result.status != 255 || !strings.Contains(result.message, "read input: input/output error") {
		t.Fatalf("status %d message %q", result.status, result.message)
	}
	guest.mu.Lock()
	defer guest.mu.Unlock()
	for _, control := range guest.controls {
		if control.GetCloseInput() != nil {
			t.Fatal("the program was told its input had ended")
		}
	}
}

func TestShellInterruptedEndsPromptly(t *testing.T) {
	t.Parallel()
	attached := make(chan struct{})
	guest := &scriptedGuest{script: func(_ *scriptedGuest, stream *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent]) error {
		close(attached)
		for {
			if _, err := stream.Receive(); err != nil {
				return nil //nolint:nilerr // The client leaving ends the script.
			}
		}
	}}
	a := newShellFixture(t, guest)
	ctx, interrupt := context.WithCancel(t.Context())
	defer interrupt()
	go func() {
		<-attached
		interrupt()
	}()
	var out, diagnostics bytes.Buffer
	in, feed := io.Pipe()
	defer func() { _ = feed.Close() }()
	err := client.Run(ctx, []string{configFlag, a.path, shellCommand, testMachineName, "--", "sleep", "600"},
		client.Streams{In: in, Out: &out, Err: &diagnostics})
	coder, ok := errors.AsType[cli.ExitCoder](err)
	if !ok || coder.ExitCode() != 130 || err.Error() != "interrupted" {
		t.Fatalf("interrupt: %v", err)
	}
	select {
	case <-guest.detached:
	case <-time.After(10 * time.Second):
		t.Fatal("the attachment outlived the interrupted command")
	}
}
