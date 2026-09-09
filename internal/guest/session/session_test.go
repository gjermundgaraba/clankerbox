package session_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/guest/session"
	"clankerbox/internal/guest/vt"
)

const (
	waitTimeout  = 15 * time.Second
	pollPeriod   = 20 * time.Millisecond
	shell        = "/bin/sh"
	sleepForever = "sleep 30"
)

// recorder is a Sink that collects delivered frames.
type recorder struct {
	mu       sync.Mutex
	snapshot bool
	prefix   []byte
	output   []byte
	next     uint64
	events   []any
	closed   chan struct{}
	fail     bool
}

func newRecorder() *recorder {
	return &recorder{closed: make(chan struct{})}
}

func (r *recorder) SendSnapshot(data []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.fail {
		return errors.New("sink failed")
	}
	r.snapshot = true
	r.prefix = append([]byte(nil), data...)
	return nil
}

func (r *recorder) SendOutput(next uint64, data []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.fail {
		return errors.New("sink failed")
	}
	if r.next != 0 && next != r.next+uint64(len(data)) {
		return errors.New("non-contiguous output")
	}
	r.next = next
	r.output = append(r.output, data...)
	return nil
}

func (r *recorder) SendEvent(event any) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event)
	return nil
}

func (r *recorder) Close() {
	select {
	case <-r.closed:
	default:
		close(r.closed)
	}
}

func (r *recorder) text() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return string(r.output)
}

func (r *recorder) prefixBytes() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.prefix
}

func newLoader(t *testing.T) *vt.Loader {
	t.Helper()
	loader, err := vt.NewLoader(t.Context())
	if err != nil {
		t.Fatalf("loader: %v", err)
	}
	t.Cleanup(func() { _ = loader.Close(context.Background()) })
	return loader
}

func newManager(t *testing.T) (*session.Manager, *vt.Loader) {
	t.Helper()
	loader := newLoader(t)
	m, err := session.New(t.Context(), session.Config{
		StateDir:      t.TempDir(),
		Loader:        loader,
		Incarnation:   uuid.NewString(),
		DaemonVersion: "test",
		RingSize:      64 * 1024,
	})
	if err != nil {
		t.Fatalf("manager: %v", err)
	}
	t.Cleanup(m.Close)
	return m, loader
}

