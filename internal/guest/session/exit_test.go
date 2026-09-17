package session

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/guest/vt"
)

// An ended session keeps its record and final screen and nothing else: the
// terminal and the ring are released at exit, not at retention.
func TestExitReleasesTheTerminalAndKeepsTheView(t *testing.T) {
	t.Parallel()
	loader, err := vt.NewLoader(t.Context())
	if err != nil {
		t.Fatalf("loader: %v", err)
	}
	t.Cleanup(func() { _ = loader.Close(context.Background()) })
	m, err := New(t.Context(), Config{StateDir: t.TempDir(), Loader: loader, Incarnation: uuid.NewString()})
	if err != nil {
		t.Fatalf("manager: %v", err)
	}
	t.Cleanup(m.Close)
	record, err := createDetached(m, protocol.CreateArgs{
		SessionID: uuid.NewString(),
		Argv:      []string{"/bin/sh", "-c", "printf 'RELEASED_%s\\n' view; exit 3"},
		Cwd:       t.TempDir(),
		Cols:      80,
		Rows:      24,
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	m.mu.Lock()
	s := m.live[record.ID]
	m.mu.Unlock()
	<-s.waitDone
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.term != nil || s.ring != nil {
		t.Fatal("terminal or ring retained after exit")
	}
	if s.record.Status != protocol.StatusExited || s.view == nil || !bytes.Contains(s.final, []byte("RELEASED_view")) {
		t.Fatalf("final view missing after exit: %+v %q", s.view, s.final)
	}
}

type discardSink struct{}

func (discardSink) SendSnapshot([]byte) error       { return nil }
func (discardSink) SendOutput(uint64, []byte) error { return nil }
func (discardSink) SendStderr(uint64, []byte) error { return nil }
func (discardSink) SendEvent(any) error             { return nil }
func (discardSink) Close()                          {}

// createDetached creates a session the only way there is, inside an attachment,
// and detaches at once: the session runs on with nobody attached.
func createDetached(m *Manager, args protocol.CreateArgs) (protocol.Session, error) {
	value, attachment, err := m.Open(protocol.OpenArgs{SessionID: args.SessionID, Create: &args}, discardSink{})
	if attachment != nil {
		attachment.Stop()
	}
	return value.Session, err
}

func TestRepeatedEndOfInputDoesNotGrowTheQueue(t *testing.T) {
	t.Parallel()
	w := newPtyWriter(inputBudget)
	for range 1000 {
		w.enqueueEOF()
	}
	if len(w.entries) != 1 {
		t.Fatalf("%d end-of-input entries queued", len(w.entries))
	}
	if reason := w.enqueueInput([]byte("late")); reason != refusedInputClosed {
		t.Fatalf("input after its end: %q", reason)
	}
}
