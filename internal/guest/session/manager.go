package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sync"
	"time"

	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/guest/vt"
)

const (
	msgNoSuchSession = "no such session"
	// DefaultMaxSessions bounds concurrently running sessions per daemon.
	DefaultMaxSessions = 48
	// DefaultRingSize is the retained output per session.
	DefaultRingSize = 8 * 1024 * 1024
	// endedRetention is how long ended records stay listed.
	endedRetention = 7 * 24 * time.Hour
)

// Config configures a Manager.
type Config struct {
	StateDir      string
	Loader        *vt.Loader
	Incarnation   string
	DaemonVersion string
	MaxSessions   int
	RingSize      int
	Now           func() time.Time
}

// Manager owns every session of one daemon.
type Manager struct {
	ctx     context.Context //nolint:containedctx // Owns the wazero runtime lifetime.
	cfg     Config
	bootID  string
	user    string
	mu      sync.Mutex
	live    map[string]*Session
	records map[string]manifest
	stop    chan struct{}
	stopped chan struct{}
}

// Attachment is what follows an open reply on the wire: a registered
// subscriber whose stream starts with Run, or the final view of an ended
// session, whose text Run sends once and then returns.
type Attachment struct {
	sub     *subscriber
	session *Session
	sink    Sink
	final   []byte
}

// Streams reports whether Run delivers a live stream that owns the connection.
func (a *Attachment) Streams() bool {
	return a.sub != nil
}

// Run delivers the prefix and tail until the sink fails or the subscriber is
// dropped, or sends the final view's text and returns. Call it after the open
// response has been written. A view that cannot be delivered in full closes
// the sink, like a failed stream: the consumer sees the closure and opens
// again rather than waiting for announced bytes that never arrive.
func (a *Attachment) Run() {
	if a.sub == nil {
		if err := a.sink.SendSnapshot(a.final); err != nil {
			a.sink.Close()
		}
		return
	}
	a.sub.run(a.session.detach)
}

// Stop drops the subscriber and unregisters it, whether or not Run started.
func (a *Attachment) Stop() {
	if a.sub == nil {
		return
	}
	a.sub.drop("closed")
	a.session.detach(a.sub)
}

