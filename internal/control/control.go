// Package control implements the single-controller durable lifecycle queue.
package control

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"syscall"
	"time"

	"clankerbox/internal/model"
	_ "modernc.org/sqlite"
)

type Transport interface {
	Call(context.Context, model.Host, model.Request) (model.Response, error)
	Connect(context.Context, model.Host, string) (io.ReadWriteCloser, error)
}
type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Status  int    `json:"-"`
}

func (e *APIError) Error() string                    { return e.Message }
func problem(status int, code, message string) error { return &APIError{code, message, status} }

type Controller struct {
	db        *sql.DB
	lock      *os.File
	cfg       model.Config
	transport Transport
	mu        sync.Mutex
	workMu    sync.Mutex
	busy      map[string]bool
	now       func() time.Time
}

func Open(path string, cfg model.Config, transport Transport) (*Controller, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if transport == nil {
		return nil, errors.New("transport required")
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		return nil, fmt.Errorf("controller database already in use: %w", err)
	}
	fail := func(e error) (*Controller, error) { lock.Close(); return nil, e }
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return fail(err)
	}
	f.Close()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return fail(err)
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, body BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, name TEXT NOT NULL, deleted INTEGER NOT NULL, body BLOB NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS live_names ON machines(name) WHERE deleted=0;
 CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, idem TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, machine_id TEXT NOT NULL, status TEXT NOT NULL, body BLOB NOT NULL, request BLOB NOT NULL, next_attempt INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS pending_operations ON operations(status,next_attempt);
 UPDATE operations SET status='unresolved' WHERE status='running';`)
	if err != nil {
		db.Close()
		return fail(err)
	}
	return &Controller{db: db, lock: lock, cfg: cfg, transport: transport, busy: map[string]bool{}, now: func() time.Time { return time.Now().UTC() }}, nil
}
func (c *Controller) Close() error { err := c.db.Close(); c.lock.Close(); return err }
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

type querier interface {
	QueryRow(string, ...any) *sql.Row
	Query(string, ...any) (*sql.Rows, error)
}
type executor interface {
	Exec(string, ...any) (sql.Result, error)
}

func readMachine(q querier, id string) (model.Machine, error) {
	var m model.Machine
	var b []byte
	err := q.QueryRow("SELECT body FROM machines WHERE id=?", id).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return m, problem(404, "not_found", "machine not found")
	}
	if err != nil {
		return m, err
	}
	err = json.Unmarshal(b, &m)
	return m, err
}
func machines(q querier) ([]model.Machine, error) {
	rows, err := q.Query("SELECT body FROM machines WHERE deleted=0 ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
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
func saveMachine(q executor, m model.Machine) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	_, err = q.Exec("INSERT INTO machines(id,name,deleted,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET deleted=excluded.deleted,body=excluded.body", m.ID, m.Name, m.Deleted, b)
	return err
}
func readOperation(q querier, id string) (model.Operation, error) {
	var o model.Operation
	var b []byte
	var status string
	err := q.QueryRow("SELECT body,status FROM operations WHERE id=?", id).Scan(&b, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return o, problem(404, "not_found", "operation not found")
	}
	if err != nil {
		return o, err
	}
	err = json.Unmarshal(b, &o)
	o.Status = status
	return o, err
}
func saveOperation(q executor, o model.Operation, next int64) error {
	b, err := json.Marshal(o)
	if err != nil {
		return err
	}
	_, err = q.Exec("UPDATE operations SET status=?,body=?,next_attempt=? WHERE id=?", o.Status, b, next, o.ID)
	return err
}
func (c *Controller) Operation(id string) (model.Operation, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return readOperation(c.db, id)
}
func (c *Controller) duplicate(tx *sql.Tx, key, fp string) (model.Operation, bool, error) {
	var id, old string
	err := tx.QueryRow("SELECT id,fingerprint FROM operations WHERE idem=?", key).Scan(&id, &old)
	if errors.Is(err, sql.ErrNoRows) {
		return model.Operation{}, false, nil
	}
	if err != nil {
		return model.Operation{}, false, err
	}
	if old != fp {
		return model.Operation{}, true, problem(409, "idempotency_conflict", "Idempotency-Key was used for different input")
	}
	o, err := readOperation(tx, id)
	if err == nil && !o.Done() {
		_, err = tx.Exec("UPDATE operations SET next_attempt=0 WHERE id=?", id)
	}
	return o, true, err
}
func validKey(key string) error {
	if len(key) < 1 || len(key) > 200 {
		return problem(400, "invalid_request", "Idempotency-Key of 1..200 printable characters is required")
	}
	for _, r := range key {
		if r < 33 || r > 126 {
			return problem(400, "invalid_request", "invalid Idempotency-Key")
		}
	}
	return nil
}
func capacity(tx *sql.Tx, h model.Host, p model.Profile, exclude string) error {
	ms, err := machines(tx)
	if err != nil {
		return err
	}
	cpu, ram := p.CPU, p.RAMMiB
	for _, m := range ms {
		if m.Host == h.ID && m.ID != exclude && (m.State != model.Stopped || m.DesiredState == model.Running) {
			cpu += m.ProfileSpec.CPU
			ram += m.ProfileSpec.RAMMiB
		}
	}
	if cpu > h.CPU || ram > h.RAMMiB {
		return problem(409, "capacity", "host CPU/RAM capacity is exhausted (unknown machines remain reserved)")
	}
	return nil
}
func insertOperation(tx *sql.Tx, key, fp string, o model.Operation, req model.Request) error {
	b, _ := json.Marshal(o)
	r, _ := json.Marshal(req)
	_, err := tx.Exec("INSERT INTO operations(id,idem,fingerprint,machine_id,status,body,request) VALUES(?,?,?,?,?,?,?)", o.ID, key, fp, o.MachineID, o.Status, b, r)
	return err
}
func (c *Controller) Create(key string, in model.CreateInput) (model.Operation, error) {
	if err := validKey(key); err != nil {
		return model.Operation{}, err
	}
	if err := in.Validate(); err != nil {
		return model.Operation{}, problem(400, "invalid_request", err.Error())
	}
	fp := model.Hash(struct {
		Action string
		Input  model.CreateInput
	}{"create", in})
	c.mu.Lock()
	defer c.mu.Unlock()
	tx, err := c.db.Begin()
	if err != nil {
		return model.Operation{}, err
	}
	defer tx.Rollback()
	if o, found, err := c.duplicate(tx, key, fp); found || err != nil {
		if err == nil {
			err = tx.Commit()
		}
		return o, err
	}
	p, ok := c.profile(in.Profile)
	if !ok {
		return model.Operation{}, problem(400, "invalid_request", "unknown profile")
	}
	h, ok := c.host(in.Host)
	if !ok || !slices.Contains(h.ProfileIDs, p.ID) {
		return model.Operation{}, problem(400, "invalid_request", "host does not provide profile")
	}
	var n int
	if err = tx.QueryRow("SELECT count(*) FROM machines WHERE name=? AND deleted=0", in.Name).Scan(&n); err != nil {
		return model.Operation{}, err
	}
	if n != 0 {
		return model.Operation{}, problem(409, "name_conflict", "machine name already exists")
	}
	if err = capacity(tx, h, p, ""); err != nil {
		return model.Operation{}, err
	}
	now := c.now()
	m := model.Machine{ID: model.NewID(), Name: in.Name, Profile: p.ID, ProfileSpec: p, Host: h.ID, State: model.Preparing, DesiredState: model.Running, Generation: 1, ObservationStale: true, CreatedAt: now}
	o := model.Operation{ID: model.NewID(), MachineID: m.ID, Action: "create", Generation: 1, Status: "pending", CreatedAt: now, UpdatedAt: now}
	req := model.Request{Action: "create", OperationID: o.ID, MachineID: m.ID, Generation: 1, Name: m.Name, Profile: p, SSHPublicKeys: in.SSHPublicKeys}
	if err = saveMachine(tx, m); err == nil {
		err = insertOperation(tx, key, fp, o, req)
	}
	if err == nil {
		err = tx.Commit()
	}
	return o, err
}
func (c *Controller) Mutate(ctx context.Context, id, action, key string) (model.Operation, error) {
	if !model.ValidID(id) {
		return model.Operation{}, problem(400, "invalid_request", "invalid machine ID")
	}
	if action != "start" && action != "stop" && action != "delete" {
		return model.Operation{}, problem(400, "unsupported", "unsupported action")
	}
	if err := validKey(key); err != nil {
		return model.Operation{}, err
	}
	fp := model.Hash(struct{ Action, ID string }{action, id})
	// Check the idempotency key before observing: completed retries must work offline.
	c.mu.Lock()
	tx, err := c.db.Begin()
	if err != nil {
		c.mu.Unlock()
		return model.Operation{}, err
	}
	o, found, err := c.duplicate(tx, key, fp)
	if err == nil {
		err = tx.Commit()
	} else {
		tx.Rollback()
	}
	c.mu.Unlock()
	if found || err != nil {
		return o, err
	}
	m, err := c.Inspect(ctx, id)
	if err != nil {
		return model.Operation{}, err
	}
	if m.ObservationStale {
		return model.Operation{}, problem(503, "host_unavailable", m.ObservationError)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	tx, err = c.db.Begin()
	if err != nil {
		return model.Operation{}, err
	}
	defer tx.Rollback()
	if o, found, err := c.duplicate(tx, key, fp); found || err != nil {
		if err == nil {
			err = tx.Commit()
		}
		return o, err
	}
	m, err = readMachine(tx, id)
	if err != nil {
		return o, err
	}
	if m.Deleted {
		return o, problem(409, "prerequisite", "machine is deleted")
	}
	if err = sourceIdle(tx, id); err != nil {
		return o, err
	}
	if action == "delete" {
		if err = machineDependencies(tx, m); err != nil {
			return o, err
		}
	}
	if m.ObservationStale || m.AcceptedGeneration != m.Generation {
		return o, problem(409, "reconciliation_required", "host generation differs from controller; reconcile before mutating")
	}
	if !m.Prepared || m.State == model.Unknown || m.State == model.Preparing {
		return o, problem(409, "prerequisite", "machine must have a known prepared execution")
	}
	if (action == "start" || action == "delete") && m.State != model.Stopped {
		return o, problem(409, "prerequisite", "action requires a stopped machine")
	}
	if action == "stop" && m.State != model.Running {
		return o, problem(409, "prerequisite", "stop requires a running machine")
	}
	h, ok := c.host(m.Host)
	if !ok {
		return o, problem(409, "configuration", "machine host is no longer configured")
	}
	if action == "start" {
		if err = capacity(tx, h, m.ProfileSpec, m.ID); err != nil {
			return o, err
		}
		m.DesiredState = model.Running
	} else {
		m.DesiredState = model.Stopped
	}
	m.Generation++
	now := c.now()
	o = model.Operation{ID: model.NewID(), MachineID: id, Action: action, Generation: m.Generation, Status: "pending", CreatedAt: now, UpdatedAt: now}
	req := model.Request{Action: action, OperationID: o.ID, MachineID: id, Generation: m.Generation, Name: m.Name, Profile: m.ProfileSpec}
	if err = saveMachine(tx, m); err == nil {
		err = insertOperation(tx, key, fp, o, req)
	}
	if err == nil {
		err = tx.Commit()
	}
	return o, err
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
func (c *Controller) Inspect(ctx context.Context, id string) (model.Machine, error) {
	c.mu.Lock()
	m, err := readMachine(c.db, id)
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
		contact, cancel := context.WithTimeout(ctx, 12*time.Second)
		resp, err = c.transport.Call(contact, h, model.Request{Action: "inspect", MachineID: id})
		cancel()
		if err == nil && resp.Status != "succeeded" {
			err = fmt.Errorf("host inspection: %s", resp.Error)
		}
		if err == nil {
			err = validateObservation(id, resp.Observation)
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	latest, readErr := readMachine(c.db, id)
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
	return latest, saveMachine(c.db, latest)
}
func (c *Controller) List(ctx context.Context) ([]model.Machine, error) {
	c.mu.Lock()
	ms, err := machines(c.db)
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
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
				_ = c.ProcessOne(ctx, h.ID)
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
func (c *Controller) ProcessOne(ctx context.Context, hostID string) error {
	c.workMu.Lock()
	if c.busy[hostID] {
		c.workMu.Unlock()
		return nil
	}
	c.busy[hostID] = true
	c.workMu.Unlock()
	defer func() { c.workMu.Lock(); delete(c.busy, hostID); c.workMu.Unlock() }()
	c.mu.Lock()
	rows, err := c.db.Query("SELECT id,request FROM operations WHERE status NOT IN ('succeeded','failed') AND next_attempt<=? ORDER BY rowid", c.now().Unix())
	if err != nil {
		c.mu.Unlock()
		return err
	}
	type work struct {
		id  string
		req model.Request
	}
	candidates := []work{}
	for rows.Next() {
		var w work
		var b []byte
		if err = rows.Scan(&w.id, &b); err != nil {
			break
		}
		if err = json.Unmarshal(b, &w.req); err != nil {
			break
		}
		candidates = append(candidates, w)
	}
	rowErr := rows.Err()
	rows.Close()
	if err == nil {
		err = rowErr
	}
	if err != nil {
		c.mu.Unlock()
		return err
	}
	var req model.Request
	var op model.Operation
	var m model.Machine
	found := false
	for _, w := range candidates {
		if w.req.Action == "checkpoint-delete" {
			m = model.Machine{ID: w.req.MachineID, Host: w.req.Host}
		} else {
			m, err = readMachine(c.db, w.req.MachineID)
		}
		if err != nil {
			break
		}
		if m.Host == hostID {
			req = w.req
			op, err = readOperation(c.db, w.id)
			found = true
			break
		}
	}
	if err != nil || !found {
		c.mu.Unlock()
		return err
	}
	op.Status = "running"
	op.UpdatedAt = c.now()
	err = saveOperation(c.db, op, 0)
	c.mu.Unlock()
	if err != nil {
		return err
	}
	h, ok := c.host(hostID)
	var resp model.Response
	if !ok {
		err = errors.New("host not configured")
	} else {
		call, cancel := context.WithTimeout(ctx, 6*time.Minute)
		resp, err = c.transport.Call(call, h, req)
		cancel()
	}
	if err == nil {
		if resp.OperationID != op.ID {
			err = errors.New("host returned wrong operation ID")
		} else if resp.Status != "succeeded" && resp.Status != "failed" && resp.Status != "unresolved" {
			err = errors.New("invalid operation status")
		} else if resp.Status == "succeeded" {
			if req.Action == "checkpoint-delete" {
				err = validateCheckpointResponse(req, resp)
			} else {
				err = validateObservation(req.MachineID, resp.Observation)
			}
			if err == nil && req.Action != "checkpoint-delete" && resp.Observation.Generation != op.Generation {
				err = errors.New("host returned wrong generation")
			}
		}
	}
	if err == nil && req.Action == "checkpoint-create" && resp.Status == "succeeded" {
		err = validateCheckpointResponse(req, resp)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	tx, txErr := c.db.Begin()
	if txErr != nil {
		return txErr
	}
	defer tx.Rollback()
	if req.Action != "checkpoint-delete" {
		m, txErr = readMachine(tx, op.MachineID)
	}
	if txErr != nil {
		return txErr
	}
	op.UpdatedAt = c.now()
	next := int64(0)
	if err != nil {
		op.Status = "unresolved"
		op.Error = err.Error()
		m.State = model.Unknown
		m.ObservationStale = true
		m.ObservationError = err.Error()
	} else {
		op.Status = resp.Status
		op.Error = resp.Error
		if resp.Observation != nil && validateObservation(m.ID, resp.Observation) == nil && resp.Observation.Generation == op.Generation {
			if m.ObservedAt == nil || !resp.Observation.ObservedAt.Before(*m.ObservedAt) {
				applyObservation(&m, resp.Observation)
			}
		} else {
			m.ObservationStale = true
		}
	}
	if !op.Done() {
		next = c.now().Add(5 * time.Second).Unix()
	}
	if op.Status == "failed" && m.State == model.Stopped && !m.ObservationStale {
		m.DesiredState = model.Stopped
	}
	if req.Checkpoint != nil && (req.Action == "checkpoint-create" || req.Action == "checkpoint-delete") {
		cp := *req.Checkpoint
		if op.Status == "succeeded" {
			cp = *resp.Checkpoint
		} else if req.Action == "checkpoint-create" {
			cp.Status = op.Status
		} else if op.Status == "failed" {
			cp.Status = "published"
		} else {
			cp.Status = "deleting"
		}
		txErr = saveCheckpoint(tx, cp)
	}
	if txErr == nil && req.Action != "checkpoint-delete" {
		txErr = saveMachine(tx, m)
	}
	if txErr == nil {
		txErr = saveOperation(tx, op, next)
	}
	if txErr == nil {
		txErr = tx.Commit()
	}
	return txErr
}
