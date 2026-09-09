// Command clankerbox-host executes journaled host operations over an SSH pipe.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"clankerbox/internal/host"
	"clankerbox/internal/model"
	"clankerbox/internal/statefs"

	"github.com/urfave/cli/v3"
)

const (
	maxRequestBytes  = 64 << 10
	operationTimeout = 6 * time.Minute
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
		Usage:     "Execute journaled host operations over an SSH pipe",
		UsageText: "clankerbox-host [options]",
		Flags: []cli.Flag{
			&cli.StringFlag{Name: "config", Usage: "Host JSON configuration `FILE`", Required: true},
			&cli.StringFlag{Name: "connect", Usage: "Relay the prepared `MACHINE` SSH endpoint"},
			&cli.StringFlag{Name: "auth-prepare", Usage: "Prepare the `MACHINE` auth relay public key"},
			&cli.StringFlag{Name: "guest-prepare", Usage: "Prepare the `MACHINE` terminal key and guest daemon"},
		},
		Before: func(_ context.Context, cmd *cli.Command) (context.Context, error) {
			modes := 0
			for _, flag := range []string{"connect", "auth-prepare", "guest-prepare"} {
				if cmd.String(flag) != "" {
					modes++
				}
			}
			if modes > 1 {
				return nil, errors.New("connect, auth-prepare and guest-prepare are mutually exclusive")
			}
			if cmd.Args().Present() {
				return nil, fmt.Errorf("unexpected argument %q", cmd.Args().First())
			}
			return nil, nil
		},
		OnUsageError: func(_ context.Context, _ *cli.Command, err error, _ bool) error { return err },
		Action:       run,
	}
}

func run(parent context.Context, cmd *cli.Command) error {
	config := cmd.String("config")
	connect := cmd.String("connect")
	data, err := statefs.ReadRegular(config)
	if err != nil {
		return err
	}
	var cfg host.Config
	if err = json.Unmarshal(data, &cfg); err != nil {
		return err
	}
	if connect == "" {
		// Durable work can finish after its SSH caller disappears.
		signal.Ignore(syscall.SIGHUP)
	}
	signals := []os.Signal{os.Interrupt, syscall.SIGTERM}
	if connect != "" {
		signals = append(signals, syscall.SIGHUP)
	}
	ctx, cancel := signal.NotifyContext(parent, signals...)
	defer cancel()
	h, err := host.Open(cfg, nil)
	if err != nil {
		return err
	}
	if id := cmd.String("auth-prepare"); id != "" {
		err = servePrepare(ctx, id, os.Stdin, os.Stdout, h.PrepareAuth)
	} else if guestID := cmd.String("guest-prepare"); guestID != "" {
		err = servePrepare(ctx, guestID, os.Stdin, os.Stdout, h.PrepareGuest)
	} else {
		err = serve(ctx, h, connect)
	}
	return errors.Join(err, h.Close())
}

func serve(ctx context.Context, h *host.Helper, connect string) error {
	if connect != "" {
		return h.Connect(ctx, connect, os.Stdin, os.Stdout)
	}
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, maxRequestBytes+1))
	decoder.DisallowUnknownFields()
	var req model.Request
	if err := decoder.Decode(&req); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("exactly one request required")
	}
	call, done := context.WithTimeout(ctx, operationTimeout)
	defer done()
	resp := h.Execute(call, req)
	return json.NewEncoder(os.Stdout).Encode(resp)
}

// servePrepare reads one public-key request and runs a preparation step.
func servePrepare(
	ctx context.Context,
	id string,
	in io.Reader,
	out io.Writer,
	prepare func(context.Context, string, string) error,
) error {
	decoder := json.NewDecoder(io.LimitReader(in, maxRequestBytes+1))
	decoder.DisallowUnknownFields()
	var req struct {
		PublicKey string `json:"public_key"`
	}
	if err := decoder.Decode(&req); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("exactly one request required")
	}
	call, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()
	if err := prepare(call, id, req.PublicKey); err != nil {
		return err
	}
	return json.NewEncoder(out).Encode(struct {
		Ready bool `json:"ready"`
	}{true})
}
