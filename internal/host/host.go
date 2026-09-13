// Package host runs machines natively on one host and journals every mutation.
package host

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite" // Register the inventory database driver.

	"clankerbox/internal/model"
	"clankerbox/internal/rpcidentity"
	"clankerbox/internal/statefs"
)

// Config pins the private storage root and trusted runtime installation paths.
type Config struct {
	RuntimeDigest string           `json:"runtime_digest,omitempty"`
	PortLeaseRoot string           `json:"port_lease_root,omitempty"`
	Listen        string           `json:"listen,omitempty"`
	TLSCert       string           `json:"tls_cert,omitempty"`
	TLSKey        string           `json:"tls_key,omitempty"`
	TLSCA         string           `json:"tls_ca,omitempty"`
	ControllerID  string           `json:"controller_id,omitempty"`
	HostOS        string           `json:"host_os,omitempty"`
	HostID        string           `json:"host_id,omitempty"`
	Root          string           `json:"root"`
	Profiles      []ProfileBinding `json:"profiles"`
	TartPath      string           `json:"tart_path,omitempty"`
	SmolvmPath    string           `json:"smolvm_path,omitempty"`
	LibraryDir    string           `json:"library_dir,omitempty"`
	DNS           string           `json:"dns,omitempty"`
	LaunchctlPath string           `json:"launchctl_path,omitempty"`
	LaunchdDomain string           `json:"launchd_domain,omitempty"`
	SystemctlPath string           `json:"systemctl_path,omitempty"`
	SystemdUser   bool             `json:"systemd_user,omitempty"`
	PortMin       int              `json:"port_min,omitempty"`
	PortMax       int              `json:"port_max,omitempty"`
}

const (
	hostDarwin        = "darwin"
	hostLinux         = "linux"
	statusPending     = "pending"
	statusUnavailable = "unavailable"
)

// Validate applies runtime defaults and rejects unsafe or inconsistent host configuration.
func (c *Config) Validate() error {
	if c.HostOS == "" {
		c.HostOS = runtime.GOOS
	}
	if c.HostOS != hostDarwin && c.HostOS != hostLinux {
		return errors.New("unsupported host platform")
	}
	if c.HostID != "" && !model.ValidName(c.HostID) {
		return errors.New("invalid host identity")
	}
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
	if err := c.validatePorts(); err != nil {
		return err
	}
	return c.validateProfiles()
}

func (c *Config) validatePorts() error {
	if c.PortLeaseRoot == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		c.PortLeaseRoot = filepath.Join(home, ".clankerbox", "ports")
	}
	if !model.SafePath(c.PortLeaseRoot) {
		return errors.New("port_lease_root must be an absolute private path")
	}
	if c.PortMin == 0 {
		c.PortMin = 22000
	}
	if c.PortMax == 0 {
		c.PortMax = 22999
	}
	if c.PortMin < 1024 || c.PortMax < c.PortMin || c.PortMax > 65535 {
		return errors.New("invalid private guest RPC port range")
	}
	return nil
}

// Manifest describes the owned machine passed to a runtime operation.
type Manifest struct {
	PendingRAM      bool          `json:"-"`
	StoreID         string        `json:"store_id,omitempty"`
	SourceMachineID string        `json:"source_machine_id,omitempty"`
	CheckpointID    string        `json:"checkpoint_id,omitempty"`
	Branchable      bool          `json:"branchable,omitempty"`
	ID              string        `json:"id"`
	Name            string        `json:"name"`
	Profile         model.Profile `json:"profile"`
	Generation      int64         `json:"generation"`
	Prepared        bool          `json:"prepared"`
	Deleted         bool          `json:"deleted"`
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
// SourcePort retains the captured guest's original forwarded guest RPC port for RAM restore.
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
	Initialize(context.Context, Manifest) (string, error)
	Verify(context.Context, Manifest) (string, error)
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
	cfg       Config
	state     *statefs.Dir
	db        *sql.DB
	runtime   Runtime
	guests    *guestRegistry
	authority *rpcidentity.Authority
	lifetime  context.Context
	cancel    context.CancelFunc
	renewals  sync.WaitGroup
	mu        sync.Mutex
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

	// A durable cross-environment lease uses the full canonical root identity.
	cfg.Root, err = filepath.EvalSymlinks(cfg.Root)
	if err != nil {
		return nil, err
	}
	if err = cfg.Validate(); err != nil {
		return nil, err
	}

	authority, err := initializeAuthority(dir, cfg)
	if err != nil {
		return nil, err
	}
	defer func() {
		if !retained {
			resultErr = errors.Join(resultErr, authority.Close())
		}
	}()

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
		rt = &NativeRuntime{Config: cfg, Runner: ExecRunner{}, authority: authority}
	}
	if native, ok := rt.(*NativeRuntime); ok {
		native.authority = authority
	}
	closeErr := lock.Close()
	lockClosed = true
	if closeErr != nil {
		return nil, errors.Join(closeErr, db.Close())
	}
	retained = true
	lifetime, cancel := context.WithCancel(context.Background())
	h := &Helper{cfg: cfg, state: dir, db: db, runtime: rt, guests: newGuestRegistry(), authority: authority, lifetime: lifetime, cancel: cancel}
	if err = h.restoreGuestReservations(context.Background()); err != nil {
		_ = h.Close()
		return nil, err
	}
	if err = h.adoptPorts(context.Background()); err != nil {
		_ = h.Close()
		return nil, err
	}
	return h, nil
}

