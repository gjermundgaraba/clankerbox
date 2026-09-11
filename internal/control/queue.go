package control

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"clankerbox/internal/model"
)

const journalCompletionTimeout = 10 * time.Second

// ProcessOne reconciles the oldest ready operation for a host, if any.
func (c *Controller) ProcessOne(ctx context.Context, hostID string) error {
	c.workMu.Lock()
	if c.busy[hostID] {
		c.workMu.Unlock()
		return nil
	}
	c.busy[hostID] = true
	c.workMu.Unlock()
	defer func() { c.workMu.Lock(); delete(c.busy, hostID); c.workMu.Unlock() }()
	req, op, found, err := c.claimWork(ctx, hostID)
	if err != nil || !found {
		return err
	}
	resp, err := c.callHost(ctx, hostID, req, op)
	// Once dispatched, cancellation cannot discard the durable ambiguity result.
	completion, cancel := context.WithTimeout(context.WithoutCancel(ctx), journalCompletionTimeout)
	defer cancel()
	return c.completeWork(completion, req, op, resp, err)
}

type queuedWork struct {
	id  string
	req model.Request
}

func (c *Controller) pendingWork(ctx context.Context) (_ []queuedWork, resultErr error) {
	rows, err := c.db.QueryContext(
		ctx,
		"SELECT id,request FROM operations WHERE status NOT IN ('succeeded','failed') AND next_attempt<=? ORDER BY rowid",
		c.now().Unix(),
	)
	if err != nil {
		return nil, err
	}
	defer func() { resultErr = errors.Join(resultErr, rows.Close()) }()
	candidates := []queuedWork{}
	for rows.Next() {
		var work queuedWork
		var body []byte
		if err = rows.Scan(&work.id, &body); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(body, &work.req); err != nil {
			return nil, err
		}
		candidates = append(candidates, work)
	}
	return candidates, rows.Err()
}

func (c *Controller) claimWork(ctx context.Context, hostID string) (model.Request, model.Operation, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var req model.Request
	var op model.Operation
	candidates, err := c.pendingWork(ctx)
	if err != nil {
		return req, op, false, err
	}
	for _, work := range candidates {
		machineHost := work.req.Host
		if work.req.Action != deleteCheckpointAction {
			machine, readErr := readMachine(ctx, c.db, work.req.MachineID)
			if readErr != nil {
				return req, op, false, readErr
			}
			machineHost = machine.Host
		}
		if machineHost != hostID {
			continue
		}
		op, err = readOperation(ctx, c.db, work.id)
		if err != nil {
			return req, op, false, err
		}
		op.Status = "running"
		op.UpdatedAt = c.now()
		return work.req, op, true, saveOperation(ctx, c.db, op, 0)
	}
	return req, op, false, nil
}

func (c *Controller) callHost(
	ctx context.Context,
	hostID string,
	req model.Request,
	op model.Operation,
) (model.Response, error) {
	host, ok := c.host(hostID)
	if !ok {
		return model.Response{}, errors.New("host not configured")
	}
	call, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()
	resumeGuest, err := c.suspendGuest(call, req)
	if err != nil {
		return model.Response{}, err
	}
	defer resumeGuest()
	resp, err := c.transport.Call(call, host, req)
	if err != nil {
		return resp, err
	}
	return resp, validateOperationResponse(req, op, resp)
}

func validateOperationResponse(req model.Request, op model.Operation, resp model.Response) error {
	if resp.OperationID != op.ID {
		return errors.New("host returned wrong operation ID")
	}
	if resp.Status != succeededStatus && resp.Status != failedStatus && resp.Status != "unresolved" {
		return errors.New("invalid operation status")
	}
	if resp.Status != succeededStatus {
		return nil
	}
	if req.Action == deleteCheckpointAction {
		return validateCheckpointResponse(req, resp)
	}
	if err := validateObservation(req.MachineID, resp.Observation); err != nil {
		return err
	}
	if resp.Observation.Generation != op.Generation {
		return errors.New("host returned wrong generation")
	}
	if req.Action == createCheckpointAction {
		return validateCheckpointResponse(req, resp)
	}
	return nil
}

func applyOperationResponse(machine *model.Machine, op *model.Operation, resp model.Response, err error) {
	if err != nil {
		op.Status = "unresolved"
		op.Error = err.Error()
		machine.State = model.Unknown
		machine.ObservationStale = true
		machine.ObservationError = err.Error()
		return
	}
	op.Status = resp.Status
	op.Error = resp.Error
	obs := resp.Observation
	if obs == nil || validateObservation(machine.ID, obs) != nil || obs.Generation != op.Generation {
		machine.ObservationStale = true
		return
	}
	if machine.ObservedAt == nil || !obs.ObservedAt.Before(*machine.ObservedAt) {
		applyObservation(machine, obs)
	}
}

func (c *Controller) completeWork(
	ctx context.Context,
	req model.Request,
	op model.Operation,
	resp model.Response,
	err error,
) (resultErr error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	tx, txErr := c.db.BeginTx(ctx, nil)
	if txErr != nil {
		return txErr
	}
	defer func() { resultErr = errors.Join(resultErr, rollbackTransaction(tx)) }()
	var m model.Machine
	if req.Action != deleteCheckpointAction {
		m, txErr = readMachine(ctx, tx, op.MachineID)
	}
	if txErr != nil {
		return txErr
	}
	op.UpdatedAt = c.now()
	next := int64(0)
	applyOperationResponse(&m, &op, resp, err)
	if !op.Done() {
		next = c.now().Add(retryDelay).Unix()
	}
	if op.Status == failedStatus && m.State == model.Stopped && !m.ObservationStale {
		m.DesiredState = model.Stopped
	}
	if req.Checkpoint != nil && (req.Action == createCheckpointAction || req.Action == deleteCheckpointAction) {
		cp := *req.Checkpoint
		switch {
		case op.Status == succeededStatus:
			cp = *resp.Checkpoint
		case req.Action == createCheckpointAction:
			cp.Status = op.Status
		case op.Status == failedStatus:
			cp.Status = publishedStatus
		default:
			cp.Status = "deleting"
		}
		txErr = saveCheckpoint(ctx, tx, cp)
	}
	if txErr == nil && req.Action != deleteCheckpointAction {
		txErr = saveMachine(ctx, tx, m)
	}
	if txErr == nil {
		txErr = saveOperation(ctx, tx, op, next)
	}
	if txErr == nil {
		txErr = tx.Commit()
	}
	return txErr
}
