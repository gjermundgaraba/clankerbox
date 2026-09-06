package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"clankerbox/internal/host"
	"clankerbox/internal/model"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
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
	data, err := os.ReadFile(*config)
	if err != nil {
		return err
	}
	var cfg host.Config
	if err = json.Unmarshal(data, &cfg); err != nil {
		return err
	}
	if *connect == "" {
		signal.Ignore(syscall.SIGHUP)
	} // durable work can finish after its SSH caller disappears.
	h, err := host.Open(cfg, nil)
	if err != nil {
		return err
	}
	defer h.Close()
	signals := []os.Signal{os.Interrupt, syscall.SIGTERM}
	if *connect != "" {
		signals = append(signals, syscall.SIGHUP)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), signals...)
	defer cancel()
	if *connect != "" {
		return h.Connect(ctx, *connect, os.Stdin, os.Stdout)
	}
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, (64<<10)+1))
	decoder.DisallowUnknownFields()
	var req model.Request
	if err = decoder.Decode(&req); err != nil {
		return err
	}
	var extra any
	if err = decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("exactly one request required")
	}
	call, done := context.WithTimeout(ctx, 6*time.Minute)
	defer done()
	resp := h.Execute(call, req)
	return json.NewEncoder(os.Stdout).Encode(resp)
}