// Close releases the journal and its private directory handle.
func (h *Helper) Close() error {
	h.cancel()
	h.guests.close()
	h.renewals.Wait()
	return errors.Join(h.authority.Close(), h.db.Close(), h.state.Close())
}

func (h *Helper) manifest(ctx context.Context, id string) (Manifest, error) {
	var m Manifest
	var b []byte
	err := h.db.QueryRowContext(ctx, "SELECT body FROM machines WHERE id=?", id).Scan(&b)
	if err == nil {
		err = json.Unmarshal(b, &m)
	}
	return m, err
}

func (h *Helper) save(ctx context.Context, m Manifest, a accepted) error {
	h.guests.mu.Lock()
	err := h.saveJournal(ctx, m, a)
	if err == nil {
		h.guests.apply(a)
	}
	h.guests.mu.Unlock()
	if err == nil && m.Deleted && a.Phase == phaseDone {
		err = h.releasePort(m)
	}
	return err
}

func (h *Helper) saveJournal(ctx context.Context, m Manifest, a accepted) (resultErr error) {
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
			return model.SameProfile(local.Profile, p)
		}
	}
	return false
}

func (h *Helper) observation(ctx context.Context, m Manifest) (*model.Observation, error) {
	obs := &model.Observation{
		MachineID:  m.ID,
		Generation: m.Generation,
		Prepared:   m.Prepared,
		Deleted:    m.Deleted,
		Endpoint:   m.Endpoint,
		State:      model.Stopped,
		ObservedAt: time.Now().UTC(),
		Guest:      h.guests.observation(m.ID),
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
	}
	return obs, nil
}

// Inspect reports the current owned state without starting or recreating a machine.
func (h *Helper) Inspect(ctx context.Context, id string) model.Response {
	if !model.ValidID(id) {
		return failure(model.Request{}, model.NewError(model.ReasonInvalid, "invalid machine ID", false))
	}
	m, err := h.manifest(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return failure(model.Request{}, model.NewError(model.ReasonNotFound, "owned machine not found", false))
	}
	if err != nil {
		return failure(model.Request{}, err)
	}
	obs, err := h.observation(ctx, m)
	if err != nil {
		return model.Response{Status: statusUnresolved, Error: err.Error(), Cause: err}
	}
	return model.Response{Status: statusSucceeded, Observation: obs}
}

func failure(req model.Request, err error) model.Response {
	return model.Response{OperationID: req.OperationID, Status: statusFailed, Error: err.Error(), Cause: err}
}

// Execute serializes a generation transition and journals native effects before dispatch.
func (h *Helper) Execute(ctx context.Context, req model.Request) model.Response {
	if req.Action == "inspect" {
		if req.OperationID != "" || req.Generation != 0 {
			return failure(req, model.NewError(model.ReasonInvalid, "inspect must not carry an operation generation", false))
		}
		return h.Inspect(ctx, req.MachineID)
	}
	if err := validMutation(req); err != nil {
		return failure(req, err)
	}
	// Mutations run one at a time; a busy host answers with a retryable status.
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
	response := h.executeLocked(ctx, req, false)
	if closeErr := lock.Close(); closeErr != nil {
		response.Status = statusUnresolved
		response.Error = errors.Join(errors.New(response.Error), closeErr).Error()
	}
	return response
}

