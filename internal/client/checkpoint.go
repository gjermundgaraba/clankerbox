package client

import (
	"context"
	"errors"

	"clankerbox/internal/model"
)

func (runner commandRunner) deriveMachine(
	ctx context.Context,
	command, action, target, name, idem string,
	wait *waitOptions,
) error {
	key, err := requestKey(idem)
	if err != nil {
		return err
	}
	child := model.ChildInput{Name: name}
	if command == forkCommand || command == restoreCommand {
		if err = child.Validate(); err != nil {
			return err
		}
	}
	if command == forkCommand || command == checkpointCommand && action == createCommand {
		m, e := runner.api.Resolve(ctx, target)
		if e != nil {
			return e
		}
		target = m.ID
	} else if !model.ValidID(target) {
		return errors.New("immutable checkpoint ID required")
	}
	var op model.Operation
	result := action
	switch {
	case command == forkCommand:
		op, err = runner.api.ForkMachine(ctx, target, key, child)
	case command == restoreCommand:
		op, err = runner.api.RestoreCheckpoint(ctx, target, key, child)
	case action == createCommand:
		op, err = runner.api.CaptureCheckpoint(ctx, target, key)
		result = checkpointCommand
	case action == deleteCommand:
		op, err = runner.api.DeleteCheckpoint(ctx, target, key)
	default:
		return errors.New("invalid checkpoint mutation")
	}
	return runner.finishMutation(ctx, op, err, key, wait, result)
}
func (runner commandRunner) queryCheckpoint(ctx context.Context, action string, args []string) error {
	if action == inspectCommand {
		if !model.ValidID(args[0]) {
			return errors.New("immutable checkpoint ID required")
		}
		cp, e := runner.api.Checkpoint(ctx, args[0])
		if e != nil {
			return e
		}
		return runner.output(cp)
	}
	cps, e := runner.api.Checkpoints(ctx)
	if e != nil {
		return e
	}
	return runner.output(&cps)
}
