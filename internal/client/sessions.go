package client

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
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
		command(
			"events",
			"Print committed change notifications until interrupted",
			" ",
			0,
			func(ctx context.Context, r commandRunner, _ *cli.Command) error {
				return r.api.Stream(ctx, "/v1/events", r.streams.Out)
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
	_, _ = fmt.Fprintln(w, "ID\tSTATUS\tACTIVITY\tSIZE\tLABEL")
	for _, s := range sessions {
		_, _ = fmt.Fprintf(w, "%s\t%s\t%s\t%dx%d\t%s\n", s.ID, s.Status, s.Activity.State, s.Cols, s.Rows, s.Label)
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

// Stream copies a long-lived text response to out line by line until ctx ends.
func (a *API) Stream(ctx context.Context, path string, out io.Writer) error {
	req, err := a.request(ctx, http.MethodGet, path, nil, "")
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	httpClient := *a.http
	httpClient.Timeout = 0
	res, err := httpClient.Do(req)
	if err != nil {
		return errors.New("API request failed (transport or TLS error)")
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("API returned HTTP %d", res.StatusCode)
	}
	scanner := bufio.NewScanner(res.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if after, ok := strings.CutPrefix(line, "data: "); ok {
			if _, err = fmt.Fprintln(out, after); err != nil {
				return err
			}
		}
	}
	if err = scanner.Err(); err != nil && ctx.Err() == nil {
		return err
	}
	return nil
}
