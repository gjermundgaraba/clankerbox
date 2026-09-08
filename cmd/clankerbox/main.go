// Command clankerbox controls machines and owns local forwarding sessions.
package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"syscall"

	"clankerbox/internal/client"
)

func main() {
	if err := run(); err != nil {
		var remote *client.SSHExitError
		if errors.As(err, &remote) && remote.ExitCode() > 0 {
			os.Exit(remote.ExitCode())
		}
		log.New(os.Stderr, "", 0).Print(err)
		os.Exit(1)
	}
}

func run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return client.Run(ctx, os.Args[1:], client.Streams{In: os.Stdin, Out: os.Stdout, Err: os.Stderr})
}
