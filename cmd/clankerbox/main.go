// Command clankerbox controls machines and lists guest terminal sessions.
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"clankerbox/internal/client"
)

func main() {
	if err := run(); err != nil {
		log.New(os.Stderr, "", 0).Print(err)
		os.Exit(1)
	}
}

func run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return client.Run(ctx, os.Args[1:], client.Streams{Out: os.Stdout, Err: os.Stderr})
}
