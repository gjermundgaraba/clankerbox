package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/urfave/cli/v3"

	"clankerbox/internal/dev"
)

func (streams commandStreams) addDevCommands(root *cli.Command) {
	root.Commands = append(root.Commands, &cli.Command{
		Name:        "dev",
		Usage:       "Run a local controller and real terminal sessions on this computer",
		Description: "Provides one local machine. Shells run as your user. Ctrl-C stops the controller; dev stop ends retained shells.",
		Flags: []cli.Flag{
			&cli.StringFlag{
				Name:  "state-dir",
				Value: dev.DefaultStateDir(),
				Usage: "Retain the local environment in DIRECTORY",
			},
			&cli.StringFlag{
				Name:  "workspace",
				Usage: "Initial shell DIRECTORY (default: retained environment workspace)",
			},
			&cli.StringFlag{Name: "listen", Value: "127.0.0.1:4780", Usage: "Loopback HTTP ADDRESS"},
		},
		Action: func(ctx context.Context, cmd *cli.Command) error {
			if cmd.NArg() != 0 {
				return errors.New("dev takes no arguments; use dev stop to end retained shells")
			}
			return dev.Run(
				ctx,
				dev.Options{
					StateDir:  cmd.String("state-dir"),
					Workspace: cmd.String("workspace"),
					Listen:    cmd.String("listen"),
				},
				func(conn dev.Connection) error {
					if cmd.Bool("json") {
						return jsonOut(streams.Out, conn)
					}
					config, err := json.Marshal(conn.Target)
					if err != nil {
						return err
					}
					quoted := "'" + strings.ReplaceAll(string(config), "'", "'\"'\"'") + "'"
					_, err = fmt.Fprintf(
						streams.Out,
						"Local machine ready: %s\nController: %s\nWorkspace: %s\nShells run as your local user.\n\nFor clankerdesk, run in its server terminal:\nexport CLANKERDESK_CLANKERBOX=%s\n\nSelect the local machine and Use for terminals.\nCtrl-C stops this controller and preserves shells. Then run:\nclankerbox dev --state-dir %s stop\n",
						conn.MachineID,
						conn.URL,
						conn.Workspace,
						quoted,
						"'"+strings.ReplaceAll(conn.StateDir, "'", "'\"'\"'")+"'",
					)
					return err
				},
			)
		},
		Commands: []*cli.Command{
			{
				Name:  "stop",
				Usage: "End retained local shells after stopping the dev controller",
				Action: func(ctx context.Context, cmd *cli.Command) error {
					if cmd.NArg() != 0 {
						return errors.New("dev stop takes no arguments")
					}
					return dev.Stop(ctx, cmd.String("state-dir"))
				},
			},
		},
	}, &cli.Command{
		Name:   "_dev-guest",
		Hidden: true,
		Flags: []cli.Flag{
			&cli.StringFlag{Name: "state-dir", Required: true},
			&cli.StringFlag{Name: "workspace", Required: true},
		},
		Action: func(ctx context.Context, cmd *cli.Command) error {
			if cmd.NArg() != 0 {
				return errors.New("unexpected guest arguments")
			}
			return dev.ServeGuest(ctx, cmd.String("state-dir"), cmd.String("workspace"))
		},
	})
}
