// Package host owns the private host inventory and reconciles exact operation generations.
package host

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite" // Register the inventory database driver.

	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

// Config pins the private storage root and trusted runtime installation paths.
type Config struct {
	Root          string          `json:"root"`
	Profiles      []model.Profile `json:"profiles"`
	TartPath      string          `json:"tart_path,omitempty"`
	SmolvmPath    string          `json:"smolvm_path,omitempty"`
	LibraryDir    string          `json:"library_dir,omitempty"`
	DNS           string          `json:"dns,omitempty"`
	LaunchctlPath string          `json:"launchctl_path,omitempty"`
	LaunchdDomain string          `json:"launchd_domain,omitempty"`
	SystemctlPath string          `json:"systemctl_path,omitempty"`
	SystemdUser   bool            `json:"systemd_user,omitempty"`
	PortMin       int             `json:"port_min,omitempty"`
	PortMax       int             `json:"port_max,omitempty"`
}

// Validate applies runtime defaults and rejects unsafe or inconsistent host configuration.
func (c *Config) Validate() error {
	if !model.SafePath(c.Root) || filepath.Clean(c.Root) != c.Root || c.Root == "/" {
		return errors.New("root must be a dedicated absolute private directory")
	}
	if c.DNS != "" && (net.ParseIP(c.DNS).To4() == nil || strings.Contains(c.DNS, ":")) {
		return errors.New("dns must be a numeric IPv4 upstream resolver address")
	}
	if c.LaunchctlPath == "" {
		c.LaunchctlPath = "/bin/launchctl"
	}
	if c.SystemctlPath == "" {
		c.SystemctlPath = "/usr/bin/systemctl"
	}
	if c.LaunchdDomain == "" {
		c.LaunchdDomain = "gui/" + strconv.Itoa(os.Getuid())
	}
	if !regexp.MustCompile(`^(gui/[0-9]+|user/[0-9]+|system)$`).MatchString(c.LaunchdDomain) {
		return errors.New("invalid launchd_domain")
	}
	if c.PortMin == 0 {
		c.PortMin = 22000
	}
	if c.PortMax == 0 {
		c.PortMax = 22999
	}
	if c.PortMin < 1024 || c.PortMax < c.PortMin || c.PortMax > 65535 {
		return errors.New("invalid private SSH port range")
	}
	return c.validateProfiles()
}

// Manifest describes the owned machine passed to a runtime operation.
type Manifest struct {
	PendingRAM      bool          `json:"-"`
	StoreID         string        `json:"store_id,omitempty"`
	SourceMachineID string        `json:"source_machine_id,omitempty"`
	CheckpointID    string        `json:"checkpoint_id,omitempty"`
	Branchable      bool          `json:"branchable,omitempty"`
	SSHPrivateKey   string        `json:"ssh_private_key,omitempty"`
	ID              string        `json:"id"`
	Name            string        `json:"name"`
	Profile         model.Profile `json:"profile"`
	Generation      int64         `json:"generation"`
	Prepared        bool          `json:"prepared"`
	Deleted         bool          `json:"deleted"`
	SSHUser         string        `json:"ssh_user,omitempty"`
	SSHHostKey      string        `json:"ssh_host_key,omitempty"`
	Endpoint        string        `json:"endpoint,omitempty"`
	Port            int           `json:"port,omitempty"`
}

// RuntimeName returns the exact native identity reserved for this machine.
func (m Manifest) RuntimeName() string { return "cb-" + m.ID }

// RuntimeState reports observed native execution state, never desired state.
type RuntimeState struct {
	Exists   bool
	State    model.State
	Endpoint string
}

// CheckpointSpec describes a runtime artifact without exposing the operation journal.
// SourcePort retains the captured guest's original forwarded SSH port for RAM restore.
type CheckpointSpec struct {
	ID         string
	Kind       string
	Profile    model.Profile
	SourcePort int
}