func create(t *testing.T, m *session.Manager, argv ...string) protocol.Session {
	t.Helper()
	record, err := m.Create(protocol.CreateArgs{
		SessionID: uuid.NewString(),
		Argv:      argv,
		Cwd:       t.TempDir(),
		Cols:      80,
		Rows:      24,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	t.Cleanup(func() { _, _ = m.End(record.ID) })
	return record
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(waitTimeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(pollPeriod)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func send(t *testing.T, m *session.Manager, id, text string) {
	t.Helper()
	value, err := m.Input(protocol.InputArgs{
		SessionID: id,
		Data:      base64.StdEncoding.EncodeToString([]byte(text)),
	}, []byte(text))
	if err != nil || value.Status != protocol.InputAccepted {
		t.Fatalf("input %q: %v %+v", text, err, value)
	}
}

// inspect finds one record in the inventory.
func inspect(t *testing.T, m *session.Manager, id string) protocol.Session {
	t.Helper()
	for _, record := range m.List() {
		if record.ID == id {
			return record
		}
	}
	t.Fatalf("session %s is not listed", id)
	return protocol.Session{}
}

// screen reads the current screen the way a consumer does: open, take the
// bootstrap snapshot, restore it into a mirror, release the attachment. An
// ended session answers with its final view instead.
func screen(t *testing.T, loader *vt.Loader, m *session.Manager, id string) string {
	t.Helper()
	sink := newRecorder()
	value, attachment, err := m.Open(protocol.OpenArgs{SessionID: id}, sink)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	switch value.Mode {
	case protocol.ModeEnded:
		if value.View == nil {
			return ""
		}
		attachment.Run()
		return string(sink.prefixBytes())
	case protocol.ModeSnapshot:
	default:
		t.Fatalf("screen needs a snapshot, got %s", value.Mode)
	}
	go attachment.Run()
	eventually(t, "snapshot prefix", func() bool { return len(sink.prefixBytes()) > 0 })
	attachment.Stop()
	mirror, err := loader.New(t.Context(), vt.Options{Cols: value.Session.Cols, Rows: value.Session.Rows})
	if err != nil {
		t.Fatalf("mirror: %v", err)
	}
	defer func() { _ = mirror.Close() }()
	if err = mirror.Restore(sink.prefixBytes()); err != nil {
		t.Fatalf("restore: %v", err)
	}
	text, err := mirror.Text()
	if err != nil {
		t.Fatalf("text: %v", err)
	}
	return text
}

func TestOutputRepliesAndExactlyOnceOpen(t *testing.T) {
	t.Parallel()
	m, loader := newManager(t)
	record := create(
		t,
		m,
		shell,
		"-c",
		`printf 'hello\r\n'; stty -icanon -echo; printf '\033[6n'; dd bs=1 count=6 2>/dev/null | od -c | head -1; stty icanon echo; while read line; do printf 'echo:%s\r\n' "$line"; done`,
	)
	eventually(t, "hello", func() bool { return strings.Contains(screen(t, loader, m, record.ID), "hello") })
	eventually(t, "cursor report reached the child", func() bool {
		return strings.Contains(screen(t, loader, m, record.ID), "033")
	})
	first := newRecorder()
	value, attachment, err := m.Open(protocol.OpenArgs{SessionID: record.ID}, first)
	if err != nil || attachment == nil || value.Mode != protocol.ModeSnapshot || value.SnapshotBytes == 0 {
		t.Fatalf("open: %v %+v", err, value)
	}
	go attachment.Run()
	send(t, m, record.ID, "one\n")
	eventually(t, "live echo", func() bool { return strings.Contains(first.text(), "echo:one") })
	prefix := first.prefixBytes()
	if uint64(len(prefix)) != value.SnapshotBytes || !bytes.HasPrefix(prefix, []byte("GHOSTSNP")) {
		t.Fatalf("snapshot prefix %d bytes, announced %d", len(prefix), value.SnapshotBytes)
	}
	if strings.Contains(first.text(), "hello") {
		t.Fatal("output before the cut was delivered as live bytes")
	}
	second := newRecorder()
	current := inspect(t, m, record.ID)
	from := current.Offset
	value, attachment, err = m.Open(protocol.OpenArgs{
		SessionID:       record.ID,
		FromOffset:      &from,
		FromIncarnation: current.Incarnation,
	}, second)
	if err != nil || value.Mode != protocol.ModeResume || value.Offset != from || value.SnapshotBytes != 0 {
		t.Fatalf("resume open: %v %+v", err, value)
	}
	go attachment.Run()
	send(t, m, record.ID, "two\n")
	eventually(t, "both viewers", func() bool {
		return strings.Contains(first.text(), "echo:two") && strings.Contains(second.text(), "echo:two")
	})
	stale := uint64(1)
	value, attachment, err = m.Open(
		protocol.OpenArgs{SessionID: record.ID, FromOffset: &stale, FromIncarnation: "other"},
		newRecorder(),
	)
	if err != nil || value.Mode != protocol.ModeSnapshot {
		t.Fatalf("foreign incarnation must snapshot: %v %+v", err, value)
	}
	go attachment.Run()
	ended, err := m.End(record.ID)
	if err != nil || ended.Status != protocol.StatusExited {
		t.Fatalf("end: %v %+v", err, ended)
	}
}

func TestEndedOpenDeliversTheFinalViewAndClosesOnFailure(t *testing.T) {
	t.Parallel()
	m, loader := newManager(t)
	record := create(t, m, shell, "-c", `printf 'FINAL_%s\r\n' view; sleep 30`)
	eventually(t, "final text", func() bool { return strings.Contains(screen(t, loader, m, record.ID), "FINAL_view") })
	if _, err := m.End(record.ID); err != nil {
		t.Fatalf("end: %v", err)
	}
	// The ended session is one observation: its final record, then its screen text as
	// announced bytes, never a stream.
	final := newRecorder()
	value, attachment, err := m.Open(protocol.OpenArgs{SessionID: record.ID}, final)
	if err != nil || attachment == nil || attachment.Streams() || value.Mode != protocol.ModeEnded ||
		value.View == nil || value.Session.Status != protocol.StatusExited {
		t.Fatalf("ended open: %v %+v", err, value)
	}
	attachment.Run()
	text := final.prefixBytes()
	if uint64(len(text)) != value.View.Bytes || !strings.Contains(string(text), "FINAL_view") {
		t.Fatalf("final view %d bytes announced %d: %q", len(text), value.View.Bytes, text)
	}
	select {
	case <-final.closed:
		t.Fatal("a delivered view must leave the connection open")
	default:
	}
	// A view that cannot be written closes the connection instead of leaving the
	// announced bytes outstanding; the next opening delivers it again.
	broken := newRecorder()
	broken.fail = true
	_, attachment, err = m.Open(protocol.OpenArgs{SessionID: record.ID}, broken)
	if err != nil || attachment == nil {
		t.Fatalf("reopen ended: %v", err)
	}
	attachment.Run()
	select {
	case <-broken.closed:
	default:
		t.Fatal("failed view transfer left the sink open")
	}
	if again := screen(t, loader, m, record.ID); !strings.Contains(again, "FINAL_view") {
		t.Fatalf("view not delivered again after a failed transfer: %q", again)
	}
}

func TestResumeAcrossRingAndResize(t *testing.T) {
	t.Parallel()
	m, _ := newManager(t)
	record := create(t, m, shell, "-c", `while read line; do printf '%s\r\n' "$line"; done`)
	before := newRecorder()
	value, attachment, err := m.Open(protocol.OpenArgs{SessionID: record.ID}, before)
	if err != nil || value.Mode != protocol.ModeSnapshot {
		t.Fatalf("open: %v %+v", err, value)
	}
	go attachment.Run()
	send(t, m, record.ID, "alpha\n")
	eventually(t, "alpha", func() bool { return strings.Contains(before.text(), "alpha") })
	before.mu.Lock()
	cursor := before.next
	before.mu.Unlock()
	if _, err = m.Resize(protocol.ResizeArgs{SessionID: record.ID, Cols: 100, Rows: 30}); err != nil {
		t.Fatalf("resize: %v", err)
	}
	eventually(t, "ordered resize event", func() bool {
		before.mu.Lock()
		defer before.mu.Unlock()
		for _, event := range before.events {
			if resize, ok := event.(protocol.ResizeEvent); ok && resize.Cols == 100 {
				return true
			}
		}
		return false
	})
	value, attachment, err = m.Open(protocol.OpenArgs{
		SessionID:       record.ID,
		FromOffset:      &cursor,
		FromIncarnation: record.Incarnation,
	}, newRecorder())
	if err != nil || value.Mode != protocol.ModeSnapshot {
		t.Fatalf("resize at the cursor must force a snapshot: %v %+v", err, value)
	}
	go attachment.Run()
	line := strings.Repeat("x", 500) + "\n"
	for range 300 {
		send(t, m, record.ID, line)
	}
	eventually(t, "ring eviction", func() bool { return inspect(t, m, record.ID).RetainedFrom > 0 })
	evicted := inspect(t, m, record.ID).RetainedFrom - 1
	value, attachment, err = m.Open(protocol.OpenArgs{
		SessionID:       record.ID,
		FromOffset:      &evicted,
		FromIncarnation: record.Incarnation,
	}, newRecorder())
	if err != nil || value.Mode != protocol.ModeSnapshot {
		t.Fatalf("evicted offset must snapshot: %v %+v", err, value)
	}
	go attachment.Run()
	if _, err = m.End(record.ID); err != nil {
		t.Fatalf("end: %v", err)
	}
}

func TestInputIsAdmissionOnly(t *testing.T) {
	t.Parallel()
	m, loader := newManager(t)
	record := create(
		t,
		m,
		shell,
		"-c",
		`count=0; while read line; do count=$((count+1)); printf 'n=%s\r\n' "$count"; done`,
	)
	for range 2 {
		send(t, m, record.ID, "a\n")
	}
	eventually(t, "both lines", func() bool { return strings.Contains(screen(t, loader, m, record.ID), "n=2") })
	if _, err := m.End(record.ID); err != nil {
		t.Fatalf("end: %v", err)
	}
	refused, err := m.Input(protocol.InputArgs{SessionID: record.ID, Data: "YQ=="}, []byte("a"))
	if err != nil || refused.Status != protocol.InputRefused || refused.Reason != protocol.CodeNotRunning {
		t.Fatalf("input after exit: %v %+v", err, refused)
	}
	missing := protocol.InputArgs{SessionID: uuid.NewString(), Data: "YQ=="}
	var typed *protocol.Error
	if _, err = m.Input(missing, []byte("a")); !errors.As(err, &typed) || typed.Code != protocol.CodeNotFound {
		t.Fatalf("unknown session: %v", err)
	}
}

func TestExitOutcomesAndLostOnRestart(t *testing.T) {
	t.Parallel()
	loader := newLoader(t)
	stateDir := t.TempDir()
	m, err := session.New(
		t.Context(),
		session.Config{StateDir: stateDir, Loader: loader, Incarnation: uuid.NewString()},
	)
	if err != nil {
		t.Fatalf("manager: %v", err)
	}
	exited, err := m.Create(
		protocol.CreateArgs{SessionID: uuid.NewString(), Argv: []string{shell, "-c", "exit 7"}, Cols: 80, Rows: 24},
	)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	eventually(t, "exit code", func() bool {
		record := inspect(t, m, exited.ID)
		return record.Status == protocol.StatusExited && record.ExitCode != nil && *record.ExitCode == 7
	})
	signalled, err := m.Create(
		protocol.CreateArgs{SessionID: uuid.NewString(), Argv: []string{shell, "-c", sleepForever}, Cols: 80, Rows: 24},
	)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	time.Sleep(100 * time.Millisecond)
	ended, err := m.End(signalled.ID)
	if err != nil || ended.Status != protocol.StatusExited || ended.Signal == nil {
		t.Fatalf("end must record signal termination: %v %+v", err, ended)
	}
	// While this daemon holds the terminal, an ended session still has a view.
	value, attachment, err := m.Open(protocol.OpenArgs{SessionID: exited.ID}, newRecorder())
	if err != nil || attachment == nil || attachment.Streams() || value.Mode != protocol.ModeEnded ||
		value.View == nil {
		t.Fatalf("ended open with view: %v %+v", err, value)
	}
	running, err := m.Create(
		protocol.CreateArgs{SessionID: uuid.NewString(), Argv: []string{shell, "-c", sleepForever}, Cols: 80, Rows: 24},
	)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	m.Close()
	restarted, err := session.New(
		t.Context(),
		session.Config{StateDir: stateDir, Loader: loader, Incarnation: uuid.NewString()},
	)
	if err != nil {
		t.Fatalf("restart: %v", err)
	}
	t.Cleanup(restarted.Close)
	if record := inspect(t, restarted, running.ID); record.Status != protocol.StatusLost {
		t.Fatalf("unfinished record must be lost: %+v", record)
	}
	value, attachment, err = restarted.Open(protocol.OpenArgs{SessionID: running.ID}, newRecorder())
	if err != nil || attachment != nil || value.Mode != protocol.ModeEnded || value.View != nil ||
		value.Session.Status != protocol.StatusLost {
		t.Fatalf("lost session must answer ended without a view: %v %+v", err, value)
	}
	kept := inspect(t, restarted, exited.ID)
	if kept.Status != protocol.StatusExited || kept.ExitCode == nil || *kept.ExitCode != 7 {
		t.Fatalf("known exit must be retained: %+v", kept)
	}
	value, _, err = restarted.Open(protocol.OpenArgs{SessionID: exited.ID}, newRecorder())
	if err != nil || value.Mode != protocol.ModeEnded || value.View != nil {
		t.Fatalf("manifest-only record must have no view: %v %+v", err, value)
	}
	var typed *protocol.Error
	_, _, err = restarted.Open(protocol.OpenArgs{SessionID: uuid.NewString()}, newRecorder())
	if !errors.As(err, &typed) || typed.Code != protocol.CodeNotFound {
		t.Fatalf("unknown session: %v", err)
	}
	_, _ = m.End(running.ID)
}

func TestCreateIdempotentAndCapacity(t *testing.T) {
	t.Parallel()
	loader := newLoader(t)
	m, err := session.New(
		t.Context(),
		session.Config{StateDir: t.TempDir(), Loader: loader, Incarnation: uuid.NewString(), MaxSessions: 1},
	)
	if err != nil {
		t.Fatalf("manager: %v", err)
	}
	t.Cleanup(m.Close)
	args := protocol.CreateArgs{
		SessionID: uuid.NewString(),
		Argv:      []string{shell, "-c", sleepForever},
		Cols:      80,
		Rows:      24,
	}
	first, err := m.Create(args)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	t.Cleanup(func() { _, _ = m.End(first.ID) })
	again, err := m.Create(args)
	if err != nil || again.ID != first.ID || again.PID != first.PID {
		t.Fatalf("repeat create must return the same session: %v %+v", err, again)
	}
	conflict := args
	conflict.Argv = []string{shell, "-c", "sleep 31"}
	if _, err = m.Create(conflict); err == nil {
		t.Fatal("conflicting repeat accepted")
	}
	changedEnv := args
	changedEnv.Env = map[string]string{"CHANGED": "yes"}
	if _, err = m.Create(changedEnv); err == nil {
		t.Fatal("repeat with a different environment accepted")
	}
	other := args
	other.SessionID = uuid.NewString()
	_, err = m.Create(other)
	var typed *protocol.Error
	if !errors.As(err, &typed) || typed.Code != protocol.CodeCapacity {
		t.Fatalf("capacity not enforced: %v", err)
	}
}

func TestSlowSubscriberIsDroppedNotThePTY(t *testing.T) {
	t.Parallel()
	m, loader := newManager(t)
	record := create(
		t,
		m,
		shell,
		"-c",
		`i=0; while [ $i -lt 400 ]; do head -c 65536 /dev/zero | tr '\0' 'y'; i=$((i+1)); done; printf 'FLOOD_DONE\r\n'; sleep 30`,
	)
	slow := newRecorder()
	slow.fail = true
	_, attachment, err := m.Open(protocol.OpenArgs{SessionID: record.ID}, slow)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	go attachment.Run()
	eventually(t, "flood completes with a failing viewer", func() bool {
		return strings.Contains(screen(t, loader, m, record.ID), "FLOOD_DONE")
	})
	select {
	case <-slow.closed:
	case <-time.After(waitTimeout):
		t.Fatal("failing sink was not closed")
	}
}

func TestEndedSessionsExpireFromThisDaemon(t *testing.T) {
	t.Parallel()
	loader := newLoader(t)
	var clock sync.Mutex
	now := time.Now()
	m, err := session.New(t.Context(), session.Config{
		StateDir:    t.TempDir(),
		Loader:      loader,
		Incarnation: uuid.NewString(),
		Now: func() time.Time {
			clock.Lock()
			defer clock.Unlock()
			return now
		},
	})
	if err != nil {
		t.Fatalf("manager: %v", err)
	}
	t.Cleanup(m.Close)
	record := create(t, m, shell, "-c", "exit 0")
	eventually(t, "exit", func() bool { return inspect(t, m, record.ID).Status == protocol.StatusExited })
	clock.Lock()
	now = now.Add(8 * 24 * time.Hour)
	clock.Unlock()
	eventually(t, "retention to remove the ended session", func() bool { return len(m.List()) == 0 })
}

func TestActivityChangesReachAttachments(t *testing.T) {
	t.Parallel()
	m, _ := newManager(t)
	record := create(t, m, shell, "-c", sleepForever)
	sink := newRecorder()
	_, attachment, err := m.Open(protocol.OpenArgs{SessionID: record.ID}, sink)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	go attachment.Run()
	if err = m.Report(protocol.ReportArgs{SessionID: record.ID, State: protocol.ActivityAttention}); err != nil {
		t.Fatalf("report: %v", err)
	}
	eventually(t, "attention event on the attachment", func() bool {
		sink.mu.Lock()
		defer sink.mu.Unlock()
		for _, event := range sink.events {
			change, ok := event.(protocol.SessionEvent)
			if ok && change.Session.Activity.State == protocol.ActivityAttention {
				return true
			}
		}
		return false
	})
}

// TestMain constructs one runtime before parallel tests so wazero's lazily
// cached version string is written once, not raced by concurrent loaders.
func TestMain(m *testing.M) {
	loader, err := vt.NewLoader(context.Background())
	if err != nil {
		panic(err)
	}
	_ = loader.Close(context.Background())
	os.Exit(m.Run())
}
