// Package control implements the single-controller durable lifecycle queue.
package control

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"slices"
	"sync"
	"time"

	_ "modernc.org/sqlite" // Register the SQLite database driver.

	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

const (
	stopAction            = "stop"
	restoreAction         = "restore"
	startAction           = "start"
	forkAction            = "fork"
	inspectTimeout        = 12 * time.Second
	inspectionConcurrency = 8
	operationTimeout      = 6 * time.Minute
	retryDelay            = 5 * time.Second
)

const (
	smolvmRuntime          = "smolvm"
	deleteCheckpointAction = "checkpoint-delete"
	createCheckpointAction = "checkpoint-create"
	publishedStatus        = "published"
	pendingStatus          = "pending"
	createAction           = "create"
	deleteAction           = "delete"
	succeededStatus        = "succeeded"
	failedStatus           = "failed"
)

// Transport dispatches lifecycle requests and opens SSH streams to configured hosts.
type Transport interface {
	Call(context.Context, model.Host, model.Request) (model.Response, error)
	Connect(context.Context, model.Host, string) (io.ReadWriteCloser, error)
}

// APIError describes a client-visible failure and its HTTP status.
type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Status  int    `json:"-"`
}

func (e *APIError) Error() string                    { return e.Message }
func problem(status int, code, message string) error { return &APIError{code, message, status} }

// Controller owns durable lifecycle intent and serializes operations per host.
type Controller struct {
	logger    *slog.Logger
	db        *sql.DB
	lock      *statefs.Lock
	stateDir  *statefs.Dir
	cfg       model.Config
	transport Transport
	mu        sync.Mutex
	workMu    sync.Mutex
	busy      map[string]bool
	now       func() time.Time
}

// Open opens the durable queue in a private state directory and acquires its exclusive controller lock.
// Close releases the database, lock, and directory.
func Open(path string, cfg model.Config, transport Transport) (*Controller, error) {
	ctx := context.Background()
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if transport == nil {
		return nil, errors.New("transport required")
	}
	directory, err := statefs.Open(path)
	if err != nil {
		return nil, err
	}
	lock, err := directory.Lock("controller.lock", true)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("controller database already in use: %w", err), directory.Close())
	}
	fail := func(err error) (*Controller, error) { return nil, errors.Join(err, lock.Close(), directory.Close()) }
	databasePath, err := directory.Database("controller.db")
	if err != nil {
		return fail(err)
	}
	db, err := sql.Open("sqlite", databasePath)
	if err != nil {
		return fail(err)
	}
	db.SetMaxOpenConns(1)
	_, err = db.ExecContext(ctx, `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, body BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, name TEXT NOT NULL, deleted INTEGER NOT NULL, body BLOB NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS live_names ON machines(name) WHERE deleted=0;
 CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, idem TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, machine_id TEXT NOT NULL, status TEXT NOT NULL, body BLOB NOT NULL, request BLOB NOT NULL, next_attempt INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS pending_operations ON operations(status,next_attempt);
 UPDATE operations SET status='unresolved' WHERE status='running';`)
	if err != nil {
		return fail(errors.Join(err, db.Close()))
	}
	return &Controller{
		logger:    slog.New(slog.NewTextHandler(os.Stderr, nil)),
		db:        db,
		lock:      lock,
		stateDir:  directory,
		cfg:       cfg,
		transport: transport,
		busy:      map[string]bool{},
		now:       func() time.Time { return time.Now().UTC() },
	}, nil
}

// Close releases all resources owned by the controller.
func (c *Controller) Close() error {
	return errors.Join(c.db.Close(), c.lock.Close(), c.stateDir.Close())
}
func (c *Controller) host(id string) (model.Host, bool) {
	for _, h := range c.cfg.Hosts {
		if h.ID == id {
			return h, true
		}
	}
	return model.Host{}, false
}
func (c *Controller) profile(id string) (model.Profile, bool) {
	for _, p := range c.cfg.Profiles {
		if p.ID == id {
			return p, true
		}
	}
	return model.Profile{}, false
}

