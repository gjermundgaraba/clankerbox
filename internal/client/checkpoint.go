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
	if command == "checkpoint" {
		if len(args) == 0 {
			return errors.New("checkpoint requires create, list, inspect or delete")
		}
		action = args[0]
		args = args[1:]
	}
	if command == "checkpoint" && (action == "list" || action == "inspect") {
		path := "/v1/checkpoints"
		if action == "list" {
			if len(args) != 0 {
				return errors.New("list takes no arguments")
			}
		} else {
			if len(args) != 1 || !model.ValidID(args[0]) {
				return errors.New("immutable checkpoint ID required")
			}
			path += "/" + args[0]
		}
		var out json.RawMessage
		if err := a.Do(ctx, "GET", path, nil, "", &out); err != nil {
			return err
		}
		return jsonOut(s.Out, out)
	}
	child := command == "fork" || command == "restore"
	if !child && action != "create" && action != "delete" {
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
		b, e := os.ReadFile(key)
		if e != nil {
			return e
		}
		in := model.ChildInput{Name: name, SSHPublicKeys: []string{strings.TrimSpace(string(b))}}
		if e = in.Validate(); e != nil {
			return e
		}
		body = in
	}
	target := f.Arg(0)
	path := ""
	if command == "fork" || command == "checkpoint" && action == "create" {
		m, e := a.Resolve(ctx, target)
		if e != nil {
			return e
		}
		suffix := "fork"
		if !child {
			suffix = "checkpoint"
		}
		path = "/v1/machines/" + m.ID + "/" + suffix
	} else {
		if !model.ValidID(target) {
			return errors.New("immutable checkpoint ID required")
		}
		path = "/v1/checkpoints/" + target + "/" + action
	}
	return mutate(ctx, a, path, body, id, s.Out)
}
