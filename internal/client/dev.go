package client

import (
	"context"
	"errors"
	"fmt"

	"github.com/urfave/cli/v3"

	"clankerbox/internal/dev"
)

func (streams commandStreams) addDevCommands(root *cli.Command) {
	root.Commands = append(root.Commands, &cli.Command{
		Name:        "dev",
		Usage:       "Run an owned local VM environment",
		Description: "Start a persistent native host service and foreground controller. Ctrl-C preserves VMs; dev stop stops VMs, and dev destroy deletes the owned environment.",
		Flags: []cli.Flag{
			&cli.StringFlag{Name: "state-dir", Value: dev.DefaultStateDir(), Usage: "Owned environment DIRECTORY"},
			&cli.StringFlag{Name: "listen", Value: "127.0.0.1:0", Usage: "Loopback controller ADDRESS"},
			&cli.StringFlag{Name: "bundle", Usage: "Verified runtime bundle MANIFEST"},
		},
		Action: func(ctx context.Context, cmd *cli.Command) error {
			if cmd.NArg() != 0 {
				return errors.New("dev takes no arguments")
			}
			return dev.Run(
				ctx,
				dev.Options{
					StateDir: cmd.String("state-dir"),
					Listen:   cmd.String("listen"),
					Bundle:   cmd.String("bundle"),
				},
				func(c dev.Connection) error {
					if cmd.Bool("json") {
						return jsonOut(streams.Out, c)
					}
					_, err := fmt.Fprintf(
						streams.Out,
						"Local VM environment ready: %s\nController: %s\nCLI config: %s\nClankerdesk target: %s\nDefault host/profile: %s / %s\nCreate machines through the ordinary API or CLI. Ctrl-C preserves the host service and VMs.\n",
						c.StateDir,
						c.URL,
						c.ClientConfig,
						c.ClankerdeskConfig,
						c.DefaultHost,
						c.DefaultProfile,
					)
					return err
				},
			)
		},
		Commands: []*cli.Command{
			{
				Name:  stopCommandName,
				Usage: "Stop retained VMs and host service",
				Action: func(ctx context.Context, cmd *cli.Command) error {
					if cmd.NArg() != 0 {
						return errors.New("dev stop takes no arguments")
					}
					return dev.Stop(ctx, cmd.String("state-dir"))
				},
			},
			{
				Name:  "destroy",
				Usage: "Delete all owned VMs, checkpoints, and environment state",
				Action: func(ctx context.Context, cmd *cli.Command) error {
					if cmd.NArg() != 0 {
						return errors.New("dev destroy takes no arguments")
					}
					return dev.Destroy(ctx, cmd.String("state-dir"))
				},
			},
		},
	})
}
