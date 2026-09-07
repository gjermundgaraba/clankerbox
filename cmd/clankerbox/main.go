// Command clankerbox controls machines and owns local forwarding sessions.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"clankerbox/internal/client"
)

func main() {
	if err := run(); err != nil {
		if writeErr := json.NewEncoder(os.Stderr).Encode(map[string]string{"error": err.Error()}); writeErr != nil {
			log.Printf("command failed: %v; writing error response: %v", err, writeErr)
		}
		os.Exit(1)
	}
}

func run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	err := client.Run(ctx, os.Args[1:], client.Streams{In: os.Stdin, Out: os.Stdout, Err: os.Stderr})
	if errors.Is(err, flag.ErrHelp) {
		return nil
	}
	return err
}