func (h *Helper) executeLocked(ctx context.Context, req model.Request, acceptOnly bool) model.Response {
	var a accepted
	var raw []byte
	var fp string
	err := h.db.QueryRowContext(ctx, "SELECT fingerprint,body FROM operations WHERE id=?", req.OperationID).
		Scan(&fp, &raw)
	if err == nil {
		if fp != model.Hash(req) {
			return failure(req, model.NewError(model.ReasonIdempotencyConflict, "operation ID input conflict", false))
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
		return h.executeDerived(ctx, req, a, len(raw) != 0, acceptOnly)
	}
	m, merr := h.manifest(ctx, req.MachineID)
	switch {
	case len(raw) == 0:
		m, a, err = h.acceptLifecycle(ctx, req, m, merr)
		if err != nil {
			return failure(req, err)
		}
	case merr != nil:
		return failure(req, merr)
	case m.Generation != req.Generation:
		return failure(req, model.NewError(model.ReasonConflict, "accepted generation no longer current", false))
	}
	if acceptOnly {
		return a.Response
	}
	return h.reconcile(ctx, m, a)
}

// rejectedOperationError marks a refusal known to precede native effects.
type rejectedOperationError struct{ error }

func (e rejectedOperationError) Unwrap() error { return e.error }

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
		err = rejectedOperationError{model.NewError(model.ReasonPrerequisite, "machine has not completed trusted preparation", false)}
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
			return rejectedOperationError{model.NewError(model.ReasonPrerequisite, "refusing to adopt an existing runtime name", false)}
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
		r.machine.Endpoint, err = r.helper.runtime.Initialize(ctx, r.machine)
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
	if r.operation.Phase == phaseAccepted {
		if !state.Exists || state.State != model.Stopped {
			return rejectedOperationError{model.NewError(model.ReasonPrerequisite, "start requires an existing stopped runtime record", false)}
		}
		if err := r.persist(ctx, "starting"); err != nil {
			return err
		}
		if err := r.helper.runtime.Start(ctx, r.machine); err != nil {
			return err
		}
	}
	state, err := r.helper.runtime.Inspect(ctx, r.machine)
	if err != nil {
		return err
	}
	if !state.Exists || state.State != model.Running {
		return errors.New("start is ambiguous; refusing another cold boot")
	}
	r.machine.Branchable = r.machine.Profile.Runtime == runtimeSmolvm
	endpoint, err := r.helper.runtime.Verify(ctx, r.machine)
	if err != nil {
		return err
	}
	r.machine.Endpoint = endpoint

	return nil
}

func (r *lifecycleAttempt) stopRetained(ctx context.Context, state RuntimeState) error {
	if !state.Exists || state.State == model.Unknown {
		return errors.New("runtime state unknown; cannot stop")
	}
	if r.operation.Phase == phaseAccepted {
		if state.State != model.Running {
			return rejectedOperationError{model.NewError(model.ReasonPrerequisite, "stop requires running execution", false)}
		}
		if err := r.persist(ctx, "stopping"); err != nil {
			return err
		}
	}
	if state.State == model.Running {
		if err := r.helper.runtime.Stop(ctx, r.machine); err != nil {
			return err
		}
	}
	state, err := r.helper.runtime.Inspect(ctx, r.machine)
	if err != nil {
		return err
	}
	if !state.Exists || state.State != model.Stopped {
		return errors.New("guest has not stopped; disks retained")
	}
	return nil
}

func (r *lifecycleAttempt) deleteRetained(ctx context.Context, state RuntimeState) error {
	if r.operation.Phase == phaseAccepted {
		if !state.Exists || state.State != model.Stopped {
			return rejectedOperationError{model.NewError(model.ReasonPrerequisite, "delete requires an inspected stopped owned runtime", false)}
		}
		if err := r.persist(ctx, "deleting"); err != nil {
			return err
		}
	}
	if state.Exists && state.State != model.Stopped {
		return errors.New("runtime no longer stopped; refusing deletion")
	}
	if err := r.helper.runtime.Delete(ctx, r.machine); err != nil {
		return err
	}
	state, err := r.helper.runtime.Inspect(ctx, r.machine)
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
	} else if port != "7443" || !ip.IsPrivate() || ip.IsLoopback() {
		return errors.New("tart endpoint must be a private guest IP on port 7443")
	}
	return nil
}

