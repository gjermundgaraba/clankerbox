package client

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"

	"clankerbox/internal/model"
)

func deriveCLI(ctx context.Context, a *API, command string, args []string, s Streams) error {
	action := command
	if command == checkpointCommand {
		if len(args) == 0 {
			return errors.New("checkpoint requires create, list, inspect or delete")
		}
		action = args[0]
		args = args[1:]
	}
	if command == checkpointCommand && (action == "list" || action == inspectCommand) {
		return queryCheckpoint(ctx, a, action, args, s)
	}
	child := command == forkCommand || command == "restore"
	if !child && action != createCommand && action != "delete" {
		return errors.New("unknown checkpoint action")
	}
	f := flags(command, s.Err)
	idem := f.String("idempotency-key", "", "retry key")
	var name, key string
	if child {
		f.StringVar(&name, "name", "", "child name")
		f.StringVar(&key, "key", "", "public key file")
	}
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 1 {
		return errors.New("exactly one source or checkpoint ID required")
	}
	id, err := requestKey(*idem)
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
	path, err := checkpointMutationPath(ctx, a, command, action, f.Arg(0))
	if err != nil {
		return err
	}
	return mutate(ctx, a, path, body, id, s.Out)
}

func queryCheckpoint(ctx context.Context, a *API, action string, args []string, streams Streams) error {
	path := "/v1/checkpoints"
	switch action {
	case "list":
		if len(args) != 0 {
			return errors.New("list takes no arguments")
		}
	case inspectCommand:
		if len(args) != 1 || !model.ValidID(args[0]) {
			return errors.New("immutable checkpoint ID required")
		}
		path += "/" + args[0]
	}
	var out json.RawMessage
	if err := a.Do(ctx, "GET", path, nil, "", &out); err != nil {
		return err
	}
	return jsonOut(streams.Out, out)
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
