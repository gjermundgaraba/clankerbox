package client

import (
	"context"
	"errors"

	"clankerbox/internal/model"
)

func (runner commandRunner) forkMachine(ctx context.Context, target, name, idem string, wait *waitOptions) error {
	child := model.ChildInput{Name: name}
	if err := child.Validate(); err != nil {
		return err
	}
	key, err := requestKey(idem)
	if err != nil {
		return err
	}
	source, err := runner.api.Resolve(ctx, target)
	if err != nil {
		return err
	}
	op, err := runner.api.ForkMachine(ctx, source.ID, key, child)
	return runner.finishMutation(ctx, op, err, key, wait, forkCommand)
}

func (runner commandRunner) restoreCheckpoint(ctx context.Context, id, name, idem string, wait *waitOptions) error {
	if !model.ValidID(id) {
		return errors.New("immutable checkpoint ID required")
	}
	child := model.ChildInput{Name: name}
	if err := child.Validate(); err != nil {
		return err
	}
	key, err := requestKey(idem)
	if err != nil {
		return err
	}
	op, err := runner.api.RestoreCheckpoint(ctx, id, key, child)
	return runner.finishMutation(ctx, op, err, key, wait, "restore")
}

func (runner commandRunner) captureCheckpoint(ctx context.Context, target, idem string, wait *waitOptions) error {
	key, err := requestKey(idem)
	if err != nil {
		return err
	}
	source, err := runner.api.Resolve(ctx, target)
	if err != nil {
		return err
	}
	op, err := runner.api.CaptureCheckpoint(ctx, source.ID, key)
	return runner.finishMutation(ctx, op, err, key, wait, checkpointCommand)
}

func (runner commandRunner) deleteCheckpoint(ctx context.Context, id, idem string, wait *waitOptions) error {
	if !model.ValidID(id) {
		return errors.New("immutable checkpoint ID required")
	}
	key, err := requestKey(idem)
	if err != nil {
		return err
	}
	op, err := runner.api.DeleteCheckpoint(ctx, id, key)
	return runner.finishMutation(ctx, op, err, key, wait, deleteCommandName)
}

func (runner commandRunner) inspectCheckpoint(ctx context.Context, id string) error {
	if !model.ValidID(id) {
		return errors.New("immutable checkpoint ID required")
	}
	checkpoint, err := runner.api.Checkpoint(ctx, id)
	if err != nil {
		return err
	}
	return runner.output(checkpoint)
}

func (runner commandRunner) listCheckpoints(ctx context.Context) error {
	checkpoints, err := runner.api.Checkpoints(ctx)
	if err != nil {
		return err
	}
	return runner.output(&checkpoints)
}
