// Command clankerbox-server serves the authenticated API and durable work queue.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"clankerbox/internal/control"
	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

const (
	headerTimeout   = 10 * time.Second
	requestTimeout  = 30 * time.Second
	idleTimeout     = time.Minute
	shutdownTimeout = 10 * time.Second
	maxHeaderBytes  = 16 << 10
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
func run() error {
	config := flag.String("config", "", "JSON hosts/profiles configuration")
	stateDir := flag.String("state-dir", "", "private controller state directory")
	tokenFile := flag.String("token-file", "", "Bearer token file (at least 32 bytes)")
	listen := flag.String("listen", "127.0.0.1:8080", "HTTP listen address")
	flag.Parse()
	if *config == "" || *stateDir == "" || *tokenFile == "" || flag.NArg() != 0 {
		return errors.New("--config, --state-dir and --token-file are required")
	}
	data, err := statefs.ReadRegular(*config)
	if err != nil {
		return err
	}
	var cfg model.Config
	if err = json.Unmarshal(data, &cfg); err != nil {
		return err
	}
	token, err := statefs.ReadPrivate(*tokenFile)
	if err != nil {
		return err
	}
	token = bytes.TrimRight(token, "\r\n")
	c, err := control.Open(*stateDir, cfg, control.SSHTransport{})
	if err != nil {
		return err
	}
	handler, err := c.Handler(token)
	if err != nil {
		return errors.Join(err, c.Close())
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	err = serve(ctx, c, handler, *listen)
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
