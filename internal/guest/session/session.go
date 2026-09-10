package session

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"

	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/guest/vt"
)

const (
	readChunk        = 64 * 1024
	drainTimeout     = 2 * time.Second
	endStepWait      = 500 * time.Millisecond
	maxSnapshotBytes = 32 * 1024 * 1024
)

var (
	errNotRunning       = errors.New("session is not running")
	errStale            = errors.New("process identity changed")
	errSnapshotTooLarge = errors.New("snapshot exceeds the announced maximum")
)

type hookState struct {
	state string
	at    time.Time
}

// Session is one live or ended terminal owned by this daemon.
type Session struct {
	mu          sync.Mutex
	record      protocol.Session
	fingerprint string
	startTime   uint64
	stateDir    string
	bootID      string
	now         func() time.Time
	log         *slog.Logger

	term   *vt.Terminal
	ring   *ring
	master *os.File
	cmd    *exec.Cmd
	writer *ptyWriter
	subs   []*subscriber
	// The final screen, captured once at exit when the terminal is released.
	view  *protocol.View
	final []byte

	lastOutput time.Time
	hook       *hookState
	readDone   chan struct{}
	waitDone   chan struct{}
}

// spawnOptions carries everything needed to start a session.
type spawnOptions struct {
	ctx         context.Context //nolint:containedctx // The daemon context owns every wazero instance.
	record      protocol.Session
	fingerprint string
	env         map[string]string
	stateDir    string
	bootID      string
	ringSize    int
	loader      *vt.Loader
	now         func() time.Time
	log         *slog.Logger
}

// spawn writes the starting manifest, starts the child on a PTY, and begins
// the reader, writer, and wait loops. The manifest is removed only when the
// child never existed: once it runs, its id stays taken whatever storage does.
func spawn(opts spawnOptions) (*Session, error) {
	s := &Session{
		record:      opts.record,
		fingerprint: opts.fingerprint,
		stateDir:    opts.stateDir,
		bootID:      opts.bootID,
		now:         opts.now,
		log:         opts.log,
		ring:        newRing(opts.ringSize),
		writer:      newPtyWriter(),
		readDone:    make(chan struct{}),
		waitDone:    make(chan struct{}),
	}
	s.record.Status = protocol.StatusStarting
	s.record.Activity = protocol.Activity{
		State:  protocol.ActivityUnknown,
		Source: protocol.SourceNone,
		Since:  s.timestamp(),
	}
	if err := writeManifest(s.stateDir, s.manifest()); err != nil {
		return nil, err
	}
	if err := s.start(opts); err != nil {
		_ = removeManifest(s.stateDir, s.record.ID)
		return nil, err
	}
	return s, nil
}

func (s *Session) start(opts spawnOptions) error {
	term, err := opts.loader.New(opts.ctx, vt.Options{
		Cols:       s.record.Cols,
		Rows:       s.record.Rows,
		OnWritePTY: s.onReply,
	})
	if err != nil {
		return fmt.Errorf("create terminal: %w", err)
	}
	s.term = term
	if err = os.MkdirAll(s.record.Cwd, dirMode); err != nil {
		_ = term.Close()
		return fmt.Errorf("create working directory: %w", err)
	}
	argv := s.record.Argv
	cmd := exec.CommandContext(opts.ctx, argv[0], argv[1:]...) //nolint:gosec // Shell-equivalent authority by contract.
	cmd.Dir = s.record.Cwd
	cmd.Env = buildEnv(opts.env, s.record.ID)
	master, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: s.record.Rows, Cols: s.record.Cols})
	if err != nil {
		_ = term.Close()
		return fmt.Errorf("start process: %w", err)
	}
	s.master = master
	s.cmd = cmd
	s.record.PID = cmd.Process.Pid
	s.record.Status = protocol.StatusRunning
	s.lastOutput = s.now()
	if s.startTime, err = processStartTime(cmd.Process.Pid); err != nil {
		s.startTime = 0
	}
	// Like every later write: logged when it fails, the running record stays in memory.
	s.persist()
	go s.writer.run(master)
	go s.readLoop()
	go s.waitLoop()
	return nil
}

// buildEnv appends terminal defaults and requested overrides; exec keeps the
// last value for a duplicated key.
func buildEnv(extra map[string]string, id string) []string {
	env := append(os.Environ(), "TERM=xterm-256color", "CLANKERBOX_SESSION_ID="+id)
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	return env
}

func (s *Session) timestamp() string {
	return s.now().UTC().Format(time.RFC3339Nano)
}

func (s *Session) manifest() manifest {
	return manifest{Session: s.record, StartTime: s.startTime, BootID: s.bootID, Fingerprint: s.fingerprint}
}

