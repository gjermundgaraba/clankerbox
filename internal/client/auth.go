package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/urfave/cli/v3"

	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

const codexAuthProvider = "codex"
const claudeAuthProvider = "claude"
const githubAuthProvider = "github"
const githubAuthTimeout = 30 * time.Second
const maxAuthTokenBytes = 16 * 1024
const authStatusKey = "status"
const authNameKey = "name"

type authConnectionStatus struct {
	Name      string `json:"name"`
	Provider  string `json:"provider"`
	AccountID string `json:"account_id"`
	ExpiresAt string `json:"expires_at"`
	Status    string `json:"status"`
}
type authStatus struct {
	Connections []authConnectionStatus `json:"connections"`
	Relays      map[string]string      `json:"relays"`
}

func (streams commandStreams) addAuthCommands(root *cli.Command) {
	auth := &cli.Command{
		Name:         "auth",
		Usage:        "Manage controller-held provider connections",
		OnUsageError: returnUsageError,
	}
	connect := streams.command(
		"connect",
		"Import a Codex login, Claude subscription token, or GitHub login",
		"codex|claude|github",
		1,
		func(ctx context.Context, r commandRunner, c *cli.Command) error {
			provider := c.Args().First()
			name := c.String(authNameKey)
			if !c.IsSet(authNameKey) {
				name = provider
			}
			if provider != codexAuthProvider && provider != claudeAuthProvider && provider != githubAuthProvider {
				return errors.New("supported connection providers are codex, claude, and github")
			}
			if c.IsSet("auth-file") && provider != codexAuthProvider {
				return errors.New("--auth-file is only supported for codex")
			}
			if c.Bool("token-stdin") && provider == codexAuthProvider {
				return errors.New("--token-stdin is only supported for claude and github")
			}
			if provider == claudeAuthProvider && !c.Bool("token-stdin") {
				return errors.New("claude requires --token-stdin with a token from claude setup-token")
			}
			if provider != codexAuthProvider {
				return r.connectTokenAuth(ctx, provider, name, c.Bool("token-stdin"))
			}
			return r.connectCodexAuth(ctx, name, c.String("auth-file"))
		},
	)
	connect.Flags = []cli.Flag{
		&cli.StringFlag{Name: authNameKey, Usage: "Connection name (default: provider name)"},
		&cli.BoolFlag{
			Name:  "token-stdin",
			Usage: "Read a Claude subscription token or GitHub token from standard input",
		},
		&cli.StringFlag{
			Name:      "auth-file",
			Usage:     "Private Codex auth JSON file (default: ~/.codex/auth.json)",
			TakesFile: true,
		},
	}
	auth.Commands = []*cli.Command{
		connect,
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
			"Show connection and machine relay status",
			" ",
			0,
			func(ctx context.Context, r commandRunner, _ *cli.Command) error { return r.showAuthStatus(ctx) },
		),
	}
	root.Commands = append(root.Commands, auth)
}

func (runner commandRunner) connectCodexAuth(ctx context.Context, name, path string) error {
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
	}{name, codexAuthProvider, raw}
	if err = runner.api.Do(ctx, http.MethodPost, "/v1/auth/connections", body, "", nil); err != nil {
		return err
	}
	return runner.authResult(
		map[string]string{authNameKey: name, "provider": codexAuthProvider, authStatusKey: "connected"},
		"Connection %s imported. The controller holds a copy of this login. Refreshing a shared local login can conflict; use a dedicated login for long-lived use.\n",
		name,
	)
}

func (runner commandRunner) connectTokenAuth(ctx context.Context, provider, name string, stdin bool) error {
	if !model.ValidName(name) {
		return errors.New("invalid connection name")
	}
	if _, err := validateAPIURL(runner.api.Config.URL); err != nil {
		return err
	}
	var raw []byte
	var err error
	if stdin {
		if runner.streams.In == nil {
			return errors.New("token required on standard input")
		}
		raw, err = io.ReadAll(io.LimitReader(runner.streams.In, maxAuthTokenBytes+1))
	} else {
		raw, err = localGitHubToken(ctx)
	}
	defer clear(raw)
	if err != nil {
		if !stdin {
			return err
		}
		return errors.New("could not read token from standard input")
	}
	if len(raw) > maxAuthTokenBytes {
		return errors.New("token exceeds size limit")
	}
	token := strings.TrimSpace(string(raw))
	if token == "" || strings.ContainsAny(token, " \t\r\n") {
		return errors.New("input must contain a single token")
	}
	body := struct {
		Name     string            `json:"name"`
		Provider string            `json:"provider"`
		Auth     map[string]string `json:"auth"`
	}{name, provider, map[string]string{"token": token}}
	if err = runner.api.Do(ctx, http.MethodPost, "/v1/auth/connections", body, "", nil); err != nil {
		return err
	}
	return runner.authResult(
		map[string]string{authNameKey: name, "provider": provider, authStatusKey: "connected"},
		"Connection %s imported. Replace the token when it expires or is revoked.\n", name,
	)
}

// tokenCapture bounds retained subprocess output while draining its stdout.
type tokenCapture struct {
	raw []byte
}

func (capture *tokenCapture) Write(p []byte) (int, error) {
	remaining := maxAuthTokenBytes + 1 - len(capture.raw)
	capture.raw = append(capture.raw, p[:min(len(p), remaining)]...)
	return len(p), nil
}

func localGitHubToken(ctx context.Context) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, githubAuthTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", "auth", "token", "--hostname", "github.com")
	var capture tokenCapture
	cmd.Stdout = &capture
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		clear(capture.raw)
		return nil, errors.New(
			"could not obtain GitHub token; run gh auth login --hostname github.com or use --token-stdin",
		)
	}
	return capture.raw, nil
}

func (runner commandRunner) authResult(value any, format string, args ...any) error {
	if runner.structured {
		return jsonOut(runner.streams.Out, value)
	}
	_, err := fmt.Fprintf(runner.streams.Out, format, args...)
	return err
}
func (runner commandRunner) showAuthStatus(ctx context.Context) error {
	status := authStatus{Connections: []authConnectionStatus{}, Relays: map[string]string{}}
	if err := runner.api.Do(ctx, http.MethodGet, "/v1/auth/status", nil, "", &status); err != nil {
		return err
	}
	if runner.structured {
		return jsonOut(runner.streams.Out, status)
	}
	for _, c := range status.Connections {
		expires := c.ExpiresAt
		if expires == "" || expires == "0001-01-01T00:00:00Z" {
			expires = "unknown"
		}
		if _, err := fmt.Fprintf(
			runner.streams.Out,
			"Connection %q: %q  Provider: %q  Account: %q  Expires: %q\n",
			c.Name,
			c.Status,
			c.Provider,
			c.AccountID,
			expires,
		); err != nil {
			return err
		}
	}
	machines := make([]string, 0, len(status.Relays))
	for machine := range status.Relays {
		machines = append(machines, machine)
	}
	slices.Sort(machines)
	for _, machine := range machines {
		if _, err := fmt.Fprintf(
			runner.streams.Out,
			"Machine %q: Relay: %q\n",
			machine,
			status.Relays[machine],
		); err != nil {
			return err
		}
	}
	if len(status.Connections) == 0 && len(status.Relays) == 0 {
		_, err := fmt.Fprintln(runner.streams.Out, "No auth connections or machine relays.")
		return err
	}
	return nil
}
