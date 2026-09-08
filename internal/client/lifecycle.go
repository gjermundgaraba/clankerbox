package client

import (
	"context"
	"errors"
	"fmt"
	"os"
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
		var current model.Operation
		if err := a.Do(ctx, "GET", "/v1/operations/"+operation.ID, nil, "", &current); err != nil {
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

func (runner commandRunner) mutate(
	ctx context.Context,
	path string,
	in any,
	id string,
	wait *waitOptions,
	result string,
) error {
	var operation model.Operation
	if err := runner.api.Do(ctx, "POST", path, in, id, &operation); err != nil {
		return fmt.Errorf("%w; retry with --idempotency-key %s", err, id)
	}
	if wait.async {
		return runner.output(operation)
	}
	ctx, cancel := context.WithTimeout(ctx, wait.timeout)
	defer cancel()
	operation, err := runner.api.WaitOperation(ctx, operation)
	if err != nil {
		return err
	}
	var out any
	switch result {
	case deleteCommand:
		return runner.output(operation)
	case checkpointCommand:
		out = &model.Checkpoint{}
		path = "/v1/checkpoints/" + operation.CheckpointID
	default:
		out = &model.Machine{}
		path = "/v1/machines/" + operation.MachineID
	}
	if err = runner.api.Do(ctx, "GET", path, nil, "", out); err != nil {
		return operationError(operation, err)
	}
	return runner.output(out)
}

func (c Config) publicKeyFile() string {
	if c.PublicKeyFile != "" {
		return c.PublicKeyFile
	}
	if c.IdentityFile != "" {
		path := c.IdentityFile + ".pub"
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			return path
		}
	}
	return ""
}

func (a *API) selectHost(ctx context.Context, host, profile string) (string, error) {
	var hosts []model.Host
	if err := a.Do(ctx, "GET", "/v1/hosts", nil, "", &hosts); err != nil {
		return "", err
	}
	var eligible []string
	for _, h := range hosts {
		if slices.Contains(h.ProfileIDs, profile) {
			eligible = append(eligible, h.ID)
		}
	}
	if host != "" {
		if slices.Contains(eligible, host) {
			return host, nil
		}
		return "", fmt.Errorf("host %q does not support profile %q; select --host explicitly", host, profile)
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