// Runtime performs host-local lifecycle effects. Errors may follow successful side
// effects; the helper journals intent and never blindly replays ambiguous live work.
type Runtime interface {
	Prerequisite(context.Context, string, Manifest, *CheckpointSpec) error
	Fork(context.Context, Manifest, Manifest) error
	Capture(context.Context, Manifest, CheckpointSpec) error
	Restore(context.Context, Manifest, CheckpointSpec) error
	DeleteCheckpoint(context.Context, CheckpointSpec) error
	Inspect(context.Context, Manifest) (RuntimeState, error)
	Create(context.Context, Manifest) error
	Configure(context.Context, Manifest) error
	Start(context.Context, Manifest) error
	Prepare(context.Context, Manifest, []string) (string, string, string, error)
	Stop(context.Context, Manifest) error
	Delete(context.Context, Manifest) error
}
type accepted struct {
	Checkpoint *ownedCheckpoint `json:"checkpoint,omitempty"`
	Request    model.Request    `json:"request"`
	Phase      string           `json:"phase"`
	Response   model.Response   `json:"response"`
}

// Helper reconciles requests against a durable generation and ownership journal.
type Helper struct {
	cfg     Config
	state   *statefs.Dir
	db      *sql.DB
	runtime Runtime
	mu      sync.Mutex
}

const ownerMarker = "clankerbox-host-v1\n"

// Open validates the private inventory and initializes its durable journal.
// The caller must close the returned helper after all operations finish.
func Open(cfg Config, rt Runtime) (_ *Helper, resultErr error) {
	retained := false
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	dir, err := statefs.Open(cfg.Root)
	if err != nil {
		return nil, err
	}
	defer func() {
		if !retained {
			resultErr = errors.Join(resultErr, dir.Close())
		}
	}()
	lock, err := dir.Lock(".lock", false)
	if err != nil {
		return nil, err
	}
	lockClosed := false
	defer func() {
		if !lockClosed {
			resultErr = errors.Join(resultErr, lock.Close())
		}
	}()

	if err = validateOwner(dir); err != nil {
		return nil, err
	}

	for _, name := range []string{"machines", "jobs", runtimeTart, "checkpoints"} {
		if childErr := statefs.EnsurePrivateDir(filepath.Join(cfg.Root, name)); childErr != nil {
			return nil, childErr
		}
	}
	path, err := dir.Database("host.db")
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.ExecContext(
		context.Background(),
		`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
 CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY, body BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS machines(id TEXT PRIMARY KEY, body BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, machine_id TEXT NOT NULL, generation INTEGER NOT NULL, body BLOB NOT NULL, UNIQUE(machine_id,generation));`,
	)
	if err != nil {
		return nil, errors.Join(err, db.Close())
	}
	if rt == nil {
		rt = &NativeRuntime{Config: cfg, Runner: ExecRunner{}}
	}
	closeErr := lock.Close()
	lockClosed = true
	if closeErr != nil {
		return nil, errors.Join(closeErr, db.Close())
	}
	retained = true
	return &Helper{cfg: cfg, state: dir, db: db, runtime: rt}, nil
}

// Close releases the journal and its private directory handle.
func (h *Helper) Close() error { return errors.Join(h.db.Close(), h.state.Close()) }

