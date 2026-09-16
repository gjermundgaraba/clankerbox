// Command clankerbox-guest owns authenticated guest sessions and live identity rebinding.
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
	"clankerbox/internal/rpcidentity"
	"clankerbox/internal/statefs"
)

var version = "dev"

func main() { os.Exit(run()) }
func run() int {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	if err := newCommand(os.Stdin, os.Stdout).Run(ctx, os.Args); err != nil {
		fmt.Fprintln(os.Stderr, "clankerbox-guest:", err)
		if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED) {
			return absentDaemonExit
		}
		return 1
	}
	return 0
}
func newCommand(stdin io.Reader, _ io.Writer) *cli.Command {
	state := func() *cli.StringFlag {
		return &cli.StringFlag{
			Name:  "state-dir",
			Value: "/var/lib/clankerbox-guest",
			Usage: "Private root-owned guest state directory",
		}
	}
	return &cli.Command{
		Name:    "clankerbox-guest",
		Usage:   "Authenticated terminal session service",
		Version: version,
		Commands: []*cli.Command{
			{
				Name:  "serve",
				Usage: "Serve guest RPC and terminal sessions as root",
				Flags: []cli.Flag{
					state(),
					&cli.StringFlag{Name: "listen", Value: "0.0.0.0:7443"},
					&cli.StringFlag{Name: "binding-file"},
				},
				Action: func(ctx context.Context, c *cli.Command) error {
					var binding *rpcidentity.Binding
					if path := c.String("binding-file"); path != "" {
						raw, err := statefs.ReadPrivate(path)
						if err != nil {
							return err
						}
						binding = &rpcidentity.Binding{}
						if err = json.Unmarshal(raw, binding); err != nil {
							return err
						}
					}
					return daemon.Serve(
						ctx,
						daemon.Options{
							Paths:   daemon.PathsIn(c.String("state-dir")),
							Listen:  c.String("listen"),
							Binding: binding,
							Version: version,
						},
					)
				},
			},
			{
				Name:  "rebind",
				Usage: "Adopt a host-issued binding via the local administrative socket",
				Flags: []cli.Flag{state()},
				Action: func(ctx context.Context, c *cli.Command) error {
					raw, err := io.ReadAll(io.LimitReader(stdin, bindingMaxBytes+1))
					if err != nil {
						return err
					}
					return daemon.Rebind(ctx, daemon.PathsIn(c.String("state-dir")), raw)
				},
			},
		},
	}
}

const (
	absentDaemonExit = 3
	bindingMaxBytes  = 64 << 10
)
