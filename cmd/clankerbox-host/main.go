// Command clankerbox-host runs the persistent private host RPC service.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"clankerbox/internal/host"
	"clankerbox/internal/statefs"

	"github.com/urfave/cli/v3"
)

func main() {
	if err := newCommand().Run(context.Background(), os.Args); err != nil {
		log.New(os.Stderr, "", 0).Print(err)
		os.Exit(1)
	}
}
func newCommand() *cli.Command {
	return &cli.Command{
		Name:      "clankerbox-host",
		Usage:     "Run the persistent private host RPC service",
		UsageText: "clankerbox-host --config FILE",
		Flags:     []cli.Flag{&cli.StringFlag{Name: "config", Usage: "Host JSON configuration `FILE`", Required: true}},
		Before: func(_ context.Context, c *cli.Command) (context.Context, error) {
			if c.Args().Present() {
				return nil, fmt.Errorf("unexpected argument %q", c.Args().First())
			}
			return nil, nil
		},
		OnUsageError: func(_ context.Context, _ *cli.Command, err error, _ bool) error { return err },
		Action:       run,
	}
}
func run(parent context.Context, cmd *cli.Command) error {
	data, err := statefs.ReadRegular(cmd.String("config"))
	if err != nil {
		return err
	}
	var cfg host.Config
	if err = json.Unmarshal(data, &cfg); err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return host.Serve(ctx, cfg)
}
