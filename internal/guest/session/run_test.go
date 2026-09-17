package session_test

import (
	"bytes"
	"crypto/rand"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/guest/session"
	"clankerbox/internal/model"
)

func (r *recorder) errText() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return string(r.stderr)
}

func (r *recorder) exited() (protocol.Session, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, event := range r.events {
		if ended, ok := event.(protocol.SessionEvent); ok {
			return ended.Session, true
		}
	}
	return protocol.Session{}, false
}

// run creates a session inside its attachment and streams it to the recorder.
func run(
	t *testing.T,
	m *session.Manager,
	sink *recorder,
	create protocol.CreateArgs,
	open protocol.OpenArgs,
) (protocol.OpenValue, *session.Attachment) {
	t.Helper()
	create.SessionID = uuid.NewString()
	create.CreatedAt = stamp()
	if create.Cwd == "" {
		create.Cwd = t.TempDir()
	}
	if !create.Pipes && create.Cols == 0 {
		create.Cols, create.Rows = 80, 24
	}
	open.SessionID = create.SessionID
	open.Create = &create
	value, attachment, err := m.Open(open, sink)
	if err != nil {
		t.Fatalf("open create: %v", err)
	}
	t.Cleanup(func() { _, _ = m.End(create.SessionID) })
	go attachment.Run()
	t.Cleanup(attachment.Stop)
	return value, attachment
}

func waitExit(t *testing.T, sink *recorder) protocol.Session {
	t.Helper()
	var record protocol.Session
	eventually(t, "exit event", func() bool {
		var ok bool
		record, ok = sink.exited()
		return ok
	})
	return record
}

// A command may finish before any separate attach could reach it; created
// inside its attachment, it never outruns its only reader.
func TestCreateOnOpenDeliversFastCommands(t *testing.T) {
	t.Parallel()
	m, _ := newManager(t)
	for i := range 25 {
		sink := newRecorder()
		value, _ := run(t, m, sink, protocol.CreateArgs{Argv: []string{shell, "-c", "printf fast; exit 7"}}, protocol.OpenArgs{})
		if value.Mode != protocol.ModeResume || value.Offset != 0 {
			t.Fatalf("run %d: opened %+v", i, value)
		}
		record := waitExit(t, sink)
		if record.ExitCode == nil || *record.ExitCode != 7 {
			t.Fatalf("run %d: exit %+v", i, record)
		}
		if got := sink.text(); got != "fast" {
			t.Fatalf("run %d: output %q", i, got)
		}
	}
}

func TestCreateOnOpenAttachesToAKnownSession(t *testing.T) {
	t.Parallel()
	m, _ := newManager(t)
	record := create(t, m, shell, "-c", "printf known; "+sleepForever)
	eventually(t, "output", func() bool { return inspect(t, m, record.ID).Offset == 5 })
	args := protocol.CreateArgs{
		SessionID: record.ID, Argv: record.Argv, Cwd: record.Cwd, Cols: 80, Rows: 24, CreatedAt: stamp(),
	}
	from := uint64(0)
	sink := newRecorder()
	value, attachment, err := m.Open(protocol.OpenArgs{
		SessionID: record.ID, Create: &args, FromOffset: &from, FromIncarnation: record.Incarnation,
	}, sink)
	if err != nil || value.Mode != protocol.ModeResume || value.Session.PID != inspect(t, m, record.ID).PID {
		t.Fatalf("open known: %v %+v", err, value)
	}
	go attachment.Run()
	t.Cleanup(attachment.Stop)
	eventually(t, "replay", func() bool { return sink.text() == "known" })

	args.Argv = []string{shell, "-c", "different"}
	_, _, err = m.Open(protocol.OpenArgs{SessionID: record.ID, Create: &args}, newRecorder())
	var typed *model.Error
	if !errors.As(err, &typed) || typed.Reason != model.ReasonConflict {
		t.Fatalf("different arguments: %v", err)
	}
}

