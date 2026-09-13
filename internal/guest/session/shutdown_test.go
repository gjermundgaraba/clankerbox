package session

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"clankerbox/internal/model"

	"github.com/google/uuid"

	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/guest/vt"
)

func TestShutdownJoinsExitedSessionsAndRefusesCreation(t *testing.T) {
	t.Parallel()
	m, err := New(t.Context(), Config{StateDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	ended := time.Now().Add(-2 * endedRetention).UTC().Format(time.RFC3339Nano)
	s := &Session{record: protocol.Session{ID: "finishing", Status: protocol.StatusExited, EndedAt: &ended}, waitDone: make(chan struct{})}
	m.live[s.record.ID] = s
	m.prune(time.Now())
	if len(m.live) != 1 {
		t.Fatal("pruned a session before exit processing completed")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err = m.Shutdown(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("shutdown failed to retain pending work: %v", err)
	}
	if _, err = m.Create(protocol.CreateArgs{SessionID: uuid.NewString()}); err == nil {
		t.Fatal("created after shutdown began")
	}
	close(s.waitDone)
	var calls sync.WaitGroup
	for range 8 {
		calls.Go(m.Close)
	}
	calls.Wait()
	select {
	case <-m.closed:
	default:
		t.Fatal("close returned before joining")
	}
}

func TestShutdownOwnsProcessAndFinalCaptureAfterCancellation(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	loader, err := vt.NewLoader(context.WithoutCancel(ctx))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = loader.Close(context.Background()) })
	m, err := New(ctx, Config{StateDir: t.TempDir(), Loader: loader, Incarnation: uuid.NewString()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	record, err := m.Create(protocol.CreateArgs{SessionID: uuid.NewString(), CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Cwd: t.TempDir(), Cols: 80, Rows: 24, Argv: []string{"/bin/sh", "-c", "printf CAPTURE_READY; exec cat"}})
	if err != nil {
		t.Fatal(err)
	}
	s := m.live[record.ID]
	deadline := time.After(5 * time.Second)
	for s.snapshot().Offset == 0 {
		select {
		case <-deadline:
			t.Fatal("child did not produce initial output")
		case <-time.After(time.Millisecond):
		}
	}
	cancel()
	// Cancelling the parent context leaves the terminal usable.
	if _, err = s.resize(81, 25); err != nil {
		t.Fatalf("cancelled parent invalidated terminal: %v", err)
	}
	closeAlongsideCreation(t, m)
	select {
	case <-s.readDone:
	default:
		t.Fatal("reader not joined")
	}
	select {
	case <-s.writer.done:
	default:
		t.Fatal("writer not joined")
	}
	select {
	case <-s.waitDone:
	default:
		t.Fatal("exit processing not joined")
	}
	if s.view == nil || len(s.final) == 0 {
		t.Fatal("shutdown lost final terminal capture")
	}
	records, err := readManifests(m.cfg.StateDir, m.cfg.Log)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != len(m.live) {
		t.Fatalf("final record not persisted: %+v", records)
	}
	for _, record := range records {
		if record.Session.Status != protocol.StatusExited {
			t.Fatalf("unfinished shutdown record: %+v", record)
		}
	}
}

func closeAlongsideCreation(t *testing.T, m *Manager) {
	t.Helper()
	start := make(chan struct{})
	var work sync.WaitGroup
	for range 4 {
		work.Go(func() {
			<-start
			_, err := m.Create(protocol.CreateArgs{SessionID: uuid.NewString(), CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Cols: 80, Rows: 24, Argv: []string{"/bin/sh", "-c", "exit 0"}})
			var typed *model.Error
			if err != nil && (!errors.As(err, &typed) || typed.Reason != model.ReasonNotRunning) {
				t.Errorf("concurrent create: %v", err)
			}
		})
		work.Go(func() { <-start; m.Close() })
	}
	close(start)
	work.Wait()
	for _, s := range m.live {
		select {
		case <-s.waitDone:
		default:
			t.Fatal("concurrent creation escaped shutdown ownership")
		}
	}
}
