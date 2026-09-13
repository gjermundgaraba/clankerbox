package client

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"clankerbox/internal/model"
)

// Streams supplies the command output and diagnostic destinations.
type Streams struct {
	Out io.Writer
	Err io.Writer
}

func jsonOut(w io.Writer, v any) error { return json.NewEncoder(w).Encode(v) }

const (
	deleteCommand     = deleteCommandName
	checkpointCommand = "checkpoint"
	forkCommand       = "fork"
	createCommand     = "create"
)

type commandRunner struct {
	api        *API
	streams    Streams
	structured bool
}

func (runner commandRunner) listResources(ctx context.Context, command string) error {
	var out any
	var err error
	switch command {
	case "hosts":
		var v []model.HostStatus
		v, err = runner.api.Hosts(ctx)
		out = &v
	case "profiles":
		var v []model.Profile
		v, err = runner.api.Profiles(ctx)
		out = &v
	default:
		var v []model.Machine
		v, err = runner.api.Machines(ctx)
		out = &v
	}
	if err != nil {
		return err
	}
	return runner.output(out)
}

func (runner commandRunner) inspectMachine(ctx context.Context, args []string) error {
	m, resolveErr := runner.api.Resolve(ctx, args[0])
	if resolveErr != nil {
		return resolveErr
	}
	return runner.output(m)
}

func (runner commandRunner) inspectOperation(ctx context.Context, args []string) error {
	if !model.ValidID(args[0]) {
		return errors.New("operation requires an immutable operation ID")
	}
	out, e := runner.api.Operation(ctx, args[0])
	if e != nil {
		return e
	}
	return runner.output(out)
}

func (runner commandRunner) createMachine(
	ctx context.Context,
	name, profile, host, idem string,
	wait *waitOptions,
) error {
	var e error
	if profile == "" {
		return errors.New("create requires a profile (flag or config default)")
	}
	host, e = runner.api.selectHost(ctx, host, profile)
	if e != nil {
		return e
	}
	in := model.CreateInput{
		Name:    name,
		Profile: profile,
		Host:    host,
	}
	if e = in.Validate(); e != nil {
		return e
	}
	id, e := requestKey(idem)
	if e != nil {
		return e
	}
	operation, err := runner.api.CreateMachine(ctx, id, in)
	return runner.finishMutation(ctx, operation, err, id, wait, createCommand)
}

func (runner commandRunner) mutateMachine(ctx context.Context, command, target, idem string, wait *waitOptions) error {
	m, resolveErr2 := runner.api.Resolve(ctx, target)
	if resolveErr2 != nil {
		return resolveErr2
	}
	id, resolveErr2 := requestKey(idem)
	if resolveErr2 != nil {
		return resolveErr2
	}
	var operation model.Operation
	var err error
	switch command {
	case "start":
		operation, err = runner.api.StartMachine(ctx, m.ID, id)
	case stopCommandName:
		operation, err = runner.api.StopMachine(ctx, m.ID, id)
	case deleteCommandName:
		operation, err = runner.api.DeleteMachine(ctx, m.ID, id)
	default:
		return errors.New("unknown mutation")
	}
	return runner.finishMutation(ctx, operation, err, id, wait, command)
}

const (
	inspectCommand = "inspect"
)

func requestKey(s string) (string, error) {
	if s != "" {
		if len(s) > 200 || strings.ContainsAny(s, "\r\n\x00 \t") {
			return "", errors.New("invalid idempotency key")
		}
		return s, nil
	}
	return model.NewID(), nil
}