func (h *Helper) manifest(ctx context.Context, id string) (Manifest, error) {
	var m Manifest
	var b []byte
	err := h.db.QueryRowContext(ctx, "SELECT body FROM machines WHERE id=?", id).Scan(&b)
	if err == nil {
		err = json.Unmarshal(b, &m)
	}
	return m, err
}
func (h *Helper) save(ctx context.Context, m Manifest, a accepted) (resultErr error) {
	// Persist ambiguous effects even when the operation deadline has expired.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), connectionTimeout)
	defer cancel()
	tx, err := h.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			resultErr = errors.Join(resultErr, rollbackErr)
		}
	}()
	mb, _ := json.Marshal(m)
	ab, _ := json.Marshal(a)
	if a.Request.Action != actionDeleteCheckpoint {
		_, err = tx.ExecContext(ctx,
			"INSERT INTO machines(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
			m.ID,
			mb,
		)
	}
	if err == nil && a.Checkpoint != nil {
		b, _ := json.Marshal(a.Checkpoint)
		_, err = tx.ExecContext(ctx,
			"INSERT INTO checkpoints(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
			a.Checkpoint.ID,
			b,
		)
	}
	if err == nil {
		_, err = tx.ExecContext(
			ctx,
			"INSERT INTO operations(id,fingerprint,machine_id,generation,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
			a.Request.OperationID,
			model.Hash(a.Request),
			a.Request.MachineID,
			a.Request.Generation,
			ab,
		)
	}
	if err == nil {
		err = tx.Commit()
	}
	return err
}
func (h *Helper) profile(p model.Profile) bool {
	for _, local := range h.cfg.Profiles {
		if local.ID == p.ID {
			return model.SameProfile(local, p)
		}
	}
	return false
}
func (h *Helper) port(ctx context.Context) (_ int, resultErr error) {
	rows, err := h.db.QueryContext(ctx, "SELECT body FROM machines")
	if err != nil {
		return 0, err
	}
	defer func() { resultErr = errors.Join(resultErr, rows.Close()) }()
	used := map[int]bool{}
	for rows.Next() {
		var b []byte
		var m Manifest
		if err = rows.Scan(&b); err != nil {
			return 0, err
		}
		if err = json.Unmarshal(b, &m); err != nil {
			return 0, err
		}
		if !m.Deleted {
			used[m.Port] = true
		}
	}
	if err = rows.Err(); err != nil {
		return 0, err
	}
	for p := h.cfg.PortMin; p <= h.cfg.PortMax; p++ {
		if !used[p] {
			listener, listenErr := (&net.ListenConfig{}).Listen(
				ctx,
				"tcp4",
				net.JoinHostPort("127.0.0.1", strconv.Itoa(p)),
			)
			if listenErr == nil {
				return p, listener.Close()
			}
		}
	}
	return 0, errors.New("private SSH port range exhausted")
}
func (h *Helper) observation(ctx context.Context, m Manifest) (*model.Observation, error) {
	obs := &model.Observation{
		MachineID:  m.ID,
		Generation: m.Generation,
		Prepared:   m.Prepared,
		Deleted:    m.Deleted,
		SSHUser:    m.SSHUser,
		SSHHostKey: m.SSHHostKey,
		Endpoint:   m.Endpoint,
		State:      model.Stopped,
		ObservedAt: time.Now().UTC(),
	}
	if m.Deleted {
		return obs, nil
	}
	state, err := h.runtime.Inspect(ctx, m)
	if err != nil {
		return nil, err
	}
	obs.ObservedAt = time.Now().UTC()
	obs.State = state.State
	if !state.Exists {
		obs.State = model.Unknown
	}
	if !m.Prepared && state.Exists {
		obs.State = model.Preparing
	}
	if state.Endpoint != "" {
		obs.Endpoint = state.Endpoint
	}
	if !m.Prepared {
		obs.Endpoint = ""
		obs.SSHUser = ""
		obs.SSHHostKey = ""
	}
	return obs, nil
}

// Inspect reports the current owned state without starting or recreating a machine.
func (h *Helper) Inspect(ctx context.Context, id string) model.Response {
	if !model.ValidID(id) {
		return model.Response{Status: statusFailed, Error: "invalid machine ID"}
	}
	m, err := h.manifest(ctx, id)
	if err != nil {
		return model.Response{Status: statusFailed, Error: "owned machine not found"}
	}
	obs, err := h.observation(ctx, m)
	if err != nil {
		return model.Response{Status: statusUnresolved, Error: err.Error()}
	}
	return model.Response{Status: statusSucceeded, Observation: obs}
}
func failure(req model.Request, err error) model.Response {
	return model.Response{OperationID: req.OperationID, Status: statusFailed, Error: err.Error()}
}

