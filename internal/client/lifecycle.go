package client

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"clankerbox/internal/model"
)

const defaultWaitTimeout = 5 * time.Minute

// WaitOperation reads an accepted operation until success, failure or an unresolved
// outcome. It never submits a mutation. The caller's context bounds the wait.
// On error the returned operation retains the last known resource IDs.
func (a *API) WaitOperation(ctx context.Context, operation model.Operation) (model.Operation, error) {
	if !model.ValidID(operation.ID) {
		return operation, operationError(operation, errors.New("invalid operation ID"))
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		switch operation.Status {
		case "succeeded":
			return operation, nil
		case "failed", "unresolved":
			return operation, operationError(operation, fmt.Errorf("%s: %s", operation.Status, operation.Error))
		case "pending", "running":
		default:
			return operation, operationError(operation, fmt.Errorf("unknown status %q", operation.Status))
		}
		current, err := a.Operation(ctx, operation.ID)
		if err != nil {
			return operation, operationError(operation, errors.Join(err, ctx.Err()))
		}
		if current.ID != operation.ID {
			return operation, operationError(operation, errors.New("operation identity mismatch"))
		}
		operation = current
		if operation.Status != "pending" && operation.Status != "running" {
			continue
		}
		select {
		case <-ctx.Done():
			return operation, operationError(operation, ctx.Err())
		case <-ticker.C:
		}
	}
}

func operationError(op model.Operation, err error) error {
	outcome := "operation may continue"
	if op.Status == "succeeded" || op.Status == "failed" || op.Status == "unresolved" {
		outcome = "operation is " + op.Status
	}
	return fmt.Errorf(
		"operation %s (machine %s, checkpoint %s): %w; %s; inspect with operation %s",
		op.ID,
		op.MachineID,
		op.CheckpointID,
		err,
		outcome,
		op.ID,
	)
}

type waitOptions struct {
	async   bool
	timeout time.Duration
}

func (runner commandRunner) finishMutation(
	ctx context.Context,
	operation model.Operation,
	err error,
	key string,
	wait *waitOptions,
	result string,
) error {
	if err != nil {
		return fmt.Errorf("%w; retry with --idempotency-key %s", err, key)
	}
	if wait.async {
		return runner.output(operation)
	}
	waitCtx, cancel := context.WithTimeout(ctx, wait.timeout)
	operation, err = runner.api.WaitOperation(waitCtx, operation)
	cancel()
	if err != nil {
		return err
	}
	if result == deleteCommand {
		return runner.output(operation)
	}
	if result == checkpointCommand {
		cp, e := runner.api.Checkpoint(ctx, operation.CheckpointID)
		if e != nil {
			return operationError(operation, e)
		}
		return runner.output(cp)
	}
	m, e := runner.api.Resolve(ctx, operation.MachineID)
	if e != nil {
		return operationError(operation, e)
	}
	return runner.output(m)
}

func (a *API) selectHost(ctx context.Context, host, profile string) (string, error) {
	if host != "" {
		return host, nil
	}
	hosts, err := a.Hosts(ctx)
	if err != nil {
		return "", err
	}
	var eligible []string
	for _, h := range hosts {
		if slices.Contains(h.ProfileIDs, profile) {
			eligible = append(eligible, h.ID)
		}
	}
	if len(eligible) != 1 {
		return "", fmt.Errorf(
			"profile %q has %d eligible hosts (%s); specify --host",
			profile,
			len(eligible),
			strings.Join(eligible, ", "),
		)
	}
	return eligible[0], nil
}
