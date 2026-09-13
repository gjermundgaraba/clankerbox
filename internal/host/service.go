package host

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"clankerbox/internal/model"
)

// OperationRecord is a view of the existing host journal, not another work queue.
type OperationRecord struct {
	Response    model.Response
	Phase       string
	Fingerprint string
}

const operationTimeout = 6 * time.Minute

// ErrBusy asks callers to retry the same operation identity.
var ErrBusy = errors.New("host mutation admission busy; retry with the same operation identity")

// ErrOperationNotFound means no durable acceptance exists.
var ErrOperationNotFound = errors.New("host operation not found")

// Service owns accepted work independently of any RPC request. One worker preserves
// the host core's mutation serialization. Restarts reconcile the same journal.
type Service struct {
	helper  *Helper
	ctx     context.Context
	cancel  context.CancelFunc
	wake    chan struct{}
	done    chan struct{}
	mu      sync.Mutex
	closed  bool
	active  map[string]bool
	failure chan error
}

// NewService starts bounded reconciliation of the existing host journal.
func NewService(h *Helper) *Service {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{
		helper:  h,
		ctx:     ctx,
		cancel:  cancel,
		wake:    make(chan struct{}, 1),
		done:    make(chan struct{}),
		active:  make(map[string]bool),
		failure: make(chan error, 1),
	}
	go s.work()
	s.notify()
	return s
}

func (s *Service) notify() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Submit commits identity, fingerprint, generation and acceptance before returning.
// An existing identical record is returned without replaying its effect.
func (s *Service) Submit(ctx context.Context, req model.Request) (OperationRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	select {
	case <-s.done:
		return OperationRecord{}, errors.New("host worker stopped")
	default:
	}
	if s.closed {
		return OperationRecord{}, errors.New("host service shutting down")
	}
	if err := s.validateRequest(req); err != nil {
		return OperationRecord{}, err
	}
	existing, err := s.helper.Operation(ctx, req.OperationID)
	if err == nil {
		if existing.Fingerprint != model.Hash(req) {
			return OperationRecord{}, errors.New("operation ID input conflict")
		}
		if existing.Phase == phaseAccepted {
			s.notify()
		}
		return existing, nil
	}
	if !errors.Is(err, ErrOperationNotFound) {
		return OperationRecord{}, err
	}
	h := s.helper
	if !h.mu.TryLock() {
		return OperationRecord{}, ErrBusy
	}
	defer h.mu.Unlock()
	lock, err := h.state.Lock(".lock", true)
	if err != nil {
		return OperationRecord{}, fmt.Errorf("%w: %w", ErrBusy, err)
	}
	response := h.executeLocked(ctx, req, true)
	if record, e := h.Operation(
		context.WithoutCancel(ctx),
		req.OperationID,
	); e == nil && record.Fingerprint == model.Hash(req) && record.Response.Status != statusFailed &&
		record.Response.Status != statusSucceeded {
		h.guests.suspend(req.MachineID, req.SourceMachineID)
	}
	closeErr := lock.Close()
	// A cancelled caller may lose the read-back/ack after a successful commit.
	// Wake the host worker regardless; the journal decides whether work exists.
	s.notify()
	if closeErr != nil {
		return OperationRecord{}, closeErr
	}
	record, err := h.Operation(ctx, req.OperationID)
	if err != nil {
		if response.Error != "" {
			return OperationRecord{}, errors.New(response.Error)
		}
		return OperationRecord{}, err
	}
	if record.Fingerprint != model.Hash(req) {
		return OperationRecord{}, errors.New("operation ID input conflict")
	}
	s.notify()
	return record, nil
}

func validMutation(req model.Request) error {
	if !model.ValidID(req.MachineID) || !model.ValidID(req.OperationID) || req.Generation < 1 {
		return errors.New("invalid operation identity")
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
		return nil
	}
	return errors.New("unsupported action")
}

// Operation reads the authoritative durable operation record.
func (h *Helper) Operation(ctx context.Context, id string) (OperationRecord, error) {
	if !model.ValidID(id) {
		return OperationRecord{}, errors.New("invalid operation identity")
	}
	var raw []byte
	var fp string
	err := h.db.QueryRowContext(ctx, "SELECT fingerprint,body FROM operations WHERE id=?", id).Scan(&fp, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return OperationRecord{}, ErrOperationNotFound
	}
	if err != nil {
		return OperationRecord{}, err
	}
	var a accepted
	if err = json.Unmarshal(raw, &a); err != nil {
		return OperationRecord{}, err
	}
	return OperationRecord{Response: a.Response, Phase: a.Phase, Fingerprint: fp}, nil
}

func (s *Service) pending() ([]model.Request, error) {
	rows, err := s.helper.db.QueryContext(s.ctx, "SELECT body FROM operations ORDER BY rowid")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var result []model.Request
	for rows.Next() {
		var raw []byte
		var a accepted
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		if s.helper.cfg.quarantineRequest(a.Request) != nil {
			continue
		}
		if a.Response.Status != statusSucceeded && a.Response.Status != statusFailed {
			result = append(result, a.Request)
		}
	}
	return result, rows.Err()
}
func (s *Service) work() {
	defer close(s.done)
	attempted := map[string]bool{}
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-s.wake:
		}
		requests, err := s.pending()
		if err != nil {
			if s.ctx.Err() == nil {
				s.failure <- fmt.Errorf("read host journal: %w", err)
			}
			return
		}
		for _, req := range requests {
			if attempted[req.OperationID] {
				continue
			}
			if s.ctx.Err() != nil {
				return
			}
			s.mu.Lock()
			s.active[req.OperationID] = true
			s.mu.Unlock()
			ctx, cancel := context.WithTimeout(s.ctx, operationTimeout)
			response := s.helper.Execute(ctx, req)
			cancel()
			s.mu.Lock()
			delete(s.active, req.OperationID)
			s.mu.Unlock()
			if response.Status != statusSucceeded && response.Status != statusFailed {
				attempted[req.OperationID] = true
			}
		}
	}
}

// Shutdown cancels bounded host work; durable intent remains for next-start reconciliation.
// The caller must not close Helper while a timed-out Shutdown is still pending.
func (s *Service) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	s.closed = true
	s.cancel()
	s.mu.Unlock()
	select {
	case <-s.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Operation distinguishes an active worker from a durable ambiguous outcome without
// changing the existing journal encoding. Accepted phase is always safe to resume.
func (s *Service) Operation(ctx context.Context, id string) (OperationRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := s.helper.Operation(ctx, id)
	if err != nil {
		return r, err
	}
	active := s.active[id]
	if r.Response.Status == statusUnresolved {
		switch {
		case active:
			r.Response.Status = "running"
			r.Response.Error = ""
		case r.Phase == phaseAccepted:
			r.Response.Status = statusPending
			r.Response.Error = ""
		case r.Response.Error == "":
			r.Response.Error = "interrupted " + r.Phase + "; explicit inspection required"
		}
	}
	return r, nil
}

func (s *Service) validateRequest(req model.Request) error {
	if err := s.helper.cfg.quarantineRequest(req); err != nil {
		return err
	}
	if err := validMutation(req); err != nil {
		return err
	}
	if s.helper.cfg.HostID != "" && req.Host != s.helper.cfg.HostID {
		return errors.New("host identity mismatch")
	}
	return nil
}