// Execute serializes a generation transition and journals native effects before dispatch.
func (h *Helper) Execute(ctx context.Context, req model.Request) model.Response {
	if req.Action == "inspect" {
		if req.OperationID != "" || req.Generation != 0 {
			return failure(req, errors.New("inspect must not carry an operation generation"))
		}
		return h.Inspect(ctx, req.MachineID)
	}
	if !model.ValidID(req.MachineID) || !model.ValidID(req.OperationID) || req.Generation < 1 {
		return failure(req, errors.New("invalid operation identity"))
	}
	switch req.Action {
	case actionCreate,
		actionStart,
		actionStop,
		actionDelete,
		actionFork,
		actionRestore,
		actionCapture,
		actionDeleteCheckpoint:
	default:
		return failure(req, errors.New("unsupported action"))
	}
	// flock serializes separate stdin helper processes. A busy helper gives a retryable answer.
	h.mu.Lock()
	defer h.mu.Unlock()
	lock, err := h.state.Lock(".lock", true)
	if err != nil {
		return model.Response{
			OperationID: req.OperationID,
			Status:      statusUnresolved,
			Error:       "lock host mutation: " + err.Error(),
		}
	}
	response := h.executeLocked(ctx, req)
	if closeErr := lock.Close(); closeErr != nil {
		response.Status = statusUnresolved
		response.Error = errors.Join(errors.New(response.Error), closeErr).Error()
	}
	return response
}
func (h *Helper) executeLocked(ctx context.Context, req model.Request) model.Response {
	var a accepted
	var raw []byte
	var fp string
	err := h.db.QueryRowContext(ctx, "SELECT fingerprint,body FROM operations WHERE id=?", req.OperationID).
		Scan(&fp, &raw)
	if err == nil {
		if fp != model.Hash(req) {
			return failure(req, errors.New("operation ID input conflict"))
		}
		if err = json.Unmarshal(raw, &a); err != nil {
			return failure(req, err)
		}
		if a.Response.Status == statusSucceeded || a.Response.Status == statusFailed {
			return a.Response
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return failure(req, err)
	}
	if req.Action == actionFork || req.Action == actionRestore || req.Action == actionCapture ||
		req.Action == actionDeleteCheckpoint {
		return h.executeDerived(ctx, req, a, len(raw) != 0)
	}
	m, merr := h.manifest(ctx, req.MachineID)
	if len(raw) == 0 {
		m, a, err = h.acceptLifecycle(ctx, req, m, merr)
		if err != nil {
			return failure(req, err)
		}
	} else if merr != nil || m.Generation != req.Generation {
		return failure(req, errors.New("accepted generation no longer current"))
	}
	return h.reconcile(ctx, m, a)
}

type rejectedOperationError string

func (e rejectedOperationError) Error() string { return string(e) }

// lifecycleAttempt owns one journalled generation and its phase transitions.
// Each native effect is preceded by a durable phase, so retries can inspect
// retained work without recreating a disk or cold-restarting a live execution.
type lifecycleAttempt struct {
	helper    *Helper
	machine   Manifest
	operation accepted
}

func (r *lifecycleAttempt) persist(ctx context.Context, phase string) error {
	r.operation.Phase = phase
	return r.helper.save(ctx, r.machine, r.operation)
}
func (r *lifecycleAttempt) unresolved(ctx context.Context, err error) model.Response {
	r.operation.Response = model.Response{
		OperationID: r.operation.Request.OperationID,
		Status:      statusUnresolved,
		Error:       err.Error(),
	}
	if saveErr := r.helper.save(ctx, r.machine, r.operation); saveErr != nil {
		r.operation.Response.Error += "; journal: " + saveErr.Error()
	}
	return r.operation.Response
}
func (r *lifecycleAttempt) reject(ctx context.Context, err error) model.Response {
	r.operation.Response = failure(r.operation.Request, err)
	r.operation.Response.Observation, _ = r.helper.observation(ctx, r.machine)
	if saveErr := r.helper.save(ctx, r.machine, r.operation); saveErr != nil {
		return r.unresolved(ctx, saveErr)
	}
	return r.operation.Response
}
func (h *Helper) reconcile(ctx context.Context, m Manifest, a accepted) model.Response {
	attempt := lifecycleAttempt{helper: h, machine: m, operation: a}
	return attempt.run(ctx)
}
func (r *lifecycleAttempt) run(ctx context.Context) model.Response {
	state, err := r.helper.runtime.Inspect(ctx, r.machine)
	if err != nil {
		return r.unresolved(ctx, err)
	}
	switch {
	case r.operation.Request.Action == actionCreate:
		err = r.create(ctx, state)
	case !r.machine.Prepared:
		err = rejectedOperationError("machine has not completed trusted preparation")
	default:
		switch r.operation.Request.Action {
		case actionStart:
			err = r.startRetained(ctx, state)
		case actionStop:
			err = r.stopRetained(ctx, state)
		case actionDelete:
			err = r.deleteRetained(ctx, state)
		}
	}
	if err != nil {
		if _, rejected := errors.AsType[rejectedOperationError](err); rejected {
			return r.reject(ctx, err)
		}
		return r.unresolved(ctx, err)
	}
	return r.complete(ctx)
}
func (r *lifecycleAttempt) complete(ctx context.Context) model.Response {
	obs, err := r.helper.observation(ctx, r.machine)
	if err != nil {
		return r.unresolved(ctx, err)
	}
	if (r.operation.Request.Action == actionCreate || r.operation.Request.Action == actionStart) &&
		obs.State != model.Running {
		return r.unresolved(ctx, errors.New("execution exited before operation completion; no automatic restart"))
	}
	r.operation.Response = model.Response{
		OperationID: r.operation.Request.OperationID,
		Status:      statusSucceeded,
		Observation: obs,
	}
	r.operation.Phase = phaseDone
	if err = r.helper.save(ctx, r.machine, r.operation); err != nil {
		return r.unresolved(ctx, err)
	}
	return r.operation.Response
}
func (r *lifecycleAttempt) create(ctx context.Context, state RuntimeState) error {
	if err := r.createRecord(ctx, state); err != nil {
		return err
	}
	if err := r.configureCreated(ctx); err != nil {
		return err
	}
	if err := r.startCreated(ctx); err != nil {
		return err
	}
	if err := r.observeCreatedStart(ctx); err != nil {
		return err
	}
	return r.prepareCreated(ctx)
}
func (r *lifecycleAttempt) createRecord(ctx context.Context, state RuntimeState) error {
	var err error
	switch r.operation.Phase {
	case phaseAccepted:
		if state.Exists {
			return rejectedOperationError("refusing to adopt an existing runtime name")
		}
		if err = r.persist(ctx, "creating"); err != nil {
			return err
		}
		if err = r.helper.runtime.Create(ctx, r.machine); err != nil {
			return err
		}
		if err = r.persist(ctx, "created"); err != nil {
			return err
		}
	case "creating":
		if !state.Exists {
			return errors.New(
				"create acknowledgement lost and runtime record absent; inspect retained artifacts before recovery",
			)
		}
		if err = r.persist(ctx, "created"); err != nil {
			return err
		}
	}

	return nil
}

func (r *lifecycleAttempt) configureCreated(ctx context.Context) error {
	var err error
	if r.operation.Phase == "created" {
		if err = r.helper.runtime.Configure(ctx, r.machine); err != nil {
			return err
		}
		if err = r.persist(ctx, "configured"); err != nil {
			return err
		}
	}

	return nil
}

func (r *lifecycleAttempt) startCreated(ctx context.Context) error {
	var err error
	if r.operation.Phase == "configured" {
		if err = r.persist(ctx, "starting"); err != nil {
			return err
		}
		if err = r.helper.runtime.Start(ctx, r.machine); err != nil {
			return err
		}
	}

	return nil
}

func (r *lifecycleAttempt) observeCreatedStart(ctx context.Context) error {
	if r.operation.Phase == "starting" {
		state, err := r.helper.runtime.Inspect(ctx, r.machine)
		if err != nil {
			return err
		}
		if !state.Exists || state.State != model.Running {
			return errors.New("start accepted but execution is not running; no automatic cold restart")
		}
		if err = r.persist(ctx, "preparing"); err != nil {
			return err
		}
	}

	return nil
}

func (r *lifecycleAttempt) prepareCreated(ctx context.Context) error {
	if r.operation.Phase == "preparing" {
		state, err := r.helper.runtime.Inspect(ctx, r.machine)
		if err != nil {
			return err
		}
		if state.State != model.Running {
			return errors.New("preparation interrupted; explicit reconciliation required before another boot")
		}
		r.machine.SSHUser, r.machine.SSHHostKey, r.machine.Endpoint, err = r.helper.runtime.Prepare(
			ctx,
			r.machine,
			r.operation.Request.SSHPublicKeys,
		)
		if err != nil {
			return err
		}
		r.machine.Prepared = true
		r.machine.Branchable = r.machine.Profile.Runtime == runtimeSmolvm
		if err = r.persist(ctx, "prepared"); err != nil {
			return err
		}
	}
	return nil
}

func (r *lifecycleAttempt) startRetained(ctx context.Context, state RuntimeState) error {
	var err error

	if r.operation.Phase == phaseAccepted {
		if !state.Exists || state.State != model.Stopped {
			return rejectedOperationError("start requires an existing stopped runtime record")
		}
		if err = r.persist(ctx, "starting"); err != nil {
			return err
		}
		if err = r.helper.runtime.Start(ctx, r.machine); err != nil {
			return err
		}
	}
	state, err = r.helper.runtime.Inspect(ctx, r.machine)
	if err != nil {
		return err
	}
	if !state.Exists || state.State != model.Running {
		return errors.New("start is ambiguous; refusing another cold boot")
	}
	r.machine.Branchable = r.machine.Profile.Runtime == runtimeSmolvm
	// Reinstall no identity: verify the retained key and restart sshd through trusted exec.
	user, key, endpoint, e := r.helper.runtime.Prepare(ctx, r.machine, nil)
	if e != nil {
		return e
	}
	if user != r.machine.SSHUser || key != r.machine.SSHHostKey {
		return errors.New("retained SSH identity changed")
	}
	r.machine.Endpoint = endpoint
	return nil
}

func (r *lifecycleAttempt) stopRetained(ctx context.Context, state RuntimeState) error {
	var err error

	if !state.Exists || state.State == model.Unknown {
		return errors.New("runtime state unknown; cannot stop")
	}
	if r.operation.Phase == phaseAccepted {
		if state.State != model.Running {
			return rejectedOperationError("stop requires running execution")
		}
		if err = r.persist(ctx, "stopping"); err != nil {
			return err
		}
	}
	if state.State == model.Running {
		if err = r.helper.runtime.Stop(ctx, r.machine); err != nil {
			return err
		}
	}
	state, err = r.helper.runtime.Inspect(ctx, r.machine)
	if err != nil {
		return err
	}
	if !state.Exists || state.State != model.Stopped {
		return errors.New("guest has not stopped; disks retained")
	}
	return nil
}

func (r *lifecycleAttempt) deleteRetained(ctx context.Context, state RuntimeState) error {
	var err error

	if r.operation.Phase == phaseAccepted {
		if !state.Exists || state.State != model.Stopped {
			return rejectedOperationError("delete requires an inspected stopped owned runtime")
		}
		if err = r.persist(ctx, "deleting"); err != nil {
			return err
		}
	}
	if state.Exists && state.State != model.Stopped {
		return errors.New("runtime no longer stopped; refusing deletion")
	}
	if err = r.helper.runtime.Delete(ctx, r.machine); err != nil {
		return err
	}
	state, err = r.helper.runtime.Inspect(ctx, r.machine)
	if err != nil {
		return err
	}
	if state.Exists {
		return errors.New("runtime deletion not confirmed")
	}
	r.machine.Deleted = true
	r.machine.Endpoint = ""
	return nil
}

// Connect resolves only a prepared owned machine. The readiness line is consumed
// by the controller, never by the user's SSH client.
func (h *Helper) Connect(ctx context.Context, id string, in io.Reader, out io.Writer) (resultErr error) {
	if !model.ValidID(id) {
		return errors.New("invalid machine ID")
	}
	m, err := h.manifest(ctx, id)
	if err != nil {
		return err
	}
	if !m.Prepared || m.Deleted {
		return errors.New("machine is not prepared")
	}
	var operation []byte
	if err = h.db.QueryRowContext(ctx, "SELECT body FROM operations WHERE machine_id=? AND generation=?", id, m.Generation).
		Scan(&operation); err != nil {
		return err
	}
	var latest accepted
	if err = json.Unmarshal(operation, &latest); err != nil {
		return err
	}
	if latest.Response.Status != statusSucceeded {
		return errors.New("machine operation is unresolved; ssh endpoint is not ready")
	}
	obs, err := h.observation(ctx, m)
	if err != nil {
		return err
	}
	if obs.State != model.Running {
		return errors.New("machine is not running")
	}
	if err = validEndpoint(m, obs.Endpoint); err != nil {
		return err
	}
	conn, err := (&net.Dialer{Timeout: connectionTimeout}).DialContext(ctx, "tcp", obs.Endpoint)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := conn.Close(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
			resultErr = errors.Join(resultErr, closeErr)
		}
	}()
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-finished:
		}
	}()
	if _, err = io.WriteString(out, "{\"ready\":true}\n"); err != nil {
		return err
	}
	go func() {
		_, _ = io.Copy(conn, in)
		if tcp, ok := conn.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
	}()
	_, err = io.Copy(out, conn)
	_ = conn.Close()
	return err
}
func validEndpoint(m Manifest, endpoint string) error {
	host, port, err := net.SplitHostPort(endpoint)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return errors.New("endpoint must be a numeric IP")
	}
	if m.Profile.Runtime == runtimeSmolvm {
		if host != "127.0.0.1" || port != strconv.Itoa(m.Port) {
			return errors.New("endpoint differs from assigned private loopback forward")
		}
	} else if port != "22" || !ip.IsPrivate() || ip.IsLoopback() {
		return errors.New("tart endpoint must be a private guest IP on port 22")
	}
	return nil
}

