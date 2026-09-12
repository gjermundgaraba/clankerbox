// Command clankerbox-guest runs inside a machine and owns terminal sessions.
// The daemon subcommand serves the session protocol on a private Unix socket;
// proxy bridges stdio to it for the SSH forced command and starts the daemon
// on demand.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/urfave/cli/v3"

	"clankerbox/internal/guest/daemon"
)

// version is stamped at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	os.Exit(run())
}

func run() int {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := newCommand(os.Stdin, os.Stdout).Run(ctx, os.Args); err != nil {
		fmt.Fprintln(os.Stderr, "clankerbox-guest:", err)
		return 1
	}
	return 0
}

func newCommand(stdin io.Reader, stdout io.Writer) *cli.Command {
	stateFlag := &cli.StringFlag{
		Name:  "state-dir",
		Usage: "private state directory (default $HOME/.clankerbox)",
	}
	return &cli.Command{
		Name:    "clankerbox-guest",
		Usage:   "terminal session daemon for Clankerbox machines",
		Version: version,
		Commands: []*cli.Command{
			{
				Name:  "daemon",
				Usage: "serve sessions on the private socket until stopped",
				Flags: []cli.Flag{stateFlag},
				Action: func(ctx context.Context, c *cli.Command) error {
					paths, err := resolvePaths(c.String("state-dir"))
					if err != nil {
						return err
					}
					err = daemon.Serve(ctx, daemon.Options{Paths: paths, Version: version})
					if errors.Is(err, daemon.ErrAlreadyRunning) {
						return nil
					}
					return err
				},
			},
			{
				Name:  "proxy",
				Usage: "bridge stdio to the daemon socket, starting the daemon if needed",
				Flags: []cli.Flag{stateFlag},
				Action: func(ctx context.Context, c *cli.Command) error {
					paths, err := resolvePaths(c.String("state-dir"))
					if err != nil {
						return err
					}
					return daemon.Proxy(ctx, paths, stdin, stdout)
				},
			},
			{
				Name:  "sessions",
				Usage: "print the daemon's sessions as JSON",
				Flags: []cli.Flag{stateFlag},
				Action: func(ctx context.Context, c *cli.Command) error {
					paths, err := resolvePaths(c.String("state-dir"))
					if err != nil {
						return err
					}
					sessions, err := daemon.List(ctx, paths)
					if err != nil {
						return err
					}
					encoder := json.NewEncoder(stdout)
					encoder.SetIndent("", "  ")
					return encoder.Encode(sessions)
				},
			},
		},
	}
}

func resolvePaths(stateDir string) (daemon.Paths, error) {
	if stateDir != "" {
		return daemon.PathsIn(stateDir), nil
	}
	return daemon.DefaultPaths()
}