// New loads manifests, converts unfinished records to lost, and starts the
// activity observer.
func New(ctx context.Context, cfg Config) (*Manager, error) {
	if cfg.MaxSessions <= 0 {
		cfg.MaxSessions = DefaultMaxSessions
	}
	if cfg.RingSize <= 0 {
		cfg.RingSize = DefaultRingSize
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	m := &Manager{
		ctx:     ctx,
		cfg:     cfg,
		bootID:  bootID(),
		user:    currentUser(),
		live:    make(map[string]*Session),
		records: make(map[string]manifest),
		stop:    make(chan struct{}),
		stopped: make(chan struct{}),
	}
	manifests, err := readManifests(cfg.StateDir)
	if err != nil {
		return nil, err
	}
	for _, record := range manifests {
		m.adoptManifest(record)
	}
	go m.observe()
	return m, nil
}

func currentUser() string {
	if name := os.Getenv("USER"); name != "" {
		return name
	}
	return "unknown"
}

// adoptManifest converts a previous daemon's record. Unfinished records become
// lost; nothing is signalled.
func (m *Manager) adoptManifest(record manifest) {
	session := record.Session
	if session.Status == protocol.StatusRunning || session.Status == protocol.StatusStarting {
		session.Status = protocol.StatusLost
		ended := m.cfg.Now().UTC().Format(time.RFC3339Nano)
		session.EndedAt = &ended
		session.Foreground = nil
		session.Activity = protocol.Activity{State: protocol.ActivityExited, Source: protocol.SourceNone, Since: ended}
		record.Session = session
		_ = writeManifest(m.cfg.StateDir, record)
	}
	m.records[session.ID] = record
}

// Hello describes this daemon.
func (m *Manager) Hello() protocol.Hello {
	return protocol.Hello{
		Event:         protocol.EventHello,
		Protocol:      protocol.Revision,
		Incarnation:   m.cfg.Incarnation,
		BootID:        m.bootID,
		DaemonVersion: m.cfg.DaemonVersion,
		OS:            runtime.GOOS,
		User:          m.user,
		WasmSHA256:    vt.AssetSHA256,
		MaxSessions:   m.cfg.MaxSessions,
	}
}

// Close stops the observer. Sessions are not ended; the process exit ends them.
func (m *Manager) Close() {
	close(m.stop)
	<-m.stopped
}

// Create starts a session or returns the existing one for a repeated id.
func (m *Manager) Create(args protocol.CreateArgs) (protocol.Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	record := m.newRecord(args)
	fingerprint := createFingerprint(record, args.Env)
	if existing, ok := m.lookup(args.SessionID); ok {
		if existing.Fingerprint != fingerprint {
			return protocol.Session{}, &protocol.Error{
				Code:    protocol.CodeConflict,
				Message: "session id exists with different arguments",
			}
		}
		return existing.Session, nil
	}
	if m.runningCount() >= m.cfg.MaxSessions {
		return protocol.Session{}, &protocol.Error{
			Code:      protocol.CodeCapacity,
			Message:   "session limit reached",
			Retryable: true,
		}
	}
	s, err := spawn(spawnOptions{
		ctx:         m.ctx,
		record:      record,
		fingerprint: fingerprint,
		env:         args.Env,
		stateDir:    m.cfg.StateDir,
		bootID:      m.bootID,
		ringSize:    m.cfg.RingSize,
		loader:      m.cfg.Loader,
		now:         m.cfg.Now,
	})
	if err != nil {
		return protocol.Session{}, &protocol.Error{Code: protocol.CodeInternal, Message: err.Error()}
	}
	m.live[record.ID] = s
	return s.snapshot(), nil
}

func (m *Manager) newRecord(args protocol.CreateArgs) protocol.Session {
	argv := args.Argv
	if len(argv) == 0 {
		argv = defaultShell()
	}
	cwd := args.Cwd
	if cwd == "" {
		cwd = homeDir()
	} else if !filepath.IsAbs(cwd) {
		cwd = filepath.Join(homeDir(), cwd)
	}
	return protocol.Session{
		ID:           args.SessionID,
		Label:        args.Label,
		Cwd:          cwd,
		Argv:         argv,
		Cols:         args.Cols,
		Rows:         args.Rows,
		Status:       protocol.StatusStarting,
		CreatedAt:    m.cfg.Now().UTC().Format(time.RFC3339Nano),
		Incarnation:  m.cfg.Incarnation,
		RetainedFrom: 0,
	}
}

func defaultShell() []string {
	if shell := os.Getenv("SHELL"); shell != "" {
		return []string{shell, "-l"}
	}
	return []string{"/bin/sh", "-l"}
}

func homeDir() string {
	if home, err := os.UserHomeDir(); err == nil {
		return home
	}
	return "/"
}

// createFingerprint identifies the immutable create arguments so a repeated
// create with a different environment is a conflict, without exposing values.
func createFingerprint(record protocol.Session, env map[string]string) string {
	raw, _ := json.Marshal(struct {
		Cwd  string            `json:"cwd"`
		Argv []string          `json:"argv"`
		Env  map[string]string `json:"env"`
	}{record.Cwd, record.Argv, env})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func (m *Manager) runningCount() int {
	count := 0
	for _, s := range m.live {
		if s.snapshot().Status == protocol.StatusRunning {
			count++
		}
	}
	return count
}

// lookup returns a record from live sessions or manifests.
func (m *Manager) lookup(id string) (manifest, bool) {
	if s, ok := m.live[id]; ok {
		return manifest{Session: s.snapshot(), Fingerprint: s.fingerprint}, true
	}
	record, ok := m.records[id]
	return record, ok
}

func (m *Manager) liveSession(id string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.live[id]; ok {
		return s, nil
	}
	if _, ok := m.records[id]; ok {
		return nil, &protocol.Error{Code: protocol.CodeNotRunning, Message: "session is not running"}
	}
	return nil, &protocol.Error{Code: protocol.CodeNotFound, Message: msgNoSuchSession}
}

// List returns every known session ordered by creation time.
func (m *Manager) List() []protocol.Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.inventory()
}

func (m *Manager) inventory() []protocol.Session {
	out := make([]protocol.Session, 0, len(m.live)+len(m.records))
	for _, s := range m.live {
		out = append(out, s.snapshot())
	}
	for _, record := range m.records {
		out = append(out, record.Session)
	}
	slices.SortFunc(out, func(a, b protocol.Session) int {
		if a.CreatedAt != b.CreatedAt {
			if a.CreatedAt < b.CreatedAt {
				return -1
			}
			return 1
		}
		if a.ID < b.ID {
			return -1
		}
		return 1
	})
	return out
}

// Open performs the cut for a running session, or describes an ended one. A
// nil Attachment means nothing follows the reply. A record adopted from an
// earlier daemon has no terminal, so it answers ended without a view.
func (m *Manager) Open(args protocol.OpenArgs, sink Sink) (protocol.OpenValue, *Attachment, error) {
	m.mu.Lock()
	s, live := m.live[args.SessionID]
	record, known := m.records[args.SessionID]
	m.mu.Unlock()
	if !live {
		if !known {
			return protocol.OpenValue{}, nil, &protocol.Error{Code: protocol.CodeNotFound, Message: msgNoSuchSession}
		}
		return protocol.OpenValue{Mode: protocol.ModeEnded, Offset: record.Offset, Session: record.Session}, nil, nil
	}
	value, attachment, err := s.open(args, m.cfg.Incarnation, sink)
	if err != nil {
		return protocol.OpenValue{}, nil, mapError(err)
	}
	return value, attachment, nil
}

// Input admits bytes for a session.
func (m *Manager) Input(args protocol.InputArgs, data []byte) (protocol.InputValue, error) {
	s, err := m.liveSession(args.SessionID)
	if err != nil {
		return protocol.InputValue{}, err
	}
	return s.input(data), nil
}

// Resize changes a session's grid.
func (m *Manager) Resize(args protocol.ResizeArgs) (protocol.Session, error) {
	s, err := m.liveSession(args.SessionID)
	if err != nil {
		return protocol.Session{}, err
	}
	record, err := s.resize(args.Cols, args.Rows)
	if err != nil {
		return protocol.Session{}, mapError(err)
	}
	return record, nil
}

// End terminates a session and waits for its exit.
func (m *Manager) End(id string) (protocol.Session, error) {
	s, err := m.liveSession(id)
	if err != nil {
		return protocol.Session{}, err
	}
	return s.end(), nil
}

// Report records a hook state for a session; attachments see the change
// through the session's own ordered events.
func (m *Manager) Report(args protocol.ReportArgs) error {
	s, err := m.liveSession(args.SessionID)
	if err != nil {
		return err
	}
	s.report(args.State, m.cfg.Now())
	s.observe(m.cfg.Now())
	return nil
}

// observe runs the activity observer and prunes old ended records.
func (m *Manager) observe() {
	defer close(m.stopped)
	ticker := time.NewTicker(activityPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-m.stop:
			return
		case <-ticker.C:
			m.tick()
		}
	}
}

