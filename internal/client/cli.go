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
	deleteCommand     = "delete"
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
	var e error
	out := resourceList(command)
	e = runner.api.Do(ctx, "GET", "/v1/"+command, nil, "", out)
	if e != nil {
		return e
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
	var e error
	if !model.ValidID(args[0]) {
		return errors.New("operation requires an immutable operation ID")
	}
	var out model.Operation
	if e = runner.api.Do(ctx, "GET", "/v1/operations/"+args[0], nil, "", &out); e != nil {
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
	return runner.mutate(ctx, "/v1/machines", in, id, wait, createCommand)
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
	return runner.mutate(ctx, "/v1/machines/"+m.ID+"/"+command, nil, id, wait, command)
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