// All runtime names derive solely from immutable random IDs, never machine aliases.
func machineDir(cfg Config, m Manifest) string { return filepath.Join(cfg.Root, "machines", m.ID) }
func compactError(err error, stderr string) error {
	stderr = strings.TrimSpace(stderr)
	if len(stderr) > runtimeErrorLimit {
		stderr = stderr[:runtimeErrorLimit]
	}
	return fmt.Errorf("%w: %s", err, stderr)
}

func (h *Helper) acceptLifecycle(
	ctx context.Context,
	req model.Request,
	m Manifest,
	merr error,
) (Manifest, accepted, error) {
	var err error
	var a accepted

	if err = h.resourceIdle(ctx, req.MachineID, false); err != nil {
		return Manifest{}, accepted{}, err
	}
	if req.Action == actionDelete && merr == nil {
		if err = h.machineDependencies(ctx, m); err != nil {
			return Manifest{}, accepted{}, err
		}
	}
	if !model.ValidName(req.Name) || !h.profile(req.Profile) {
		return Manifest{}, accepted{}, errors.New("unknown or changed pinned profile/name")
	}
	if req.Action == actionCreate {
		m, err = h.createIdentity(ctx, req, merr)
	} else {
		err = h.validateRetainedGeneration(ctx, req, m, merr)
	}
	if err != nil {
		return Manifest{}, accepted{}, err
	}

	m.Generation = req.Generation
	a = accepted{
		Request:  req,
		Phase:    phaseAccepted,
		Response: model.Response{OperationID: req.OperationID, Status: statusUnresolved},
	}
	if err = h.save(ctx, m, a); err != nil {
		return Manifest{}, accepted{}, err
	}
	return m, a, nil
}