// rollbackTransaction releases an unfinished transaction and preserves cleanup failures.
func rollbackTransaction(tx *sql.Tx) error {
	err := tx.Rollback()
	if errors.Is(err, sql.ErrTxDone) {
		return nil
	}
	return err
}

type querier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}
type executor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func readMachine(ctx context.Context, q querier, id string) (model.Machine, error) {
	var m model.Machine
	var b []byte
	err := q.QueryRowContext(ctx, "SELECT body FROM machines WHERE id=?", id).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return m, problem(http.StatusNotFound, "not_found", "machine not found")
	}
	if err != nil {
		return m, err
	}
	err = json.Unmarshal(b, &m)
	return m, err
}
func machines(ctx context.Context, q querier) (_ []model.Machine, resultErr error) {
	rows, err := q.QueryContext(ctx, "SELECT body FROM machines WHERE deleted=0 ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer func() { resultErr = errors.Join(resultErr, rows.Close()) }()
	out := []model.Machine{}
	for rows.Next() {
		var b []byte
		var m model.Machine
		if err = rows.Scan(&b); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(b, &m); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
func saveMachine(ctx context.Context, q executor, m model.Machine) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	_, err = q.ExecContext(
		ctx,
		"INSERT INTO machines(id,name,deleted,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET deleted=excluded.deleted,body=excluded.body",
		m.ID,
		m.Name,
		m.Deleted,
		b,
	)
	return err
}
func readOperation(ctx context.Context, q querier, id string) (model.Operation, error) {
	var o model.Operation
	var b []byte
	var status string
	err := q.QueryRowContext(ctx, "SELECT body,status FROM operations WHERE id=?", id).Scan(&b, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return o, problem(http.StatusNotFound, "not_found", "operation not found")
	}
	if err != nil {
		return o, err
	}
	err = json.Unmarshal(b, &o)
	o.Status = status
	return o, err
}
func saveOperation(ctx context.Context, q executor, o model.Operation, next int64) error {
	b, err := json.Marshal(o)
	if err != nil {
		return err
	}
	_, err = q.ExecContext(
		ctx,
		"UPDATE operations SET status=?,body=?,next_attempt=? WHERE id=?",
		o.Status,
		b,
		next,
		o.ID,
	)
	return err
}

// Operation retrieves a durable operation by identifier.
func (c *Controller) Operation(ctx context.Context, id string) (model.Operation, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return readOperation(ctx, c.db, id)
}
func (c *Controller) duplicate(ctx context.Context, tx *sql.Tx, key, fp string) (model.Operation, bool, error) {
	var id, old string
	err := tx.QueryRowContext(ctx, "SELECT id,fingerprint FROM operations WHERE idem=?", key).Scan(&id, &old)
	if errors.Is(err, sql.ErrNoRows) {
		return model.Operation{}, false, nil
	}
	if err != nil {
		return model.Operation{}, false, err
	}
	if old != fp {
		return model.Operation{}, true, problem(
			http.StatusConflict,
			"idempotency_conflict",
			"Idempotency-Key was used for different input",
		)
	}
	o, err := readOperation(ctx, tx, id)
	if err == nil && !o.Done() {
		_, err = tx.ExecContext(ctx, "UPDATE operations SET next_attempt=0 WHERE id=?", id)
	}
	return o, true, err
}

// duplicateIntent checks completed retries without requiring the host to be available.
func (c *Controller) duplicateIntent(
	ctx context.Context,
	key, fingerprint string,
) (_ model.Operation, _ bool, resultErr error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		return model.Operation{}, false, err
	}
	defer func() { resultErr = errors.Join(resultErr, rollbackTransaction(tx)) }()
	op, found, err := c.duplicate(ctx, tx, key, fingerprint)
	if err != nil {
		return op, found, err
	}
	return op, found, tx.Commit()
}

func validKey(key string) error {
	if len(key) < 1 || len(key) > 200 {
		return problem(
			http.StatusBadRequest,
			"invalid_request",
			"Idempotency-Key of 1..200 printable characters is required",
		)
	}
	for _, r := range key {
		if r < 33 || r > 126 {
			return problem(http.StatusBadRequest, "invalid_request", "invalid Idempotency-Key")
		}
	}
	return nil
}
func capacity(ctx context.Context, tx *sql.Tx, h model.Host, p model.Profile, exclude string) error {
	ms, err := machines(ctx, tx)
	if err != nil {
		return err
	}
	used := hostCapacity(h, ms, exclude)
	if p.CPU > used.RemainingCPU || p.RAMMiB > used.RemainingRAMMiB {
		return problem(
			http.StatusConflict,
			"capacity",
			"host CPU/RAM capacity is exhausted (unknown machines remain reserved)",
		)
	}
	return nil
}
func insertOperation(ctx context.Context, tx *sql.Tx, key, fp string, o model.Operation, req model.Request) error {
	b, _ := json.Marshal(o)
	r, _ := json.Marshal(req)
	_, err := tx.ExecContext(ctx,
		"INSERT INTO operations(id,idem,fingerprint,machine_id,status,body,request) VALUES(?,?,?,?,?,?,?)",
		o.ID,
		key,
		fp,
		o.MachineID,
		o.Status,
		b,
		r,
	)
	return err
}

// Create accepts an idempotent request to create a machine.
func (c *Controller) Create(
	ctx context.Context,
	key string,
	in model.CreateInput,
) (_ model.Operation, resultErr error) {
	if err := validKey(key); err != nil {
		return model.Operation{}, err
	}
	if err := in.Validate(); err != nil {
		return model.Operation{}, problem(http.StatusBadRequest, "invalid_request", err.Error())
	}
	fp := model.Hash(struct {
		Action string
		Input  model.CreateInput
	}{createAction, in})
	c.mu.Lock()
	defer c.mu.Unlock()
	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		return model.Operation{}, err
	}
	defer func() { resultErr = errors.Join(resultErr, rollbackTransaction(tx)) }()
	duplicate, found, duplicateErr := c.duplicate(ctx, tx, key, fp)
	if found || duplicateErr != nil {
		if duplicateErr == nil {
			duplicateErr = tx.Commit()
		}
		return duplicate, duplicateErr
	}
	p, ok := c.profile(in.Profile)
	if !ok {
		return model.Operation{}, problem(http.StatusBadRequest, "invalid_request", "unknown profile")
	}
	h, ok := c.host(in.Host)
	if !ok || !slices.Contains(h.ProfileIDs, p.ID) {
		return model.Operation{}, problem(http.StatusBadRequest, "invalid_request", "host does not provide profile")
	}
	var n int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM machines WHERE name=? AND deleted=0", in.Name).
		Scan(&n); err != nil {
		return model.Operation{}, err
	}
	if n != 0 {
		return model.Operation{}, problem(http.StatusConflict, "name_conflict", "machine name already exists")
	}
	if err = capacity(ctx, tx, h, p, ""); err != nil {
		return model.Operation{}, err
	}
	now := c.now()
	m := model.Machine{
		ID:               model.NewID(),
		Name:             in.Name,
		Profile:          p.ID,
		ProfileSpec:      p,
		Host:             h.ID,
		State:            model.Preparing,
		DesiredState:     model.Running,
		Generation:       1,
		ObservationStale: true,
		CreatedAt:        now,
	}
	o := model.Operation{
		ID:         model.NewID(),
		MachineID:  m.ID,
		Action:     createAction,
		Generation: 1,
		Status:     pendingStatus,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	req := model.Request{
		Action:        createAction,
		OperationID:   o.ID,
		MachineID:     m.ID,
		Generation:    1,
		Name:          m.Name,
		Profile:       p,
		SSHPublicKeys: in.SSHPublicKeys,
	}
	if err = saveMachine(ctx, tx, m); err == nil {
		err = insertOperation(ctx, tx, key, fp, o, req)
	}
	if err == nil {
		err = tx.Commit()
	}
	return o, err
}

// Mutate accepts an idempotent start, stop, or delete after checking current host state.
func (c *Controller) Mutate(ctx context.Context, id, action, key string) (_ model.Operation, resultErr error) {
	if err := validateMutationInput(id, action, key); err != nil {
		return model.Operation{}, err
	}
	fp := model.Hash(struct{ Action, ID string }{action, id})
	// Check the idempotency key before observing: completed retries must work offline.
	o, found, err := c.duplicateIntent(ctx, key, fp)
	if found || err != nil {
		return o, err
	}
	if err = c.requireFreshObservation(ctx, id); err != nil {
		return model.Operation{}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		return model.Operation{}, err
	}
	defer func() { resultErr = errors.Join(resultErr, rollbackTransaction(tx)) }()
	duplicate, found, duplicateErr := c.duplicate(ctx, tx, key, fp)
	if found || duplicateErr != nil {
		if duplicateErr == nil {
			duplicateErr = tx.Commit()
		}
		return duplicate, duplicateErr
	}
	m, err := readMachine(ctx, tx, id)
	if err != nil {
		return o, err
	}
	if err = validateMutation(ctx, tx, m, action); err != nil {
		return o, err
	}
	h, ok := c.host(m.Host)
	if !ok {
		return o, problem(http.StatusConflict, "configuration", "machine host is no longer configured")
	}
	if action == startAction {
		if err = capacity(ctx, tx, h, m.ProfileSpec, m.ID); err != nil {
			return o, err
		}
		m.DesiredState = model.Running
	} else {
		m.DesiredState = model.Stopped
	}
	m.Generation++
	now := c.now()
	o = model.Operation{
		ID:         model.NewID(),
		MachineID:  id,
		Action:     action,
		Generation: m.Generation,
		Status:     pendingStatus,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	req := model.Request{
		Action:      action,
		OperationID: o.ID,
		MachineID:   id,
		Generation:  m.Generation,
		Name:        m.Name,
		Profile:     m.ProfileSpec,
	}
	if err = saveMachine(ctx, tx, m); err == nil {
		err = insertOperation(ctx, tx, key, fp, o, req)
	}
	if err == nil {
		err = tx.Commit()
	}
	return o, err
}
func (c *Controller) requireFreshObservation(ctx context.Context, id string) error {
	m, err := c.Inspect(ctx, id)
	if err != nil {
		return err
	}
	if m.ObservationStale {
		return problem(http.StatusServiceUnavailable, "host_unavailable", m.ObservationError)
	}
	return nil
}

func applyObservation(m *model.Machine, obs *model.Observation) {
	m.State = obs.State
	m.AcceptedGeneration = obs.Generation
	m.Prepared = obs.Prepared
	m.SSHUser = obs.SSHUser
	m.SSHHostKey = obs.SSHHostKey
	m.Endpoint = obs.Endpoint
	m.ObservedAt = &obs.ObservedAt
	m.ObservationStale = false
	m.ObservationError = ""
	m.Deleted = obs.Deleted
}
func validateObservation(id string, obs *model.Observation) error {
	if obs == nil || obs.MachineID != id || obs.Generation < 1 || obs.ObservedAt.IsZero() {
		return errors.New("invalid host observation")
	}
	switch obs.State {
	case model.Running, model.Stopped, model.Unknown, model.Preparing:
	default:
		return errors.New("invalid observed state")
	}
	if obs.Prepared {
		keys, err := model.ValidateKeys([]string{obs.SSHHostKey})
		if err != nil || len(keys) != 1 || obs.SSHUser == "" {
			return errors.New("invalid prepared SSH identity")
		}
	}
	return nil
}

// Inspect refreshes a machine observation and reports unavailable hosts as stale.
func (c *Controller) Inspect(ctx context.Context, id string) (model.Machine, error) {
	c.mu.Lock()
	m, err := readMachine(ctx, c.db, id)
	c.mu.Unlock()
	if err != nil {
		return m, err
	}
	if m.Deleted {
		return m, nil
	}
	h, ok := c.host(m.Host)
	var resp model.Response
	if !ok {
		err = errors.New("host is no longer configured")
	} else {
		contact, cancel := context.WithTimeout(ctx, inspectTimeout)
		resp, err = c.transport.Call(contact, h, model.Request{Action: "inspect", MachineID: id})
		cancel()
		if err == nil && resp.Status != succeededStatus {
			err = fmt.Errorf("host inspection: %s", resp.Error)
		}
		if err == nil {
			err = validateObservation(id, resp.Observation)
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	latest, readErr := readMachine(ctx, c.db, id)
	if readErr != nil {
		return m, readErr
	}
	// Do not let an in-flight observation roll back a newer dispatch or observation.
	if latest.Generation != m.Generation || latest.Deleted {
		return latest, nil
	}
	if err != nil {
		latest.ObservationStale = true
		latest.ObservationError = err.Error()
		latest.State = model.Unknown
	} else if latest.ObservedAt == nil || !resp.Observation.ObservedAt.Before(*latest.ObservedAt) {
		applyObservation(&latest, resp.Observation)
	}
	return latest, saveMachine(ctx, c.db, latest)
}

// List returns machines with refreshed host observations.
func (c *Controller) List(ctx context.Context) ([]model.Machine, error) {
	c.mu.Lock()
	ms, err := machines(ctx, c.db)
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	var wg sync.WaitGroup
	sem := make(chan struct{}, inspectionConcurrency)
	errs := make([]error, len(ms))
	for i := range ms {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			ms[i], errs[i] = c.Inspect(ctx, ms[i].ID)
		}(i)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	return ms, nil
}

// Run starts one serial worker per configured host. A slow host cannot hold up another host.
// Unresolved work is retried with the exact persisted request, including its original ID.
func (c *Controller) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for _, h := range c.cfg.Hosts {
		wg.Add(1)
		go func(h model.Host) {
			defer wg.Done()
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			for {
				if ctx.Err() != nil {
					return
				}
				if err := c.ProcessOne(ctx, h.ID); err != nil && ctx.Err() == nil {
					c.logger.ErrorContext(ctx, "reconcile host operation", "host", h.ID, "error", err)
				}
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
		}(h)
	}
	wg.Wait()
}

func validateMutation(ctx context.Context, tx *sql.Tx, m model.Machine, action string) error {
	var err error
	if m.Deleted {
		return problem(http.StatusConflict, "prerequisite", "machine is deleted")
	}
	if err = sourceIdle(ctx, tx, m.ID); err != nil {
		return err
	}
	if action == deleteAction {
		if err = machineDependencies(ctx, tx, m); err != nil {
			return err
		}
	}
	if m.ObservationStale || m.AcceptedGeneration != m.Generation {
		return problem(
			http.StatusConflict,
			"reconciliation_required",
			"host generation differs from controller; reconcile before mutating",
		)
	}
	if !m.Prepared || m.State == model.Unknown || m.State == model.Preparing {
		return problem(http.StatusConflict, "prerequisite", "machine must have a known prepared execution")
	}
	if (action == startAction || action == deleteAction) && m.State != model.Stopped {
		return problem(http.StatusConflict, "prerequisite", "action requires a stopped machine")
	}
	if action == stopAction && m.State != model.Running {
		return problem(http.StatusConflict, "prerequisite", "stop requires a running machine")
	}

	return nil
}

func validateMutationInput(id, action, key string) error {
	if !model.ValidID(id) {
		return problem(http.StatusBadRequest, "invalid_request", "invalid machine ID")
	}
	if action != startAction && action != stopAction && action != deleteAction {
		return problem(http.StatusBadRequest, "unsupported", "unsupported action")
	}
	if err := validKey(key); err != nil {
		return err
	}

	return nil
}