func (m *Manager) tick() {
	now := m.cfg.Now()
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.live))
	for _, s := range m.live {
		sessions = append(sessions, s)
	}
	m.mu.Unlock()
	for _, s := range sessions {
		s.observe(now)
	}
	m.prune(now)
}

// prune applies the ended-session retention to sessions this daemon ran and
// to records adopted from earlier daemons.
func (m *Manager) prune(now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, s := range m.live {
		if expired(s.snapshot(), now) {
			s.close()
			delete(m.live, id)
			_ = removeManifest(m.cfg.StateDir, id)
		}
	}
	for id, record := range m.records {
		if expired(record.Session, now) {
			delete(m.records, id)
			_ = removeManifest(m.cfg.StateDir, id)
		}
	}
}

func expired(record protocol.Session, now time.Time) bool {
	if record.EndedAt == nil {
		return false
	}
	ended, err := time.Parse(time.RFC3339Nano, *record.EndedAt)
	return err == nil && now.Sub(ended) >= endedRetention
}

func mapError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, errNotRunning):
		return &protocol.Error{Code: protocol.CodeNotRunning, Message: "session is not running"}
	default:
		if typed, ok := errors.AsType[*protocol.Error](err); ok {
			return typed
		}
		return &protocol.Error{Code: protocol.CodeInternal, Message: err.Error()}
	}
}