// persist writes the record under the session mutex. A failure is logged and
// the in-memory record stays authoritative until the daemon restarts.
func (s *Session) persist() {
	if err := writeManifest(s.stateDir, s.manifest()); err != nil {
		s.log.Error("write session record", "session", s.record.ID, "error", err)
	}
}

// onReply runs inside vt.Write, under the session mutex held by ingest.
func (s *Session) onReply(data []byte) {
	if !s.writer.enqueueReply(data) {
		s.record.ReplyOverflow++
	}
}

func (s *Session) readLoop() {
	defer close(s.readDone)
	buf := make([]byte, readChunk)
	for {
		n, err := s.master.Read(buf)
		if n > 0 {
			s.ingest(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

// ingest advances the VT, the ring, and every subscriber under one mutex.
func (s *Session) ingest(data []byte) {
	chunk := append([]byte(nil), data...)
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.term.Write(chunk)
	s.ring.append(chunk)
	s.record.Offset += uint64(len(chunk))
	s.record.RetainedFrom = s.ring.start
	s.lastOutput = s.now()
	for _, sub := range s.subs {
		sub.enqueueOutput(s.record.Offset, chunk)
	}
}

func (s *Session) waitLoop() {
	defer close(s.waitDone)
	err := s.cmd.Wait()
	select {
	case <-s.readDone:
	case <-time.After(drainTimeout):
		_ = s.master.Close()
		<-s.readDone
	}
	s.mu.Lock()
	s.record.Status = protocol.StatusExited
	ended := s.timestamp()
	s.record.EndedAt = &ended
	s.record.Foreground = nil
	s.record.Activity = protocol.Activity{State: protocol.ActivityExited, Source: protocol.SourceProcess, Since: ended}
	s.applyExit(err)
	// An ended session is its record plus its final screen: the terminal and
	// the ring are released here, since nothing resumes an ended session.
	s.view, s.final = capture(s.term)
	term := s.term
	s.term, s.ring = nil, nil
	s.persist()
	record := s.record
	subs := s.subs
	s.mu.Unlock()
	_ = term.Close()
	s.writer.close()
	_ = s.master.Close()
	for _, sub := range subs {
		sub.enqueueEvent(protocol.SessionEvent{Event: protocol.EventSession, Session: record})
	}
}

func (s *Session) applyExit(err error) {
	var exitErr *exec.ExitError
	if err == nil {
		code := 0
		s.record.ExitCode = &code
		return
	}
	if !errors.As(err, &exitErr) {
		return
	}
	status, ok := exitErr.Sys().(syscall.WaitStatus)
	if !ok {
		return
	}
	if status.Signaled() {
		name := unix.SignalName(status.Signal())
		s.record.Signal = &name
		return
	}
	code := status.ExitStatus()
	s.record.ExitCode = &code
}

// snapshot returns the public record.
func (s *Session) snapshot() protocol.Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.record
}

func (s *Session) running() bool {
	return s.record.Status == protocol.StatusRunning || s.record.Status == protocol.StatusStarting
}

// open performs the cut and returns what follows the reply once it has been
// written: a live stream, the final view's text for an ended session, or
// nothing when the terminal cannot encode a snapshot right now.
func (s *Session) open(
	args protocol.OpenArgs,
	incarnation string,
	sink Sink,
) (protocol.OpenValue, *Attachment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cut := s.record.Offset
	if !s.running() {
		value := protocol.OpenValue{Mode: protocol.ModeEnded, Offset: cut, Session: s.record, View: s.view}
		if s.view == nil {
			return value, nil, nil
		}
		return value, &Attachment{sink: sink, final: s.final}, nil
	}
	sub := newSubscriber(sink, s.record.ID)
	if s.resumable(args, incarnation) {
		sub.prefix = s.ring.slice(*args.FromOffset)
		sub.from = *args.FromOffset
		s.subs = append(s.subs, sub)
		value := protocol.OpenValue{Mode: protocol.ModeResume, Offset: *args.FromOffset, Session: s.record}
		return value, &Attachment{sub: sub, session: s}, nil
	}
	snapshot, err := s.term.Snapshot()
	if err != nil {
		return protocol.OpenValue{Mode: protocol.ModeUnavailable, Offset: cut, Session: s.record}, nil, nil
	}
	if len(snapshot) > maxSnapshotBytes {
		return protocol.OpenValue{}, nil, errSnapshotTooLarge
	}
	sub.snapshot = true
	sub.prefix = snapshot
	s.subs = append(s.subs, sub)
	return protocol.OpenValue{
		Mode:          protocol.ModeSnapshot,
		Offset:        cut,
		Session:       s.record,
		SnapshotBytes: uint64(len(snapshot)),
	}, &Attachment{sub: sub, session: s}, nil
}

// capture reads the final screen once: its announcement and the text bytes.
// Nil when the terminal cannot be read, never an invented screen.
func capture(term *vt.Terminal) (*protocol.View, []byte) {
	text, err := term.Text()
	if err != nil {
		return nil, nil
	}
	x, y, err := term.Cursor()
	if err != nil {
		return nil, nil
	}
	return &protocol.View{Cursor: protocol.Cursor{X: x, Y: y}, Bytes: uint64(len(text))}, []byte(text)
}

func (s *Session) resumable(args protocol.OpenArgs, incarnation string) bool {
	if args.FromOffset == nil || args.FromIncarnation != incarnation {
		return false
	}
	from := *args.FromOffset
	if from < s.ring.start || from > s.record.Offset {
		return false
	}
	return s.record.LastResizeOffset == nil || *s.record.LastResizeOffset < from
}

func (s *Session) detach(sub *subscriber) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, candidate := range s.subs {
		if candidate == sub {
			s.subs = append(s.subs[:i], s.subs[i+1:]...)
			return
		}
	}
}

// input admits bytes to the writer queue or refuses them.
func (s *Session) input(data []byte) protocol.InputValue {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case !s.running():
		return protocol.InputValue{Status: protocol.InputRefused, Reason: protocol.CodeNotRunning}
	case !s.writer.enqueueInput(data):
		return protocol.InputValue{Status: protocol.InputRefused, Reason: "queue_full"}
	default:
		return protocol.InputValue{Status: protocol.InputAccepted}
	}
}

// resize applies a new grid: PTY first, then VT, then the ordered event.
func (s *Session) resize(cols, rows uint16) (protocol.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.running() {
		return protocol.Session{}, errNotRunning
	}
	previous := pty.Winsize{Rows: s.record.Rows, Cols: s.record.Cols}
	if err := pty.Setsize(s.master, &pty.Winsize{Rows: rows, Cols: cols}); err != nil {
		return protocol.Session{}, fmt.Errorf("resize pty: %w", err)
	}
	if err := s.term.Resize(cols, rows); err != nil {
		_ = pty.Setsize(s.master, &previous)
		return protocol.Session{}, fmt.Errorf("resize terminal: %w", err)
	}
	s.record.Cols, s.record.Rows = cols, rows
	offset := s.record.Offset
	s.record.LastResizeOffset = &offset
	event := protocol.ResizeEvent{
		Event:     protocol.EventResize,
		SessionID: s.record.ID,
		Cols:      cols,
		Rows:      rows,
		Offset:    offset,
	}
	for _, sub := range s.subs {
		sub.enqueueEvent(event)
	}
	s.persist()
	return s.record, nil
}

// end terminates the child with guarded escalation and waits for the exit.
func (s *Session) end() protocol.Session {
	s.mu.Lock()
	if !s.running() {
		record := s.record
		s.mu.Unlock()
		return record
	}
	pid := s.record.PID
	fd := int(s.master.Fd())
	s.mu.Unlock()
	if pgid, err := unix.IoctlGetInt(fd, unix.TIOCGPGRP); err == nil && pgid > 0 {
		if sid, sidErr := unix.Getsid(pgid); sidErr == nil && sid == pid {
			_ = s.guardedKill(-pgid, syscall.SIGHUP)
			if s.waitExit(endStepWait) {
				return s.snapshot()
			}
		}
	}
	for _, sig := range []syscall.Signal{syscall.SIGTERM, syscall.SIGKILL} {
		if err := s.guardedKill(-pid, sig); err != nil && !errors.Is(err, errStale) {
			_ = s.guardedKill(pid, sig)
		}
		if s.waitExit(endStepWait) {
			return s.snapshot()
		}
	}
	<-s.waitDone
	return s.snapshot()
}

// guardedKill signals only when the child identity still matches.
func (s *Session) guardedKill(target int, sig syscall.Signal) error {
	if s.startTime != 0 {
		current, err := processStartTime(s.record.PID)
		if err != nil || current != s.startTime {
			return errStale
		}
	}
	if err := unix.Kill(target, sig); err != nil {
		return fmt.Errorf("kill %d: %w", target, err)
	}
	return nil
}

func (s *Session) waitExit(d time.Duration) bool {
	select {
	case <-s.waitDone:
		return true
	case <-time.After(d):
		return false
	}
}

// foreground reports the PTY foreground process.
func (s *Session) foreground() *protocol.Foreground {
	s.mu.Lock()
	master := s.master
	running := s.running()
	s.mu.Unlock()
	if !running || master == nil {
		return nil
	}
	pgid, err := unix.IoctlGetInt(int(master.Fd()), unix.TIOCGPGRP)
	if err != nil || pgid <= 0 {
		return nil
	}
	return &protocol.Foreground{PID: pgid, Command: processCommand(pgid)}
}