func (h *Helper) createIdentity(ctx context.Context, req model.Request, merr error) (Manifest, error) {
	var err error

	if !errors.Is(merr, sql.ErrNoRows) {
		return Manifest{}, errors.New("machine ID already owned; it cannot be recreated")
	}
	if req.Generation != 1 {
		return Manifest{}, errors.New("create requires generation 1")
	}
	keys, e := model.ValidateKeys(req.SSHPublicKeys)
	if e != nil {
		return Manifest{}, e
	}
	if model.Hash(keys) != model.Hash(req.SSHPublicKeys) {
		return Manifest{}, errors.New("SSH keys must use canonical sorted public-key lines")
	}
	m := Manifest{ID: req.MachineID, Name: req.Name, Profile: req.Profile}
	if m.Profile.Runtime == runtimeSmolvm {
		m.Port, err = h.port(ctx)
		if err != nil {
			return Manifest{}, err
		}
	}
	return m, nil
}

func (h *Helper) validateRetainedGeneration(ctx context.Context, req model.Request, m Manifest, merr error) error {
	var err error

	if merr != nil || m.Deleted {
		return errors.New("stopped owned machine required; missing or deleted identity")
	}
	if m.Generation+1 != req.Generation {
		return errors.New("generation conflict; controller reconciliation required")
	}
	if m.Name != req.Name || !model.SameProfile(m.Profile, req.Profile) {
		return errors.New("immutable machine identity conflict")
	}
	var last []byte
	if err = h.db.QueryRowContext(ctx, "SELECT body FROM operations WHERE machine_id=? AND generation=?", m.ID, m.Generation).
		Scan(&last); err != nil {
		return err
	}
	var previous accepted
	if err = json.Unmarshal(last, &previous); err != nil {
		return err
	}
	if previous.Response.Status != statusSucceeded && previous.Response.Status != statusFailed {
		return errors.New("previous generation is unresolved")
	}
	return nil
}