func TestEndOnDetachEndsTheSessionWithItsLastAttachment(t *testing.T) {
	t.Parallel()
	m, _ := newManager(t)
	sink := newRecorder()
	value, first := run(t, m, sink, protocol.CreateArgs{Argv: []string{shell, "-c", sleepForever}, EndOnDetach: true},
		protocol.OpenArgs{})
	if !value.Session.EndOnDetach {
		t.Fatalf("record %+v", value.Session)
	}
	second := newRecorder()
	_, viewer, err := m.Open(protocol.OpenArgs{SessionID: value.Session.ID}, second)
	if err != nil {
		t.Fatal(err)
	}
	go viewer.Run()
	first.Stop()
	time.Sleep(10 * pollPeriod)
	if got := inspect(t, m, value.Session.ID).Status; got != protocol.StatusRunning {
		t.Fatalf("ended with an attachment left: %s", got)
	}
	viewer.Stop()
	eventually(t, "end after last detach", func() bool {
		return inspect(t, m, value.Session.ID).Status == protocol.StatusExited
	})

	kept := newRecorder()
	plain, attachment := run(t, m, kept, protocol.CreateArgs{Argv: []string{shell, "-c", sleepForever}}, protocol.OpenArgs{})
	attachment.Stop()
	time.Sleep(10 * pollPeriod)
	if got := inspect(t, m, plain.Session.ID).Status; got != protocol.StatusRunning {
		t.Fatalf("a session without the option ended on detach: %s", got)
	}
}

func TestPipeSessionSeparatesStreamsAndEndsInput(t *testing.T) {
	t.Parallel()
	m, _ := newManager(t)
	sink := newRecorder()
	script := `test -t 0 || test -t 1 || echo notty; cat; echo problem >&2; exit 3`
	value, _ := run(t, m, sink, protocol.CreateArgs{Argv: []string{shell, "-c", script}, Pipes: true}, protocol.OpenArgs{})
	id := value.Session.ID
	if !value.Session.Pipes || !value.Session.EndOnDetach || value.Session.Cols != 0 {
		t.Fatalf("record %+v", value.Session)
	}
	payload := make([]byte, 300*1024)
	_, _ = rand.Read(payload)
	for start := 0; start < len(payload); start += 64 * 1024 {
		chunk := payload[start:min(len(payload), start+64*1024)]
		eventually(t, "input admitted", func() bool {
			result, err := m.Input(id, chunk)
			return err == nil && result.Status == protocol.InputAccepted
		})
	}
	if result, err := m.CloseInput(id); err != nil || result.Status != protocol.InputAccepted {
		t.Fatalf("close input: %v %+v", err, result)
	}
	record := waitExit(t, sink)
	if record.ExitCode == nil || *record.ExitCode != 3 {
		t.Fatalf("exit %+v", record)
	}
	sink.mu.Lock()
	output := append([]byte(nil), sink.output...)
	sink.mu.Unlock()
	if !bytes.Equal(output, append([]byte("notty\n"), payload...)) {
		t.Fatalf("stdout carried %d bytes, want %d binary-exact", len(output), len(payload)+6)
	}
	if got := sink.errText(); got != "problem\n" {
		t.Fatalf("stderr %q", got)
	}
}

func TestPipeSessionRefusesWhatOnlyATerminalHas(t *testing.T) {
	t.Parallel()
	m, _ := newManager(t)
	var typed *model.Error
	var err error
	value, _ := run(t, m, newRecorder(), protocol.CreateArgs{Argv: []string{shell, "-c", sleepForever}, Pipes: true},
		protocol.OpenArgs{})
	if _, _, err = m.Open(protocol.OpenArgs{SessionID: value.Session.ID}, newRecorder()); !errors.As(err, &typed) ||
		typed.Reason != model.ReasonConflict {
		t.Fatalf("second attachment: %v", err)
	}
	if _, err = m.Resize(protocol.ResizeArgs{SessionID: value.Session.ID, Cols: 80, Rows: 24}); !errors.As(err, &typed) ||
		typed.Reason != model.ReasonInvalid {
		t.Fatalf("resize: %v", err)
	}
	// End of input is final and repeating it changes nothing.
	for range 3 {
		if result, closeErr := m.CloseInput(value.Session.ID); closeErr != nil || result.Status != protocol.InputAccepted {
			t.Fatalf("close input: %v %+v", closeErr, result)
		}
	}
	if result, inputErr := m.Input(value.Session.ID, []byte("late")); inputErr != nil ||
		result.Status != protocol.InputRefused || result.Reason != "input_closed" {
		t.Fatalf("input after its end: %v %+v", inputErr, result)
	}
	terminal := create(t, m, shell, "-c", sleepForever)
	if result, closeErr := m.CloseInput(terminal.ID); closeErr != nil || result.Status != protocol.InputRefused {
		t.Fatalf("close input on a terminal: %v %+v", closeErr, result)
	}
}

