// Command clankerbox-server serves the authenticated API and durable work queue.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"clankerbox/internal/control"
	"clankerbox/internal/model"
	"clankerbox/internal/statefs"

	"github.com/urfave/cli/v3"
)

const (
	headerTimeout   = 10 * time.Second
	requestTimeout  = 30 * time.Second
	idleTimeout     = time.Minute
	shutdownTimeout = 10 * time.Second
	maxHeaderBytes  = 16 << 10
)

func main() {
	if err := newCommand().Run(context.Background(), os.Args); err != nil {
		log.New(os.Stderr, "", 0).Print(err)
		os.Exit(1)
	}
}
func newCommand() *cli.Command {
	return &cli.Command{
		Name:      "clankerbox-server",
		Usage:     "Serve the authenticated API and durable work queue",
		UsageText: "clankerbox-server [options]",
		Flags: []cli.Flag{
			&cli.StringFlag{Name: "config", Usage: "JSON hosts/profiles configuration `FILE`", Required: true},
			&cli.StringFlag{Name: "state-dir", Usage: "Private controller state `DIRECTORY`", Required: true},
			&cli.StringFlag{Name: "token-file", Usage: "Bearer token `FILE` (at least 32 bytes)", Required: true},
			&cli.StringFlag{
				Name:      "auth-key-file",
				Usage:     "Private 32-byte auth encryption key FILE (enables managed auth)",
				TakesFile: true,
			},
			&cli.StringFlag{Name: "listen", Usage: "HTTP listen `ADDRESS`", Value: "127.0.0.1:8080"},
		},
		Before: func(_ context.Context, cmd *cli.Command) (context.Context, error) {
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
	stateDir := cmd.String("state-dir")
	tokenFile := cmd.String("token-file")
	listen := cmd.String("listen")
	data, err := statefs.ReadRegular(config)
	if err != nil {
		return err
	}
	var cfg model.Config
	if err = json.Unmarshal(data, &cfg); err != nil {
		return err
	}
	token, err := statefs.ReadPrivate(tokenFile)
	if err != nil {
		return err
	}
	token = bytes.TrimRight(token, "\r\n")
	c, err := control.Open(stateDir, cfg, control.SSHTransport{})
	if err != nil {
		return err
	}
	if path := cmd.String("auth-key-file"); path != "" {
		key, readErr := statefs.ReadPrivate(path)
		if readErr != nil {
			return errors.Join(readErr, c.Close())
		}
		if enableErr := c.EnableAuth(key); enableErr != nil {
			return errors.Join(enableErr, c.Close())
		}
	}
	handler, err := c.Handler(token)
	if err != nil {
		return errors.Join(err, c.Close())
	}
	ctx, cancel := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
	defer cancel()
	err = serve(ctx, c, handler, listen)
	return errors.Join(err, c.Close())
}

func serve(parent context.Context, c *control.Controller, handler http.Handler, listen string) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	workers := make(chan struct{})
	go func() { defer close(workers); c.Run(ctx) }()
	server := &http.Server{
		Addr:              listen,
		Handler:           handler,
		ReadHeaderTimeout: headerTimeout,
		ReadTimeout:       requestTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
	}
	stopped := make(chan error, 1)
	go func() {
		<-ctx.Done()
		shutdown, done := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
		defer done()
		err := server.Shutdown(shutdown)
		if err != nil {
			err = errors.Join(err, server.Close())
		}
		stopped <- err
	}()
	log.Printf("clankerbox API listening on %s", listen)
	err := server.ListenAndServe()
	cancel()
	<-workers
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	return errors.Join(err, <-stopped)
}
