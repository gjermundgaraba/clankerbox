package client

import (
	"context"
	"errors"
	"os"
	"strings"

	"clankerbox/internal/model"
)

func (runner commandRunner) deriveMachine(
	ctx context.Context,
	command, action, target, name, key, idem string,
	wait *waitOptions,
) error {
	a := runner.api
	child := command == forkCommand || command == restoreCommand
	id, err := requestKey(idem)
	if err != nil {
		return err
	}
	var body any
	if child {
		input, inputErr := childInput(name, key)
		if inputErr != nil {
			return inputErr
		}
		body = input
	}
	path, err := checkpointMutationPath(ctx, a, command, action, target)
	if err != nil {
		return err
	}
	result := action
	if command == checkpointCommand && action == createCommand {
		result = checkpointCommand
	}
	return runner.mutate(ctx, path, body, id, wait, result)
}

func (runner commandRunner) queryCheckpoint(ctx context.Context, action string, args []string) error {
	path := "/v1/checkpoints"
	if action == inspectCommand {
		if !model.ValidID(args[0]) {
			return errors.New("immutable checkpoint ID required")
		}
		path += "/" + args[0]
	}
	var out any = &[]model.Checkpoint{}
	if action == inspectCommand {
		out = &model.Checkpoint{}
	}
	if err := runner.api.Do(ctx, "GET", path, nil, "", out); err != nil {
		return err
	}
	return runner.output(out)
}

func childInput(name, key string) (model.ChildInput, error) {
	//nolint:gosec // G304: Read the public-key file explicitly selected by the local CLI user; key data is validated.
	data, err := os.ReadFile(key)
	if err != nil {
		return model.ChildInput{}, err
	}
	input := model.ChildInput{Name: name, SSHPublicKeys: []string{strings.TrimSpace(string(data))}}
	return input, input.Validate()
}

func checkpointMutationPath(ctx context.Context, a *API, command, action, target string) (string, error) {
	if command == forkCommand || command == checkpointCommand && action == createCommand {
		machine, err := a.Resolve(ctx, target)
		if err != nil {
			return "", err
		}
		suffix := command
		return "/v1/machines/" + machine.ID + "/" + suffix, nil
	}
	if !model.ValidID(target) {
		return "", errors.New("immutable checkpoint ID required")
	}
	return "/v1/checkpoints/" + target + "/" + action, nil
}
