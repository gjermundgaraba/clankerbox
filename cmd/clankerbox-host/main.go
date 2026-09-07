// Command clankerbox-host executes journaled host operations over an SSH pipe.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"clankerbox/internal/host"
	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

const (
	maxRequestBytes  = 64 << 10
	operationTimeout = 6 * time.Minute
)

func main() {
	if err := run(); err != nil {
		log.New(os.Stderr, "", 0).Print(err)
		os.Exit(1)
	}
}
func run() error {
	config := flag.String("config", "", "host JSON configuration")
	connect := flag.String("connect", "", "relay this prepared machine's SSH endpoint")
	flag.Parse()
	if *config == "" || flag.NArg() != 0 {
		return errors.New("--config required")
	}
	data, err := statefs.ReadRegular(*config)
	if err != nil {
		return err
	}
	var cfg host.Config
	if err = json.Unmarshal(data, &cfg); err != nil {
		return err
	}
	if *connect == "" {
		// Durable work can finish after its SSH caller disappears.
		signal.Ignore(syscall.SIGHUP)
	}
	signals := []os.Signal{os.Interrupt, syscall.SIGTERM}
	if *connect != "" {
		signals = append(signals, syscall.SIGHUP)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), signals...)
	defer cancel()
	h, err := host.Open(cfg, nil)
	if err != nil {
		return err
	}
	err = serve(ctx, h, *connect)
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
