package client

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"text/tabwriter"

	"github.com/urfave/cli/v3"

	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/model"
)

const labelSeparator = "="

func (streams commandStreams) addSessionCommands(root *cli.Command) {
	command := streams.command
	root.Commands = append(root.Commands,
		command(
			"sessions",
			"List terminal sessions owned by a machine's guest daemon",
			"MACHINE",
			1,
			func(ctx context.Context, r commandRunner, c *cli.Command) error {
				return r.listSessions(ctx, c.Args().First())
			},
		),
		command(
			"labels",
			"Replace a machine's labels (no pairs clears them)",
			"MACHINE [KEY=VALUE...]",
			-1,
			func(ctx context.Context, r commandRunner, c *cli.Command) error {
				return r.setLabels(ctx, c.Args().Slice())
			},
		),
	)
}

func (runner commandRunner) listSessions(ctx context.Context, name string) error {
	m, err := runner.api.Resolve(ctx, name)
	if err != nil {
		return err
	}
	var sessions []protocol.Session
	if err = runner.api.Do(ctx, http.MethodGet, "/v1/machines/"+m.ID+"/sessions", nil, "", &sessions); err != nil {
		return err
	}
	if runner.structured {
		return jsonOut(runner.streams.Out, sessions)
	}
	w := tabwriter.NewWriter(runner.streams.Out, 0, 0, tablePadding, ' ', 0)
	_, _ = fmt.Fprintln(w, "ID\tSTATUS\tSIZE\tLABEL")
	for _, s := range sessions {
		_, _ = fmt.Fprintf(w, "%s\t%s\t%dx%d\t%s\n", s.ID, s.Status, s.Cols, s.Rows, s.Label)
	}
	return w.Flush()
}

func (runner commandRunner) setLabels(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New("labels requires MACHINE and optional KEY=VALUE pairs")
	}
	m, err := runner.api.Resolve(ctx, args[0])
	if err != nil {
		return err
	}
	labels := make(map[string]string, len(args)-1)
	for _, pair := range args[1:] {
		key, value, ok := strings.Cut(pair, labelSeparator)
		if !ok || key == "" {
			return fmt.Errorf("label %q must be KEY=VALUE", pair)
		}
		labels[key] = value
	}
	var updated model.Machine
	body := map[string]map[string]string{"labels": labels}
	if err = runner.api.Do(ctx, http.MethodPost, "/v1/machines/"+m.ID+"/labels", body, "", &updated); err != nil {
		return err
	}
	return runner.output(&updated)
}
