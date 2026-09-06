package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"clankerbox/internal/control"
	"clankerbox/internal/model"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
func run() error {
	config := flag.String("config", "", "JSON hosts/profiles configuration")
	db := flag.String("db", "", "SQLite database path")
	tokenFile := flag.String("token-file", "", "Bearer token file (at least 32 bytes)")
	listen := flag.String("listen", "127.0.0.1:8080", "HTTP listen address")
	flag.Parse()
	if *config == "" || *db == "" || *tokenFile == "" || flag.NArg() != 0 {
		return fmt.Errorf("--config, --db and --token-file are required")
	}
	data, err := os.ReadFile(*config)
	if err != nil {
		return err
	}
	var cfg model.Config
	if err = json.Unmarshal(data, &cfg); err != nil {
		return err
	}
	token, err := os.ReadFile(*tokenFile)
	if err != nil {
		return err
	}
	token = bytes.TrimRight(token, "\r\n")
	c, err := control.Open(*db, cfg, control.SSHTransport{})
	if err != nil {
		return err
	}
	defer c.Close()
	handler, err := c.Handler(token)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	workers := make(chan struct{})
	go func() { defer close(workers); c.Run(ctx) }()
	server := &http.Server{Addr: *listen, Handler: handler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() {
		<-ctx.Done()
		shutdown, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("clankerbox API listening on %s", *listen)
	err = server.ListenAndServe()
	cancel()
	<-workers
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}
