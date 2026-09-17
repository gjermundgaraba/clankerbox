package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"path/filepath"
	"runtime"
	"slices"
	"sync"
	"time"

	"clankerbox/internal/model"

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
	// createHorizon is how long a caller may repeat a create this daemon does
	// not remember. Ended sessions are remembered for longer, so a session this
	// daemon ran is still known when its create expires and never starts twice.
	createHorizon = 24 * time.Hour
	// createSkew is how far ahead of this daemon's clock a create may be dated.
	createSkew = time.Hour
)

// Horizon plus skew must stay inside retention; a negative constant does not compile.
const _ uint64 = uint64(endedRetention - createHorizon - createSkew)

// Config supplies session storage and resource limits.
type Config struct {
	StateDir      string
	Loader        *vt.Loader
	Incarnation   string
	DaemonVersion string
	MaxSessions   int
	RingSize      int
	Now           func() time.Time
	// Log receives record persistence failures; the in-memory record stays
	// authoritative until the daemon restarts. Defaults to slog.Default.
	Log *slog.Logger
}

// Manager owns every session of one daemon.
type Manager struct {
	ctx     context.Context //nolint:containedctx // Owns the wazero runtime lifetime.
	cfg     Config
	bootID  string
	process processIdentity
	mu      sync.Mutex
	live    map[string]*Session
	records map[string]manifest
	stop    chan struct{}
	stopped chan struct{}
	closing bool
	closed  chan struct{}
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
// retention cleanup loop.
func New(ctx context.Context, cfg Config) (*Manager, error) {
	process, err := currentIdentity()
	if err != nil {
		return nil, err
	}
	if cfg.MaxSessions <= 0 {
		cfg.MaxSessions = DefaultMaxSessions
	}
	if cfg.RingSize <= 0 {
		cfg.RingSize = DefaultRingSize
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	m := &Manager{
		ctx:     context.WithoutCancel(ctx),
		cfg:     cfg,
		bootID:  bootID(),
		process: process,
		live:    make(map[string]*Session),
		records: make(map[string]manifest),
		stop:    make(chan struct{}),
		stopped: make(chan struct{}),
		closed:  make(chan struct{}),
	}
	manifests, err := readManifests(cfg.StateDir, cfg.Log)
	if err != nil {
		return nil, err
	}
	for _, record := range manifests {
		m.adoptManifest(record)
	}
	go m.cleanup()
	return m, nil
}

// adoptManifest converts a previous daemon's record. Unfinished records become
// lost; nothing is signalled.
func (m *Manager) adoptManifest(record manifest) {
	session := record.Session
	if session.Status == protocol.StatusRunning || session.Status == protocol.StatusStarting {
		session.Status = protocol.StatusLost
		ended := m.cfg.Now().UTC().Format(time.RFC3339Nano)
		session.EndedAt = &ended
		record.Session = session
		if err := writeManifest(m.cfg.StateDir, record); err != nil {
			m.cfg.Log.Error("write session record", "session", session.ID, "error", err)
		}
	}
	m.records[session.ID] = record
}

// Hello describes this daemon.
func (m *Manager) Hello() protocol.Hello {
	return protocol.Hello{
		Incarnation:   m.cfg.Incarnation,
		BootID:        m.bootID,
		DaemonVersion: m.cfg.DaemonVersion,
		OS:            runtime.GOOS,
		User:          m.process.user,
		WasmSHA256:    vt.AssetSHA256,
		MaxSessions:   m.cfg.MaxSessions,
	}
}

// Close joins every session before its loader or state directory may be released.
func (m *Manager) Close() { _ = m.Shutdown(context.Background()) }

// Shutdown refuses new creation and joins all owned work. A timeout leaves
// resources owned by the manager until a subsequent call completes successfully.
func (m *Manager) Shutdown(ctx context.Context) error {
	m.mu.Lock()
	if !m.closing {
		m.closing = true
		close(m.stop)
		sessions := make([]*Session, 0, len(m.live))
		for _, s := range m.live {
			sessions = append(sessions, s)
		}
		go func() {
			var joined sync.WaitGroup
			for _, s := range sessions {
				joined.Go(func() { s.end() })
			}
			joined.Wait()
			<-m.stopped
			close(m.closed)
		}()
	}
	m.mu.Unlock()
	select {
	case <-m.closed:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// admit applies creation's identity, horizon and capacity rules under the
// manager mutex. A known id returns its record instead of spawn options. A
// create this daemon does not remember is refused once it is older than the
// retry horizon, never started.
func (m *Manager) admit(args protocol.CreateArgs) (spawnOptions, *manifest, error) {
	if m.closing {
		return spawnOptions{}, nil, &model.Error{Reason: model.ReasonNotRunning, Message: "session manager is closing"}
	}
	record := m.newRecord(args)
	fingerprint := createFingerprint(record, args.Env)
	if existing, ok := m.lookup(args.SessionID); ok {
		// A quarantined record has no fingerprint left to compare; the id is still taken.
		if existing.Fingerprint != "" && existing.Fingerprint != fingerprint {
			return spawnOptions{}, nil, &model.Error{
				Reason:  model.ReasonConflict,
				Message: "session id exists with different arguments",
			}
		}
		return spawnOptions{}, &existing, nil
	}
	created, err := args.Created()
	if err != nil {
		return spawnOptions{}, nil, err
	}
	now := m.cfg.Now()
	if created.After(now.Add(createSkew)) {
		return spawnOptions{}, nil, &model.Error{Reason: model.ReasonInvalid, Message: "created_at is in the future"}
	}
	if now.Sub(created) > createHorizon {
		return spawnOptions{}, nil, &model.Error{
			Reason:  model.ReasonExpired,
			Message: "create is older than the retry horizon and was never started",
		}
	}
	if m.runningCount() >= m.cfg.MaxSessions {
		return spawnOptions{}, nil, &model.Error{
			Reason:    model.ReasonCapacity,
			Message:   "session limit reached",
			Retryable: true,
		}
	}
	return spawnOptions{
		ctx:         m.ctx,
		record:      record,
		fingerprint: fingerprint,
		env:         args.Env,
		process:     m.process,
		stateDir:    m.cfg.StateDir,
		ringSize:    m.cfg.RingSize,
		loader:      m.cfg.Loader,
		now:         m.cfg.Now,
		log:         m.cfg.Log,
	}, nil, nil
}

func (m *Manager) newRecord(args protocol.CreateArgs) protocol.Session {
	argv := args.Argv
	if len(argv) == 0 {
		argv = []string{"/bin/sh", "-l"}
	}
	cwd := args.Cwd
	if cwd == "" {
		cwd = m.process.home
	} else if !filepath.IsAbs(cwd) {
		cwd = filepath.Join(m.process.home, cwd)
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
		Pipes:        args.Pipes,
		// Nothing can attach to a pipe session again, so it ends with its creator.
		EndOnDetach: args.EndOnDetach || args.Pipes,
	}
}

// createFingerprint identifies the immutable create arguments so a repeated
// create with a different environment is a conflict, without exposing values.
func createFingerprint(record protocol.Session, env map[string]string) string {
	raw, _ := json.Marshal(struct {
		Cwd         string            `json:"cwd"`
		Argv        []string          `json:"argv"`
		Env         map[string]string `json:"env"`
		Pipes       bool              `json:"pipes"`
		EndOnDetach bool              `json:"end_on_detach"`
	}{record.Cwd, record.Argv, env, record.Pipes, record.EndOnDetach})
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
		return nil, &model.Error{Reason: model.ReasonNotRunning, Message: "session is not running"}
	}
	return nil, &model.Error{Reason: model.ReasonNotFound, Message: msgNoSuchSession}
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
	if args.Create != nil {
		value, attachment, created, err := m.createOpen(args, sink)
		if created || err != nil {
			return value, attachment, err
		}
	}
	m.mu.Lock()
	s, live := m.live[args.SessionID]
	record, known := m.records[args.SessionID]
	m.mu.Unlock()
	if !live {
		if !known {
			return protocol.OpenValue{}, nil, &model.Error{Reason: model.ReasonNotFound, Message: msgNoSuchSession}
		}
		return protocol.OpenValue{Mode: protocol.ModeEnded, Offset: record.Offset, Session: record.Session}, nil, nil
	}
	value, attachment, err := s.open(args, m.cfg.Incarnation, sink)
	if err != nil {
		return protocol.OpenValue{}, nil, mapError(err)
	}
	return value, attachment, nil
}

// createOpen creates the session inside its first attachment, the only way a
// session begins: the subscriber exists before the child starts, so the stream
// begins at offset zero and no output, however brief the command, precedes it.
// A known id reports false and is opened like any other session, which is what
// makes repeating an Open after a lost reply safe.
func (m *Manager) createOpen(args protocol.OpenArgs, sink Sink) (protocol.OpenValue, *Attachment, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	opts, existing, err := m.admit(*args.Create)
	if err != nil || existing != nil {
		return protocol.OpenValue{}, nil, false, err
	}
	s, err := prepare(opts)
	if err != nil {
		return protocol.OpenValue{}, nil, false, &model.Error{Reason: model.ReasonInternal, Message: err.Error()}
	}
	attachment := s.subscribe(args, sink)
	if err = s.launch(opts); err != nil {
		return protocol.OpenValue{}, nil, false, &model.Error{Reason: model.ReasonInternal, Message: err.Error()}
	}
	m.live[opts.record.ID] = s
	return protocol.OpenValue{Mode: protocol.ModeResume, Session: s.snapshot()}, attachment, true, nil
}

// CloseInput delivers end of input to a pipe session.
func (m *Manager) CloseInput(id string) (protocol.InputValue, error) {
	s, err := m.liveSession(id)
	if err != nil {
		return protocol.InputValue{}, err
	}
	return s.closeInput(), nil
}

// Input admits bytes for a session.
func (m *Manager) Input(id string, data []byte) (protocol.InputValue, error) {
	s, err := m.liveSession(id)
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

// cleanup periodically prunes old ended records.
func (m *Manager) cleanup() {
	defer close(m.stopped)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-m.stop:
			return
		case <-ticker.C:
			m.prune(m.cfg.Now())
		}
	}
}

// prune applies the ended-session retention to sessions this daemon ran and
// to records adopted from earlier daemons.
func (m *Manager) prune(now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, s := range m.live {
		if expired(s.snapshot(), now) {
			// Exited status precedes final resource release; retain ownership until joined.
			select {
			case <-s.waitDone:
			default:
				continue
			}
			delete(m.live, id)
			m.forget(id)
		}
	}
	for id, record := range m.records {
		if expired(record.Session, now) {
			delete(m.records, id)
			m.forget(id)
		}
	}
}

func (m *Manager) forget(id string) {
	if err := removeManifest(m.cfg.StateDir, id); err != nil {
		m.cfg.Log.Error("remove session record", "session", id, "error", err)
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
	if errors.Is(err, errNotRunning) {
		return &model.Error{Reason: model.ReasonNotRunning, Message: "session is not running"}
	}
	if errors.Is(err, errPipeAttached) {
		return &model.Error{Reason: model.ReasonConflict, Message: err.Error()}
	}
	if errors.Is(err, errNoGrid) {
		return &model.Error{Reason: model.ReasonInvalid, Message: err.Error()}
	}
	return &model.Error{Reason: model.ReasonInternal, Message: err.Error()}
}