func (c *Config) validateProfiles() error {
	seen := map[string]bool{}
	for i := range c.Profiles {
		p := &c.Profiles[i]
		if err := p.Validate(); err != nil {
			return err
		}
		if seen[p.ID] {
			return errors.New("duplicate profile")
		}
		seen[p.ID] = true
		switch p.Runtime {
		case runtimeTart:
			if !model.SafePath(c.TartPath) || !model.SafePath(c.LaunchctlPath) {
				return errors.New("tart requires absolute tart_path and launchctl_path")
			}
		case runtimeSmolvm:
			if !model.SafePath(c.SmolvmPath) || !model.SafePath(c.LibraryDir) || !model.SafePath(c.SystemctlPath) {
				return errors.New("smolvm requires absolute smolvm_path, library_dir and systemctl_path")
			}
			if len(
				c.Root,
			)+len(
				"/machines/",
			)+32+len(
				"/c/smolvm/vms/0000000000000000/control.sock",
			) >= unixSocketPathLimit {
				return errors.New("smolvm root too long for Unix socket paths; use a short private path")
			}
		}
	}
	return nil
}

func validateOwner(dir *statefs.Dir) error {
	b, err := dir.ReadFile(".owner")
	if errors.Is(err, os.ErrNotExist) {
		entries, readErr := dir.Entries()
		if readErr != nil {
			return readErr
		}
		for _, entry := range entries {
			if entry.Name() != ".lock" {
				return errors.New("refusing to adopt a nonempty unowned root")
			}
		}
		err = dir.WriteFile(".owner", []byte(ownerMarker))
	} else if err == nil && string(b) != ownerMarker {
		err = errors.New("private root ownership marker mismatch")
	}
	if err != nil {
		return err
	}
	return nil
}