// A pipe session retains nothing, so a slow consumer must slow the child
// instead of losing output.
func TestPipeSessionHoldsTheProducerForASlowConsumer(t *testing.T) {
	t.Parallel()
	m, _ := newManager(t)
	sink := newRecorder()
	const total = 24 * 1024 * 1024
	create := protocol.CreateArgs{SessionID: uuid.NewString(), CreatedAt: stamp(), Cwd: t.TempDir(), Pipes: true,
		Argv: []string{shell, "-c", "head -c 25165824 /dev/zero"}}
	_, attachment, err := m.Open(protocol.OpenArgs{SessionID: create.SessionID, Create: &create}, sink)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(attachment.Stop)
	// Let the tail fill well past its limit before the consumer starts.
	time.Sleep(500 * time.Millisecond)
	if got := inspect(t, m, create.SessionID).Offset; got >= total {
		t.Fatalf("the producer was not held: %d bytes already read", got)
	}
	go attachment.Run()
	waitExit(t, sink)
	sink.mu.Lock()
	defer sink.mu.Unlock()
	if len(sink.output) != total {
		t.Fatalf("delivered %d of %d bytes", len(sink.output), total)
	}
	for _, event := range sink.events {
		if gap, ok := event.(protocol.GapEvent); ok {
			t.Fatalf("consumer was dropped: %+v", gap)
		}
	}
}

func TestFilteredAttachmentOmitsAnsweredQueriesAndUsesTheProfile(t *testing.T) {
	t.Parallel()
	m, _ := newManager(t)
	background := uint32(0xFAFBFC)
	filtered := newRecorder()
	filtered.filtered = true
	// The shell asks for the background colour and prints the terminal's answer.
	script := `stty raw -echo; printf 'A\033]11;?\007B'; dd bs=1 count=24 2>/dev/null | od -An -c | tr -d ' \n'; printf 'C\033[1mD'`
	value, _ := run(t, m, filtered, protocol.CreateArgs{Argv: []string{shell, "-c", script}},
		protocol.OpenArgs{OmitAnsweredQueries: true, Profile: &protocol.TerminalProfile{Background: &background}})
	if value.Mode != protocol.ModeResume {
		t.Fatalf("opened %+v", value)
	}
	waitExit(t, filtered)
	got := filtered.text()
	if strings.Contains(got, "\x1b]11;?") || !strings.HasPrefix(got, "AB") || !strings.HasSuffix(got, "C\x1b[1mD") {
		t.Fatalf("filtered output %q", got)
	}
	if !strings.Contains(got, "rgb:fafa/fbfb/fcfc") {
		t.Fatalf("the terminal did not answer with the attached terminal's background: %q", got)
	}
}

// The child can exit while its last output still sits in the pipe behind a
// consumer that has stopped reading, such as a pager. Draining must wait for
// that consumer instead of closing the pipe under it.
func TestPipeSessionKeepsOutputForAConsumerPausedAtExit(t *testing.T) {
	t.Parallel()
	m, _ := newManager(t)
	sink := newRecorder()
	const total = 8500000
	create := protocol.CreateArgs{SessionID: uuid.NewString(), CreatedAt: stamp(), Cwd: t.TempDir(), Pipes: true,
		Argv: []string{shell, "-c", "head -c 8500000 /dev/zero"}}
	_, attachment, err := m.Open(protocol.OpenArgs{SessionID: create.SessionID, Create: &create}, sink)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(attachment.Stop)
	// Longer than the drain timeout: the child has written everything and exited.
	time.Sleep(3 * time.Second)
	go attachment.Run()
	record := waitExit(t, sink)
	sink.mu.Lock()
	defer sink.mu.Unlock()
	if record.ExitCode == nil || *record.ExitCode != 0 || len(sink.output) != total {
		t.Fatalf("exit %v with %d of %d bytes", record.ExitCode, len(sink.output), total)
	}
}
