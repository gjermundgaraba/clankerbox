package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"

	"github.com/urfave/cli/v3"

	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

const codexAuthProvider = "codex"
const authStatusKey = "status"
const authNameKey = "name"

type authConnectionStatus struct {
	Name      string `json:"name"`
	AccountID string `json:"account_id"`
	ExpiresAt string `json:"expires_at"`
	Status    string `json:"status"`
}
type authBinding struct {
	MachineID      string `json:"machine_id"`
	ConnectionName string `json:"connection_name"`
}
type authStatus struct {
	Connections []authConnectionStatus `json:"connections"`
	Bindings    []authBinding          `json:"bindings"`
	Relays      map[string]string      `json:"relays"`
}

func (streams commandStreams) addAuthCommands(root *cli.Command) {
	auth := &cli.Command{
		Name:         "auth",
		Usage:        "Manage controller-held coding agent connections",
		OnUsageError: returnUsageError,
	}
	connect := streams.command(
		"connect",
		"Import a local Codex login",
		"codex",
		1,
		func(ctx context.Context, r commandRunner, c *cli.Command) error {
			return r.connectAuth(ctx, c.Args().First(), c.String(authNameKey), c.String("auth-file"))
		},
	)
	connect.Flags = []cli.Flag{
		&cli.StringFlag{Name: authNameKey, Value: codexAuthProvider, Usage: "Connection name"},
		&cli.StringFlag{
			Name:      "auth-file",
			Usage:     "Private Codex auth JSON file (default: ~/.codex/auth.json)",
			TakesFile: true,
		},
	}
	attach := streams.command(
		"attach",
		"Bind a connection to a machine",
		"MACHINE",
		1,
		func(ctx context.Context, r commandRunner, c *cli.Command) error {
			return r.bindAuth(ctx, c.Args().First(), c.String("connection"), true)
		},
	)
	attach.Flags = []cli.Flag{&cli.StringFlag{Name: "connection", Value: codexAuthProvider, Usage: "Connection name"}}
	auth.Commands = []*cli.Command{
		connect,
		attach,
		streams.command(
			"detach",
			"Remove a machine's connection binding",
			"MACHINE",
			1,
			func(ctx context.Context, r commandRunner, c *cli.Command) error {
				return r.bindAuth(ctx, c.Args().First(), "", false)
			},
		),
		streams.command(
			"disconnect",
			"Remove a stored connection",
			"NAME",
			1,
			func(ctx context.Context, r commandRunner, c *cli.Command) error {
				name := c.Args().First()
				if !model.ValidName(name) {
					return errors.New("invalid connection name")
				}
				if err := r.api.Do(
					ctx,
					http.MethodDelete,
					"/v1/auth/connections/"+url.PathEscape(name),
					nil,
					"",
					nil,
				); err != nil {
					return err
				}
				return r.authResult(
					map[string]string{authNameKey: name, authStatusKey: "disconnected"},
					"Connection %s disconnected.\n",
					name,
				)
			},
		),
		streams.command(
			"status",
			"Show connection and binding metadata",
			" ",
			0,
			func(ctx context.Context, r commandRunner, _ *cli.Command) error { return r.showAuthStatus(ctx) },
		),
	}
	root.Commands = append(root.Commands, auth)
}

func (runner commandRunner) connectAuth(ctx context.Context, provider, name, path string) error {
	if provider != codexAuthProvider {
		return errors.New("only codex connections are supported")
	}
	if !model.ValidName(name) {
		return errors.New("invalid connection name")
	}
	if _, err := validateAPIURL(runner.api.Config.URL); err != nil {
		return err
	}
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		path = filepath.Join(home, ".codex", "auth.json")
	}
	path, err := absolutePath(path, ".")
	if err != nil {
		return err
	}
	raw, err := statefs.ReadPrivate(path)
	if err != nil {
		return err
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return errors.New("auth file must contain a JSON object")
	}
	body := struct {
		Name     string          `json:"name"`
		Provider string          `json:"provider"`
		Auth     json.RawMessage `json:"auth"`
	}{name, provider, raw}
	if err = runner.api.Do(ctx, http.MethodPost, "/v1/auth/connections", body, "", nil); err != nil {
		return err
	}
	return runner.authResult(
		map[string]string{authNameKey: name, "provider": provider, authStatusKey: "connected"},
		"Connection %s imported. The controller holds a copy of this login. Refreshing a shared local login can conflict; use a dedicated login for long-lived use.\n",
		name,
	)
}

func (runner commandRunner) bindAuth(ctx context.Context, machine, connection string, attach bool) error {
	if attach && !model.ValidName(connection) {
		return errors.New("invalid connection name")
	}
	m, err := runner.api.Resolve(ctx, machine)
	if err != nil {
		return err
	}
	method := http.MethodDelete
	var body any
	if attach {
		method = http.MethodPost
		body = map[string]string{"connection": connection}
	}
	if err = runner.api.Do(ctx, method, "/v1/machines/"+m.ID+"/auth", body, "", nil); err != nil {
		return err
	}
	if attach {
		return runner.authResult(
			authBinding{m.ID, connection},
			"Connection %s bound to machine %s. Binding saved; relay starts when the machine is running. Check clankerbox auth status.\n",
			connection,
			m.ID,
		)
	}
	return runner.authResult(
		map[string]string{"machine_id": m.ID, authStatusKey: "detached"},
		"Connection binding removed from machine %s.\n",
		m.ID,
	)
}
func (runner commandRunner) authResult(value any, format string, args ...any) error {
	if runner.structured {
		return jsonOut(runner.streams.Out, value)
	}
	_, err := fmt.Fprintf(runner.streams.Out, format, args...)
	return err
}
func (runner commandRunner) showAuthStatus(ctx context.Context) error {
	status := authStatus{Connections: []authConnectionStatus{}, Bindings: []authBinding{}, Relays: map[string]string{}}
	if err := runner.api.Do(ctx, http.MethodGet, "/v1/auth/status", nil, "", &status); err != nil {
		return err
	}
	if runner.structured {
		return jsonOut(runner.streams.Out, status)
	}
	for _, c := range status.Connections {
		if _, err := fmt.Fprintf(
			runner.streams.Out,
			"Connection %q: %q  Account: %q  Expires: %q\n",
			c.Name,
			c.Status,
			c.AccountID,
			c.ExpiresAt,
		); err != nil {
			return err
		}
	}
	for _, b := range status.Bindings {
		relay := status.Relays[b.MachineID]
		if relay == "" {
			relay = "waiting (stopped/detached)"
		}
		if _, err := fmt.Fprintf(
			runner.streams.Out,
			"Machine %q: connection %q  Relay: %q\n",
			b.MachineID,
			b.ConnectionName,
			relay,
		); err != nil {
			return err
		}
	}
	if len(status.Connections) == 0 && len(status.Bindings) == 0 {
		_, err := fmt.Fprintln(runner.streams.Out, "No auth connections or bindings.")
		return err
	}
	return nil
}
