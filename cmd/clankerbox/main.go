// Command clankerbox controls machines and runs guest sessions.
package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/urfave/cli/v3"

	"clankerbox/internal/client"
)

func main() {
	err := run()
	if err == nil {
		return
	}
	// A session exits with its program's status and nothing to say.
	if message := err.Error(); message != "" {
		log.New(os.Stderr, "", 0).Print(message)
	}
	status := 1
	if coder, ok := errors.AsType[cli.ExitCoder](err); ok {
		status = coder.ExitCode()
	}
	os.Exit(status)
}

func run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer cancel()
	return client.Run(ctx, os.Args[1:], client.Streams{
		In: os.Stdin, Out: os.Stdout, Err: os.Stderr,
		Terminal: client.ControllingTerminal(os.Stdin, os.Stdout),
	})
}
