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
	record, err := m.Create(protocol.CreateArgs{
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