// machineDir is keyed by the machine ID, not its alias.
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
	if !model.ValidName(req.Name) {
		return Manifest{}, accepted{}, model.NewError(model.ReasonInvalid, "valid machine name required", false)
	}
	if !h.profile(req.Profile) {
		return Manifest{}, accepted{}, model.NewError(model.ReasonConfiguration, "unknown or changed pinned profile", false)
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
	if merr != nil && !errors.Is(merr, sql.ErrNoRows) {
		return Manifest{}, merr
	}
	if merr == nil {
		return Manifest{}, model.NewError(model.ReasonConflict, "machine ID already owned; it cannot be recreated", false)
	}
	if req.Generation != 1 {
		return Manifest{}, model.NewError(model.ReasonInvalid, "create requires generation 1", false)
	}
	m := Manifest{ID: req.MachineID, Name: req.Name, Profile: req.Profile}
	if m.Profile.Runtime == runtimeSmolvm {
		var err error
		m.Port, err = h.port(ctx, req.MachineID)
		if err != nil {
			return Manifest{}, err
		}
	}
	return m, nil
}

func (h *Helper) validateRetainedGeneration(ctx context.Context, req model.Request, m Manifest, merr error) error {
	if merr != nil && !errors.Is(merr, sql.ErrNoRows) {
		return merr
	}
	if errors.Is(merr, sql.ErrNoRows) || m.Deleted {
		return model.NewError(model.ReasonNotFound, "stopped owned machine required; missing or deleted identity", false)
	}
	if m.Generation+1 != req.Generation {
		return model.NewError(model.ReasonConflict, "generation conflict; controller reconciliation required", false)
	}
	if m.Name != req.Name || !model.SameProfile(m.Profile, req.Profile) {
		return model.NewError(model.ReasonConflict, "immutable machine identity conflict", false)
	}
	var last []byte
	if err := h.db.QueryRowContext(ctx, "SELECT body FROM operations WHERE machine_id=? AND generation=?", m.ID, m.Generation).
		Scan(&last); err != nil {
		return err
	}
	var previous accepted
	if err := json.Unmarshal(last, &previous); err != nil {
		return err
	}
	if previous.Response.Status != statusSucceeded && previous.Response.Status != statusFailed {
		return model.NewError(model.ReasonReconciliationRequired, "previous generation is unresolved", false)
	}
	return nil
}

func (c *Config) validateProfiles() error {
	if c.RuntimeDigest == "" {
		return errors.New("runtime_digest required")
	}
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
		if err := c.validateRuntimeProfile(p.Profile); err != nil {
			return err
		}
	}
	return nil
}

func (c *Config) validateRuntimeProfile(p model.Profile) error {
	switch p.Runtime {
	case runtimeTart:
		if c.HostOS != hostDarwin {
			return errors.New("tart requires a macOS host")
		}
		if !model.SafePath(c.TartPath) || !model.SafePath(c.LaunchctlPath) {
			return errors.New("tart requires absolute tart_path and launchctl_path")
		}
	case runtimeSmolvm:
		if (c.HostOS == hostDarwin && p.Arch != "arm64") || (c.HostOS == hostLinux && p.Arch != "amd64") {
			return errors.New("unsupported: smolvm host/guest architecture is not qualified")
		}
		supervisorPath := c.SystemctlPath
		if c.HostOS == hostDarwin {
			supervisorPath = c.LaunchctlPath
		}
		if !model.SafePath(c.SmolvmPath) || !model.SafePath(c.LibraryDir) || !model.SafePath(supervisorPath) {
			return errors.New("smolvm requires absolute smolvm_path, library_dir and systemctl_path")
		}
		suffix := "/runtime/c/smolvm/vms/0000000000000000/control.sock"
		limit := unixSocketPathLimit
		if c.HostOS == hostDarwin {
			suffix = "/runtime/Library/Caches/smolvm/vms/0000000000000000/control.sock"
			limit = 104
		}
		if len(c.Root)+len(suffix) >= limit {
			return errors.New("smolvm root too long for Unix socket paths; use a short private path")
		}
	}
	return nil
}
